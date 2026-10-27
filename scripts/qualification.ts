import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { z } from 'zod';
import { sourceDigest } from './verification-state.ts';

export const qualificationGates = {
  identity: ['production identity and real-device recovery', 'hosted-synthetic'],
  keys: ['production key rotation and retained-key receipts', 'hosted-synthetic'],
  content: ['verified launch content and attribution', 'automated-review'],
  provider: ['provider qualification and billing reconciliation', 'provider-evaluation'],
  release: ['hosted release isolation and failing-test proof', 'hosted-synthetic'],
  database: ['hosted D1 concurrency and scheduled recovery', 'hosted-synthetic'],
  restore: ['hosted erasure/security restore and independent backups', 'hosted-synthetic'],
  accessibility: ['automated browser and accessibility acceptance', 'automated-review'],
  operations: ['operational monitoring and runbooks', 'hosted-synthetic'],
  owner: ['owner decisions', 'owner-decision'],
} as const;

const gateId = z.enum(
  Object.keys(qualificationGates) as [
    keyof typeof qualificationGates,
    ...(keyof typeof qualificationGates)[],
  ],
);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const manifestSchema = z.strictObject({
  version: z.literal(1),
  gates: z
    .array(
      z.discriminatedUnion('status', [
        z.strictObject({
          id: gateId,
          status: z.literal('pending'),
          reason: z.string().min(1).max(2000),
        }),
        z.strictObject({
          id: gateId,
          status: z.literal('verified'),
          reviewedBy: z.string().trim().min(1).max(120),
          reviewedAt: z.iso.datetime(),
          scope: z.enum([
            'hosted-synthetic',
            'automated-review',
            'provider-evaluation',
            'owner-decision',
          ]),
          applicationDigest: hash,
          evidence: z.strictObject({
            path: z.string().regex(/^qualification\/evidence\/[a-zA-Z0-9._/-]+\.(json|md|txt)$/),
            sha256: hash,
          }),
        }),
      ]),
    )
    .max(Object.keys(qualificationGates).length),
});

/** Evidence records are excluded to avoid a self-referential digest. All application and test bytes remain bound. */
export function qualificationDigest(root: string) {
  return sourceDigest(root, ['qualification']);
}

export function checkQualifications(root: string) {
  const file = resolve(root, 'qualification/acceptance.json');
  const manifest = existsSync(file)
    ? manifestSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
    : { version: 1, gates: [] };
  const ids = manifest.gates.map((gate) => gate.id);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate qualification gate');
  const applicationDigest = qualificationDigest(root);
  const gates = Object.entries(qualificationGates).map(([id, [label, scope]]) => {
    const gate = manifest.gates.find((item) => item.id === id);
    if (!gate || gate.status === 'pending')
      return {
        id,
        label,
        status: 'pending' as const,
        reason: gate?.reason ?? 'No qualification evidence recorded',
      };
    if (gate.scope !== scope) throw new Error(`Wrong evidence scope for ${id}`);
    if (gate.applicationDigest !== applicationDigest)
      throw new Error(`Stale qualification evidence for ${id}`);
    if (Date.parse(gate.reviewedAt) > Date.now() + 300_000)
      throw new Error(`Future qualification review for ${id}`);
    const evidence = resolve(root, gate.evidence.path);
    const allowed = resolve(root, 'qualification/evidence') + sep;
    if (!evidence.startsWith(allowed) || !realpathSync(evidence).startsWith(allowed))
      throw new Error(`Unsafe evidence path for ${id}`);
    const stat = statSync(evidence);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024)
      throw new Error(`Invalid evidence file for ${id}`);
    const digest = createHash('sha256').update(readFileSync(evidence)).digest('hex');
    if (digest !== gate.evidence.sha256) throw new Error(`Evidence hash mismatch for ${id}`);
    return { id, label, status: 'verified' as const, reviewedBy: gate.reviewedBy };
  });
  return { applicationDigest, gates, complete: gates.every((gate) => gate.status === 'verified') };
}
