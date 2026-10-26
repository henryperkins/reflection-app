import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeEach, expect, test, vi } from 'vitest';
import { SyntheticGenerationPrototype } from '../../src/worker/db/prototype.ts';
import {
  addContext,
  clearDatabase,
  seedDatabase,
  sql,
  OWNER,
  OTHER,
  SYNTHETIC,
} from '../fixtures/database.ts';
import type { WritingProvider } from '../../src/contracts/index.ts';

const writer: WritingProvider = {
  write: vi.fn(async () => ({
    kind: 'candidate' as const,
    candidate: { synthetic: true },
    providerResponseId: null,
    returnedModel: 'gpt-5.6-terra',
    inputTokens: 1,
    outputTokens: 1,
    durationMs: 1,
  })),
};
beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await clearDatabase(env.DB);
  vi.clearAllMocks();
});
const count = async (table: string) =>
  (await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
const quota = async () =>
  env.DB.prepare('SELECT sum(held) AS held,sum(consumed) AS consumed FROM quota_buckets').first();
async function prepared(context = false) {
  let plan = await seedDatabase(env.DB);
  if (context) plan = await addContext(env.DB, plan);
  const service = new SyntheticGenerationPrototype(env.DB, writer);
  const requestId = await service.start(plan);
  const lease = await service.claim(plan.ownerId, requestId);
  expect(lease).not.toBeNull();
  return { service, plan, requestId, lease: lease! };
}
async function validating(context = false) {
  const f = await prepared(context);
  await f.service.dispatch(f.lease, new TextEncoder().encode('only projected synthetic payload'));
  return f;
}

test('concurrent duplicate intents and keys reserve quota once and changed payload conflicts', async () => {
  const plan = await seedDatabase(env.DB),
    service = new SyntheticGenerationPrototype(env.DB, writer);
  const ids = await Promise.all(Array.from({ length: 8 }, () => service.start(plan)));
  expect(new Set(ids).size).toBe(1);
  expect(await count('generation_requests')).toBe(1);
  expect(await quota()).toEqual({ held: 2, consumed: 0 });
  await expect(service.start({ ...plan, payloadHmac: 'd'.repeat(64) })).rejects.toThrow('CONFLICT');
  expect(await count('idempotency_keys')).toBe(1);
});
test('CAS claims have one winner; unique dispatch and lost delivery publish once', async () => {
  const f = await prepared();
  expect(await f.service.claim(OWNER, f.requestId)).toBeNull();
  const payload = new TextEncoder().encode('only projected synthetic payload');
  await Promise.all([f.service.dispatch(f.lease, payload), f.service.dispatch(f.lease, payload)]);
  expect(writer.write).toHaveBeenCalledTimes(1);
  expect(vi.mocked(writer.write).mock.calls[0]![0].payload).toEqual(payload);
  const edition = await f.service.publish(f.lease);
  expect(await f.service.publish(f.lease)).toBe(edition);
  expect(await count('reading_editions')).toBe(1);
  expect(await count('provider_dispatches')).toBe(1);
  expect(await quota()).toEqual({ held: 0, consumed: 2 });
  await expect(f.service.publish({ ...f.lease, ownerId: OTHER })).rejects.toThrow();
});
const invalidations: [string, (f: Awaited<ReturnType<typeof validating>>) => Promise<unknown>][] = [
  [
    'stale epoch',
    (f) =>
      sql(
        env.DB,
        'UPDATE generation_requests SET run_epoch=run_epoch+1 WHERE id=?',
        f.requestId,
      ).run(),
  ],
  [
    'stale token',
    (f) =>
      sql(
        env.DB,
        "UPDATE generation_requests SET lease_token='new-token' WHERE id=?",
        f.requestId,
      ).run(),
  ],
  [
    'expired lease',
    (f) =>
      sql(
        env.DB,
        'UPDATE generation_requests SET lease_expires_at=1 WHERE id=?',
        f.requestId,
      ).run(),
  ],
  [
    'deadline equality',
    (f) =>
      sql(
        env.DB,
        "UPDATE generation_requests SET expires_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id=?",
        f.requestId,
      ).run(),
  ],
  [
    'permission revoked',
    async () => {
      await sql(
        env.DB,
        "INSERT INTO permission_revisions VALUES (?,2,0,'egress.v1',1)",
        OWNER,
      ).run();
      return sql(env.DB, 'UPDATE accounts SET permission_revision=2 WHERE id=?', OWNER).run();
    },
  ],
  [
    'key rotated',
    async () => {
      await sql(
        env.DB,
        "INSERT INTO account_keys VALUES (?,2,'synthetic',?,?,1)",
        OWNER,
        SYNTHETIC,
        SYNTHETIC,
      ).run();
      return sql(env.DB, 'UPDATE accounts SET key_version=2 WHERE id=?', OWNER).run();
    },
  ],
  [
    'content withdrawn',
    () => env.DB.prepare("UPDATE content_editions SET state='withdrawn'").run(),
  ],
  [
    'source withdrawn',
    () => env.DB.prepare("UPDATE reading_editions SET status='withdrawn',invalidated_at=1").run(),
  ],
  [
    'grant revoked',
    () => env.DB.prepare("UPDATE context_grants SET state='revoked',revision=revision+1").run(),
  ],
  ['missing snapshot', () => env.DB.prepare('DELETE FROM generation_context').run()],
  ['erased basis', () => env.DB.prepare('UPDATE basis_snapshots SET body_enc=NULL').run()],
  [
    'changed fragment',
    () => env.DB.prepare("UPDATE generation_context SET fragment_hmac='tampered'").run(),
  ],
  ['account frozen', () => env.DB.prepare("UPDATE accounts SET status='frozen'").run()],
];
for (const [name, invalidate] of invalidations)
  test(`publication rolls back edition, events and quota for ${name}`, async () => {
    const f = await validating(true);
    await invalidate(f);
    await expect(f.service.publish(f.lease)).rejects.toThrow();
    expect(await count('reading_editions')).toBe(1);
    expect(await quota()).toEqual({ held: 2, consumed: 0 });
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM quota_events WHERE event='consume'").first(),
    ).toEqual({ n: 0 });
    await f.service.terminalize(OWNER, f.requestId, 'blocked');
    await f.service.terminalize(OWNER, f.requestId, 'blocked');
    expect(await quota()).toEqual({ held: 0, consumed: 0 });
    expect(await count('assertion_probe')).toBe(0);
  });
