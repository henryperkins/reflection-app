// Ephemeral signatures and intercepted HTTP only: never qualification evidence.
import { ContentBundleV2, ModelCandidateV2 } from '../../src/contracts/index.ts';
import { contentHashV2, reviewedRecordHash } from '../../src/domain/tarot/context-v2.ts';
import { editorialBundle, signedApproval } from './content-approval.ts';
import { v2Input } from './canon-v2.ts';
import { qualificationFixture } from './provider.ts';
import { READING_V2_APPLICATION_POLICY } from '../../src/contracts/provider-policy.ts';
import { providerPolicyHash } from '../../src/domain/provider-policy.ts';
import { activateContent } from '../../src/worker/content/activation.ts';
import { authenticateProviderQualification } from '../../src/worker/provider/qualification.ts';
import { D1ContentRepository } from '../../src/worker/content/repository.ts';
import { OpenAIWritingProvider } from '../../src/worker/provider/openai.ts';

export function candidateFromRequest(payload: Uint8Array) {
  const request = JSON.parse(new TextDecoder().decode(payload));
  const packet = JSON.parse(request.input[2].content);
  const ids = packet.meanings.map((m: { sourceId: string }) => m.sourceId);
  return ModelCandidateV2.parse({
    schemaVersion: 2,
    kind: 'tarot.interpretation.v2',
    units: packet.meanings.map(
      (m: { position: string; factId: string; sourceId: string }, i: number) => ({
        position: m.position,
        factIds: [m.factId],
        sourceIds: [m.sourceId],
        contextRefs: ['reader:question'],
        interpretation: [
          'A working approach can offer a useful starting point.',
          'Compare the demands of each possible format.',
          'Consistent criteria can make the comparison informative.',
        ][i],
      }),
    ),
    synthesis: {
      sourceIds: ids,
      relationshipIds: [],
      contextRefs: ['reader:question'],
      text: 'Preserving a useful method can leave room to compare a different format.',
    },
    action: {
      sourceIds: ids,
      contextRefs: ['reader:question'],
      text: 'One optional exercise is to compare both formats against the stated goal and note which differences would affect the choice.',
    },
    reflectionQuestion: null,
  });
}
export async function qualifiedFixture(db: D1Database, expiresAt?: string) {
  const old = await editorialBundle(),
    sample = await v2Input();
  const bundle = ContentBundleV2.parse({
    ...sample.content,
    ...old,
    schemaVersion: 2,
    spreadVersion: sample.content.spreadVersion,
    relationships: [],
    fallbackV2: sample.content.fallbackV2,
    sources: old.sources.map((s, i) => ({ ...s, meaning: sample.content.sources[i]!.meaning })),
  });
  for (const s of bundle.sources) {
    s.hash = await reviewedRecordHash(s);
    s.review.reviewedHash = s.hash;
  }
  bundle.editionHash = await contentHashV2(bundle);
  const approval = await signedApproval(bundle);
  const policy = READING_V2_APPLICATION_POLICY;
  const policyHash = await providerPolicyHash(policy);
  await db
    .prepare('INSERT INTO system_state(id,provider_policy_hash,updated_at) VALUES (1,?,1)')
    .bind(policyHash)
    .run();
  await activateContent(db, bundle, await approval.authenticate(), 1);
  // Explicit test operator decision, distinct from the activation operation.
  await db
    .prepare("UPDATE system_state SET generation_enabled=1,dispatch_mode='model' WHERE id=1")
    .run();
  const f = await qualificationFixture({
    policyHash,
    contentHash: bundle.editionHash,
    ...(expiresAt ? { expiresAt } : {}),
  });
  const qualification = await authenticateProviderQualification(f.signed, {
    ...f.options,
    policyHash,
    contentHash: bundle.editionHash,
  });
  let calls = 0,
    payload: Uint8Array | undefined;
  const config = {
    enabled: true,
    apiKey: 'synthetic-test-only-key',
    qualification,
    policy,
    expectedPolicyHash: policyHash,
    expectedContentHash: bundle.editionHash,
    projectId: f.options.projectId,
    environmentId: f.options.environmentId,
    fetch: (async (_url, init) => {
      calls++;
      payload = new Uint8Array(await new Response(init!.body).arrayBuffer());
      return Response.json({
        id: 'resp_test_only',
        object: 'response',
        status: 'completed',
        error: null,
        model: 'gpt-6.1-terra',
        service_tier: 'fast',
        usage: {
          input_tokens: 1000,
          input_tokens_details: { cached_tokens: 100, cache_write_tokens: 0 },
          output_tokens: 100,
          output_tokens_details: { reasoning_tokens: 10 },
          total_tokens: 1100,
        },
        output: [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: JSON.stringify(candidateFromRequest(payload)) }],
          },
        ],
      });
    }) as typeof fetch,
  };
  const writer = new OpenAIWritingProvider(config);
  const dependencies = {
    content: new D1ContentRepository(db, approval.trust),
    policy,
    writer,
    authorization: { kind: 'application' as const, qualification },
    ensureReady: () => writer.ensureReady(),
  };
  return { bundle, config, dependencies, policyHash, calls: () => calls, payload: () => payload };
}
