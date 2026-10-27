import { providerReceipt } from '../fixtures/provider.ts';
import { READING_PROVIDER_POLICY } from '../../src/contracts/provider-policy.ts';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { expect, test, vi } from 'vitest';
import { canonicalJson } from '../../src/domain/json.ts';
import { renderFacts } from '../../src/domain/tarot/facts.ts';
import { buildPlan, validateCandidateBindings } from '../../src/domain/tarot/plan.ts';
import { composeTemplate, projectWriterPayload } from '../../src/domain/tarot/render.ts';
import { SyntheticGenerationPrototype } from '../../src/worker/db/prototype.ts';
import { InterceptedWritingProvider } from '../../src/worker/provider/intercepted.ts';
import { syntheticCandidate, syntheticPlanInput, TEST_ONLY } from '../fixtures/canon.ts';
import { clearDatabase, POLICY, seedDatabase, sql, SYNTHETIC } from '../fixtures/database.ts';

/** Known local-only key; never production key material or an editorial approval identity. */
async function fixtureHmac(domain: string, bytes: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    Uint8Array.from({ length: 32 }, (_, i) => i),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const prefix = new TextEncoder().encode(`${domain}\0`);
  const message = new Uint8Array(prefix.length + bytes.length);
  message.set(prefix);
  message.set(bytes, prefix.length);
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, message)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

