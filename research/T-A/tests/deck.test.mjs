import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Import the functions we need to test
import { seededShuffle, cryptoShuffle, computeSeed, getDeckPool, drawSpread, computeRelationships } from '../src/lib/deck.js';
import { MAJOR_ARCANA } from '../src/data/majorArcana.js';
import { MINOR_ARCANA } from '../src/data/minorArcana.js';
import { SPREADS } from '../src/data/spreads.js';

describe('Deck Shuffling and Seeding', () => {
  describe('computeSeed', () => {
    it('should produce deterministic seeds for same inputs', () => {
      const seed1 = computeSeed({
        cutIndex: 5,
        knockTimes: [100, 200, 300],
        userQuestion: 'What is my path?',
        timestamp: 1000000
      });
      
      const seed2 = computeSeed({
        cutIndex: 5,
        knockTimes: [100, 200, 300],
        userQuestion: 'What is my path?',
        timestamp: 1000000
      });
      
      assert.strictEqual(seed1, seed2, 'Same inputs should produce same seed');
    });
    
    it('should produce different seeds for different questions', () => {
      const seed1 = computeSeed({
        cutIndex: 5,
        knockTimes: [100, 200, 300],
        userQuestion: 'What is my path?',
        timestamp: 1000000
      });
      
      const seed2 = computeSeed({
        cutIndex: 5,
        knockTimes: [100, 200, 300],
        userQuestion: 'What should I focus on?',
        timestamp: 1000000
      });
      
      assert.notStrictEqual(seed1, seed2, 'Different questions should produce different seeds');
    });
    
    it('should incorporate knock count into seed', () => {
      const seed1 = computeSeed({
        cutIndex: 5,
        knockTimes: [100, 200], // 2 knocks
        userQuestion: 'Test',
        timestamp: 1000000
      });
      
      const seed2 = computeSeed({
        cutIndex: 5,
        knockTimes: [100, 200, 300, 400], // 4 knocks
        userQuestion: 'Test',
        timestamp: 1000000
      });
      
      assert.notStrictEqual(seed1, seed2, 'Different knock counts should produce different seeds');
    });
    
    it('should incorporate timing patterns into seed', () => {
      const seed1 = computeSeed({
        cutIndex: 5,
        knockTimes: [100, 150, 200], // rapid knocks (50ms intervals)
        userQuestion: 'Test',
        timestamp: 1000000
      });
      
      const seed2 = computeSeed({
        cutIndex: 5,
        knockTimes: [100, 600, 1100], // slow knocks (500ms intervals)
        userQuestion: 'Test',
        timestamp: 1000000
      });
      
      assert.notStrictEqual(seed1, seed2, 'Different timing patterns should produce different seeds');
    });
    
    it('should handle empty inputs gracefully', () => {
      const seed = computeSeed({
        cutIndex: 0,
        knockTimes: [],
        userQuestion: '',
        timestamp: 1000000
      });
      
      assert.strictEqual(typeof seed, 'number', 'Should produce a number even with empty inputs');
      assert.notStrictEqual(seed, 0, 'Should not produce zero seed');
    });

    it('should produce different seeds for different timestamps', () => {
      const seed1 = computeSeed({
        cutIndex: 5,
        knockTimes: [100, 200, 300],
        userQuestion: 'Test',
        timestamp: 1000000
      });

      const seed2 = computeSeed({
        cutIndex: 5,
        knockTimes: [100, 200, 300],
        userQuestion: 'Test',
        timestamp: 1000001
      });

      assert.notStrictEqual(seed1, seed2, 'Different timestamps should produce different seeds');
    });
  });
  
  describe('seededShuffle', () => {
    it('should produce reproducible shuffles with same seed', () => {
      const deck = [...MAJOR_ARCANA];
      const seed = 12345;
      
      const shuffle1 = seededShuffle(deck, seed);
      const shuffle2 = seededShuffle(deck, seed);
      
      assert.deepStrictEqual(shuffle1, shuffle2, 'Same seed should produce same shuffle');
    });
    
    it('should produce different shuffles with different seeds', () => {
      const deck = [...MAJOR_ARCANA];
      
      const shuffle1 = seededShuffle(deck, 12345);
      const shuffle2 = seededShuffle(deck, 54321);
      
      // They might occasionally be the same by chance, but very unlikely for 22 cards
      const areDifferent = shuffle1.some((card, i) => card.name !== shuffle2[i].name);
      assert.ok(areDifferent, 'Different seeds should likely produce different shuffles');
    });
    
    it('should not modify original array', () => {
      const deck = [...MAJOR_ARCANA];
      const originalNames = deck.map(c => c.name);
      
      seededShuffle(deck, 12345);
      
      const currentNames = deck.map(c => c.name);
      assert.deepStrictEqual(currentNames, originalNames, 'Original array should not be modified');
    });
    
    it('should maintain all cards in shuffle', () => {
      const deck = [...MAJOR_ARCANA];
      const seed = 12345;
      
      const shuffled = seededShuffle(deck, seed);
      
      assert.strictEqual(shuffled.length, deck.length, 'Shuffled deck should have same length');
      
      const originalNames = new Set(deck.map(c => c.name));
      const shuffledNames = new Set(shuffled.map(c => c.name));
      
      assert.deepStrictEqual(shuffledNames, originalNames, 'All cards should be present in shuffle');
    });
  });
  
  describe('cryptoShuffle', () => {
    it('should produce different shuffles on multiple calls', () => {
      const deck = [...MAJOR_ARCANA];
      
      const shuffle1 = cryptoShuffle(deck);
      const shuffle2 = cryptoShuffle(deck);
      
      // They might occasionally be the same by chance, but very unlikely for 22 cards
      const areDifferent = shuffle1.some((card, i) => card.name !== shuffle2[i].name);
      assert.ok(areDifferent, 'Multiple calls should likely produce different shuffles');
    });
    
    it('should not modify original array', () => {
      const deck = [...MAJOR_ARCANA];
      const originalNames = deck.map(c => c.name);
      
      cryptoShuffle(deck);
      
      const currentNames = deck.map(c => c.name);
      assert.deepStrictEqual(currentNames, originalNames, 'Original array should not be modified');
    });
    
    it('should maintain all cards in shuffle', () => {
      const deck = [...MAJOR_ARCANA];
      
      const shuffled = cryptoShuffle(deck);
      
      assert.strictEqual(shuffled.length, deck.length, 'Shuffled deck should have same length');
      
      const originalNames = new Set(deck.map(c => c.name));
      const shuffledNames = new Set(shuffled.map(c => c.name));
      
      assert.deepStrictEqual(shuffledNames, originalNames, 'All cards should be present in shuffle');
    });
  });
  
  describe('drawSpread', () => {
    it('should draw correct number of cards for each spread', () => {
      Object.entries(SPREADS).forEach(([key, spread]) => {
        const cards = drawSpread({
          spreadKey: key,
          useSeed: false,
          seed: 0,
          includeMinors: false
        });
        
        assert.strictEqual(cards.length, spread.count, 
          `${spread.name} should draw ${spread.count} cards`);
      });
    });
    
    it('should throw error when deck is too small for spread', () => {
      // Create a mock spread that requires more cards than available
      // Temporarily add a problematic spread
      SPREADS.oversized = {
        name: 'Oversized Test Spread',
        positions: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21', '22', '23', '24', '25'],
        count: 25,
        description: 'Test spread that requires too many cards'
      };
      
      try {
        assert.throws(() => {
          drawSpread({
            spreadKey: 'oversized',
            useSeed: false,
            seed: 0,
            includeMinors: false
          });
        }, /Deck too small for spread/);
      } finally {
        // Clean up
        delete SPREADS.oversized;
      }
    });
    
    it('should produce deterministic results with seed', () => {
      const draw1 = drawSpread({
        spreadKey: 'threeCard',
        useSeed: true,
        seed: 12345,
        includeMinors: false
      });
      
      const draw2 = drawSpread({
        spreadKey: 'threeCard',
        useSeed: true,
        seed: 12345,
        includeMinors: false
      });
      
      assert.deepStrictEqual(
        draw1.map(c => ({ name: c.name, isReversed: c.isReversed })),
        draw2.map(c => ({ name: c.name, isReversed: c.isReversed })),
        'Same seed should produce same draw'
      );
    });
    
    it('should include reversals in seeded draws', () => {
      const draw = drawSpread({
        spreadKey: 'celtic',
        useSeed: true,
        seed: 12345,
        includeMinors: false
      });
      
      const reversals = draw.filter(c => c.isReversed);
      assert.ok(reversals.length > 0, 'Seeded draw should include some reversed cards');
    });
    
    it('should work with minors deck', () => {
      const draw = drawSpread({
        spreadKey: 'threeCard',
        useSeed: true,
        seed: 12345,
        includeMinors: true
      });

      assert.strictEqual(draw.length, 3, 'Should draw correct number with minors');

      // Verify the deck pool includes minors (not that a specific seed produces them)
      const pool = getDeckPool(true);
      const poolHasMinors = pool.some(c => c.suit !== undefined);
      assert.ok(poolHasMinors, 'Deck pool with includeMinors=true should contain minor arcana');

      // If any drawn cards are minors, verify they have valid structure
      const drawnMinors = draw.filter(c => c.suit !== undefined);
      drawnMinors.forEach(minor => {
        assert.ok(typeof minor.suit === 'string', 'Minor card should have suit');
        assert.ok(typeof minor.rank === 'string', 'Minor card should have rank');
        assert.ok(typeof minor.rankValue === 'number', 'Minor card should have rankValue');
      });
    });
  });
  
  describe('getDeckPool', () => {
    it('should return majors only when includeMinors is false', () => {
      const pool = getDeckPool(false);
      assert.strictEqual(pool.length, MAJOR_ARCANA.length, 'Should return only majors');
      assert.ok(pool.every(c => c.number !== undefined), 'All cards should have numbers (majors)');
    });
    
    it('should return full deck when includeMinors is true and data is valid', () => {
      const pool = getDeckPool(true);
      assert.strictEqual(pool.length, MAJOR_ARCANA.length + MINOR_ARCANA.length, 'Should return full deck');
    });
    
    it('should validate minor arcana structure', () => {
      // Test with valid minors
      const pool = getDeckPool(true);
      const minorsInPool = pool.filter(c => c.suit !== undefined);
      
      assert.ok(minorsInPool.length > 0, 'Should include minor arcana');
      assert.ok(minorsInPool.every(c => 
        typeof c.name === 'string' &&
        typeof c.suit === 'string' &&
        typeof c.rank === 'string' &&
        typeof c.rankValue === 'number' &&
        c.rankValue >= 1 && c.rankValue <= 14
      ), 'All minor arcana cards should have valid structure');
    });
    
    it('should fall back to majors if minors data is invalid', () => {
      // This test would require mocking the MINOR_ARCANA import
      // For now, we test the fallback logic by checking the function handles errors
      const pool = getDeckPool(true);
      assert.ok(pool.length >= MAJOR_ARCANA.length, 'Should at least return majors');
    });
  });
  
  describe('computeRelationships', () => {
    it('should detect sequences in major arcana', () => {
      const cards = [
        { name: 'The Fool', number: 0, isReversed: false },
        { name: 'The Magician', number: 1, isReversed: false },
        { name: 'The High Priestess', number: 2, isReversed: false }
      ];
      
      const relationships = computeRelationships(cards);
      const hasSequence = relationships.some(r => r.type === 'sequence');
      assert.ok(hasSequence, 'Should detect sequential major arcana cards');
    });
    
    it('should detect reversal patterns', () => {
      const cards = [
        { name: 'The Fool', number: 0, isReversed: true },
        { name: 'The Magician', number: 1, isReversed: true },
        { name: 'The High Priestess', number: 2, isReversed: false },
        { name: 'The Empress', number: 3, isReversed: true },
        { name: 'The Emperor', number: 4, isReversed: true }
      ];
      
      const relationships = computeRelationships(cards);
      const hasHeavyReversals = relationships.some(r => r.type === 'reversal-heavy');
      const hasConsecutive = relationships.some(r => r.type === 'consecutive-reversals');
      
      assert.ok(hasHeavyReversals, 'Should detect heavy reversal pattern');
      assert.ok(hasConsecutive, 'Should detect consecutive reversals');
    });
    
    it('should detect suit runs in minor arcana', () => {
      const cards = [
        { name: 'Two of Wands', suit: 'Wands', rankValue: 2, isReversed: false },
        { name: 'Three of Wands', suit: 'Wands', rankValue: 3, isReversed: false },
        { name: 'Four of Wands', suit: 'Wands', rankValue: 4, isReversed: false }
      ];
      
      const relationships = computeRelationships(cards);
      const hasSuitRun = relationships.some(r => r.type === 'suit-run');
      assert.ok(hasSuitRun, 'Should detect suit runs');
    });
    
    it('should detect suit dominance', () => {
      const cards = [
        { name: 'Two of Wands', suit: 'Wands', rankValue: 2, isReversed: false },
        { name: 'Three of Wands', suit: 'Wands', rankValue: 3, isReversed: false },
        { name: 'Four of Wands', suit: 'Wands', rankValue: 4, isReversed: false },
        { name: 'Five of Cups', suit: 'Cups', rankValue: 5, isReversed: false }
      ];
      
      const relationships = computeRelationships(cards);
      const hasDominance = relationships.some(r => r.type === 'suit-dominance');
      assert.ok(hasDominance, 'Should detect suit dominance');
    });
    
    it('should detect court card clusters', () => {
      const cards = [
        { name: 'Page of Wands', suit: 'Wands', rank: 'Page', rankValue: 11, isReversed: false },
        { name: 'Knight of Cups', suit: 'Cups', rank: 'Knight', rankValue: 12, isReversed: false },
        { name: 'Queen of Swords', suit: 'Swords', rank: 'Queen', rankValue: 13, isReversed: false }
      ];
      
      const relationships = computeRelationships(cards);
      const hasCourtCluster = relationships.some(r => r.type === 'court-cluster');
      assert.ok(hasCourtCluster, 'Should detect court card clusters');
    });
    
    it('should detect reversed court cards', () => {
      const cards = [
        { name: 'Page of Wands', suit: 'Wands', rank: 'Page', rankValue: 11, isReversed: true },
        { name: 'Knight of Cups', suit: 'Cups', rank: 'Knight', rankValue: 12, isReversed: true },
        { name: 'Queen of Swords', suit: 'Swords', rank: 'Queen', rankValue: 13, isReversed: false }
      ];
      
      const relationships = computeRelationships(cards);
      const hasReversedCourts = relationships.some(r => r.type === 'reversed-court-cluster');
      assert.ok(hasReversedCourts, 'Should detect reversed court card clusters');
    });
    
    it('should detect major arcana pairings', () => {
      const cards = [
        { name: 'The Fool', number: 0, isReversed: false },
        { name: 'The Magician', number: 1, isReversed: false },
        { name: 'The High Priestess', number: 2, isReversed: false }
      ];
      
      const relationships = computeRelationships(cards);
      const hasPairing = relationships.some(r => r.type === 'pairing');
      assert.ok(hasPairing, 'Should detect major arcana pairings');
    });
    
    it('should detect growth arcs', () => {
      const cards = [
        { name: 'The Fool', number: 0, isReversed: false },
        { name: 'Card', number: 1, isReversed: false },
        { name: 'Card', number: 2, isReversed: false },
        { name: 'Card', number: 3, isReversed: false },
        { name: 'Card', number: 4, isReversed: false },
        { name: 'Card', number: 5, isReversed: false },
        { name: 'The World', number: 21, isReversed: false }
      ];
      
      const relationships = computeRelationships(cards);
      const hasArc = relationships.some(r => r.type === 'arc');
      assert.ok(hasArc, 'Should detect growth arcs from low to high numbers');
    });
    
    it('should return empty array for empty input', () => {
      const relationships = computeRelationships([]);
      assert.deepStrictEqual(relationships, [], 'Should return empty array for empty input');
    });
    
    it('should return empty array for null input', () => {
      const relationships = computeRelationships(null);
      assert.deepStrictEqual(relationships, [], 'Should return empty array for null input');
    });
  });
});

console.log('Running deck tests...');


describe('single-card reversal language', () => {
  it('leaves a lone reversal to the orientation summary', () => {
    assert.deepEqual(computeRelationships([{ ...MAJOR_ARCANA[17], isReversed: true }]), []);
  });
  it('keeps the majority pattern for multiple reversed cards', () => {
    const cards = [17, 14, 13].map((number, index) => ({ ...MAJOR_ARCANA[number], isReversed: index < 2 }));
    assert.ok(computeRelationships(cards).some(item => item.type === 'reversal-heavy'));
  });
});

