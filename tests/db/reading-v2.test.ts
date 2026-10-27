import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, test } from 'vitest';
import {
  AcceptedReadingV2,
  apiSchemas,
  ModelCandidateV2,
  StartRequest,
  type WritingProvider,
} from '../../src/contracts/index.ts';
import { clearDatabase } from '../fixtures/database.ts';
import { readingAccount } from '../fixtures/reading-client.ts';
import { localIdentity } from '../../src/worker/identity/routes.ts';
import { RecordBase } from '../../src/worker/readings/base.ts';
import { LocalGeneration } from '../../src/worker/readings/local-generation.ts';
import { providerReceipt } from '../fixtures/provider.ts';
import { sha256Bytes, sha256Json } from '../../src/domain/json.ts';
import { READING_V2_EVALUATION_POLICY } from '../../src/contracts/provider-policy.ts';

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
beforeEach(() => clearDatabase(env.DB));

test('new starts preserve exact input and persist complete v2 packet identities through save and reopen', async () => {
  const { client } = await readingAccount();
  const question =
    '  I am not discouraged.\nMy workload is manageable. How can I develop a coherent collection?  ';
  const result = await client.create(question);
  const reading = AcceptedReadingV2.parse(result.reading);
  expect(reading.question).toBe(question);
  expect(reading.units).toHaveLength(3);
  expect(reading.reflectionQuestion).toBeNull();
  expect(reading.synthesis.sourceIds).toHaveLength(3);
  expect(reading.action.text).toContain('compare');
  expect(
    new Set([
      reading.provenance.promptHash,
      reading.provenance.validatorHash,
      reading.provenance.schemaHash,
      reading.provenance.policyHash,
    ]).size,
  ).toBe(4);
  expect(reading.provenance.promptHash).toBe(await sha256Json(READING_V2_EVALUATION_POLICY.prompt));
  expect(reading.contextReceipt?.diagnosticOnly).toBe(true);
  expect(
    reading.sources.every(
      (s) => s.review.kind === 'agent_reviewed' && s.rights.status === 'unknown',
    ),
  ).toBe(true);
  expect(
    (
      await client.request(
        `/sessions/${reading.sessionId}/save`,
        { saved: true },
        { method: 'PUT', revision: 1 },
      )
    ).status,
  ).toBe(200);
  const before = await env.DB.prepare('SELECT body_enc FROM reading_editions WHERE id=?')
    .bind(reading.editionId)
    .first('body_enc');
  await client.permission(false);
  expect(await (await client.request(`/readings/${reading.editionId}`)).json()).toEqual(reading);
  expect(
    await env.DB.prepare('SELECT body_enc FROM reading_editions WHERE id=?')
      .bind(reading.editionId)
      .first('body_enc'),
  ).toBe(before);
});

test.each([false, true])(
  'v2 dispatch binds actual transmission and screens synthesis; invalid=%s',
  async (invalid) => {
    const { client } = await readingAccount(),
      identity = localIdentity(client.bindings)!;
    const session = await identity.sessions.get(client.cookies.get('__Host-session'));
    let packet:
        | {
            reader: { text: string };
            spread: { positions: unknown[] };
            selected: unknown[];
            draw: Array<{ cardId: string }>;
            meanings: Array<{ sourceId: string; position: string; factId: string }>;
          }
        | undefined,
      transmitted: Uint8Array | undefined,
      calls = 0;
    const writer: WritingProvider = {
      async write(input) {
        calls++;
        transmitted = input.payload;
        const request = JSON.parse(new TextDecoder().decode(input.payload));
        packet = JSON.parse(request.input[2].content);
        expect(input.reasoning).toBe('xhigh');
        expect(request.service_tier).toBe('fast');
        const ids = packet!.meanings.map((m) => m.sourceId);
        const candidate = ModelCandidateV2.parse({
          schemaVersion: 2,
          kind: 'tarot.interpretation.v2',
          units: packet!.meanings.map((m, i) => ({
            position: m.position,
            factIds: [m.factId],
            sourceIds: [m.sourceId],
            contextRefs: ['reader:question'],
            interpretation: [
              'A working approach can offer a useful starting point.',
              'Compare the demands of each possible format.',
              'Consistent criteria can make the comparison informative.',
            ][i],
          })),
          synthesis: {
            sourceIds: ids,
            relationshipIds: [],
            contextRefs: ['reader:question'],
            text: invalid
              ? 'You have always struggled to finish your projects.'
              : 'Preserving a useful method can leave room to compare a different format.',
          },
          action: {
            sourceIds: ids,
            contextRefs: ['reader:question'],
            text: 'One optional exercise is to compare both formats against the stated goal and note which differences would affect the choice.',
          },
          reflectionQuestion: null,
        });
        return {
          kind: 'candidate',
          candidate,
          receipt: providerReceipt({ returnedModel: 'gpt-6.1-terra', serviceTier: 'fast' }),
        };
      },
    };
    const generation = new LocalGeneration(new RecordBase(env.DB, identity), writer);
    const input = StartRequest.parse({
      clientIntentId: crypto.randomUUID(),
      question: '  My work is manageable. How could I compare formats?  ',
      languageConfirmed: 'en',
      reversals: true,
      permissionRevision: (await client.me()).permission.revision,
      parentEditionId: null,
      selection: [],
    });
    const start = await generation.start(session!, input, crypto.randomUUID());
    const status = apiSchemas.RequestStatus.parse(
      await generation.status(session!, start.requestId),
    );
    expect(status.state).toBe('published');
    const reading = AcceptedReadingV2.parse(
      await (await client.request(`/readings/${status.editionId}`)).json(),
    );
    expect(reading.mode).toBe(invalid ? 'template' : 'model');
    expect(reading.contextReceipt?.transmissionHash).toBe(await sha256Bytes(transmitted!));
    expect(packet!.reader.text).toBe(input.question);
    expect(packet!.spread.positions).toHaveLength(3);
    expect(packet!.draw.map((c) => c.cardId)).toEqual(reading.basis.cards.map((c) => c.cardId));
    expect(packet!.selected).toEqual([]);
    expect(calls).toBe(1);
    expect(await env.DB.prepare('SELECT state FROM cost_reservations').first('state')).toBe(
      'actual',
    );
    expect(await env.DB.prepare('SELECT state FROM quota_reservations').first('state')).toBe(
      invalid ? 'released' : 'consumed',
    );
  },
);
