import { z } from 'zod';
import {
  ModelCandidate,
  ModelCandidateV2,
  ProviderReceipt,
  type WriterOutcome,
  type WritingProvider,
} from '../../contracts/index.ts';
import type { WriterProviderPolicy } from '../../contracts/provider-policy.ts';
import { boundedCandidateJson } from '../../domain/tarot/safety.ts';

const Count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Metadata = z.object({
  id: z.string().min(1).max(300).nullish(),
  model: z.string().min(1).max(200),
  service_tier: z.string().min(1).max(32),
  usage: z
    .object({
      input_tokens: Count,
      output_tokens: Count,
      total_tokens: Count,
      input_tokens_details: z.object({ cached_tokens: Count, cache_write_tokens: Count }),
      output_tokens_details: z.object({ reasoning_tokens: Count }),
    })
    .refine(
      (v) =>
        Number.isSafeInteger(v.input_tokens + v.output_tokens) &&
        v.total_tokens === v.input_tokens + v.output_tokens,
    ),
});
const MessageOutput = z.object({
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
    .length(1),
});
const ReasoningOutput = z.object({
  id: z.string().min(1).max(300),
  type: z.literal('reasoning'),
  status: z.literal('completed').optional(),
  summary: z.array(z.object({ type: z.literal('summary_text'), text: z.string() })),
});
const Output = z
  .array(z.discriminatedUnion('type', [MessageOutput, ReasoningOutput]))
  .min(1)
  .max(16)
  .refine(
    (items) =>
      items.filter((item) => item.type === 'message').length === 1 &&
      items.at(-1)?.type === 'message',
  );

const RefusalEnvelope = z.object({ output: z.array(z.unknown()) });
const AssistantMessage = z.object({
  type: z.literal('message'),
  role: z.literal('assistant'),
  content: z.array(z.unknown()),
});
const RefusalPart = z.object({ type: z.literal('refusal'), refusal: z.string() });
function hasRefusal(value: unknown): boolean {
  const envelope = RefusalEnvelope.safeParse(value);
  return (
    envelope.success &&
    envelope.data.output.some((item) => {
      const message = AssistantMessage.safeParse(item);
      return (
        message.success && message.data.content.some((part) => RefusalPart.safeParse(part).success)
      );
    })
  );
}

function hasResponseMetadata(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (Object.hasOwn(value, 'usage') ||
      Object.hasOwn(value, 'model') ||
      Object.hasOwn(value, 'output') ||
      ('object' in value && value.object === 'response'))
  );
}

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
        void reader.cancel().catch(() => {});
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
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

function receipt(value: unknown, durationMs: number): ProviderReceipt | null {
  const meta = Metadata.safeParse(value);
  if (!meta.success) return null;
  const { usage, ...body } = meta.data;
  const parsed = ProviderReceipt.safeParse({
    responseId: body.id ?? null,
    returnedModel: body.model,
    serviceTier: body.service_tier,
    durationMs,
    usage: {
      inputTokens: usage.input_tokens,
      cachedInputTokens: usage.input_tokens_details.cached_tokens,
      cacheWriteTokens: usage.input_tokens_details.cache_write_tokens,
      outputTokens: usage.output_tokens,
      reasoningTokens: usage.output_tokens_details.reasoning_tokens,
    },
  });
  return parsed.success ? parsed.data : null;
}

