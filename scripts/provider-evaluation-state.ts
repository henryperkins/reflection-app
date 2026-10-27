import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import {
  Hash,
  ModelCandidate,
  ProviderReceipt,
  type WriterOutcome,
} from '../src/contracts/index.ts';
import { canonicalJson } from '../src/domain/json.ts';
import { priceReceipt } from '../src/domain/provider-cost.ts';
import { digest, type PreparedEvaluation } from './provider-evaluation-corpus.ts';
export { digest } from './provider-evaluation-corpus.ts';

export const EvaluationPermit = z.strictObject({
  version: z.literal('reflection-evaluation-permit.v1'),
  scope: z.literal('evaluation'),
  purpose: z.enum([
    'transport-smoke',
    'synthetic-research',
    'human-review',
    'human-review-fast-xhigh',
    'source-diagnostic-fast-xhigh',
  ]),
  runId: z.uuid(),
  authorizedBy: z.string().trim().min(1).max(200),
  authorizedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  projectId: z.string().regex(/^proj_[A-Za-z0-9_-]+$/),
  credentialHash: Hash,
  encryptionKeyHash: Hash,
  model: z.literal('gpt-6.1-terra'),
  policyHash: Hash,
  contentHash: Hash,
  corpusHash: Hash,
  manifestHash: Hash,
  maxCalls: z.number().int().min(1).max(720),
  maxConcurrency: z.number().int().min(1).max(2),
  maxCostMicrousd: z.number().int().min(1).max(40000000),
  outputDirectory: z.string().min(1),
  sourceBundlePath: z.string().min(1).optional(),
});
export type EvaluationPermit = z.infer<typeof EvaluationPermit>;
export type EvaluationSummary = {
  version: 'reflection-evaluation-summary.v1';
  runId: string;
  manifestHash: string;
  attempts: number;
  recordedOutcomes: number;
  receipts: number;
  unknown: number;
  chargedMicrousd: number;
  accepted: number;
  refused: number;
  invalid: number;
  rejected: number;
  status: 'ready' | 'complete' | 'budget-exhausted' | 'halted';
  qualificationEligible: false;
};
type Artifact = { path: string; sha256: string; expiresAt: string; kind: string };
type Event = { seq: number; kind: string; data: string; previous: string; mac: string };
type Reservation = {
  attemptId: string;
  payloadHash: string;
  artifact: Artifact;
  reservedMicrousd: number;
};
type Receipt = {
  attemptId: string;
  outcomeHash: string;
  actualMicrousd: number | null;
  kind: WriterOutcome['kind'];
  assessment: string;
  halt: boolean;
  artifact: Artifact;
  rawArtifact: Artifact | null;
};
const inside = (path: string, root: string) => path === root || path.startsWith(root + sep);

/** Reject symlinks in every existing ancestor, including paths outside the checkout. */
export function protectedPath(path: string): string {
  if (!isAbsolute(path)) throw new Error('Absolute protected path required');
  const result = resolve(path);
  for (let cursor = result; ; cursor = dirname(cursor)) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink())
      throw new Error('Protected path is a symlink');
    if (cursor === dirname(cursor)) break;
  }
  return result;
}
function directory(path: string, checkoutRoot: string) {
  const target = protectedPath(path),
    root = realpathSync(checkoutRoot);
  if (inside(target, root)) throw new Error('Evaluation data must remain outside checkout');
  mkdirSync(target, { recursive: true, mode: 0o700 });
  if (inside(realpathSync(target), root)) throw new Error('Evaluation path aliases checkout');
  if ((lstatSync(target).mode & 0o077) !== 0)
    throw new Error('Evaluation directory must be private');
  return target;
}
function durableFile(path: string, bytes: string) {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const parent = openSync(dirname(path), 'r');
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}
export function validatePermit(
  value: unknown,
  prepared: PreparedEvaluation,
  now = Date.now(),
): EvaluationPermit {
  const p = EvaluationPermit.parse(value),
    m = prepared.manifest;
  if (
    !Number.isSafeInteger(now) ||
    Date.parse(p.authorizedAt) > now ||
    Date.parse(p.expiresAt) <= now ||
    Date.parse(p.expiresAt) <= Date.parse(p.authorizedAt) ||
    now >= Date.parse(p.authorizedAt) + 90 * 86400000 ||
    p.manifestHash !== prepared.manifestHash ||
    digest(canonicalJson(m)) !== p.manifestHash ||
    digest(
      canonicalJson({ policy: prepared.policy, outputSchema: z.toJSONSchema(ModelCandidate) }),
    ) !== p.policyHash ||
    p.policyHash !== m.policyHash ||
    p.model !== m.model ||
    p.model !== prepared.policy.model ||
    m.reservationMicrousd !== prepared.policy.reservationMicrousd ||
    p.contentHash !== m.contentHash ||
    p.corpusHash !== m.corpusHash ||
    (p.purpose === 'source-diagnostic-fast-xhigh'
      ? !p.sourceBundlePath || !m.sourceDiagnostic || p.maxCalls > 12 || p.maxCostMicrousd > 1440000
      : p.sourceBundlePath !== undefined || m.sourceDiagnostic !== undefined) ||
    m.profile !==
      (p.purpose === 'transport-smoke'
        ? 'smoke'
        : p.purpose === 'synthetic-research'
          ? 'baseline'
          : p.purpose)
  )
    throw new Error('Evaluation permit rejected');
  return p;
}

