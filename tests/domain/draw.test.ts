import { describe, expect, it, vi } from 'vitest';
import { drawTarot, uniformIndex } from '../../src/domain/tarot/draw.ts';
const deck = [
  ...Array.from({ length: 22 }, (_, i) => `major-${String(i).padStart(2, '0')}`),
  ...['wands', 'cups', 'swords', 'pentacles'].flatMap((s) =>
    Array.from({ length: 14 }, (_, i) => `${s}-${String(i + 1).padStart(2, '0')}`),
  ),
];
const base = {
  deck,
  deckEdition: 'a'.repeat(64),
  basisId: '00000000-0000-4000-8000-000000000001',
  drawnAt: '2026-10-26T00:00:00Z',
  reversals: true,
};
describe('HMAC-SHA256 Fisher–Yates draw', () => {
  it.each([
    {
      seed: new Uint8Array(32),
      cards: ['wands-08', 'major-04', 'cups-10'],
      orientations: ['reversed', 'upright', 'upright'],
      counts: [1, 1, 0, 0],
    },
    {
      seed: Uint8Array.from({ length: 32 }, (_, i) => i),
      cards: ['wands-12', 'cups-07', 'pentacles-05'],
      orientations: ['reversed', 'reversed', 'upright'],
      counts: [1, 1, 0, 1],
    },
    {
      seed: new Uint8Array(32).fill(255),
      cards: ['swords-10', 'pentacles-07', 'wands-03'],
      orientations: ['reversed', 'upright', 'reversed'],
      counts: [1, 0, 1, 1],
    },
  ])(
    'replays independently computed seeded vector $cards',
    async ({ seed, cards, orientations, counts }) => {
      const result = await drawTarot({ ...base, seed });
      expect(result.cards.map((c) => c.cardId)).toEqual(cards);
      expect(result.cards.map((c) => c.orientation)).toEqual(orientations);
      expect(result.cards.map((c) => c.id)).toEqual([
        'card:situation',
        'card:tension',
        'card:possibility',
      ]);
      expect(result.counts.map((c) => c.count)).toEqual(counts);
      expect(result.counts.map((c) => c.id)).toEqual([
        'count:wands',
        'count:cups',
        'count:swords',
        'count:pentacles',
      ]);
    },
  );
  it('does not use question, time or basis identity as entropy and disables all reversals', async () => {
    const a = await drawTarot({ ...base, seed: new Uint8Array(32), reversals: false });
    const b = await drawTarot({
      ...base,
      seed: new Uint8Array(32),
      reversals: false,
      basisId: '00000000-0000-4000-8000-000000000002',
      drawnAt: '2026-10-27T00:00:00Z',
      ...{ question: 'private irrelevant question' },
    });
    expect(a.cards).toEqual(b.cards);
    expect(a.cards.map((c) => c.orientation)).toEqual(['upright', 'upright', 'upright']);
    expect(a.seed).toBe('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  });
  it('rejects the upper rejection-sampling interval and accepts the exact lower boundary', async () => {
    const values = [4294967295, 4294967274, 4294967273];
    let reads = 0;
    expect(
      await uniformIndex(async () => {
        reads++;
        return values.shift()!;
      }, 78),
    ).toBe(77);
    expect(reads).toBe(3);
    expect(await uniformIndex(async () => 4294967295, 2)).toBe(1);
  });
  it.each([new Uint8Array(0), new Uint8Array(31), new Uint8Array(33)])(
    'rejects a non-256-bit seed',
    async (seed) => {
      await expect(drawTarot({ ...base, seed })).rejects.toThrow('BAD_INPUT');
    },
  );
  it.each([
    { invalid: deck.slice(1) },
    { invalid: [...deck.slice(0, 77), deck[0]!] },
    { invalid: [...deck.slice(0, 77), 'invalid-card'] },
  ])('rejects incomplete, duplicate or invalid decks', async ({ invalid }) => {
    await expect(drawTarot({ ...base, deck: invalid, seed: new Uint8Array(32) })).rejects.toThrow(
      'BAD_INPUT',
    );
  });
  it('fails closed when secure randomness is unavailable', async () => {
    const entropy = vi.spyOn(crypto, 'getRandomValues').mockImplementation(() => {
      throw new Error('synthetic entropy unavailable');
    });
    try {
      await expect(drawTarot(base)).rejects.toThrow('synthetic entropy unavailable');
    } finally {
      entropy.mockRestore();
    }
  });
  it('uses secure randomness when a local replay seed is absent', async () => {
    const a = await drawTarot(base);
    const b = await drawTarot(base);
    expect(a.seed).toHaveLength(43);
    expect(a.seed).not.toBe(b.seed);
  });
});