test('revocation before dispatch prevents transmission and rolls back spend', async () => {
  const f = await prepared(true);
  await env.DB.prepare("UPDATE context_grants SET state='revoked'").run();
  await expect(f.service.dispatch(f.lease, new Uint8Array([1]))).rejects.toThrow();
  expect(writer.write).not.toHaveBeenCalled();
  expect(await count('provider_dispatches')).toBe(0);
  expect(await count('cost_reservations')).toBe(0);
});
test('cross-owner links cannot reserve or persist a request', async () => {
  const plan = await seedDatabase(env.DB),
    service = new SyntheticGenerationPrototype(env.DB, writer);
  await expect(service.start({ ...plan, ownerId: OTHER })).rejects.toThrow();
  expect(await count('generation_requests')).toBe(0);
});
test('uncertain provider result never retries and releases product quota while retaining spend', async () => {
  const f = await prepared();
  const uncertain: WritingProvider = {
    write: vi.fn(async () => ({ kind: 'uncertain' as const, reason: 'lost_response' as const })),
  };
  const service = new SyntheticGenerationPrototype(env.DB, uncertain);
  await service.dispatch(f.lease, new Uint8Array([1]));
  await service.dispatch(f.lease, new Uint8Array([1]));
  expect(uncertain.write).toHaveBeenCalledTimes(1);
  expect(await quota()).toEqual({ held: 0, consumed: 0 });
  expect(
    await env.DB.prepare('SELECT sum(committed_microusd) AS n FROM spend_buckets').first(),
  ).toEqual({ n: 80000 });
});

