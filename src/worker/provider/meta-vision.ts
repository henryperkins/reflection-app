import { z } from 'zod';
import {
  type CardId,
  Position,
  ProviderReceipt,
  SpreadPhoto,
  SpreadRecognition,
  type SpreadRecognizer,
} from '../../contracts/index.ts';
import { drawTarot } from '../../domain/tarot/draw.ts';
import { SPREAD_PROVIDER_POLICY } from '../../contracts/spread-policy.ts';

export const META_RESPONSES_URL = 'https://api.meta.ai/v1/responses';
export const META_SPREAD_MODEL = SPREAD_PROVIDER_POLICY.model;

const MetaContentItem = z.object({
  type: z.string(),
  text: z.string().optional(),
  refusal: z.string().optional(),
});

const MetaOutputItem = z.object({
  type: z.string(),
  role: z.string().optional(),
  content: z.array(MetaContentItem).optional(),
});

const MetaResponseEnvelope = z.object({
  id: z.string().optional(),
  status: z.string().optional(),
  model: z.string().optional(),
  service_tier: z.string().optional(),
  usage: z.unknown().optional(),
  output: z.array(MetaOutputItem).optional(),
});
const MetaUsage = z.object({
  input_tokens: z.number(),
  input_tokens_details: z.object({ cached_tokens: z.number().optional() }).optional(),
  output_tokens: z.number(),
  output_tokens_details: z.object({ reasoning_tokens: z.number().optional() }).optional(),
});

export function buildSpreadRecognitionPrompt(
  deck: ReadonlyArray<{ id: z.infer<typeof CardId>; name: string }>,
): string {
  const catalog = deck.map((card) => `${card.id}: ${card.name}`).join('\n');
  return [
    'Examine this photo of a 3-card tarot spread dealt left-to-right.',
    'Identify the three distinct tarot cards from left to right as:',
    '1. situation (left card)',
    '2. tension (middle card)',
    '3. possibility (right card)',
    'For each position, return its canonical cardId from the catalog below and whether the card appears upright or reversed (upside-down relative to the viewer).',
    'Never repeat the same cardId twice.',
    '',
    'Canonical 78-card catalog:',
    catalog,
  ].join('\n');
}

export function buildMetaSpreadRequestBody(input: {
  spreadPhoto: SpreadPhoto;
  deck: ReadonlyArray<{ id: z.infer<typeof CardId>; name: string }>;
  model?: string;
}) {
  const photo = SpreadPhoto.parse(input.spreadPhoto);
  const deckIds = input.deck.map((card) => card.id) as [string, ...string[]];
  const schema = z.toJSONSchema(
    SpreadRecognition.extend({
      cards: z
        .array(
          SpreadRecognition.shape.cards.element.extend({
            cardId: z.enum(deckIds),
          }),
        )
        .length(3),
    }),
  );
  return {
    model: input.model ?? META_SPREAD_MODEL,
    store: false as const,
    max_output_tokens: SPREAD_PROVIDER_POLICY.maxOutputTokens,
    reasoning: { effort: 'low' as const },
    input: [
      {
        type: 'message' as const,
        role: 'user' as const,
        content: [
          {
            type: 'input_text' as const,
            text: buildSpreadRecognitionPrompt(input.deck),
          },
          {
            type: 'input_image' as const,
            image_url: photo,
          },
        ],
      },
    ],
    text: {
      format: {
        type: 'json_schema' as const,
        name: 'tarot_spread_recognition',
        strict: true,
        schema,
      },
    },
  };
}

function validateRecognizedSpread(
  candidate: unknown,
  deck: ReadonlyArray<{ id: z.infer<typeof CardId>; name: string }>,
): SpreadRecognition {
  const parsed = SpreadRecognition.safeParse(candidate);
  if (!parsed.success) throw new Error('INVALID_CANDIDATE: spread recognition schema');
  const deckIds = new Set(deck.map((card) => card.id));
  const cards = Position.options.map((position) => {
    const match = parsed.data.cards.find((card) => card.position === position);
    if (!match || !deckIds.has(match.cardId))
      throw new Error('INVALID_CANDIDATE: spread position or cardId');
    return match;
  });
  if (new Set(cards.map((card) => card.cardId)).size !== 3)
    throw new Error('INVALID_CANDIDATE: duplicate recognized card');
  return { cards };
}

