import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { ContentBundleV2 } from '../../src/contracts/index.ts';
import { contentHashV2, reviewedRecordHash } from '../../src/domain/tarot/context-v2.ts';
import { contentReviewPacket } from '../../scripts/content-activate.ts';
import {
  inspectReviewedBundle,
  verifySignedContentApproval,
} from '../../src/worker/content/approval.ts';
import { editorialBundle, signedApproval } from '../fixtures/content-approval.ts';
import { v2Input, relationship } from '../fixtures/canon-v2.ts';

test('v2 draft covers every orientation with substantive bounded components and accurate status', async () => {
  const b = ContentBundleV2.parse(
    JSON.parse(readFileSync('content/reading-canon-v2-draft.json', 'utf8')),
  );
  expect(b.editionHash).toBe(await contentHashV2(b));
  expect(b.sources).toHaveLength(156);
  expect(b.relationships).toEqual([]);
  for (const c of b.deck)
    for (const o of ['upright', 'reversed']) {
      const matches = b.sources.filter(
        (s) => s.cardId === c.id && s.orientation === o && s.position === null,
      );
      expect(matches).toHaveLength(1);
      const s = matches[0]!;
      expect(s.hash).toBe(await reviewedRecordHash(s));
      const words = [
        s.meaning.core,
        ...s.meaning.distinctions,
        s.meaning.positive,
        ...s.meaning.limits,
      ]
        .join(' ')
        .split(/\s+/).length;
      expect(words, s.id).toBeGreaterThanOrEqual(60);
      expect(words, s.id).toBeLessThanOrEqual(120);
      expect(s.meaning.imagery).toBeNull();
      expect(s.review.kind).toBe('agent_reviewed');
      expect(s.review.reviewedHash).toBeNull();
      expect(s.rights.status).toBe('unknown');
    }
  const packet = await contentReviewPacket(b);
  for (const s of b.sources) {
    expect(packet).toContain(s.meaning.core);
    expect(packet).toContain(s.meaning.positive);
    for (const t of [...s.meaning.distinctions, ...s.meaning.limits]) expect(packet).toContain(t);
  }
  expect(packet).toContain(b.fallbackV2.synthesis);
  await expect(inspectReviewedBundle(b)).rejects.toThrow('Content not approved');
});

async function approvedV2Fixture() {
  const old = await editorialBundle(),
    sample = await v2Input();
  const b = ContentBundleV2.parse({
    ...sample.content,
    ...old,
    schemaVersion: 2,
    spreadVersion: sample.content.spreadVersion,
    relationships: [],
    fallbackV2: sample.content.fallbackV2,
    sources: old.sources.map((s, i) => ({ ...s, meaning: sample.content.sources[i]!.meaning })),
  });
  const override = structuredClone(b.sources[0]!);
  override.id += ':situation';
  override.position = 'situation';
  b.sources.push(override);
  for (const s of b.sources) {
    s.hash = await reviewedRecordHash(s);
    s.review.reviewedHash = s.hash;
  }
  b.editionHash = await contentHashV2(b);
  return b;
}

test('v2 approval binds rich fields and permits reviewed position-specific entries without changing v1 approval', async () => {
  const b = await approvedV2Fixture();
  expect((await inspectReviewedBundle(b)).schemaVersion).toBe(2);
  const a = await signedApproval(b);
  expect(a.signed.document.version).toBe('content-approval.v2');
  await a.authenticate();
  for (const mutate of [
    (v: typeof b) => {
      v.sources[0]!.meaning.positive += ' Changed.';
    },
    (v: typeof b) => {
      v.spreadVersion += '-changed';
    },
    (v: typeof b) => {
      v.fallbackV2.action += ' Changed.';
    },
  ]) {
    const changed = structuredClone(b);
    mutate(changed);
    for (const s of changed.sources) {
      s.hash = await reviewedRecordHash(s);
      s.review.reviewedHash = s.hash;
    }
    changed.editionHash = await contentHashV2(changed);
    await expect(verifySignedContentApproval(a.signed, changed, a.trust)).rejects.toThrow();
  }
  expect((await signedApproval(await editorialBundle())).signed.document.version).toBe(
    'content-approval.v1',
  );
});

test('automated validation still rejects draft markers in relationship text and limits', async () => {
  const b = await approvedV2Fixture(),
    input = await v2Input();
  for (const s of b.sources) {
    s.review.kind = 'automated_validated';
    s.rights.status = 'unknown';
    s.rights.evidence = '';
    s.rights.territory = '';
    s.hash = await reviewedRecordHash(s);
    s.review.reviewedHash = s.hash;
  }
  const note = await relationship(input, 'relationship-automated');
  note.deckEdition = b.deckEdition;
  note.sourceIds = b.sources.slice(0, 2).map((s) => s.id);
  note.review.kind = 'automated_validated';
  note.review.reviewer = 'validator-a';
  (note.rights as { status: string }).status = 'unknown';
  note.rights.evidence = '';
  note.rights.attribution = '';
  note.rights.territory = '';
  note.hash = await reviewedRecordHash(note);
  note.review.reviewedHash = note.hash;
  b.relationships = [note];
  b.editionHash = await contentHashV2(b);
  // Deferred rights evidence for automated records does not defer prose checks.
  await expect(inspectReviewedBundle(b)).resolves.toHaveProperty('schemaVersion', 2);
  for (const mutate of [
    (v: typeof note) => {
      v.text = 'A synthetic relationship note.';
    },
    (v: typeof note) => {
      v.limits = 'Pending codex draft limits.';
    },
  ]) {
    const changed = structuredClone(b);
    mutate(changed.relationships[0]! as typeof note);
    changed.relationships[0]!.hash = await reviewedRecordHash(changed.relationships[0]!);
    changed.relationships[0]!.review.reviewedHash = changed.relationships[0]!.hash;
    changed.editionHash = await contentHashV2(changed);
    await expect(inspectReviewedBundle(changed)).rejects.toThrow('Content not approved');
  }
});

test('unreviewed relationship cannot enter an otherwise approved v2 edition', async () => {
  const b = await approvedV2Fixture(),
    input = await v2Input();
  const note = await relationship(input, 'relationship-reviewed');
  note.deckEdition = b.deckEdition;
  note.sourceIds = b.sources.slice(0, 2).map((s) => s.id);
  note.review.kind = 'agent_reviewed';
  note.hash = await reviewedRecordHash(note);
  b.relationships = [note];
  b.editionHash = await contentHashV2(b);
  await expect(inspectReviewedBundle(b)).rejects.toThrow('Content not approved');
});
