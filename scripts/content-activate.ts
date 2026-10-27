import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ContentBundle } from '../src/contracts/index.ts';
import { bundleHash } from '../src/domain/tarot/plan.ts';
import { canonicalJson, sha256Json } from '../src/domain/json.ts';
import {
  authenticateContentApproval,
  inspectReviewedBundle,
  type Bundle,
} from '../src/worker/content/approval.ts';
import { activateContent, withdrawContent } from '../src/worker/content/activation.ts';
import {
  operatorArguments,
  required,
  readOperatorBytes,
  readOperatorJson,
  withLocalReadingDatabase,
} from './local-reading-operator.ts';

export async function contentReviewPacket(
  bundle: Bundle,
  previous: unknown = null,
): Promise<string> {
  if (bundle.editionHash !== (await bundleHash(bundle))) throw new Error();
  const old = previous as Bundle | null,
    lines = [
      '# UNAPPROVED content review packet',
      '',
      'This packet records an agent-prepared draft. It grants no human approval, rights clearance or production activation. Review every card and reversal, fallback, position frame, disclosure and license. Keep private evidence outside the checkout.',
      '',
      `Bundle: ${bundle.editionHash}`,
      `Deck: ${bundle.deckEdition}`,
      `Copy: ${await sha256Json(bundle.productCopy)}`,
      `Sources: ${bundle.sources.length} (required: 78 × 2 neutral sources)`,
      '',
      '## Changes from previous bytes',
      '',
    ];
  if (old && canonicalJson(old) === canonicalJson(bundle)) lines.push('No content differences.');
  else {
    lines.push(`Previous bundle: ${old?.editionHash ?? 'none supplied'}`);
    for (const key of ['deck', 'positionFrames', 'productCopy', 'licenseNotice'] as const) {
      if (!old || canonicalJson(old[key]) !== canonicalJson(bundle[key])) {
        lines.push(
          `Changed ${key}: ${old ? await sha256Json(old[key]) : 'none'} → ${await sha256Json(bundle[key])}`,
        );
        if (key === 'productCopy')
          for (const [k, v] of Object.entries(bundle.productCopy)) {
            const before = (old?.productCopy as Record<string, string> | undefined)?.[k];
            if (before !== v)
              lines.push(`- ${k} before: ${before ?? '(absent)'}`, `- ${k} after: ${v}`);
          }
      }
    }
    for (const s of bundle.sources) {
      const p = old?.sources.find((v) => v.id === s.id);
      if (!p || canonicalJson(p) !== canonicalJson(s))
        lines.push(
          `Source ${s.id}: ${p?.hash ?? 'none'} → ${s.hash}`,
          `- Before: ${p?.text ?? '(absent)'}`,
          `- After: ${s.text}`,
        );
    }
    for (const s of old?.sources ?? [])
      if (!bundle.sources.some((v) => v.id === s.id))
        lines.push(`Removed source: ${s.id} (${s.hash})`);
  }
  lines.push('', '## Product copy', '');
  for (const [k, v] of Object.entries(bundle.productCopy)) lines.push(`### ${k}`, '', v, '');
  lines.push('## License', '', bundle.licenseNotice, '', '## Position frames', '');
  for (const p of bundle.positionFrames) lines.push(`- ${p.position}: ${p.text}`);
  lines.push('', '## Deck', '');
  for (const c of bundle.deck)
    lines.push(
      `- ${c.id}: ${c.name}; image ${c.imageHash ?? 'none'}; attribution: ${c.attribution}`,
    );
  lines.push('', '## Card sources', '');
  for (const s of bundle.sources)
    lines.push(
      `### ${s.id}`,
      '',
      `Card: ${s.cardId}; ${s.orientation}; ${s.position ?? 'neutral'}; version ${s.version}`,
      `Hash: ${s.hash}`,
      '',
      s.text,
      '',
      `Fallback: ${s.fallbackText}`,
      `Reflection: ${s.reflectionQuestion}`,
      `Review: ${s.review.kind}; ${s.review.reviewer ?? 'none'}; reviewed hash ${s.review.reviewedHash ?? 'none'}; time ${s.review.reviewedAt ?? 'none'}`,
      `Rights: ${s.rights.status}; ${s.rights.evidence}; attribution ${s.rights.attribution}; territory ${s.rights.territory}`,
      '',
    );
  lines.push(
    '## Human decision still required',
    '',
    'Record the named reviewer, exact reviewed hashes, rights evidence digest, attribution and territories in an externally signed content-approval.v1 document. A trusted public key must be configured independently. Agent and synthetic markers cannot satisfy activation. No approval record has been generated.',
    '',
  );
  return lines.join('\n');
}
export async function runContentActivation(argv: string[]) {
  if (argv.length === 1 && argv[0] === '--help')
    return {
      scope: 'local-operator',
      deploymentAllowed: false,
      usage: [
        '--check --bundle <public-bundle.json>',
        '--review-packet --bundle <draft.json> [--previous <old.json>] --out <new-review.md>',
        '--activate --bundle <approved.json> --approval <signed.json> --public-key <trusted-public-jwk.json> --rights-evidence <protected-file> --environment <id> --reviewer <id> --expected-revision <n> --persist-to <local-state-directory>',
        '--withdraw --hash <content-hash> --expected-revision <n> --persist-to <local-state-directory>',
      ],
      notes:
        'Stop the local app and maintenance runner before mutation. Check-only does not grant approval. Activation leaves generation off; no hosted deployment or provider call is performed.',
    };
  const { mode, values } = operatorArguments(
    argv,
    ['--check', '--review-packet', '--activate', '--withdraw'],
    [
      '--bundle',
      '--previous',
      '--out',
      '--approval',
      '--public-key',
      '--rights-evidence',
      '--environment',
      '--reviewer',
      '--expected-revision',
      '--persist-to',
      '--hash',
    ],
  );
  const allowed =
    mode === '--review-packet'
      ? ['--bundle', '--previous', '--out']
      : mode === '--check'
        ? ['--bundle']
        : mode === '--withdraw'
          ? ['--hash', '--expected-revision', '--persist-to']
          : [
              '--bundle',
              '--approval',
              '--public-key',
              '--rights-evidence',
              '--environment',
              '--reviewer',
              '--expected-revision',
              '--persist-to',
            ];
  if ([...values.keys()].some((k) => !allowed.includes(k))) throw new Error();
  if (mode === '--withdraw')
    return withLocalReadingDatabase(required(values, '--persist-to'), async (db) => {
      await withdrawContent(
        db,
        required(values, '--hash'),
        Number(required(values, '--expected-revision')),
      );
      return { withdrawn: true, generationActivated: false };
    });
  const bundle = ContentBundle.parse(readOperatorJson(required(values, '--bundle')));
  if (mode === '--review-packet') {
    const packet = await contentReviewPacket(
      bundle,
      values.has('--previous') ? readOperatorJson(values.get('--previous')!) : null,
    );
    writeFileSync(resolve(required(values, '--out')), packet, { flag: 'wx', mode: 0o600 });
    return {
      contentHash: bundle.editionHash,
      sources: bundle.sources.length,
      approvalGranted: false,
    };
  }
  await inspectReviewedBundle(bundle);
  if (mode === '--check')
    return {
      contentHash: bundle.editionHash,
      structurallyValid: true,
      approvalVerified: false,
      generationActivated: false,
    };
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    readOperatorJson(required(values, '--public-key')) as JsonWebKey,
    { name: 'Ed25519' },
    false,
    ['verify'],
  );
  const approval = await authenticateContentApproval(
    readOperatorJson(required(values, '--approval')),
    {
      bundle,
      publicKey,
      rightsEvidence: readOperatorBytes(required(values, '--rights-evidence')),
      environmentId: required(values, '--environment'),
      reviewerId: required(values, '--reviewer'),
      now: Date.now(),
    },
  );
  return withLocalReadingDatabase(required(values, '--persist-to'), async (db) => ({
    ...(await activateContent(
      db,
      bundle,
      approval,
      Number(required(values, '--expected-revision')),
    )),
    generationActivated: false,
  }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(await runContentActivation(process.argv.slice(2)), null, 2));
  } catch {
    console.error(
      'Content not approved or operation unconfirmed: check the explicit local inputs, signature, evidence and current revision.',
    );
    process.exitCode = 1;
  }
}
