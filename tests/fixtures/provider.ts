import type { ProviderReceipt } from '../../src/contracts/index.ts';
import { READING_PROVIDER_POLICY } from '../../src/contracts/provider-policy.ts';
import { canonicalJson } from '../../src/domain/json.ts';
import { providerPolicyHash } from '../../src/domain/provider-policy.ts';

export function providerReceipt(patch: Partial<ProviderReceipt> = {}): ProviderReceipt {
  return {
    responseId: null,
    returnedModel: 'synthetic-test-only',
    serviceTier: 'default',
    durationMs: 1,
    usage: {
      inputTokens: 20,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 30,
      reasoningTokens: 0,
    },
    ...patch,
  };
}

const bytes = (text: string) => new TextEncoder().encode(text);
async function digest(value: Uint8Array) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(value))),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
}
export async function qualificationFixture(patch: Record<string, unknown> = {}) {
  const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const evidence = {
    projectAccess: bytes('SYNTHETIC project access review'),
    retention: bytes('SYNTHETIC retention review'),
    editorial: bytes('SYNTHETIC editorial review'),
    corpus: bytes('SYNTHETIC evaluation results'),
    tokenEstimator: bytes('SYNTHETIC estimator review'),
    pricing: bytes('SYNTHETIC pricing review'),
  };
  const evaluationManifest = bytes('SYNTHETIC frozen evaluation manifest');
  const policyHash = await providerPolicyHash(READING_PROVIDER_POLICY);
  const now = Date.now(),
    contentHash = 'b'.repeat(64);
  const document = {
    version: 'openai-responses.qualification.v2',
    scope: 'application',
    model: 'gpt-6.1-terra',
    policyHash,
    contentHash,
    projectId: 'synthetic-project',
    environmentId: 'synthetic-environment',
    reviewerId: 'synthetic-reviewer',
    issuedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 3600000).toISOString(),
    evaluationManifestHash: await digest(evaluationManifest),
    evidence: Object.fromEntries(
      await Promise.all(Object.entries(evidence).map(async ([k, v]) => [k, await digest(v)])),
    ),
    ...patch,
  };
  const signature = await crypto.subtle.sign(
    'Ed25519',
    keys.privateKey,
    bytes(canonicalJson(document)),
  );
  const signed = {
    document,
    signature: btoa(String.fromCharCode(...new Uint8Array(signature)))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', ''),
  };
  const options = {
    publicKey: keys.publicKey,
    evidence,
    evaluationManifest,
    policyHash,
    contentHash,
    now,
    projectId: 'synthetic-project',
    environmentId: 'synthetic-environment',
    reviewerId: 'synthetic-reviewer',
  };
  return { signed, options, keys, expected: { policyHash, contentHash, now } };
}
