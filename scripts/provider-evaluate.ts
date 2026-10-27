import { readFileSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WritingProvider, WriterOutcome } from '../src/contracts/index.ts';
import { canonicalJson } from '../src/domain/json.ts';
import { validateCandidate } from '../src/domain/tarot/safety.ts';
import { validateCandidateV2 } from '../src/domain/tarot/safety-v2.ts';
import { OpenAIResponsesTransport } from '../src/worker/provider/transport.ts';
import { projectRoot } from './schemas.ts';
import {
  prepareEvaluation,
  evaluationPolicyForRequest,
  type PreparedEvaluation,
} from './provider-evaluation-corpus.ts';
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
            if (request.plan.version === 'tarot-plan.v2')
              await validateCandidateV2(
                request.plan,
                outcome.candidate,
                request.contextReceipt ?? null,
              );
            else validateCandidate(request.plan, outcome.candidate);
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
function liveWriter(
  apiKey: string,
  projectId: string,
  fetcher: typeof fetch,
  prepared: PreparedEvaluation,
): CapturingWriter {
  const captures = new Map<string, unknown>();
  return {
    takeCapture(id) {
      const value = captures.get(id);
      captures.delete(id);
      return value;
    },
    async write(input) {
      const policy = evaluationPolicyForRequest(prepared, input.dispatchId);
      const startedAt = new Date().toISOString();
      let fetchStartedAt: string | null = null,
        responseHeadersAt: string | null = null,
        providerRequestId: string | null = null,
        fetchInvocations = 0;
      const chunks: Uint8Array[] = [];
      let length = 0,
        complete = false,
        mismatch = false;
      let status: number | null = null;
      const capturedFetch: typeof fetch = async (url, init) => {
        fetchInvocations++;
        fetchStartedAt = new Date().toISOString();
        const headers = new Headers(init?.headers);
        headers.set('OpenAI-Project', projectId);
        const response = await fetcher(url, { ...init, headers });
        responseHeadersAt = new Date().toISOString();
        providerRequestId = response.headers.get('x-request-id')?.slice(0, 300) ?? null;
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
        startedAt,
        fetchStartedAt,
        responseHeadersAt,
        finishedAt: new Date().toISOString(),
        providerRequestId,
        fetchInvocations,
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
function diagnosticBundle(file: string) {
  const within = relative(projectRoot, resolve(file));
  if (!within.startsWith(`..${sep}`) && within !== '..')
    throw new Error('Diagnostic sources must remain outside checkout');
  return protectedJson(file);
}
export async function runEvaluationCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, unknown> | EvaluationSummary> {
  if (argv.length === 1 && argv[0] === '--help')
    return {
      usage: [
        'provider:evaluate -- --dry-run [--profile baseline|smoke|human-review|human-review-fast-xhigh]',
        'provider:evaluate -- --dry-run --profile source-diagnostic-fast-xhigh --source-bundle /protected/sources.json',
        'provider:evaluate -- --dry-run --profile prompt-comparison-fast-xhigh --source-bundle /protected/sources.json',
        'provider:evaluate -- --dry-run --profile independent-context-fast-xhigh --source-bundle /protected/sources.json',
        'provider:evaluate -- --dry-run --profile reading-v2-development-fast-xhigh',
        'provider:evaluate -- --dry-run --profile reading-v2-editorial-fast-xhigh',
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
        : (argv.length === 3 || argv.length === 5) && argv[1] === '--profile'
          ? argv[2]
          : null;
    if (
      profile !== 'baseline' &&
      profile !== 'smoke' &&
      profile !== 'human-review' &&
      profile !== 'human-review-fast-xhigh' &&
      profile !== 'source-diagnostic-fast-xhigh' &&
      profile !== 'prompt-comparison-fast-xhigh' &&
      profile !== 'independent-context-fast-xhigh' &&
      profile !== 'reading-v2-development-fast-xhigh' &&
      profile !== 'reading-v2-editorial-fast-xhigh'
    )
      throw new Error('Invalid evaluation profile');
    const diagnostic =
      profile === 'source-diagnostic-fast-xhigh' ||
      profile === 'prompt-comparison-fast-xhigh' ||
      profile === 'independent-context-fast-xhigh';
    if (diagnostic ? argv.length !== 5 || argv[3] !== '--source-bundle' : argv.length > 3)
      throw new Error('Diagnostic source bundle required only for diagnostic profile');
    const prepared = await prepareEvaluation(
      profile,
      diagnostic ? diagnosticBundle(argv[4]!) : undefined,
    );
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
      : permit.purpose === 'synthetic-research'
        ? 'baseline'
        : permit.purpose,
    (permit.purpose === 'source-diagnostic-fast-xhigh' ||
      permit.purpose === 'prompt-comparison-fast-xhigh' ||
      permit.purpose === 'independent-context-fast-xhigh') &&
      permit.sourceBundlePath
      ? diagnosticBundle(permit.sourceBundlePath)
      : undefined,
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
    return await runEvaluation(permit, liveWriter(apiKey, projectId, fetch, prepared), journal);
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
