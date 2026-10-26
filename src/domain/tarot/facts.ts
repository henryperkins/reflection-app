import { Position, Suit, TarotBasis, TarotFactId } from '../../contracts/index.ts';
export type RenderedFact = {id:typeof TarotFactId._output;text:string};
/** Schemas validate fields; this enforces the cross-field relationships as well. */
export function assertBasis(value:unknown): TarotBasis {
  const parsed=TarotBasis.safeParse(value);
  if(!parsed.success)throw new Error('BAD_INPUT: basis schema');
  const basis=parsed.data;
  if(!/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(basis.seed))throw new Error('BAD_INPUT: canonical 32-byte seed');
  if(new Set(basis.cards.map(c=>c.cardId)).size!==3)throw new Error('BAD_INPUT: repeated card');
  for(const [i,position] of Position.options.entries()) {
    const card=basis.cards[i]!;
    if(card.position!==position||card.id!==`card:${position}`||(!basis.reversals&&card.orientation!=='upright'))throw new Error('BAD_INPUT: card binding');
  }
  for(const [i,suit] of Suit.options.entries()) {
    const count=basis.counts[i]!;
    if(count.suit!==suit||count.id!==`count:${suit}`||count.count!==basis.cards.filter(c=>c.cardId.startsWith(`${suit}-`)).length)throw new Error('BAD_INPUT: count binding');
  }
  return basis;
}
/** Canonical IDs are displayed explicitly; edition-specific display names remain metadata. */
export function renderFacts(value: TarotBasis): RenderedFact[] {
  const basis=assertBasis(value);
  return [
    ...basis.cards.map(card=>({id:TarotFactId.parse(card.id),text:`The ${card.position} card is ${card.cardId} (${card.orientation}).`})),
    ...basis.counts.map(count=>({id:TarotFactId.parse(count.id),text:`The draw contains ${count.count} ${count.suit[0]!.toUpperCase()+count.suit.slice(1)} ${count.count===1?'card':'cards'}.`})),
  ];
}