test('simultaneous publication callers receive the same edition', async () => {
  const f = await validating();
  const ids = await Promise.all([f.service.publish(f.lease), f.service.publish(f.lease)]);
  expect(new Set(ids).size).toBe(1);
  expect(await count('reading_editions')).toBe(1);
  expect(await quota()).toEqual({ held: 0, consumed: 2 });
});
test('a second idempotency key joining an intent remains bound to its original payload', async () => {
  const plan = await seedDatabase(env.DB),
    service = new SyntheticGenerationPrototype(env.DB, writer),
    id = await service.start(plan);
  const alias = crypto.randomUUID();
  expect(await service.start({ ...plan, idempotencyKey: alias })).toBe(id);
  await expect(
    service.start({
      ...plan,
      idempotencyKey: alias,
      clientIntentId: crypto.randomUUID(),
      payloadHmac: 'e'.repeat(64),
    }),
  ).rejects.toThrow('CONFLICT');
  expect(await count('generation_requests')).toBe(1);
});
test('known provider usage settles cost separately from product quota', async () => {
  const f = await validating();
  expect(
    await env.DB.prepare('SELECT state,actual_microusd FROM cost_reservations').first(),
  ).toEqual({ state: 'actual', actual_microusd: 14 });
  expect(
    await env.DB.prepare('SELECT sum(committed_microusd) AS n FROM spend_buckets').first(),
  ).toEqual({ n: 28 });
  await f.service.terminalize(OWNER, f.requestId, 'cancelled');
  expect(await quota()).toEqual({ held: 0, consumed: 0 });
  expect(
    await env.DB.prepare('SELECT sum(committed_microusd) AS n FROM spend_buckets').first(),
  ).toEqual({ n: 28 });
});

test('an injected mid-publication statement failure rolls the entire actual D1 batch back', async () => {
  const f = await validating();
  const beforeEvents = await count('request_events');
  const beforeStorage = await sql(
    env.DB,
    'SELECT storage_bytes FROM accounts WHERE id=?',
    OWNER,
  ).first();
  const failingDb = {
    prepare: env.DB.prepare.bind(env.DB),
    batch: (statements: D1PreparedStatement[]) =>
      env.DB.batch([
        ...statements.slice(0, 4),
        env.DB.prepare('INSERT INTO assertion_probe VALUES (0)'),
        ...statements.slice(4),
      ]),
  } as unknown as D1Database;
  await expect(
    new SyntheticGenerationPrototype(failingDb, writer).publish(f.lease),
  ).rejects.toThrow();
  expect(await count('reading_editions')).toBe(0);
  expect(await count('request_events')).toBe(beforeEvents);
  expect(await quota()).toEqual({ held: 2, consumed: 0 });
  expect(await sql(env.DB, 'SELECT storage_bytes FROM accounts WHERE id=?', OWNER).first()).toEqual(
    beforeStorage,
  );
  expect(await f.service.publish(f.lease)).toBeTypeOf('string');
});
test('publication delayed past its deadline rejects using the database execution clock', async () => {
  const f = await validating();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    ready = new Promise<void>((r) => {
      entered = r;
    });
  const service = new SyntheticGenerationPrototype(env.DB, writer, {
    beforePublication: async () => {
      entered();
      await gate;
    },
  });
  const pending = service.publish(f.lease);
  const rejection = expect(pending).rejects.toThrow();
  await ready;
  await sql(
    env.DB,
    "UPDATE generation_requests SET expires_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id=?",
    f.requestId,
  ).run();
  release();
  await rejection;
  expect(await count('reading_editions')).toBe(0);
  expect(await quota()).toEqual({ held: 2, consumed: 0 });
  await service.terminalize(OWNER, f.requestId, 'expired');
  expect(await quota()).toEqual({ held: 0, consumed: 0 });
});
test('revocation between dispatch authorization and publication prevents an edition', async () => {
  const f = await prepared(true);
  const service = new SyntheticGenerationPrototype(env.DB, writer, {
    beforeReceipt: async () => {
      await env.DB.prepare("UPDATE context_grants SET state='revoked'").run();
    },
  });
  await service.dispatch(f.lease, new Uint8Array([1]));
  await expect(service.publish(f.lease)).rejects.toThrow();
  expect(writer.write).toHaveBeenCalledTimes(1);
  expect(await count('reading_editions')).toBe(1);
  await service.terminalize(OWNER, f.requestId, 'blocked');
  expect(await quota()).toEqual({ held: 0, consumed: 0 });
});
test('cancellation before a late receipt cannot restore candidate material', async () => {
  const f = await prepared();
  const service = new SyntheticGenerationPrototype(env.DB, writer, {
    beforeReceipt: () => f.service.terminalize(OWNER, f.requestId, 'cancelled'),
  });
  await expect(service.dispatch(f.lease, new Uint8Array([1]))).rejects.toThrow();
  expect(
    await env.DB.prepare(
      'SELECT state,candidate_enc,transmission_enc FROM provider_dispatches',
    ).first(),
  ).toEqual({ state: 'unknown', candidate_enc: null, transmission_enc: null });
  expect(await quota()).toEqual({ held: 0, consumed: 0 });
  expect(await count('reading_editions')).toBe(0);
  expect(
    await env.DB.prepare('SELECT state,actual_microusd FROM cost_reservations').first(),
  ).toEqual({ state: 'actual', actual_microusd: 14 });
});
for (const kind of ['parent status', 'parent content', 'selected native content'] as const)
  test(`guard blocks ${kind} withdrawal even when the request uses newer content`, async () => {
    const first = await validating();
    const parent = await first.service.publish(first.lease),
      newContent = 'd'.repeat(64);
    await sql(
      env.DB,
      `INSERT INTO content_editions(hash,state,bundle_json,reviewed_hash,reviewer_kind,reviewer_id,rights_status,created_at,approved_at) VALUES (?,'approved','{}',?,'human_approved','synthetic','cleared',1,1)`,
      newContent,
      newContent,
    ).run();
    let plan = {
      ...first.plan,
      contentHash: newContent,
      clientIntentId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      ...(kind === 'selected native content' ? {} : { parentEditionId: parent }),
    };
    if (kind === 'selected native content') {
      const grant = crypto.randomUUID();
      await sql(
        env.DB,
        `INSERT INTO context_grants(id,owner_id,edition_id,state,created_at,updated_at) VALUES (?,?,?,'allowed',1,1)`,
        grant,
        OWNER,
        parent,
      ).run();
      plan = {
        ...plan,
        context: [{ grantId: grant, grantRevision: 1, fragmentHmac: first.plan.planHmac }],
      };
    }
    const requestId = await first.service.start(plan),
      lease = (await first.service.claim(OWNER, requestId))!;
    await first.service.dispatch(lease, new Uint8Array([1]));
    if (kind === 'parent status')
      await sql(
        env.DB,
        "UPDATE reading_editions SET status='withdrawn',invalidated_at=1 WHERE id=?",
        parent,
      ).run();
    else
      await sql(
        env.DB,
        "UPDATE content_editions SET state='withdrawn' WHERE hash=?",
        first.plan.contentHash,
      ).run();
    await expect(first.service.publish(lease)).rejects.toThrow();
    expect(await count('reading_editions')).toBe(1);
    await first.service.terminalize(OWNER, requestId, 'blocked');
    expect(await quota()).toEqual({ held: 0, consumed: 2 });
  });
