import {
  CardId,
  Hash,
  Id,
  Instant,
  Position,
  SpreadPhoto,
  SpreadRecognition,
  Suit,
  TarotBasis,
} from '../../contracts/index.ts';
import { assertBasis } from './facts.ts';
export type DrawInput = {
  deck: readonly string[];
  deckEdition: string;
  basisId: string;
  drawnAt: string;
  reversals: boolean;
  seed?: Uint8Array;
};
export type SpreadBasisInput = {
  deck: readonly string[];
  deckEdition: string;
  basisId: string;
  drawnAt: string;
  reversals: boolean;
  spreadPhoto: string;
  recognized: SpreadRecognition;
};
/** Rejection sampling over unsigned 32-bit words, with a bound on pathological exhaustion. */
export async function uniformIndex(nextWord: () => Promise<number>, size: number): Promise<number> {
  if (!Number.isInteger(size) || size < 1 || size > 78) throw new Error('BAD_INPUT: sampling size');
  const ceiling = Math.floor(2 ** 32 / size) * size;
  for (let attempts = 0; attempts < 1024; attempts++) {
    const word = await nextWord();
    if (!Number.isInteger(word) || word < 0 || word >= 2 ** 32)
      throw new Error('BAD_INPUT: unsigned word');
    if (word < ceiling) return word % size;
  }
  throw new Error('INTERNAL: entropy exhaustion');
}
/** Local domain replay seam only. Production callers must never accept a client seed. */
export async function drawTarot(input: DrawInput): Promise<TarotBasis> {
  if (
    input.deck.length !== 78 ||
    new Set(input.deck).size !== 78 ||
    input.deck.some((id) => !CardId.safeParse(id).success) ||
    !Hash.safeParse(input.deckEdition).success ||
    !Id.safeParse(input.basisId).success ||
    !Instant.safeParse(input.drawnAt).success ||
    typeof input.reversals !== 'boolean' ||
    (input.seed !== undefined &&
      (!(input.seed instanceof Uint8Array) || input.seed.byteLength !== 32))
  ) {
    throw new Error('BAD_INPUT: draw parameters');
  }
  const seed = input.seed
    ? Uint8Array.from(input.seed)
    : crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey('raw', seed, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const domain = new TextEncoder().encode('reflection.draw.v1');
  let counter = 0n;
  let block = new DataView(new ArrayBuffer(0));
  let offset = 0;
  const nextWord = async () => {
    if (offset >= block.byteLength) {
      const message = new Uint8Array(domain.length + 8);
      message.set(domain);
      new DataView(message.buffer).setBigUint64(domain.length, counter++, false);
      block = new DataView(await crypto.subtle.sign('HMAC', key, message));
      offset = 0;
    }
    const word = block.getUint32(offset, false);
    offset += 4;
    return word;
  };
  const shuffled = [...input.deck];
  for (let i = 77; i > 0; i--) {
    const j = await uniformIndex(nextWord, i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  const cards: TarotBasis['cards'] = [];
  for (const [i, position] of Position.options.entries()) {
    const orientation = input.reversals && (await nextWord()) % 2 === 1 ? 'reversed' : 'upright';
    cards.push({
      kind: 'tarot.card',
      id: `card:${position}`,
      position,
      cardId: shuffled[i]!,
      orientation,
    });
  }
  return TarotBasis.parse({
    kind: 'tarot.v1',
    schemaVersion: 1,
    basisId: input.basisId,
    deckEdition: input.deckEdition,
    spread: 'situation-tension-possibility.v1',
    drawAlgorithm: 'hmac-sha256-fisher-yates-reject.v1',
    seed: btoa(String.fromCharCode(...seed))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, ''),
    reversals: input.reversals,
    cards,
    counts: Suit.options.map((suit) => ({
      kind: 'tarot.suit_count',
      id: `count:${suit}`,
      suit,
      count: cards.filter((card) => card.cardId.startsWith(`${suit}-`)).length,
    })),
    drawnAt: input.drawnAt,
  });
}

/** Construct a canonical TarotBasis from a recognized 3-card offline spread photo. */
export async function basisFromSpread(input: SpreadBasisInput): Promise<TarotBasis> {
  const parsedRecognition = SpreadRecognition.safeParse(input.recognized);
  if (
    input.deck.length !== 78 ||
    new Set(input.deck).size !== 78 ||
    input.deck.some((id) => !CardId.safeParse(id).success) ||
    !Hash.safeParse(input.deckEdition).success ||
    !Id.safeParse(input.basisId).success ||
    !Instant.safeParse(input.drawnAt).success ||
    typeof input.reversals !== 'boolean' ||
    !SpreadPhoto.safeParse(input.spreadPhoto).success ||
    !parsedRecognition.success
  ) {
    throw new Error('BAD_INPUT: spread parameters');
  }
  const deckSet = new Set(input.deck);
  const cards: TarotBasis['cards'] = Position.options.map((position) => {
    const match = parsedRecognition.data.cards.find((card) => card.position === position);
    if (!match || !deckSet.has(match.cardId)) throw new Error('BAD_INPUT: spread card binding');
    return {
      kind: 'tarot.card',
      id: `card:${position}`,
      position,
      cardId: match.cardId,
      orientation: match.orientation,
    };
  });
  if (new Set(cards.map((card) => card.cardId)).size !== 3)
    throw new Error('BAD_INPUT: repeated card');
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input.spreadPhoto)),
  );
  const reversals = input.reversals || cards.some((card) => card.orientation === 'reversed');
  return assertBasis({
    kind: 'tarot.v1',
    schemaVersion: 1,
    basisId: input.basisId,
    deckEdition: input.deckEdition,
    spread: 'situation-tension-possibility.v1',
    drawAlgorithm: 'hmac-sha256-fisher-yates-reject.v1',
    seed: btoa(String.fromCharCode(...digest))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, ''),
    reversals,
    cards,
    counts: Suit.options.map((suit) => ({
      kind: 'tarot.suit_count',
      id: `count:${suit}`,
      suit,
      count: cards.filter((card) => card.cardId.startsWith(`${suit}-`)).length,
    })),
    drawnAt: input.drawnAt,
  });
}
