import { readFileSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WritingProvider, WriterOutcome } from '../src/contracts/index.ts';
import { READING_PROVIDER_POLICY as policy } from '../src/contracts/provider-policy.ts';
import { canonicalJson } from '../src/domain/json.ts';
import { validateCandidate } from '../src/domain/tarot/safety.ts';
import { OpenAIResponsesTransport } from '../src/worker/provider/transport.ts';
import { projectRoot } from './schemas.ts';
import { prepareEvaluation } from './provider-evaluation-corpus.ts';
import {
  EvaluationJournal,
  EvaluationPermit,
  type EvaluationSummary,
  digest,
  protectedPath,
  purgeExpiredEvaluationArchives,
  validatePermit,
} from './provider-evaluation-state.ts';
export { prepareEvaluation } from './provider-evaluation-corpus.ts';

type CapturingWriter = WritingProvider & { takeCapture?: (dispatchId: string) => unknown };

export async function runEvaluation(
  permit: EvaluationPermit,
  transport: CapturingWriter,
  journal: EvaluationJournal,
): Promise<EvaluationSummary> {
  validatePermit(permit, journal.prepared);
  if (canonicalJson(permit) !== canonicalJson(journal.permit))
    throw new Error('Journal permit mismatch');
  journal.acquire();
  try {
    journal.resume();
    let cursor = 0,
      stopped = false;
    const worker = async () => {
      for (;;) {
        if (stopped || journal.summary().status === 'halted') return;
        const request = journal.prepared.requests[cursor++];
        if (!request) return;
        if (!journal.reserve(request.id)) continue;
        let outcome: WriterOutcome;
        try {
          outcome = await transport.write({
            ...request.input,
            payload: new Uint8Array(request.input.payload),
            // The shared transport enforces its own deadline across fetch and body reading.
            signal: new AbortController().signal,
          });
        } catch {
          outcome = { kind: 'uncertain', reason: 'network', receipt: null };
        }
        let assessment: string = outcome.kind;
        if (outcome.kind === 'candidate') {
          try {
            validateCandidate(request.plan, outcome.candidate);
            assessment = 'accepted';
          } catch {
            assessment = 'validation-rejected';
          }
        }
        journal.recordReceipt(
          request.id,
          outcome,
          assessment,
          transport.takeCapture?.(request.id) ?? null,
        );
      }
    };
    // A process-wide SQLite lock prevents another runner from exceeding this concurrency.
    const workers = await Promise.allSettled(
      Array.from({ length: permit.maxConcurrency }, async () => {
        try {
          await worker();
        } catch (error) {
          stopped = true;
          throw error;
        }
      }),
    );
    if (workers.some((result) => result.status === 'rejected'))
      throw new Error('Evaluation interrupted; retain journal liability');
    journal.verifyArtifacts();
    return journal.summary();
  } finally {
    journal.release();
  }
}

/** Capture the exact bounded wire bytes without logging bodies, IDs, keys or headers. */
function liveWriter(apiKey: string, projectId: string, fetcher: typeof fetch): CapturingWriter {
  const captures = new Map<string, unknown>();
  return {
    takeCapture(id) {
      const value = captures.get(id);
      captures.delete(id);
      return value;
    },
    async write(input) {
      const chunks: Uint8Array[] = [];
      let length = 0,
        complete = false,
        mismatch = false;
      let status: number | null = null;
      const capturedFetch: typeof fetch = async (url, init) => {
        const headers = new Headers(init?.headers);
        headers.set('OpenAI-Project', projectId);
        const response = await fetcher(url, { ...init, headers });
        status = response.status;
        const returnedProject = response.headers.get('openai-project');
        mismatch = returnedProject !== null && returnedProject !== projectId;
        const reader = response.body?.getReader();
        if (!reader) return response;
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const next = await reader.read();
              if (next.done) {
                complete = true;
                controller.close();
                return;
              }
              const copy = next.value.slice(0, Math.max(0, 65536 - length));
              chunks.push(copy);
              length += copy.length;
              controller.enqueue(next.value);
            } catch {
              controller.error(new Error('Evaluation response interrupted'));
            }
          },
          async cancel() {
            await reader.cancel();
          },
        });
        return new Response(stream, { status: response.status, headers: response.headers });
      };
      const outcome = await new OpenAIResponsesTransport({
        apiKey,
        fetch: capturedFetch,
        policy,
      }).write(input);
      captures.set(input.dispatchId, {
        status,
        complete,
        boundedBytes: length,
        encoding: 'base64',
        bytes: Buffer.concat(chunks).toString('base64'),
      });
      return mismatch
        ? {
            kind: 'uncertain',
            reason: 'lost_response',
            receipt: outcome.receipt,
            haltGeneration: true,
          }
        : outcome;
    },
  };
}