test('an expired pre-dispatch lease can be reclaimed and fences the old driver', async () => {
  const f = await prepared();
  await sql(
    env.DB,
    'UPDATE generation_requests SET lease_expires_at=1 WHERE id=?',
    f.requestId,
  ).run();
  const current = (await f.service.claim(OWNER, f.requestId))!;
  expect(current.runEpoch).toBe(f.lease.runEpoch + 1);
  await expect(f.service.dispatch(f.lease, new Uint8Array([1]))).rejects.toThrow();
  await f.service.dispatch(current, new Uint8Array([2]));
  expect(writer.write).toHaveBeenCalledTimes(1);
  expect(await count('generation_attempts')).toBe(2);
  expect(await count('provider_dispatches')).toBe(1);
});

test('dispatch refuses less than 21 seconds of remaining request budget', async () => {
  const f = await prepared();
  await sql(
    env.DB,
    "UPDATE generation_requests SET expires_at=CAST(unixepoch('subsec')*1000 AS INTEGER)+20000 WHERE id=?",
    f.requestId,
  ).run();
  await expect(f.service.dispatch(f.lease, new Uint8Array([1]))).rejects.toThrow();
  expect(writer.write).not.toHaveBeenCalled();
  expect(await count('provider_dispatches')).toBe(0);
});
test('quota admission at the daily limit rolls all fourth-request writes back', async () => {
  const plan = await seedDatabase(env.DB),
    service = new SyntheticGenerationPrototype(env.DB, writer);
  for (let i = 0; i < 3; i++) {
    const id = await service.start({
      ...plan,
      clientIntentId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
    });
    const lease = (await service.claim(OWNER, id))!;
    await service.dispatch(lease, new Uint8Array([1]));
    await service.publish(lease);
  }
  await expect(service.start(plan)).rejects.toThrow();
  expect(await count('generation_requests')).toBe(3);
  expect(await quota()).toEqual({ held: 0, consumed: 6 });
});
test('dispatch mode off prevents authorization and leaves no spend hold', async () => {
  const f = await prepared();
  await env.DB.prepare("UPDATE system_state SET dispatch_mode='off'").run();
  await expect(f.service.dispatch(f.lease, new Uint8Array([1]))).rejects.toThrow();
  expect(writer.write).not.toHaveBeenCalled();
  expect(await count('spend_buckets')).toBe(0);
  expect(await count('cost_reservations')).toBe(0);
});
test('cross-owner context snapshots are rejected by the composite foreign keys', async () => {
  const f = await prepared(true);
  await expect(
    sql(
      env.DB,
      'UPDATE generation_context SET owner_id=? WHERE request_id=?',
      OTHER,
      f.requestId,
    ).run(),
  ).rejects.toThrow();
  expect(
    await sql(
      env.DB,
      'SELECT owner_id FROM generation_context WHERE request_id=?',
      f.requestId,
    ).first(),
  ).toEqual({ owner_id: OWNER });
});

