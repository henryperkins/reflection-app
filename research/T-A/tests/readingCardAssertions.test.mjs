import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync } from 'node:fs';

// Import conditionally so the baseline failure describes the missing contract.
const assertions = existsSync(new URL('../functions/lib/readingCardAssertions.js', import.meta.url))
  ? await import('../functions/lib/readingCardAssertions.js') : {};
const drawn = [{ card: 'Temperance', canonicalName: 'Temperance', canonicalKey: 'temperance' }];

describe('clause-local undrawn card assertions', () => {
  for (const text of [
    'The Moon appears in your spread.',
    'The Moon card appears in your spread.',
    'You drew The Moon.',
    'The Moon is among your cards.',
    'Outcome: The Moon.',
    'The Moon occupies your outcome position.',
    'The Moon is in the outcome position.',
    'The Moon in your outcome position invites reflection.',
    'Your outcome card is The Moon.',
    'Your cards include The Moon.',
    'The Moon appears in your reading.',
    '**The Moon** (reversed) is in your spread.',
    '“The Moon” appears in your spread.',
    'The Moon is not absent from your spread.',
    'The Moon is not not drawn.',
    'The Moon is never absent from your spread.',
    'It is not true that The Moon is not drawn.',
    'You drew not only The Moon but also Temperance.',
    'The Moon is not only in your spread, it is your outcome.',
    'The Moon card is not drawn here. However, The Moon appears in your spread.',
    'Unlike The Moon card, Temperance is drawn. The Moon is among your cards.'
  ]) {
    it(`rejects affirmative presence: ${text}`, () => {
      assert.equal(typeof assertions.detectUndrawnCardAssertions, 'function');
      assert.deepEqual(assertions.detectUndrawnCardAssertions(text, drawn, 'rws-1909'), ['The Moon']);
    });
  }

  for (const text of [
    'The Moon card is not drawn here.',
    'The Moon card does not appear in your spread.',
    'You did not draw The Moon card.',
    'You didn’t draw The Moon card.',
    'The Moon card wasn’t drawn.',
    'The Moon card and The Sun card are not drawn here.',
    'Neither The Moon nor The Sun is in your spread.',
    'Unlike The Moon card, Temperance asks for measured attention.',
    'Compared with The Moon card, this is a quieter reflection.',
    'If you drew The Moon card, you might explore uncertainty.',
    'Imagine The Moon appearing in your spread as a hypothetical example.',
    'Had you drawn The Moon card, uncertainty could be a theme.',
    'In a hypothetical spread, The Moon appears in your spread.',
    'You wrote, “The Moon appears in your spread.” This is your earlier quotation.',
    'The user said: "You drew The Moon and The Sun."',
    'You wrote: ‘The Moon appears in your spread.’',
    "You said: 'You drew The Moon.'",
    'Justice, strength, and love are qualities you can practice.',
    'The Moon is full tonight.',
    'Temperance is in your spread.'
  ]) {
    it(`preserves non-assertive or drawn control: ${text}`, () => {
      assert.equal(typeof assertions.detectUndrawnCardAssertions, 'function');
      assert.deepEqual(assertions.detectUndrawnCardAssertions(text, drawn, 'rws-1909'), []);
      assert.ok(assertions.classifyCardMentions(text, { cardsInfo: drawn }).every(mention => mention.drawn || mention.classification !== 'unclassified'), 'clear controls must not consume the residual mention allowance');
    });
  }

  it('checks every coordinated identity and each occurrence separately', () => {
    assert.equal(typeof assertions.detectUndrawnCardAssertions, 'function');
    assert.deepEqual(assertions.detectUndrawnCardAssertions('The Moon and The Sun appear in your spread.', drawn), ['The Moon', 'The Sun']);
    assert.deepEqual(assertions.detectUndrawnCardAssertions('You drew The Moon and The Sun.', drawn), ['The Moon', 'The Sun']);
    assert.deepEqual(assertions.detectUndrawnCardAssertions('The Moon card is not drawn, but The Sun appears in your spread.', drawn), ['The Sun']);
    assert.deepEqual(assertions.detectUndrawnCardAssertions('You did not draw The Moon, and The Sun appears in your spread.', drawn), ['The Sun']);
    assert.deepEqual(assertions.detectUndrawnCardAssertions('You did not draw The Moon and The Sun appears in your spread.', drawn), ['The Sun']);
  });

  it('keeps unknown syntax unclassified and records offsets privately', () => {
    assert.equal(typeof assertions.classifyCardMentions, 'function');
    const text = 'The Moon card suggests reflection.';
    const mentions = assertions.classifyCardMentions(text, { cardsInfo: drawn, deckStyle: 'rws-1909' });
    assert.equal(mentions.length, 1);
    assert.equal(mentions[0].classification, 'unclassified');
    assert.equal(mentions[0].canonical, 'The Moon');
    assert.equal(text.slice(mentions[0].start, mentions[0].end), 'The Moon');
  });

  it('treats the Fool\'s Journey as terminology even when an article precedes it', () => {
    assert.equal(typeof assertions.classifyCardMentions, 'function');
    const majors = [{ card: 'The Star', canonicalName: 'The Star', canonicalKey: 'the star' }, { card: 'The Sun', canonicalName: 'The Sun', canonicalKey: 'the sun' }];
    for (const text of [
      'Two Majors from the late stretch of the Fool\'s Journey suggest more than timelines.',
      'Both sit late in The Fool’s Journey.',
      'This is **the Fool\'s Journey** at its culmination.',
      'The journey of the Fool reaches the Sun.'
    ]) {
      assert.deepEqual(assertions.classifyCardMentions(text, { cardsInfo: majors }).filter(mention => mention.canonical === 'The Fool'), [], text);
    }
    // A separate mention of the card outside the term is still measured.
    const mentions = assertions.classifyCardMentions('The Fool\'s Journey begins with The Fool card.', { cardsInfo: majors });
    assert.deepEqual(mentions.map(mention => [mention.canonical, mention.start]), [['The Fool', 31]]);
  });

  it('preserves deck identities without canonicalizing Thoth Knights twice', () => {
    assert.equal(typeof assertions.detectUndrawnCardAssertions, 'function');
    const thoth = [{ card: 'Knight of Wands', canonicalName: 'King of Wands', canonicalKey: 'king of wands' }];
    for (const name of ['Knight of Wands', 'King of Wands']) {
      assert.deepEqual(assertions.detectUndrawnCardAssertions(`You drew ${name}.`, thoth, 'thoth-a1'), []);
    }
    assert.deepEqual(assertions.detectUndrawnCardAssertions('Art is among your cards.', thoth, 'thoth-a1'), ['Temperance']);
    assert.deepEqual(assertions.detectUndrawnCardAssertions('You drew Le Mat.', drawn, 'marseille-classic'), ['The Fool']);
  });
});