/** Append-only SQLite ledger. FULL synchronous commits precede every external attempt. */
export class EvaluationJournal {
  readonly permit: EvaluationPermit;
  readonly prepared: PreparedEvaluation;
  private readonly db: DatabaseSync;
  private readonly key: Uint8Array;
  private readonly output: string;
  private readonly state: string;
  private lock: DatabaseSync | null = null;
  private closed = false;
  constructor(
    value: EvaluationPermit,
    options: {
      stateDirectory: string;
      checkoutRoot: string;
      key: Uint8Array;
      prepared: PreparedEvaluation;
    },
    resume = false,
  ) {
    this.permit = Object.freeze(validatePermit(value, options.prepared));
    this.prepared = options.prepared;
    this.key = new Uint8Array(options.key);
    if (this.key.length !== 32 || digest(this.key) !== this.permit.encryptionKeyHash)
      throw new Error('Evaluation encryption key mismatch');
    this.state = directory(options.stateDirectory, options.checkoutRoot);
    const outputRoot = directory(this.permit.outputDirectory, options.checkoutRoot);
    this.output = join(outputRoot, this.permit.runId);
    const dbPath = protectedPath(join(this.state, 'journal.sqlite'));
    this.db = new DatabaseSync(dbPath);
    chmodSync(dbPath, 0o600);
    try {
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;
        CREATE TABLE IF NOT EXISTS runs(run_id TEXT PRIMARY KEY,permit_hash TEXT NOT NULL,output_directory TEXT NOT NULL,expires_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events(run_id TEXT NOT NULL,seq INTEGER NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL,previous TEXT NOT NULL,mac TEXT NOT NULL,PRIMARY KEY(run_id,seq),FOREIGN KEY(run_id) REFERENCES runs(run_id));
        CREATE TRIGGER IF NOT EXISTS immutable_event_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'append only'); END;
        CREATE TRIGGER IF NOT EXISTS immutable_event_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'append only'); END;
        CREATE TRIGGER IF NOT EXISTS immutable_run_update BEFORE UPDATE ON runs BEGIN SELECT RAISE(ABORT,'append only'); END;
        CREATE TRIGGER IF NOT EXISTS immutable_run_delete BEFORE DELETE ON runs BEGIN SELECT RAISE(ABORT,'append only'); END;`);
      const prior = this.db
        .prepare('SELECT permit_hash FROM runs WHERE run_id=?')
        .get(this.permit.runId);
      const permitHash = digest(canonicalJson(this.permit));
      if (resume) {
        if (!prior || prior.permit_hash !== permitHash) throw new Error('Resume identity mismatch');
        protectedPath(this.output);
        if (!existsSync(this.output)) throw new Error('Evaluation archive is missing');
        this.verifyArtifacts();
      } else {
        if (prior || existsSync(this.output)) throw new Error('Evaluation run ID already used');
        this.db
          .prepare('INSERT INTO runs VALUES(?,?,?,?)')
          .run(this.permit.runId, permitHash, this.output, this.expiry());
        mkdirSync(this.output, { mode: 0o700 });
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private expiry() {
    return new Date(Date.parse(this.permit.authorizedAt) + 90 * 86400000).toISOString();
  }
  private mac(seq: number, kind: string, data: string, previous: string) {
    return createHmac('sha256', this.key)
      .update(
        canonicalJson([this.permit.runId, this.permit.manifestHash, seq, kind, data, previous]),
      )
      .digest('hex');
  }
  private events(): Event[] {
    const rows = this.db
      .prepare('SELECT seq,kind,data,previous,mac FROM events WHERE run_id=? ORDER BY seq')
      .all(this.permit.runId) as Event[];
    let previous = '';
    for (const [i, row] of rows.entries()) {
      if (
        row.seq !== i + 1 ||
        row.previous !== previous ||
        row.mac !== this.mac(row.seq, row.kind, row.data, previous)
      )
        throw new Error('Evaluation journal integrity failure');
      previous = row.mac;
    }
    return rows;
  }
  private append(kind: string, data: unknown) {
    const rows = this.events(),
      seq = rows.length + 1,
      previous = rows.at(-1)?.mac ?? '',
      serialized = canonicalJson(data);
    this.db
      .prepare('INSERT INTO events VALUES(?,?,?,?,?,?)')
      .run(
        this.permit.runId,
        seq,
        kind,
        serialized,
        previous,
        this.mac(seq, kind, serialized, previous),
      );
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private archive(kind: string, attemptId: string, value: unknown): Artifact {
    const path = join(this.output, `${attemptId}.${kind}.${randomBytes(8).toString('hex')}.enc`);
    const expiresAt = this.expiry(),
      iv = randomBytes(12);
    const aad = canonicalJson({
      runId: this.permit.runId,
      manifestHash: this.permit.manifestHash,
      kind,
      attemptId,
      expiresAt,
    });
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const data = Buffer.concat([cipher.update(canonicalJson(value), 'utf8'), cipher.final()]);
    const bytes = JSON.stringify({
      version: 1,
      aad,
      iv: iv.toString('base64'),
      data: data.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    });
    durableFile(path, bytes);
    return { path, sha256: digest(bytes), expiresAt, kind };
  }
  acquire() {
    if (this.lock) throw new Error('Evaluation already executing');
    const path = protectedPath(join(this.state, `${this.permit.runId}.lock.sqlite`));
    const db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    try {
      db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
      this.lock = db;
    } catch {
      db.close();
      throw new Error('Evaluation already executing');
    }
  }
  release() {
    if (this.lock) {
      this.lock.exec('ROLLBACK');
      this.lock.close();
      this.lock = null;
    }
  }
  resume() {
    if (!this.lock) throw new Error('Resume requires an execution lock');
    this.verifyArtifacts();
    return this.transaction(() => {
      const rows = this.events();
      const finished = new Set(
        rows
          .filter((r) => r.kind === 'receipt' || r.kind === 'abandoned')
          .map((r) => (JSON.parse(r.data) as { attemptId: string }).attemptId),
      );
      for (const row of rows.filter((r) => r.kind === 'reserved')) {
        const r = JSON.parse(row.data) as Reservation;
        if (!finished.has(r.attemptId)) this.append('abandoned', { attemptId: r.attemptId });
      }
      return this.summary();
    });
  }
  reserve(attemptId: string): Reservation | null {
    validatePermit(this.permit, this.prepared);
    const policy = this.prepared.policy;
    const request = this.prepared.requests.find((r) => r.id === attemptId);
    const scheduled = this.prepared.manifest.schedule.find((r) => r.id === attemptId);
    if (
      !request ||
      !scheduled ||
      scheduled.admission !== null ||
      scheduled.payloadHash !== request.payloadHash ||
      digest(request.input.payload) !== request.payloadHash
    )
      throw new Error('Unscheduled evaluation request');
    return this.transaction(() => {
      const state = this.summary();
      if (
        state.status === 'halted' ||
        this.events().some(
          (e) =>
            e.kind === 'reserved' && (JSON.parse(e.data) as Reservation).attemptId === attemptId,
        )
      )
        return null;
      if (
        state.attempts >= this.permit.maxCalls ||
        state.chargedMicrousd + policy.reservationMicrousd > this.permit.maxCostMicrousd
      )
        return null;
      const reservation = {
        attemptId,
        payloadHash: request.payloadHash,
        reservedMicrousd: policy.reservationMicrousd,
        artifact: this.archive('request', attemptId, {
          encoding: 'base64',
          bytes: Buffer.from(request.input.payload).toString('base64'),
        }),
      };
      this.append('reserved', reservation);
      return reservation;
    });
  }
  recordReceipt(
    attemptId: string,
    outcome: WriterOutcome,
    assessment = outcome.kind as string,
    raw: unknown = null,
  ) {
    const policy = this.prepared.policy;
    return this.transaction(() => {
      const rows = this.events();
      if (
        !rows.some(
          (r) =>
            r.kind === 'reserved' && (JSON.parse(r.data) as Reservation).attemptId === attemptId,
        )
      )
        throw new Error('Receipt without reservation');
      const outcomeHash = digest(canonicalJson(outcome));
      const prior = rows
        .filter((r) => r.kind === 'receipt')
        .map((r) => JSON.parse(r.data) as Receipt)
        .find((r) => r.attemptId === attemptId);
      if (prior) {
        if (prior.outcomeHash !== outcomeHash) throw new Error('Conflicting evaluation receipt');
        return;
      }
      const parsed = ProviderReceipt.safeParse(outcome.receipt);
      const price = parsed.success ? priceReceipt(parsed.data, policy) : null;
      const request = this.prepared.requests.find((r) => r.id === attemptId)!;
      const halt =
        (outcome.kind === 'uncertain' && outcome.haltGeneration === true) ||
        (outcome.receipt !== null && !price) ||
        (parsed.success &&
          (parsed.data.usage.inputTokens > request.estimatedInputTokens ||
            parsed.data.usage.outputTokens > policy.request.max_output_tokens)) ||
        (price !== null && price.actualMicrousd > policy.reservationMicrousd) ||
        (outcome.kind === 'rejected' && [400, 401, 403].includes(outcome.status));
      this.append('receipt', {
        attemptId,
        outcomeHash,
        actualMicrousd: price?.actualMicrousd ?? null,
        kind: outcome.kind,
        assessment,
        halt,
        artifact: this.archive('outcome', attemptId, outcome),
        rawArtifact: raw === null ? null : this.archive('response', attemptId, raw),
      } satisfies Receipt);
    });
  }
  summary(): EvaluationSummary {
    const policy = this.prepared.policy;
    const events = this.events(),
      reservations = events
        .filter((e) => e.kind === 'reserved')
        .map((e) => JSON.parse(e.data) as Reservation);
    const receipts = events
      .filter((e) => e.kind === 'receipt')
      .map((e) => JSON.parse(e.data) as Receipt);
    const chargedMicrousd = reservations.reduce(
      (sum, r) =>
        sum +
        (receipts.find((p) => p.attemptId === r.attemptId)?.actualMicrousd ?? r.reservedMicrousd),
      0,
    );
    const halted = receipts.some((r) => r.halt);
    const complete = reservations.length === this.prepared.requests.length;
    return {
      version: 'reflection-evaluation-summary.v1',
      runId: this.permit.runId,
      manifestHash: this.permit.manifestHash,
      attempts: reservations.length,
      recordedOutcomes: receipts.length,
      receipts: receipts.filter((r) => r.actualMicrousd !== null).length,
      unknown: reservations.filter(
        (r) => receipts.find((p) => p.attemptId === r.attemptId)?.actualMicrousd == null,
      ).length,
      chargedMicrousd,
      accepted: receipts.filter((r) => r.assessment === 'accepted').length,
      refused: receipts.filter((r) => r.kind === 'refusal').length,
      invalid: receipts.filter(
        (r) => r.kind === 'invalid' || r.assessment === 'validation-rejected',
      ).length,
      rejected: receipts.filter((r) => r.kind === 'rejected').length,
      status: halted
        ? 'halted'
        : complete
          ? 'complete'
          : reservations.length >= this.permit.maxCalls ||
              chargedMicrousd + policy.reservationMicrousd > this.permit.maxCostMicrousd
            ? 'budget-exhausted'
            : 'ready',
      qualificationEligible: false,
    };
  }
  artifacts(): Artifact[] {
    return this.events().flatMap((e) => {
      if (e.kind === 'reserved') return [(JSON.parse(e.data) as Reservation).artifact];
      if (e.kind === 'receipt') {
        const r = JSON.parse(e.data) as Receipt;
        return r.rawArtifact ? [r.artifact, r.rawArtifact] : [r.artifact];
      }
      return [];
    });
  }
  verifyArtifacts() {
    if (Date.now() >= Date.parse(this.expiry())) throw new Error('Evaluation retention expired');
    for (const artifact of this.artifacts()) {
      if (
        !inside(protectedPath(artifact.path), this.output) ||
        artifact.expiresAt !== this.expiry()
      )
        throw new Error('Evaluation artifact location changed');
      const bytes = readFileSync(artifact.path);
      if (digest(bytes) !== artifact.sha256)
        throw new Error('Evaluation artifact integrity failure');
      const value = JSON.parse(bytes.toString('utf8')) as {
        iv: string;
        aad: string;
        tag: string;
        data: string;
      };
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(value.iv, 'base64'));
      decipher.setAAD(Buffer.from(value.aad));
      decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
      decipher.update(Buffer.from(value.data, 'base64'));
      decipher.final();
    }
    return true;
  }
  close() {
    if (!this.closed) {
      this.release();
      this.db.close();
      this.closed = true;
    }
  }
}

/** TTL deletion keeps the content-free run tombstone, preventing run-ID reuse. */
export function purgeExpiredEvaluationArchives(stateDirectory: string, now = Date.now()): number {
  const file = protectedPath(join(stateDirectory, 'journal.sqlite'));
  if (!existsSync(file)) return 0;
  const db = new DatabaseSync(file);
  let removed = 0;
  try {
    for (const row of db.prepare('SELECT run_id,output_directory,expires_at FROM runs').all()) {
      if (Date.parse(String(row.expires_at)) > now) continue;
      const path = protectedPath(String(row.output_directory));
      if (path.split(sep).at(-1) !== row.run_id) throw new Error('Invalid evaluation archive');
      if (existsSync(path)) {
        rmSync(path, { recursive: true });
        removed++;
      }
    }
  } finally {
    db.close();
  }
  return removed;
}