function protectedJson(file: string) {
  const path = protectedPath(file),
    stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 64000 || (stat.mode & 0o077) !== 0)
    throw new Error('Permit must be a protected regular file');
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}
export async function runEvaluationCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, unknown> | EvaluationSummary> {
  if (argv.length === 1 && argv[0] === '--help')
    return {
      usage: [
        'provider:evaluate -- --dry-run [--profile baseline|smoke|human-review]',
        'provider:evaluate -- --execute --permit /protected/permit.json [--resume]',
        'provider:evaluate -- --purge-expired',
      ],
      scope: 'offline-evaluation-only',
      qualificationEligible: false,
    };
  const stateDirectory =
    env.REFLECTION_EVALUATION_STATE_DIR ??
    join(homedir(), '.local/state/reflection-provider-evaluation');
  if (argv.length === 1 && argv[0] === '--purge-expired')
    return { removed: purgeExpiredEvaluationArchives(stateDirectory), retentionDays: 90 };
  if (argv[0] === '--dry-run') {
    const profile =
      argv.length === 1
        ? 'baseline'
        : argv.length === 3 && argv[1] === '--profile'
          ? argv[2]
          : null;
    if (profile !== 'baseline' && profile !== 'smoke' && profile !== 'human-review')
      throw new Error('Invalid evaluation profile');
    const prepared = await prepareEvaluation(profile);
    const frozen = JSON.parse(
      readFileSync(resolve(projectRoot, 'evaluation/manifest.json'), 'utf8'),
    ) as unknown;
    if (profile === 'baseline' && canonicalJson(frozen) !== canonicalJson(prepared.manifest))
      throw new Error('Frozen evaluation manifest drift');
    return {
      mode: 'dry-run',
      calls: 0,
      qualificationEligible: false,
      manifestHash: prepared.manifestHash,
      manifest: prepared.manifest,
    };
  }
  if (
    argv[0] !== '--execute' ||
    argv[1] !== '--permit' ||
    !argv[2] ||
    !(argv.length === 3 || (argv.length === 4 && argv[3] === '--resume'))
  )
    throw new Error('Explicit evaluation mode and permit required');
  if (env.REFLECTION_NETWORK === 'deny' || env.CI || env.VITEST)
    throw new Error('Live evaluation is forbidden in verification');
  const apiKey = env.OPENAI_API_KEY,
    projectId = env.OPENAI_PROJECT_ID;
  if (!apiKey || !projectId || !env.REFLECTION_EVALUATION_KEY)
    throw new Error('Evaluation credentials are missing');
  const permit = EvaluationPermit.parse(protectedJson(argv[2]));
  if (permit.projectId !== projectId || permit.credentialHash !== digest(apiKey))
    throw new Error('Evaluation project or credential mismatch');
  const prepared = await prepareEvaluation(
    permit.purpose === 'transport-smoke'
      ? 'smoke'
      : permit.purpose === 'human-review'
        ? 'human-review'
        : 'baseline',
  );
  validatePermit(permit, prepared);
  // No transport exists until authorization, identity, archive protection and journal all validate.
  const journal = new EvaluationJournal(
    permit,
    {
      stateDirectory,
      checkoutRoot: projectRoot,
      key: Buffer.from(env.REFLECTION_EVALUATION_KEY, 'base64'),
      prepared,
    },
    argv[3] === '--resume',
  );
  try {
    return await runEvaluation(permit, liveWriter(apiKey, projectId, fetch), journal);
  } finally {
    journal.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(await runEvaluationCli(process.argv.slice(2)), null, 2));
  } catch {
    console.error(
      'Evaluation refused or interrupted. Check the protected permit, project, manifest, budget and journal; private details were not printed. Resume only with the original permit.',
    );
    process.exitCode = 1;
  }
}
