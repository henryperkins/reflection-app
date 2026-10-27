import type { WritingProvider, WriterOutcome } from '../../contracts/index.ts';
import { READING_PROVIDER_POLICY } from '../../contracts/provider-policy.ts';
import { providerPolicyHash } from '../../domain/provider-policy.ts';
import { verifyProviderQualification } from './qualification.ts';
import { OpenAIResponsesTransport } from './transport.ts';
export type { ProviderQualification } from './qualification.ts';

export interface OpenAIProviderOptions {
  enabled?: boolean;
  apiKey?: string;
  fetch?: typeof fetch;
  qualification?: unknown;
  expectedPolicyHash?: string;
  expectedContentHash?: string;
  projectId?: string;
  environmentId?: string;
}

/** Disabled by default. Protected bootstrap supplies authenticated evidence and target identity. */
export class OpenAIWritingProvider implements WritingProvider {
  private stopped = false;
  constructor(private readonly options: OpenAIProviderOptions = {}) {}
  async write(input: Parameters<WritingProvider['write']>[0]): Promise<WriterOutcome> {
    const config = this.options;
    if (
      this.stopped ||
      !config.enabled ||
      !config.apiKey ||
      !config.fetch ||
      !config.expectedPolicyHash ||
      !config.expectedContentHash ||
      !config.projectId ||
      !config.environmentId
    )
      return { kind: 'rejected', status: 503, receipt: null };
    try {
      if (config.expectedPolicyHash !== (await providerPolicyHash(READING_PROVIDER_POLICY)))
        throw new Error();
      const qualification = verifyProviderQualification(config.qualification, {
        policyHash: config.expectedPolicyHash,
        contentHash: config.expectedContentHash,
        now: Date.now(),
      });
      if (
        qualification.projectId !== config.projectId ||
        qualification.environmentId !== config.environmentId
      )
        throw new Error();
    } catch {
      return { kind: 'rejected', status: 503, receipt: null };
    }
    const outcome = await new OpenAIResponsesTransport({
      apiKey: config.apiKey,
      fetch: config.fetch,
      policy: READING_PROVIDER_POLICY,
    }).write(input);
    if (outcome.kind === 'uncertain' && outcome.haltGeneration) this.stopped = true;
    return outcome;
  }
}
