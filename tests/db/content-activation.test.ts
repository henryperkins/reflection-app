import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, test } from 'vitest';
import draft from '../../content/launch-canon-draft.json';
import { activateContent, withdrawContent } from '../../src/worker/content/activation.ts';
import { D1ContentRepository } from '../../src/worker/content/repository.ts';
import { authenticateContentApproval } from '../../src/worker/content/approval.ts';
import { bundleHash, sourceHash } from '../../src/domain/tarot/plan.ts';
import { editorialBundle, signedApproval } from '../fixtures/content-approval.ts';
import { clearDatabase, seedDatabase, OWNER } from '../fixtures/database.ts';
import { SyntheticGenerationPrototype } from '../../src/worker/db/prototype.ts';
import { canonicalJson, sha256Json } from '../../src/domain/json.ts';
beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(() => clearDatabase(env.DB));

test('signed exact approval activates atomically with generation off and idempotent acknowledgment', async () => {
  await seedDatabase(env.DB);
  const b = await editorialBundle(),
    a = await signedApproval(b),
    approved = await a.authenticate();
  expect(await activateContent(env.DB, b, approved, 1)).toEqual({
    contentHash: b.editionHash,
    revision: 2,
  });
  expect(await activateContent(env.DB, b, approved, 1)).toEqual({
    contentHash: b.editionHash,
    revision: 2,
  });
  const repo = new D1ContentRepository(env.DB, a.trust);
  expect(await repo.active()).toEqual(b);
  expect(
    await env.DB.prepare('SELECT generation_enabled,dispatch_mode FROM system_state').first(),
  ).toEqual({ generation_enabled: 0, dispatch_mode: 'off' });
  await expect(activateContent(env.DB, b, approved, 7)).rejects.toThrow();
  await expect(activateContent(env.DB, b, { ...approved }, 2)).rejects.toThrow();
});
test.each([
  'draft',
  'synthetic',
  'changed-source',
  'missing-reversal',
  'missing-attribution',
  'changed-copy',
  'missing-position',
])('rejects %s content before any activation', async (kind) => {
  await seedDatabase(env.DB);
  const b = await editorialBundle();
  if (kind === 'draft') Object.assign(b, structuredClone(draft));
  if (kind === 'synthetic')
    b.sources[0]!.review.reviewer = 'SYNTHETIC LOCAL FIXTURE; NOT EDITORIAL APPROVAL';
  if (kind === 'changed-source') b.sources[0]!.text += ' Altered after review.';
  if (kind === 'missing-reversal')
    b.sources.splice(
      b.sources.findIndex((s) => s.orientation === 'reversed'),
      1,
    );
  if (kind === 'missing-attribution') b.sources[0]!.rights.attribution = '';
  if (kind === 'changed-copy') b.productCopy.aiPermission = 'New unreviewed privacy promise';
  if (kind === 'missing-position') b.positionFrames[0]!.position = 'tension';
  b.editionHash = await bundleHash(b);
  await expect(
    (async () => {
      const a = await signedApproval(b);
      await activateContent(env.DB, b, await a.authenticate(), 1);
    })(),
  ).rejects.toThrow();
  expect(await env.DB.prepare('SELECT revision FROM system_state').first('revision')).toBe(1);
});
test('signature, evidence bytes, environment and immutable authenticated capability are required', async () => {
  const b = await editorialBundle(),
    a = await signedApproval(b);
  await expect(
    authenticateContentApproval({ ...a.signed, signature: 'a'.repeat(86) }, a.options),
  ).rejects.toThrow();
  await expect(
    authenticateContentApproval(a.signed, { ...a.options, rightsEvidence: new Uint8Array([1]) }),
  ).rejects.toThrow();
  await expect(
    authenticateContentApproval(a.signed, { ...a.options, environmentId: 'another' }),
  ).rejects.toThrow();
  const approved = await a.authenticate();
  expect(Object.isFrozen(approved)).toBe(true);
  b.productCopy.saveReading += ' changed';
  await expect(activateContent(env.DB, b, approved, 1)).rejects.toThrow();
});
test('competing activation is rejected and superseded editions remain immutable by hash', async () => {
  await seedDatabase(env.DB);
  const b = await editorialBundle(),
    a = await signedApproval(b);
  await activateContent(env.DB, b, await a.authenticate(), 1);
  const next = structuredClone(b);
  next.sources[0]!.version++;
  next.sources[0]!.hash = await sourceHash(next.sources[0]!);
  next.sources[0]!.review.reviewedHash = next.sources[0]!.hash;
  next.editionHash = await bundleHash(next);
  const c = await signedApproval(next);
  await expect(activateContent(env.DB, next, await c.authenticate(), 1)).rejects.toThrow();
  await activateContent(env.DB, next, await c.authenticate(), 2);
  expect(await new D1ContentRepository(env.DB, a.trust).byHash(b.editionHash)).toEqual(b);
});
test('activation fences in-flight publication and withdrawal rejects active and historical use', async () => {
  const plan = await seedDatabase(env.DB);
  let calls = 0;
  const service = new SyntheticGenerationPrototype(env.DB, {
    write: async () => {
      calls++;
      return { kind: 'uncertain', reason: 'timeout', receipt: null };
    },
  });
  const request = await service.start(plan),
    lease = (await service.claim(OWNER, request))!;
  const b = await editorialBundle(),
    a = await signedApproval(b),
    approval = await a.authenticate();
  await activateContent(env.DB, b, approval, 1);
  await expect(service.dispatch(lease, new Uint8Array([1]))).rejects.toThrow();
  expect(calls).toBe(0);
  await withdrawContent(env.DB, b.editionHash, 2);
  const repo = new D1ContentRepository(env.DB, a.trust);
  await expect(repo.active()).rejects.toThrow();
  await expect(repo.byHash(b.editionHash)).rejects.toThrow();
  await expect(activateContent(env.DB, b, approval, 3)).rejects.toThrow();
});
test('repository rejects rows with synthetic approval markers or altered stored bytes', async () => {
  await seedDatabase(env.DB);
  const b = await editorialBundle(),
    a = await signedApproval(b);
  await expect(new D1ContentRepository(env.DB, a.trust).active()).rejects.toThrow();
  await activateContent(env.DB, b, await a.authenticate(), 1);
  await env.DB.prepare("UPDATE content_editions SET bundle_json='{}' WHERE hash=?")
    .bind(b.editionHash)
    .run();
  await expect(new D1ContentRepository(env.DB, a.trust).active()).rejects.toThrow();
});
test('a signed historical edition retains its reviewed copy after the compiled active copy changes', async () => {
  await seedDatabase(env.DB);
  const b = await editorialBundle(),
    a = await signedApproval(b);
  b.productCopy.initialClosing = 'An earlier reviewed closing.';
  b.editionHash = await bundleHash(b);
  const document = {
    ...a.signed.document,
    bundleHash: b.editionHash,
    copyHash: await sha256Json(b.productCopy),
  };
  const bytes = new Uint8Array(
    await crypto.subtle.sign(
      'Ed25519',
      a.keys.privateKey,
      new TextEncoder().encode(canonicalJson(document)),
    ),
  );
  const signed = {
    document,
    signature: btoa(String.fromCharCode(...bytes))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', ''),
  };
  await env.DB.prepare(
    "INSERT INTO content_editions(hash,state,bundle_json,reviewed_hash,reviewer_kind,reviewer_id,rights_status,created_at,approved_at,approval_json,approval_hash) VALUES (?,'superseded',?,?,'human_approved','editor-a','cleared',1,1,?,?)",
  )
    .bind(
      b.editionHash,
      canonicalJson(b),
      b.editionHash,
      canonicalJson(signed),
      await sha256Json(signed),
    )
    .run();
  expect(await new D1ContentRepository(env.DB, a.trust).byHash(b.editionHash)).toEqual(b);
  await expect(authenticateContentApproval(signed, { ...a.options, bundle: b })).rejects.toThrow();
});
test('A to B to A rollback preserves signed bytes and fences old A work with new policy and pointer revisions', async () => {
  const seeded = await seedDatabase(env.DB),
    a = await editorialBundle(),
    signedA = await signedApproval(a),
    approvalA = await signedA.authenticate();
  await activateContent(env.DB, a, approvalA, 1);
  const original = await env.DB.prepare(
    'SELECT bundle_json,approval_json,approval_hash FROM content_editions WHERE hash=?',
  )
    .bind(a.editionHash)
    .first();
  await env.DB.prepare("UPDATE system_state SET generation_enabled=1,dispatch_mode='model'").run();
  let calls = 0;
  const service = new SyntheticGenerationPrototype(env.DB, {
    write: async () => {
      calls++;
      return { kind: 'uncertain', reason: 'timeout', receipt: null };
    },
  });
  const plan = {
    ...seeded,
    contentHash: a.editionHash,
    contentPolicyRevision: 1,
    clientIntentId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
  };
  const request = await service.start(plan),
    lease = (await service.claim(OWNER, request))!;
  const b = structuredClone(a);
  b.sources[0]!.version++;
  b.sources[0]!.hash = await sourceHash(b.sources[0]!);
  b.sources[0]!.review.reviewedHash = b.sources[0]!.hash;
  b.editionHash = await bundleHash(b);
  const signedB = await signedApproval(b);
  await activateContent(env.DB, b, await signedB.authenticate(), 2);
  expect(await activateContent(env.DB, a, approvalA, 3)).toEqual({
    contentHash: a.editionHash,
    revision: 4,
  });
  expect(
    await env.DB.prepare(
      'SELECT bundle_json,approval_json,approval_hash FROM content_editions WHERE hash=?',
    )
      .bind(a.editionHash)
      .first(),
  ).toEqual(original);
  expect(
    await env.DB.prepare('SELECT policy_revision FROM content_editions WHERE hash=?')
      .bind(a.editionHash)
      .first('policy_revision'),
  ).toBe(3);
  expect(
    await env.DB.prepare(
      'SELECT revision,generation_enabled,dispatch_mode FROM system_state',
    ).first(),
  ).toEqual({ revision: 4, generation_enabled: 0, dispatch_mode: 'off' });
  expect(await new D1ContentRepository(env.DB, signedA.trust).active()).toEqual(a);
  await env.DB.prepare("UPDATE system_state SET generation_enabled=1,dispatch_mode='model'").run();
  await expect(service.dispatch(lease, new Uint8Array([1]))).rejects.toThrow();
  expect(calls).toBe(0);
  await withdrawContent(env.DB, a.editionHash, 4);
  await expect(activateContent(env.DB, a, approvalA, 5)).rejects.toThrow();
});
