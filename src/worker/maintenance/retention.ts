import { DB_NOW, statement as q } from '../db/core.ts';
import { assertion } from '../identity/checkpoint.ts';

const DAY = 86400000;
const terminal = "'published','blocked','failed','expired','cancelled'";
/** Routine D1 retention only. Independent recovery objects require the offline cleanup service. */
export class RetentionMaintenance {
  constructor(readonly db: D1Database) {}
  private ids(table: string, eligible: string, order: string) {
    return `SELECT rowid FROM ${table} WHERE ${eligible} ORDER BY ${order},rowid LIMIT 100`;
  }
  private invalidate(table: string, ids: string, ...values: number[]) {
    return q(
      this.db,
      `UPDATE accounts SET data_revision=data_revision+1 WHERE id IN (SELECT owner_id FROM ${table} WHERE rowid IN (${ids}))`,
      ...values,
    );
  }
  async run() {
    const counts: Record<string, number> = {};
    const batch = async (name: string, statements: D1PreparedStatement[]) => {
      const results = await this.db.batch([
        assertion(this.db, 'NOT EXISTS(SELECT 1 FROM system_state WHERE restore_in_progress=1)'),
        q(this.db, 'PRAGMA defer_foreign_keys=ON'),
        ...statements,
      ]);
      counts[name] = results.reduce((sum, result) => sum + result.meta.changes, 0);
    };
    const remove = async (table: string, where: string, order: string, exported = false) => {
      const ids = this.ids(table, where, order);
      await batch(table, [
        ...(exported ? [this.invalidate(table, ids)] : []),
        q(this.db, `DELETE FROM ${table} WHERE rowid IN (${ids})`),
      ]);
    };
    await remove('auth_challenges', `expires_at<=${DB_NOW}`, 'expires_at');
    await remove(
      'auth_sessions',
      `expires_at<=${DB_NOW} OR idle_expires_at<=${DB_NOW}`,
      'min(expires_at,idle_expires_at)',
    );
    await remove('rate_buckets', `expires_at<=${DB_NOW}`, 'expires_at');
    await remove('export_tickets', `expires_at<=${DB_NOW}`, 'expires_at');
    await remove('idempotency_keys', `expires_at<=${DB_NOW}`, 'expires_at');
    await remove(
      'security_operations',
      `state='applied' AND applied_at<=${DB_NOW}-${30 * DAY}`,
      'applied_at',
    );

    const events = this.ids('request_events', `created_at<=${DB_NOW}-${7 * DAY}`, 'created_at');
    await batch('request_events', [
      q(
        this.db,
        `UPDATE generation_requests SET next_event=max(next_event,coalesce((SELECT max(sequence)+1 FROM request_events WHERE request_id=generation_requests.id),next_event)) WHERE id IN (SELECT request_id FROM request_events WHERE rowid IN (${events}))`,
      ),
      q(this.db, `DELETE FROM request_events WHERE rowid IN (${events})`),
    ]);

    const candidates = this.ids(
      'provider_dispatches',
      `candidate_enc IS NOT NULL AND coalesce(received_at,authorized_at)<=${DB_NOW}-${DAY} AND EXISTS(SELECT 1 FROM generation_requests r WHERE r.id=provider_dispatches.request_id AND r.owner_id=provider_dispatches.owner_id AND r.state IN (${terminal}))`,
      'coalesce(received_at,authorized_at)',
    );
    await batch('candidates', [
      this.invalidate('provider_dispatches', candidates),
      q(
        this.db,
        `UPDATE provider_dispatches SET candidate_enc=NULL WHERE rowid IN (${candidates})`,
      ),
    ]);

    const failed = `state IN ('blocked','failed','expired','cancelled') AND NOT EXISTS(SELECT 1 FROM reading_editions e WHERE e.request_id=generation_requests.id AND e.owner_id=generation_requests.owner_id) AND NOT EXISTS(SELECT 1 FROM generation_context gc WHERE gc.request_id=generation_requests.id)`;
    const oldFailure = `${failed} AND coalesce(finished_at,expires_at)<=${DB_NOW}-${DAY}`;
    const bodyCandidates = this.ids(
      'generation_requests',
      `${oldFailure} AND (input_enc IS NOT NULL OR plan_enc IS NOT NULL OR EXISTS(SELECT 1 FROM provider_dispatches d WHERE d.request_id=generation_requests.id AND (d.transmission_enc IS NOT NULL OR d.candidate_enc IS NOT NULL OR d.provider_response_id_enc IS NOT NULL)))`,
      'coalesce(finished_at,expires_at)',
    );
    // Freeze only the bounded row identities. Recheck terminal/deadline/reference eligibility
    // in every statement; changing a body must not pull the next owner's row into this batch.
    const bodyIds = (await q(this.db, bodyCandidates).all<{ rowid: number }>()).results.map(
      (r) => r.rowid,
    );
    const bodies = `SELECT rowid FROM generation_requests WHERE rowid IN (${bodyIds.map(() => '?').join(',') || 'NULL'}) AND ${oldFailure}`;
    await batch('failed_bodies', [
      this.invalidate('generation_requests', bodies, ...bodyIds),
      q(
        this.db,
        `UPDATE generation_requests SET input_enc=NULL,plan_enc=NULL,revision=revision+1 WHERE rowid IN (${bodies})`,
        ...bodyIds,
      ),
      q(
        this.db,
        `UPDATE provider_dispatches SET transmission_enc=NULL,candidate_enc=NULL,provider_response_id_enc=NULL WHERE request_id IN (SELECT id FROM generation_requests WHERE rowid IN (${bodies}))`,
        ...bodyIds,
      ),
    ]);

    const stale = this.ids(
      'generation_requests',
      `${failed} AND coalesce(finished_at,expires_at)<=${DB_NOW}-${30 * DAY} AND input_enc IS NULL AND plan_enc IS NULL AND NOT EXISTS(SELECT 1 FROM quota_reservations qr WHERE qr.request_id=generation_requests.id AND qr.state='held') AND NOT EXISTS(SELECT 1 FROM provider_dispatches d WHERE d.request_id=generation_requests.id AND (d.transmission_enc IS NOT NULL OR d.candidate_enc IS NOT NULL OR d.provider_response_id_enc IS NOT NULL))`,
      'coalesce(finished_at,expires_at)',
    );
    await batch('failed_metadata', [
      this.invalidate('generation_requests', stale),
      q(
        this.db,
        `UPDATE cost_reservations SET owner_id=NULL,dispatch_id=NULL WHERE dispatch_id IN (SELECT id FROM provider_dispatches WHERE request_id IN (SELECT id FROM generation_requests WHERE rowid IN (${stale})))`,
      ),
      q(this.db, `DELETE FROM generation_requests WHERE rowid IN (${stale})`),
    ]);
    await remove(
      'generation_attempts',
      `finished_at<=${DB_NOW}-${30 * DAY} AND NOT EXISTS(SELECT 1 FROM provider_dispatches d WHERE d.attempt_id=generation_attempts.id) AND EXISTS(SELECT 1 FROM generation_requests r WHERE r.id=generation_attempts.request_id AND r.state IN (${terminal}))`,
      'finished_at',
    );

    const settled = `state='actual' AND settled_at<=${DB_NOW}-${90 * DAY} AND NOT EXISTS(SELECT 1 FROM cost_adjustments a WHERE a.cost_id=cost_reservations.id AND a.created_at>${DB_NOW}-${90 * DAY})`;
    const unresolved = `state IN ('reserved','unknown') AND created_at<=${DB_NOW}-${90 * DAY} AND (owner_id IS NOT NULL OR dispatch_id IS NOT NULL)`;
    for (const [name, where, deleting] of [
      ['settled_costs', settled, true],
      ['detached_liabilities', unresolved, false],
    ] as const) {
      const ids = this.ids('cost_reservations', where, 'created_at');
      await batch(name, [
        this.invalidate('cost_reservations', ids),
        q(
          this.db,
          `UPDATE provider_dispatches SET cost_expired_at=coalesce(cost_expired_at,${DB_NOW}) WHERE (owner_id,id) IN (SELECT owner_id,dispatch_id FROM cost_reservations WHERE rowid IN (${ids}))`,
        ),
        q(
          this.db,
          deleting
            ? `DELETE FROM cost_reservations WHERE rowid IN (${ids})`
            : `UPDATE cost_reservations SET owner_id=NULL,dispatch_id=NULL WHERE rowid IN (${ids})`,
        ),
      ]);
    }
    const previousMonth = "strftime('%Y-%m','now','start of month','-1 month')";
    await remove(
      'quota_buckets',
      `held=0 AND ((period LIKE 'day:%' AND substr(period,5,7)<${previousMonth}) OR (period LIKE 'month:%' AND substr(period,7,7)<${previousMonth})) AND NOT EXISTS(SELECT 1 FROM quota_reservations qr WHERE qr.owner_id=quota_buckets.owner_id AND (qr.day_period=quota_buckets.period OR qr.month_period=quota_buckets.period))`,
      'period',
    );
    await remove(
      'spend_buckets',
      `((period LIKE 'day:%' AND substr(period,5)<strftime('%Y-%m-%d','now','-90 days')) OR (period LIKE 'month:%' AND substr(period,7)<strftime('%Y-%m','now','-90 days'))) AND NOT EXISTS(SELECT 1 FROM cost_reservations c WHERE c.day_period=spend_buckets.period OR c.month_period=spend_buckets.period)`,
      'period',
    );

    const source = 'reading_sessions';
    const owned = (table: string, condition = '1') =>
      `NOT EXISTS(SELECT 1 FROM ${table} x WHERE x.owner_id=${source}.owner_id AND (${condition}))`;
    const session = (table: string, condition: string) =>
      owned(table, `x.session_id=${source}.id AND (${condition})`);
    const empty = [
      `status='deleted' AND deleted_at<=${DB_NOW}-${30 * DAY} AND question_enc IS NULL`,
      owned('deletion_jobs', "x.state!='complete'"),
      owned('context_grants'),
      owned('import_items'),
      owned('import_identities'),
      owned('revisits'),
      session('basis_snapshots', 'x.body_enc IS NOT NULL'),
      session('reading_editions', 'x.body_enc IS NOT NULL'),
      session(
        'generation_requests',
        `x.state NOT IN (${terminal}) OR x.input_enc IS NOT NULL OR x.plan_enc IS NOT NULL`,
      ),
      `NOT EXISTS(SELECT 1 FROM reflection_revisions rv JOIN reflections f ON f.id=rv.reflection_id AND f.owner_id=rv.owner_id WHERE f.owner_id=${source}.owner_id AND f.session_id=${source}.id AND rv.body_enc IS NOT NULL)`,
      `NOT EXISTS(SELECT 1 FROM reading_editions child JOIN reading_editions parent ON parent.id=child.parent_edition_id AND parent.owner_id=child.owner_id WHERE parent.owner_id=${source}.owner_id AND parent.session_id=${source}.id AND child.session_id!=${source}.id)`,
      `NOT EXISTS(SELECT 1 FROM quota_reservations qr JOIN generation_requests r ON r.id=qr.request_id WHERE r.session_id=${source}.id AND qr.state='held')`,
      `NOT EXISTS(SELECT 1 FROM provider_dispatches d JOIN generation_requests r ON r.id=d.request_id WHERE r.session_id=${source}.id AND (d.transmission_enc IS NOT NULL OR d.candidate_enc IS NOT NULL OR d.provider_response_id_enc IS NOT NULL))`,
    ].join(' AND ');
    const shells = this.ids(source, empty, 'deleted_at');
    await batch('deleted_session_metadata', [
      this.invalidate(source, shells),
      q(
        this.db,
        `UPDATE cost_reservations SET owner_id=NULL,dispatch_id=NULL WHERE dispatch_id IN (SELECT d.id FROM provider_dispatches d JOIN generation_requests r ON r.id=d.request_id WHERE r.session_id IN (SELECT id FROM reading_sessions WHERE rowid IN (${shells})))`,
      ),
      q(this.db, `DELETE FROM reading_sessions WHERE rowid IN (${shells})`),
    ]);
    return { scope: 'd1-retention' as const, mutations: counts };
  }
}
