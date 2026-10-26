import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { projectRoot } from './schemas.ts';
import { sourceDigest } from './verification-state.ts';
import { checkQualifications } from './qualification.ts';

const Receipt = z.object({
  status: z.literal('passed'),
  sourceDigest: z.string(),
  scope: z.literal('synthetic-local-only'),
});

export function checkRelease(root = projectRoot) {
  const receipt = Receipt.parse(
    JSON.parse(readFileSync(resolve(root, 'artifacts/verify.json'), 'utf8')),
  );
  if (receipt.sourceDigest !== sourceDigest(root))
    throw new Error('Verification receipt is stale; rerun npm run verify');
  const qualification = checkQualifications(root);
  return {
    localVerification: 'passed',
    deploymentAllowed: false,
    milestone2Complete: qualification.complete,
    applicationDigest: qualification.applicationDigest,
    outstanding: qualification.gates
      .filter((gate) => gate.status === 'pending')
      .map((gate) => gate.label),
    qualification: qualification.gates,
  } as const;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.slice(2).join(' ') !== '--check') {
    throw new Error(
      'Deployment is disabled while launch qualifications remain open. Use npm run release -- --check to inspect qualification status.',
    );
  }
  console.log(JSON.stringify(checkRelease(), null, 2));
}
