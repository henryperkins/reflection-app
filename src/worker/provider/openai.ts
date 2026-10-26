import { z } from 'zod';
import type { WritingProvider, WriterOutcome } from '../../contracts/index.ts';
import { boundedCandidateJson } from '../../domain/tarot/safety.ts';

/** Evidence hashes are operator-reviewed receipts, never inferred from a key or model listing. */
export interface ProviderQualification {
  version: 'openai-responses.qualification.v1';
  model: 'gpt-5.6-terra';
  policyHash: string;
  expiresAt: string;
  evidence: {
    projectAccess: string;
    retention: string;
    editorial: string;
    corpus: string;
    tokenEstimator: string;
    pricing: string;
  };
}
export interface OpenAIProviderOptions {
  enabled?: boolean;
  apiKey?: string;
  /** Required injection: importing this module never selects a global network transport. */
  fetch?: typeof fetch;
  qualification?: ProviderQualification;
  expectedPolicyHash?: string;
}
const Qualification = z.strictObject({
  version: z.literal('openai-responses.qualification.v1'),
  model: z.literal('gpt-5.6-terra'),
  policyHash: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.iso.datetime(),
  evidence: z
    .strictObject({
      projectAccess: z.string(),
      retention: z.string(),
      editorial: z.string(),
      corpus: z.string(),
      tokenEstimator: z.string(),
      pricing: z.string(),
    })
    .refine((v) => Object.values(v).every((hash) => /^[a-f0-9]{64}$/.test(hash))),
});
const Payload = z.strictObject({
  model: z.literal('gpt-5.6-terra'),
  reasoning: z.strictObject({ effort: z.literal('none') }),
  max_output_tokens: z.literal(1600),
  store: z.literal(false),
  input: z.tuple([
    z.strictObject({ role: z.literal('system'), content: z.string() }),
    z.strictObject({ role: z.literal('developer'), content: z.string() }),
    z.strictObject({ role: z.literal('user'), content: z.string() }),
  ]),
  text: z.strictObject({
    format: z.strictObject({
      type: z.literal('json_schema'),
      name: z.literal('tarot_interpretation'),
      strict: z.literal(true),
      schema: z.record(z.string(), z.unknown()),
    }),
  }),
});
const Envelope = z.object({
  id: z.string().min(1).max(300),
  status: z.literal('completed'),
  model: z.string().min(1).max(200),
  error: z.null().optional(),
  usage: z.object({
    input_tokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    output_tokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  }),
  output: z
    .array(
      z.object({
        type: z.literal('message'),
        role: z.literal('assistant'),
        status: z.literal('completed').optional(),
        content: z
          .array(
            z.discriminatedUnion('type', [
              z.object({ type: z.literal('output_text'), text: z.string() }),
              z.object({ type: z.literal('refusal'), refusal: z.string() }),
            ]),
          )
          .min(1),
      }),
    )
    .length(1),
});
async function readResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty provider response');
  const chunks: Uint8Array[] = [];
  let length = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw new Error('Provider deadline');
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > 65536) {
        await reader.cancel();
        throw new Error('Provider response bound');
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    boundedCandidateJson(value);
    return value;
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

/** Disabled by default and unwired from application bindings; only intercepted qualification tests enable it. */
export class OpenAIWritingProvider implements WritingProvider {
  constructor(private readonly options: OpenAIProviderOptions = {}) {}
  async write(input: Parameters<WritingProvider['write']>[0]): Promise<WriterOutcome> {
    const config = this.options,
      qualification = Qualification.safeParse(config.qualification);
    if (
      !config.enabled ||
      !config.fetch ||
      !config.apiKey ||
      !qualification.success ||
      qualification.data.policyHash !== config.expectedPolicyHash ||
      Date.parse(qualification.data.expiresAt) <= Date.now()
    )
      return { kind: 'rejected', status: 503 };
    try {
      if (
        input.model !== 'gpt-5.6-terra' ||
        input.store !== false ||
        input.reasoning !== 'none' ||
        input.timeoutMs !== 18000 ||
        input.maxOutputTokens !== 1600 ||
        input.payload.length > 28 * 1024 ||
        input.payload.length + 256 > 8000
      )
        throw new Error();
      Payload.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input.payload)));
    } catch {
      return { kind: 'rejected', status: 400 };
    }
    if (input.signal.aborted) return { kind: 'uncertain', reason: 'network' };
    const controller = new AbortController(),
      started = Date.now();
    let timedOut = false,
      abort!: () => void;
    const stopped = new Promise<WriterOutcome>((resolve) => {
      abort = () => {
        controller.abort();
        resolve({ kind: 'uncertain', reason: timedOut ? 'timeout' : 'network' });
      };
    });
    input.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      abort();
    }, 18000);
    try {
      const request = async (): Promise<WriterOutcome> => {
        let response: Response;
        try {
          response = await config.fetch!('https://api.openai.com/v1/responses', {
            method: 'POST',
            redirect: 'error',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${config.apiKey}`,
            },
            body: new Uint8Array(input.payload),
            signal: controller.signal,
          });
        } catch {
          return { kind: 'uncertain', reason: timedOut ? 'timeout' : 'network' };
        }
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          const status = (
            [400, 401, 403, 429, 500, 503].includes(response.status)
              ? response.status
              : response.status >= 500
                ? 503
                : 400
          ) as 400 | 401 | 403 | 429 | 500 | 503;
          return { kind: 'rejected', status };
        }
        try {
          const body = Envelope.parse(await readResponse(response, controller.signal));
          if (body.model !== qualification.data.model)
            return { kind: 'uncertain', reason: 'lost_response' };
          const content = body.output[0]!.content;
          if (content.some((part) => part.type === 'refusal')) return { kind: 'refusal' };
          if (content.length !== 1 || content[0]!.type !== 'output_text')
            return { kind: 'uncertain', reason: 'lost_response' };
          const candidate: unknown = JSON.parse(content[0]!.text);
          boundedCandidateJson(candidate);
          return {
            kind: 'candidate',
            candidate,
            providerResponseId: body.id,
            returnedModel: body.model,
            inputTokens: body.usage.input_tokens,
            outputTokens: body.usage.output_tokens,
            durationMs: Date.now() - started,
          };
        } catch {
          return { kind: 'uncertain', reason: timedOut ? 'timeout' : 'lost_response' };
        }
      };
      return await Promise.race([request(), stopped]);
    } finally {
      clearTimeout(timer);
      input.signal.removeEventListener('abort', abort);
    }
  }
}