/** Meta Model API (/v1/responses) vision recognizer for user-uploaded tarot spread photos. */
export class MetaSpreadRecognizer implements SpreadRecognizer {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: {
    apiKey: string;
    endpoint?: string;
    model?: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
  }) {
    if (!options.apiKey.trim()) throw new Error('PROVIDER_UNAVAILABLE: missing MODEL_API_KEY');
    this.apiKey = options.apiKey.trim();
    this.endpoint = options.endpoint ?? META_RESPONSES_URL;
    this.model = options.model ?? META_SPREAD_MODEL;
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? SPREAD_PROVIDER_POLICY.timeoutMs;
  }

  async recognize(input: {
    spreadPhoto: SpreadPhoto;
    deck: ReadonlyArray<{ id: z.infer<typeof CardId>; name: string }>;
    signal?: AbortSignal;
    onReceipt?: (receipt: ProviderReceipt) => Promise<void>;
  }): Promise<SpreadRecognition> {
    const body = buildMetaSpreadRequestBody({
      spreadPhoto: input.spreadPhoto,
      deck: input.deck,
      model: this.model,
    });
    const started = Date.now();
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetcher(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch {
      throw new Error('PROVIDER_UNAVAILABLE: Meta Model API network failure');
    }
    if (!response.ok) {
      throw new Error(`PROVIDER_UNAVAILABLE: Meta Model API status ${response.status}`);
    }
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw new Error('INVALID_CANDIDATE: malformed Meta Model API JSON');
    }
    const envelope = MetaResponseEnvelope.safeParse(raw);
    const parsedUsage = MetaUsage.safeParse(envelope.success ? envelope.data.usage : undefined);
    if (envelope.success && parsedUsage.success && input.onReceipt) {
      const usage = parsedUsage.data;
      const receipt = ProviderReceipt.safeParse({
        responseId: envelope.data.id ?? null,
        returnedModel: envelope.data.model,
        serviceTier: envelope.data.service_tier ?? 'auto',
        durationMs: Date.now() - started,
        usage: {
          inputTokens: usage.input_tokens,
          cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? 0,
          cacheWriteTokens: 0,
          outputTokens: usage.output_tokens,
          reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
        },
      });
      if (receipt.success) await input.onReceipt(receipt.data);
    }
    if (!envelope.success || envelope.data.status !== 'completed') {
      throw new Error('PROVIDER_UNAVAILABLE: incomplete Meta Model API response');
    }
    const contents = (envelope.data.output ?? [])
      .filter((item) => item.type === 'message')
      .flatMap((item) => item.content ?? []);
    if (contents.some((item) => item.type === 'refusal' || Boolean(item.refusal))) {
      throw new Error('PROVIDER_REFUSAL: spread photo refused');
    }
    const textItem = contents.find(
      (item) => item.type === 'output_text' && typeof item.text === 'string',
    );
    if (!textItem?.text) {
      throw new Error('INVALID_CANDIDATE: missing output_text from Meta Model API');
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(textItem.text);
    } catch {
      throw new Error('INVALID_CANDIDATE: non-JSON output_text from Meta Model API');
    }
    return validateRecognizedSpread(parsedJson, input.deck);
  }
}

/** Deterministic offline recognizer for synthetic-local mode and zero-network verification. */
export class DeterministicSpreadRecognizer implements SpreadRecognizer {
  async recognize(input: {
    spreadPhoto: SpreadPhoto;
    deck: ReadonlyArray<{ id: z.infer<typeof CardId>; name: string }>;
  }): Promise<SpreadRecognition> {
    const photo = SpreadPhoto.parse(input.spreadPhoto);
    const seed = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(photo)),
    );
    const basis = await drawTarot({
      deck: input.deck.map((card) => card.id),
      deckEdition: '0'.repeat(64),
      basisId: '10101010-1010-4010-8010-101010101010',
      drawnAt: '2026-10-31T00:00:00Z',
      reversals: true,
      seed,
    });
    return {
      cards: basis.cards.map((card) => ({
        position: card.position,
        cardId: card.cardId,
        orientation: card.orientation,
      })),
    };
  }
}
