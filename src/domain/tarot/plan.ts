import type { z } from 'zod';
import {
  type CanonSource,
  ContentBundle,
  ModelCandidate,
  Position,
  PreparedPlan,
  TarotFactId,
} from '../../contracts/index.ts';
import { sha256Json } from '../json.ts';
import { assertBasis } from './facts.ts';
export type BuildPlanInput = Omit<
  PreparedPlan,
  'version' | 'contentHash' | 'sources' | 'mandatoryFactIds' | 'fallbackClosing'
> & { content: z.infer<typeof ContentBundle> };
type Source = z.infer<typeof CanonSource>;
/** Review metadata is excluded so approval can bind the reviewed content without a hash cycle. */
export async function sourceHash(source: Source): Promise<string> {
  const { hash: _hash, review: _review, ...reviewed } = source;
  return sha256Json(reviewed);
}
export async function bundleHash(bundle: z.infer<typeof ContentBundle>): Promise<string> {
  const { editionHash: _hash, ...content } = bundle;
  return sha256Json(content);
}
function approved(source: Source): boolean {
  return (
    source.rights.status === 'cleared' &&
    source.rights.evidence.trim().length > 0 &&
    source.review.kind === 'human_approved' &&
    !!source.review.reviewer?.trim() &&
    source.review.reviewedAt !== null &&
    source.review.reviewedHash === source.hash
  );
}
export async function buildPlan(input: BuildPlanInput): Promise<PreparedPlan> {
  const basis = assertBasis(input.basis);
  const parsed = ContentBundle.safeParse(input.content);
  if (!parsed.success) throw new Error('CONTENT_UNAVAILABLE: content schema');
  const content = parsed.data;
  if (
    content.editionHash !== (await bundleHash(content)) ||
    content.deckEdition !== (await sha256Json(content.deck)) ||
    content.deckEdition !== basis.deckEdition ||
    new Set(content.deck.map((c) => c.id)).size !== 78 ||
    new Set(content.positionFrames.map((f) => f.position)).size !== 3 ||
    content.positionFrames.some((f) => !f.text.trim())
  )
    throw new Error('CONTENT_UNAVAILABLE: content identity');
  const sourceIds = new Set<string>();
  const bindings = new Set<string>();
  for (const source of content.sources) {
    const binding = `${source.cardId}:${source.orientation}:${source.position ?? 'neutral'}`;
    if (
      !source.id.trim() ||
      sourceIds.has(source.id) ||
      bindings.has(binding) ||
      source.hash !== (await sourceHash(source))
    )
      throw new Error('CONTENT_UNAVAILABLE: source identity');
    sourceIds.add(source.id);
    bindings.add(binding);
  }
  for (const card of content.deck)
    for (const orientation of ['upright', 'reversed']) {
      if (
        !content.sources.some(
          (s) =>
            s.cardId === card.id &&
            s.orientation === orientation &&
            s.position === null &&
            approved(s),
        )
      )
        throw new Error('CONTENT_UNAVAILABLE: neutral canon coverage');
    }
  const sources = basis.cards.map((card) => {
    const eligible = content.sources.filter(
      (s) => s.cardId === card.cardId && s.orientation === card.orientation && approved(s),
    );
    const source =
      eligible.find((s) => s.position === card.position) ??
      eligible.find((s) => s.position === null);
    if (!source) throw new Error('CONTENT_UNAVAILABLE: required source');
    return source;
  });
  const { content: _content, ...metadata } = input;
  return assertPlan({
    ...metadata,
    basis,
    question: input.question.trim(),
    version: 'tarot-plan.v1',
    contentHash: content.editionHash,
    sources,
    fallbackClosing:
      input.operation === 'followup'
        ? content.productCopy.followupClosing
        : content.productCopy.initialClosing,
    mandatoryFactIds: TarotFactId.options,
  });
}
/** Synchronous shape/binding checks; integrity checks are async at composition/egress boundaries. */
export function assertPlan(value: unknown): PreparedPlan {
  const parsed = PreparedPlan.safeParse(value);
  if (!parsed.success) throw new Error('BAD_INPUT: prepared plan schema');
  const plan = parsed.data;
  assertBasis(plan.basis);
  if (
    !plan.question.trim() ||
    plan.question !== plan.question.trim() ||
    (plan.operation === 'initial') !== (plan.parentEditionId === null) ||
    plan.mandatoryFactIds.some((id, i) => id !== TarotFactId.options[i])
  )
    throw new Error('BAD_INPUT: plan identity');
  if (new Set(plan.sources.map((s) => s.id)).size !== 3)
    throw new Error('CONTENT_UNAVAILABLE: repeated source');
  for (const [i, card] of plan.basis.cards.entries()) {
    const source = plan.sources[i]!;
    if (
      !approved(source) ||
      source.cardId !== card.cardId ||
      source.orientation !== card.orientation ||
      (source.position !== null && source.position !== card.position)
    )
      throw new Error('CONTENT_UNAVAILABLE: source binding');
  }
  let total = 0;
  for (const [i, fragment] of plan.selected.entries()) {
    if (
      fragment.ordinal !== i ||
      fragment.availability !== 'retained' ||
      fragment.text === null ||
      fragment.textHash === null ||
      fragment.end <= fragment.start ||
      fragment.end - fragment.start !== Array.from(fragment.text).length
    )
      throw new Error('CONTEXT_CHANGED: selected fragment');
    const length = Array.from(fragment.text).length;
    if (length > 1200) throw new Error('INPUT_TOO_LARGE: selected fragment');
    total += length;
  }
  if (total > 3000) throw new Error('INPUT_TOO_LARGE: selected fragments');
  return plan;
}
export async function validatePlanIntegrity(value: unknown): Promise<PreparedPlan> {
  const plan = assertPlan(value);
  for (const source of plan.sources)
    if (source.hash !== (await sourceHash(source)))
      throw new Error('CONTENT_UNAVAILABLE: source hash');
  return plan;
}
/** Mechanical binding checks only; this is not the later semantic safety validator. */
export function validateCandidateBindings(value: PreparedPlan, candidate: unknown): void {
  const plan = assertPlan(value);
  const parsed = ModelCandidate.safeParse(candidate);
  if (!parsed.success) throw new Error('INVALID_CANDIDATE: schema');
  const positions = new Set<string>();
  for (const unit of parsed.data.units) {
    const i = Position.options.indexOf(unit.position);
    const card = plan.basis.cards[i]!;
    const source = plan.sources[i]!;
    const sameSuit = card.cardId.split('-')[0];
    if (
      positions.has(unit.position) ||
      unit.sourceIds[0] !== source.id ||
      unit.factIds.filter((id) => id === card.id).length !== 1 ||
      new Set(unit.factIds).size !== unit.factIds.length ||
      unit.factIds.some((id) => id !== card.id && id !== `count:${sameSuit}`)
    )
      throw new Error('INVALID_CANDIDATE: binding');
    positions.add(unit.position);
  }
}
