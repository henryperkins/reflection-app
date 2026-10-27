import { z } from 'zod';
import { ModelCandidate } from '../contracts/index.ts';
import type { ReadingProviderPolicy } from '../contracts/provider-policy.ts';
import { sha256Json } from './json.ts';

/** Bind the real output contract as well as its version; source enums are content-bound. */
export async function providerPolicyHash(policy: ReadingProviderPolicy): Promise<string> {
  return sha256Json({ policy, outputSchema: z.toJSONSchema(ModelCandidate) });
}