test('admission deadlines and financial ceilings preserve the documented policy', async () => {
  const f = await prepared();
  expect(
    await env.DB.prepare('SELECT expires_at-created_at AS ttl FROM generation_requests').first(),
  ).toEqual({ ttl: 180000 });
  expect(
    await env.DB.prepare('SELECT expires_at-created_at AS ttl FROM idempotency_keys').first(),
  ).toEqual({ ttl: 604800000 });
  await f.service.dispatch(f.lease, new Uint8Array([1]));
  expect(
    (
      await env.DB.prepare(
        'SELECT ceiling_microusd FROM spend_buckets ORDER BY ceiling_microusd',
      ).all()
    ).results,
  ).toEqual([{ ceiling_microusd: 10000000 }, { ceiling_microusd: 100000000 }]);
});
test('at most two active requests per account are admitted under concurrency', async () => {
  const plan = await seedDatabase(env.DB),
    service = new SyntheticGenerationPrototype(env.DB, writer);
  const results = await Promise.allSettled(
    Array.from({ length: 3 }, () =>
      service.start({
        ...plan,
        clientIntentId: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
      }),
    ),
  );
  expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(2);
  expect(await count('generation_requests')).toBe(2);
  expect(await quota()).toEqual({ held: 4, consumed: 0 });
});
test('provider usage exceeding reservation increases aggregate liability and disables generation', async () => {
  const f = await prepared();
  const expensive: WritingProvider = {
    write: async () => ({
      kind: 'candidate',
      candidate: { synthetic: true },
      providerResponseId: null,
      returnedModel: 'gpt-5.6-terra',
      inputTokens: 0,
      outputTokens: 4000,
      durationMs: 1,
    }),
  };
  await new SyntheticGenerationPrototype(env.DB, expensive).dispatch(f.lease, new Uint8Array([1]));
  expect(await env.DB.prepare('SELECT actual_microusd FROM cost_reservations').first()).toEqual({
    actual_microusd: 48000,
  });
  expect(
    await env.DB.prepare('SELECT sum(committed_microusd) AS total FROM spend_buckets').first(),
  ).toEqual({ total: 96000 });
  expect(await env.DB.prepare('SELECT generation_enabled FROM system_state').first()).toEqual({
    generation_enabled: 0,
  });
});

test('a trusted fixture request ID binds publication and cannot be reused by a different intent', async () => {
  const plan = { ...(await seedDatabase(env.DB)), requestId: crypto.randomUUID() };
  const service = new SyntheticGenerationPrototype(env.DB, writer);
  expect(await service.start(plan)).toBe(plan.requestId);
  expect(await service.start(plan)).toBe(plan.requestId);
  await expect(
    service.start({
      ...plan,
      clientIntentId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      payloadHmac: 'f'.repeat(64),
    }),
  ).rejects.toThrow();
  expect(await count('generation_requests')).toBe(1);
  expect(await quota()).toEqual({ held: 2, consumed: 0 });
  const lease = (await service.claim(OWNER, plan.requestId))!;
  await service.dispatch(lease, new Uint8Array([1]));
  const edition = await service.publish(lease);
  expect(
    await sql(env.DB, 'SELECT request_id FROM reading_editions WHERE id=?', edition).first(),
  ).toEqual({ request_id: plan.requestId });
});

