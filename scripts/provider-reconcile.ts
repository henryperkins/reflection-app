import { z } from 'zod';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ProviderReceipt, Hash, Instant } from '../src/contracts/index.ts';
import { READING_PROVIDER_POLICY as policy } from '../src/contracts/provider-policy.ts';
import { providerPolicyHash } from '../src/domain/provider-policy.ts';
import { sha256Bytes } from '../src/domain/json.ts';
import { priceReceipt } from '../src/domain/provider-cost.ts';
import { reconcileProviderCost } from '../src/worker/provider/costs.ts';
import {
  operatorArguments,
  required,
  readOperatorBytes,
  readOperatorJson,
  withLocalReadingDatabase,
} from './local-reading-operator.ts';
const Identity = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const Import = z.strictObject({
  version: z.literal('provider-cost-import.v1'),
  reviewerId: z.string().trim().min(1).max(200),
  reviewedAt: Instant,
  policyHash: Hash,
  evidenceHash: Hash,
  receipts: z
    .array(
      z.strictObject({
        dispatchId: Identity,
        receiptId: Identity,
        receipt: ProviderReceipt.nullable(),
      }),
    )
    .min(1)
    .max(1000),
});
/** The explicit local operator attests provenance; a matching hash alone is not human review. */
export async function runProviderReconciliation(argv: string[]) {
  if (argv.length === 1 && argv[0] === '--help')
    return {
      scope: 'local-operator',
      deploymentAllowed: false,
      usage: [
        '--check --input <protected-import.json> --evidence <protected-bill>',
        '--apply --input <protected-import.json> --evidence <protected-bill> --persist-to <local-state-directory>',
      ],
      notes:
        'Stop the local app and maintenance runner before apply. Supply a genuinely reviewed provider-cost-import.v1 bill; include all usage categories and exact policy hash. Unknown usage retains full liability. Conflicting actual receipts require review. No prompt/response bodies or provider response IDs are printed.',
    };
  const { mode, values } = operatorArguments(
    argv,
    ['--check', '--apply'],
    ['--input', '--evidence', '--persist-to'],
  );
  if (mode === '--check' && values.has('--persist-to')) throw new Error();
  const file = Import.parse(readOperatorJson(required(values, '--input'))),
    policyHash = await providerPolicyHash(policy);
  if (
    file.policyHash !== policyHash ||
    Date.parse(file.reviewedAt) > Date.now() ||
    (await sha256Bytes(readOperatorBytes(required(values, '--evidence')))) !== file.evidenceHash ||
    new Set(file.receipts.map((r) => r.dispatchId)).size !== file.receipts.length ||
    new Set(file.receipts.map((r) => r.receiptId)).size !== file.receipts.length
  )
    throw new Error();
  const summary = {
    receipts: file.receipts.length,
    knownMicrousd: 0,
    unknown: 0,
    policyHash,
    applied: false,
  };
  for (const item of file.receipts) {
    const price = item.receipt ? priceReceipt(item.receipt, policy) : null;
    if (price) summary.knownMicrousd += price.actualMicrousd;
    else summary.unknown++;
  }
  if (!Number.isSafeInteger(summary.knownMicrousd)) throw new Error();
  if (mode === '--check') return summary;
  return withLocalReadingDatabase(required(values, '--persist-to'), async (db) => {
    let actual = 0,
      unknown = 0;
    for (const item of file.receipts) {
      const result = await reconcileProviderCost(db, { ...item, policy });
      if (result.state === 'actual') actual++;
      else unknown++;
    }
    return { receipts: file.receipts.length, actual, unknown, policyHash, applied: true };
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(await runProviderReconciliation(process.argv.slice(2)), null, 2));
  } catch {
    console.error(
      'Provider reconciliation refused: verify the protected import, bill evidence, policy and settled receipt. No private receipt details were printed.',
    );
    process.exitCode = 1;
  }
}
