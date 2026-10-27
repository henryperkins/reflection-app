import type { z } from 'zod';
import {
  ContentBundleV2,
  PreparedPlanV2,
  Position,
  TarotFactId,
  type CanonSourceV2,
  type RelationshipSource,
} from '../../contracts/index.ts';
import { sha256Json } from '../json.ts';
import { assertBasis } from './facts.ts';
import type { BuildPlanInput } from './plan.ts';

type Source = z.infer<typeof CanonSourceV2>;
type Relationship = z.infer<typeof RelationshipSource>;
export type BundleV2 = z.infer<typeof ContentBundleV2>;
export type BuildPlanInputV2 = Omit<BuildPlanInput, 'content'> & { content: BundleV2 };
export async function reviewedRecordHash<T extends { hash: string; review: unknown }>(record: T) {
  const { hash: _hash, review: _review, ...body } = record;
  return sha256Json(body);
}
export async function contentHashV2(bundle: BundleV2) {
  const { editionHash: _hash, ...body } = bundle;
  return sha256Json(body);
}
export function eligibleReview(
  record: Pick<Source, 'hash' | 'review' | 'rights'>,
  diagnosticOnly: boolean,
) {
  if (record.rights.status === 'disallowed') return false;
  if (diagnosticOnly && record.review.kind === 'agent_reviewed') return true;
  return (
    record.rights.status === 'cleared' &&
    !!record.rights.evidence.trim() &&
    record.review.kind === 'human_approved' &&
    !!record.review.reviewer?.trim() &&
    record.review.reviewedAt !== null &&
    record.review.reviewedHash === record.hash
  );
}
export function eligibleRelationship(
  record: Relationship,
  plan: Pick<PreparedPlanV2, 'basis' | 'sources' | 'diagnosticOnly'>,
) {
  const selected = new Set(plan.sources.map((s) => s.id));
  const themes = new Set(
    plan.sources.filter((s) => record.sourceIds.includes(s.id)).flatMap((s) => s.meaning.themes),
  );
  return (
    eligibleReview(record, plan.diagnosticOnly) &&
    record.deckEdition === plan.basis.deckEdition &&
    (record.cards.length > 0 || record.themes.length > 0) &&
    new Set(record.sourceIds).size === record.sourceIds.length &&
    record.sourceIds.every((id) => selected.has(id)) &&
    new Set(record.cards.map((c) => c.cardId)).size === record.cards.length &&
    record.cards.every((c) =>
      plan.basis.cards.some((d) => d.cardId === c.cardId && c.orientations.includes(d.orientation)),
    ) &&
    record.themes.every((theme) => themes.has(theme))
  );
}
const unavailable = (detail: string): never => {
  throw new Error(`CONTENT_UNAVAILABLE: ${detail}`);
};
function contextSnapshot(plan: Omit<PreparedPlanV2, 'contextHash'> | PreparedPlanV2) {
  return {
    diagnosticOnly: plan.diagnosticOnly,
    reader: plan.reader,
    draw: plan.draw,
    basis: plan.basis,
    contentHash: plan.contentHash,
    spread: plan.spread,
    sources: plan.sources.map((s) => ({ id: s.id, version: s.version, hash: s.hash })),
    relationships: plan.relationships.map((s) => ({ id: s.id, version: s.version, hash: s.hash })),
    fallbackV2: plan.fallbackV2,
  };
}
export async function buildPlanV2(
  input: BuildPlanInputV2,
  diagnosticOnly = false,
): Promise<PreparedPlanV2> {
  const basis = assertBasis(input.basis),
    content = ContentBundleV2.parse(input.content);
  if (
    !input.question.trim() ||
    input.operation !== 'initial' ||
    input.parentEditionId !== null ||
    input.selected.length
  )
    throw new Error('BAD_INPUT: v2 current context only');
  if (
    content.editionHash !== (await contentHashV2(content)) ||
    content.deckEdition !== (await sha256Json(content.deck)) ||
    content.deckEdition !== basis.deckEdition ||
    new Set(content.deck.map((c) => c.id)).size !== 78
  )
    unavailable('v2 content identity');
  if (
    new Set(content.positionFrames.map((f) => f.position)).size !== 3 ||
    content.positionFrames.some((f) => !f.text.trim())
  )
    unavailable('v2 position frames');
  const ids = new Set<string>(),
    bindings = new Set<string>();
  for (const source of content.sources) {
    const binding = `${source.cardId}:${source.orientation}:${source.position ?? 'neutral'}`;
    if (
      !source.id.trim() ||
      ids.has(source.id) ||
      bindings.has(binding) ||
      source.hash !== (await reviewedRecordHash(source)) ||
      !content.deck.some((c) => c.id === source.cardId)
    )
      unavailable('v2 source identity');
    ids.add(source.id);
    bindings.add(binding);
  }
  for (const c of content.deck)
    for (const orientation of ['upright', 'reversed'])
      if (
        !content.sources.some(
          (s) =>
            s.cardId === c.id &&
            s.orientation === orientation &&
            s.position === null &&
            eligibleReview(s, diagnosticOnly),
        )
      )
        unavailable('v2 neutral coverage');
  const sources = basis.cards.map((card) => {
    const eligible = content.sources.filter(
      (s) =>
        s.cardId === card.cardId &&
        s.orientation === card.orientation &&
        eligibleReview(s, diagnosticOnly),
    );
    return (
      eligible.find((s) => s.position === card.position) ??
      eligible.find((s) => s.position === null) ??
      unavailable('v2 selected source')
    );
  });
  const relationshipIds = new Set<string>();
  for (const r of content.relationships) {
    if (relationshipIds.has(r.id) || r.hash !== (await reviewedRecordHash(r)))
      unavailable('v2 relationship identity');
    relationshipIds.add(r.id);
  }
  const relationships = content.relationships
    .filter((r) => eligibleRelationship(r, { basis, sources, diagnosticOnly }))
    .sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, 2);
  const { content: _content, ...metadata } = input;
  const snapshot = {
    ...metadata,
    version: 'tarot-plan.v2' as const,
    operation: 'initial' as const,
    parentEditionId: null,
    basis,
    diagnosticOnly,
    contentHash: content.editionHash,
    sources,
    selected: [],
    mandatoryFactIds: [...TarotFactId.options],
    reader: { id: 'reader:question' as const, text: input.question },
    draw: basis.cards.map((c) => ({
      cardId: c.cardId,
      name: content.deck.find((d) => d.id === c.cardId)!.name,
      orientation: c.orientation,
      position: c.position,
      factId: TarotFactId.parse(c.id),
      deckEdition: basis.deckEdition,
    })),
    spread: {
      version: content.spreadVersion,
      positions: Position.options.map((p) => content.positionFrames.find((f) => f.position === p)!),
    },
    relationships,
    fallbackV2: content.fallbackV2,
  };
  return validatePlanV2({ ...snapshot, contextHash: await sha256Json(contextSnapshot(snapshot)) });
}
export async function validatePlanV2(value: unknown): Promise<PreparedPlanV2> {
  const parsed = PreparedPlanV2.safeParse(value);
  if (!parsed.success) throw new Error('BAD_INPUT: v2 prepared plan');
  const plan = parsed.data;
  assertBasis(plan.basis);
  if (
    !plan.question.trim() ||
    plan.reader.text !== plan.question ||
    plan.contextHash !== (await sha256Json(contextSnapshot(plan))) ||
    plan.mandatoryFactIds.some((id, i) => id !== TarotFactId.options[i])
  )
    unavailable('v2 snapshot identity');
  if (new Set(plan.sources.map((s) => s.id)).size !== 3) unavailable('v2 repeated source');
  for (const [i, card] of plan.basis.cards.entries()) {
    const source = plan.sources[i]!,
      draw = plan.draw[i]!,
      frame = plan.spread.positions[i]!;
    if (
      !eligibleReview(source, plan.diagnosticOnly) ||
      source.hash !== (await reviewedRecordHash(source)) ||
      source.cardId !== card.cardId ||
      source.orientation !== card.orientation ||
      (source.position !== null && source.position !== card.position) ||
      draw.cardId !== card.cardId ||
      draw.position !== card.position ||
      draw.factId !== card.id ||
      draw.orientation !== card.orientation ||
      draw.deckEdition !== plan.basis.deckEdition ||
      !draw.name.trim() ||
      frame.position !== card.position ||
      !frame.text.trim()
    )
      unavailable('v2 selected binding');
  }
  if (new Set(plan.relationships.map((r) => r.id)).size !== plan.relationships.length)
    unavailable('v2 repeated relationship');
  for (const r of plan.relationships)
    if (r.hash !== (await reviewedRecordHash(r)) || !eligibleRelationship(r, plan))
      unavailable('v2 relationship binding');
  return plan;
}