/** One bounded direct HTTPS attempt. Application qualification belongs to the wrapper. */
export class OpenAIResponsesTransport implements WritingProvider {
  constructor(
    private readonly options: {
      apiKey: string;
      fetch: typeof fetch;
      policy: WriterProviderPolicy;
    },
  ) {}
  async write(input: Parameters<WritingProvider['write']>[0]): Promise<WriterOutcome> {
    const { policy, fetch: fetcher, apiKey } = this.options;
    if (!apiKey || !fetcher) return { kind: 'rejected', status: 503, receipt: null };
    try {
      const Payload = z.strictObject({
        model: z.literal(policy.model),
        reasoning: z.strictObject({ effort: z.literal(policy.request.reasoning.effort) }),
        max_output_tokens: z.literal(policy.request.max_output_tokens),
        store: z.literal(policy.request.store),
        service_tier: z.literal(policy.request.service_tier),
        prompt_cache_options: z.strictObject({
          mode: z.literal(policy.request.prompt_cache_options.mode),
          ttl: z.literal(policy.request.prompt_cache_options.ttl),
        }),
        input: z.tuple([
          z.strictObject({ role: z.literal('system'), content: z.literal(policy.prompt.system) }),
          z.strictObject({
            role: z.literal('developer'),
            content: z.literal(policy.prompt.developer),
          }),
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
      if (
        input.model !== policy.model ||
        input.store !== policy.request.store ||
        input.reasoning !== policy.request.reasoning.effort ||
        input.timeoutMs !== policy.timeoutMs ||
        input.maxOutputTokens !== policy.request.max_output_tokens ||
        input.payload.length > policy.estimator.maxPayloadBytes ||
        input.payload.length + policy.estimator.framingTokens > policy.estimator.maxInputTokens
      )
        throw new Error();
      Payload.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input.payload)));
    } catch {
      return { kind: 'rejected', status: 400, receipt: null };
    }
    if (input.signal.aborted) return { kind: 'uncertain', reason: 'network', receipt: null };
    const controller = new AbortController(),
      started = Date.now();
    let timedOut = false,
      abort!: () => void;
    const stopped = new Promise<WriterOutcome>((resolve) => {
      abort = () => {
        controller.abort();
        resolve({ kind: 'uncertain', reason: timedOut ? 'timeout' : 'network', receipt: null });
      };
    });
    input.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      abort();
    }, policy.timeoutMs);
    try {
      const request = async (): Promise<WriterOutcome> => {
        let response: Response;
        try {
          response = await fetcher(policy.endpoint, {
            method: 'POST',
            // Workers supports manual redirects; non-2xx replies are rejected below.
            redirect: 'manual',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: new Uint8Array(input.payload),
            signal: controller.signal,
          });
        } catch {
          return { kind: 'uncertain', reason: timedOut ? 'timeout' : 'network', receipt: null };
        }
        let body: unknown;
        try {
          body = response.body ? await readResponse(response, controller.signal) : null;
        } catch {
          return response.ok
            ? {
                kind: 'uncertain',
                reason: timedOut ? 'timeout' : 'lost_response',
                receipt: null,
                haltGeneration: true,
              }
            : { kind: 'rejected', status: this.status(response.status), receipt: null };
        }
        const known = receipt(body, Math.max(0, Date.now() - started));
        if (!response.ok && !known && !hasResponseMetadata(body))
          return { kind: 'rejected', status: this.status(response.status), receipt: known };
        if (
          !known ||
          known.returnedModel !== policy.model ||
          known.serviceTier !== policy.request.service_tier ||
          known.usage.inputTokens > policy.estimator.maxInputTokens ||
          known.usage.outputTokens > policy.request.max_output_tokens
        )
          return {
            kind: 'uncertain',
            reason: 'lost_response',
            receipt: known,
            haltGeneration: true,
          };
        // Explicit refusal is a non-reading even when other output parts or the wrapper are unusable.
        if (hasRefusal(body)) return { kind: 'refusal', receipt: known };
        if (!response.ok)
          return { kind: 'rejected', status: this.status(response.status), receipt: known };
        const envelope = z
          .object({ status: z.string(), error: z.null().optional(), output: z.unknown() })
          .safeParse(body);
        if (envelope.success && envelope.data.status === 'incomplete')
          return { kind: 'invalid', reason: 'incomplete', receipt: known };
        if (!envelope.success || envelope.data.status !== 'completed')
          return { kind: 'invalid', reason: 'malformed', receipt: known };
        const output = Output.safeParse(envelope.data.output);
        if (
          !output.success ||
          (policy.request.reasoning.effort === 'none' && output.data.length !== 1)
        )
          return { kind: 'invalid', reason: 'malformed', receipt: known };
        // Reasoning metadata is never interpreted or returned as reading content.
        const part = output.data.find((item) => item.type === 'message')!.content[0]!;
        if (part.type === 'refusal') return { kind: 'refusal', receipt: known };
        try {
          const candidate: unknown = JSON.parse(part.text);
          boundedCandidateJson(candidate);
          const schema =
            policy.schemaVersion === 'tarot.interpretation.v2' ? ModelCandidateV2 : ModelCandidate;
          return { kind: 'candidate', candidate: schema.parse(candidate), receipt: known };
        } catch {
          return { kind: 'invalid', reason: 'malformed', receipt: known };
        }
      };
      return await Promise.race([request(), stopped]);
    } finally {
      clearTimeout(timer);
      input.signal.removeEventListener('abort', abort);
    }
  }
  private status(value: number): 400 | 401 | 403 | 429 | 500 | 503 {
    if (value === 401 || value === 403 || value === 429 || value === 500 || value === 503)
      return value;
    return value >= 500 ? 503 : 400;
  }
}