test('synthetic domain plan reaches the intercepted writer and publishes once through actual D1', async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await clearDatabase(env.DB);
  const databaseFixture = await seedDatabase(env.DB);
  const input = await syntheticPlanInput();
  input.requestId = crypto.randomUUID();
  input.basis.basisId = databaseFixture.basisId;
  input.generationPolicyHash = POLICY;
  const plan = await buildPlan(input);
  const facts = renderFacts(plan.basis);
  const template = await composeTemplate(plan);
  const payload = await projectWriterPayload(plan, READING_PROVIDER_POLICY);
  const payloadText = new TextDecoder().decode(payload);
  const body = JSON.parse(payloadText);
  const supplied = JSON.parse(body.input[2].content);

  expect(plan.basis.cards.map((card) => [card.cardId, card.orientation])).toEqual([
    ['wands-08', 'reversed'],
    ['major-04', 'upright'],
    ['cups-10', 'upright'],
  ]);
  expect(facts).toHaveLength(7);
  expect(template.facts).toEqual(facts);
  expect(supplied.facts).toEqual(facts);
  expect(template.units[0]!.basisText).toBe('The situation card is wands-08 (reversed).');
  expect(supplied.sources).toEqual(
    plan.sources.map((source, i) => ({
      id: source.id,
      factId: plan.basis.cards[i]!.id,
      text: source.text,
    })),
  );
  expect(Object.keys(supplied)).toEqual(['facts', 'positions', 'sources', 'question', 'selected']);
  expect(supplied.selected).toEqual([]);
  for (const forbidden of [
    databaseFixture.ownerId,
    databaseFixture.sessionId,
    databaseFixture.basisId,
    plan.requestId,
    plan.basis.seed,
    'PRIVATE_RIGHTS_SENTINEL',
    'reviewedHash',
    'reviewer',
    'rights',
    'permissionRevision',
    'keyVersion',
  ]) {
    expect(payloadText).not.toContain(forbidden);
  }

  const planHmac = await fixtureHmac(
    'reflection.synthetic.integration.plan.v1',
    new TextEncoder().encode(canonicalJson(plan)),
  );
  const payloadHmac = await fixtureHmac('reflection.synthetic.integration.payload.v1', payload);
  expect(planHmac).toMatch(/^[a-f0-9]{64}$/);
  expect(payloadHmac).toMatch(/^[a-f0-9]{64}$/);
  expect(planHmac).not.toBe(payloadHmac);
  const databasePlan = {
    ...databaseFixture,
    requestId: plan.requestId,
    contentHash: plan.contentHash,
    policyHash: plan.generationPolicyHash,
    planHmac,
    payloadHmac,
  };
  await env.DB.batch([
    sql(
      env.DB,
      `INSERT INTO content_editions(hash,state,bundle_json,reviewed_hash,reviewer_kind,reviewer_id,rights_status,created_at,approved_at)
       VALUES (?,'approved',?,?,'human_approved',?,'cleared',1,1)`,
      input.content.editionHash,
      canonicalJson(input.content),
      input.content.editionHash,
      TEST_ONLY,
    ),
    sql(
      env.DB,
      'UPDATE system_state SET active_content_hash=? WHERE id=1',
      input.content.editionHash,
    ),
  ]);
  const candidate = syntheticCandidate(plan);
  const intercepted = new InterceptedWritingProvider({
    outcome: {
      kind: 'candidate',
      candidate,
      receipt: providerReceipt({
        responseId: 'synthetic-test-only-response',
        returnedModel: 'gpt-6.1-terra',
        durationMs: 1,
        usage: {
          inputTokens: 100,
          outputTokens: 100,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
      }),
    },
  });
  const write = vi.spyOn(intercepted, 'write');
  const service = new SyntheticGenerationPrototype(env.DB, intercepted);
  const requestIds = await Promise.all([service.start(databasePlan), service.start(databasePlan)]);
  expect(requestIds).toEqual([plan.requestId, plan.requestId]);
  const lease = await service.claim(databasePlan.ownerId, plan.requestId);
  expect(lease).not.toBeNull();
  expect(lease!.plan).toEqual(databasePlan);
  const stored = await sql(
    env.DB,
    'SELECT content_hash,plan_hmac,payload_hmac FROM generation_requests WHERE id=?',
    plan.requestId,
  ).first();
  expect(stored).toEqual({
    content_hash: plan.contentHash,
    plan_hmac: planHmac,
    payload_hmac: payloadHmac,
  });
  const outcomes = await Promise.all([
    service.dispatch(lease!, payload),
    service.dispatch(lease!, payload),
  ]);
  expect(write).toHaveBeenCalledTimes(1);
  expect(write.mock.calls[0]![0].payload).toEqual(payload);
  expect(
    await fixtureHmac(
      'reflection.synthetic.integration.payload.v1',
      write.mock.calls[0]![0].payload,
    ),
  ).toBe(payloadHmac);
  const received = outcomes.find((outcome) => outcome?.kind === 'candidate');
  expect(received?.kind).toBe('candidate');
  if (received?.kind !== 'candidate') throw new Error('Expected synthetic candidate receipt');
  expect(received.candidate).toEqual(candidate);
  expect(() => validateCandidateBindings(plan, received.candidate)).not.toThrow();
  const editions = await Promise.all([service.publish(lease!), service.publish(lease!)]);
  expect(new Set(editions).size).toBe(1);
  expect(await service.publish(lease!)).toBe(editions[0]);
  expect(await env.DB.prepare('SELECT count(*) AS n FROM provider_dispatches').first()).toEqual({
    n: 1,
  });
  expect(await env.DB.prepare('SELECT count(*) AS n FROM reading_editions').first()).toEqual({
    n: 1,
  });
  expect(
    await env.DB.prepare(
      'SELECT sum(held) AS held,sum(consumed) AS consumed FROM quota_buckets',
    ).first(),
  ).toEqual({ held: 0, consumed: 2 });
  expect(
    await sql(
      env.DB,
      'SELECT request_id,basis_id,content_hash,status,body_enc FROM reading_editions WHERE id=?',
      editions[0]!,
    ).first(),
  ).toEqual({
    request_id: plan.requestId,
    basis_id: plan.basis.basisId,
    content_hash: plan.contentHash,
    status: 'accepted',
    // The local prototype persists a marker, never a real encrypted AcceptedReading.
    body_enc: SYNTHETIC,
  });
  expect(
    await sql(
      env.DB,
      "SELECT count(*) AS n FROM request_events WHERE request_id=? AND code='ACCEPTED'",
      plan.requestId,
    ).first(),
  ).toEqual({ n: 1 });
});