test('dispatch mode off denies new admission and rolls back request and quota writes', async () => {
  const plan = await seedDatabase(env.DB);
  await env.DB.prepare("UPDATE system_state SET dispatch_mode='off'").run();
  const service = new SyntheticGenerationPrototype(env.DB, writer);
  await expect(service.start(plan)).rejects.toThrow();
  for (const table of [
    'generation_requests',
    'quota_reservations',
    'quota_buckets',
    'quota_events',
    'request_events',
    'idempotency_keys',
  ]) {
    expect(await count(table)).toBe(0);
  }
  expect(writer.write).not.toHaveBeenCalled();
});

test('outage template mode still admits work but cannot authorize a model dispatch', async () => {
  const plan = await seedDatabase(env.DB);
  await env.DB.prepare("UPDATE system_state SET dispatch_mode='outage_template'").run();
  const service = new SyntheticGenerationPrototype(env.DB, writer);
  const requestId = await service.start(plan);
  const lease = (await service.claim(OWNER, requestId))!;
  await expect(service.dispatch(lease, new Uint8Array([1]))).rejects.toThrow();
  expect(await count('generation_requests')).toBe(1);
  expect(await count('provider_dispatches')).toBe(0);
  expect(writer.write).not.toHaveBeenCalled();
});

for (const deadlineColumn of ['lease_expires_at', 'expires_at'] as const) {
  test(`clock-only passage across ${deadlineColumn} after eligibility sampling rolls publication back`, async () => {
    const f = await validating();
    await sql(
      env.DB,
      `UPDATE generation_requests SET ${deadlineColumn}=CAST(unixepoch('subsec')*1000 AS INTEGER)+500 WHERE id=?`,
      f.requestId,
    ).run();
    const beforeEvents = await count('request_events');
    const beforeAccount = await sql(
      env.DB,
      'SELECT data_revision,storage_bytes FROM accounts WHERE id=?',
      OWNER,
    ).first();
    type ClockSample = { now: number; deadline: number };
    let eligibleSample: ClockSample | null = null;
    let expiredSample: ClockSample | null = null;
    const sample = () =>
      sql(
        env.DB,
        `SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) AS now,${deadlineColumn} AS deadline FROM generation_requests WHERE id=?`,
        f.requestId,
      ).first<ClockSample>();
    const service = new SyntheticGenerationPrototype(env.DB, writer, {
      beforePublication: async () => {
        eligibleSample = await sample();
        expect(eligibleSample).not.toBeNull();
        expect(eligibleSample!.now).toBeLessThan(eligibleSample!.deadline);
        // No row mutations or fake timers: only wall-clock time crosses the deadline.
        await new Promise<void>((resolve) =>
          setTimeout(resolve, eligibleSample!.deadline - eligibleSample!.now + 30),
        );
        expiredSample = await sample();
        expect(expiredSample!.now).toBeGreaterThanOrEqual(expiredSample!.deadline);
        expect(expiredSample!.deadline).toBe(eligibleSample!.deadline);
      },
    });
    // Match the SQL assertion failure so a failed sampling assertion cannot pass this test.
    await expect(service.publish(f.lease)).rejects.toThrow(/CHECK constraint failed/);
    expect(eligibleSample).not.toBeNull();
    expect(expiredSample).not.toBeNull();
    expect(await count('reading_editions')).toBe(0);
    expect(await count('request_events')).toBe(beforeEvents);
    expect(await quota()).toEqual({ held: 2, consumed: 0 });
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM quota_events WHERE event='consume'").first(),
    ).toEqual({ n: 0 });
    expect(
      await sql(
        env.DB,
        'SELECT data_revision,storage_bytes FROM accounts WHERE id=?',
        OWNER,
      ).first(),
    ).toEqual(beforeAccount);
    expect(
      await sql(env.DB, 'SELECT state FROM generation_requests WHERE id=?', f.requestId).first(),
    ).toEqual({ state: 'validating' });
    await service.terminalize(OWNER, f.requestId, 'cancelled');
    expect(await quota()).toEqual({ held: 0, consumed: 0 });
  });
}
