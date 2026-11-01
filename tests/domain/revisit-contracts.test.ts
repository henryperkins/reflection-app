import { expect, test } from 'vitest';
import {
  AnyRevisit,
  Revisit,
  RevisitV2,
  PortableRecord,
  apiSchemas,
  ErrorCode,
} from '../../src/contracts/index.ts';
import { REVISIT_LIMITS, revisitTextLength } from '../../src/contracts/revisit-policy.ts';
const editionId = '11111111-1111-4111-8111-111111111111';
const legacy = {
  id: editionId,
  editionId,
  note: 'Old authored note',
  createdAt: '2026-10-01T00:00:00Z',
};
const current = {
  ...legacy,
  kind: 'revisit.v2',
  sessionId: editionId,
  revision: 1,
  stance: 'unspecified',
  updatedAt: legacy.createdAt,
};
test('authored note validation counts Unicode code points and preserves whitespace', () => {
  expect(revisitTextLength('😀'.repeat(2000))).toBe(2000);
  expect(REVISIT_LIMITS).toEqual({
    textCodePoints: 2000,
    activePerEdition: 100,
    revisionsPerNote: 100,
    pageDefault: 20,
    pageMax: 50,
    idempotencyMs: 604800000,
  });
  expect(apiSchemas.RevisitWrite.safeParse({ editionId, note: '😀'.repeat(2000) }).success).toBe(
    true,
  );
  for (const note of ['x'.repeat(2001), '', ' \n\t'])
    expect(apiSchemas.RevisitWrite.safeParse({ editionId, note }).success).toBe(false);
  expect(apiSchemas.RevisitWrite.parse({ editionId, note: '  hello\n' })).toEqual({
    editionId,
    note: '  hello\n',
    stance: 'unspecified',
  });
});
test('new endpoints use explicit V2 while portable notes retain legacy decoding', () => {
  expect(Revisit.safeParse(legacy).success).toBe(true);
  expect(AnyRevisit.safeParse(legacy).success).toBe(true);
  expect(AnyRevisit.safeParse(current).success).toBe(true);
  expect(RevisitV2.safeParse(current).success).toBe(true);
  for (const value of [legacy, current])
    expect(
      PortableRecord.safeParse({
        kind: 'revisit',
        originalId: editionId,
        identity: {
          source: { namespaceId: editionId, revision: 'v1' },
          kind: 'revisit',
          recordId: editionId,
          recordRevision: 1,
        },
        value,
      }).success,
    ).toBe(true);
  expect(apiSchemas.Revisit.safeParse(legacy).success).toBe(false);
  expect(apiSchemas.RevisitPage.parse({ items: [current], nextCursor: null }).items).toHaveLength(
    1,
  );
});
test('updates reject identity/date mutations and report distinct admission errors', () => {
  expect(apiSchemas.RevisitUpdate.parse({ note: 'Now' })).toEqual({
    note: 'Now',
    stance: 'unspecified',
  });
  for (const extra of [
    { editionId },
    { createdAt: legacy.createdAt },
    { ownerId: editionId },
    { sessionId: editionId },
    { revision: 2 },
  ])
    expect(apiSchemas.RevisitUpdate.safeParse({ note: 'Now', ...extra }).success).toBe(false);
  for (const error of [
    'NOTE_LIMIT_EXCEEDED',
    'REVISION_LIMIT_EXCEEDED',
    'STORAGE_LIMIT_EXCEEDED',
    'DEPENDENTS_EXIST',
  ])
    expect(ErrorCode.safeParse(error).success).toBe(true);
});

test.each(['', ' \n\t'])('normalized stored responses preserve valid legacy text %j', (note) => {
  const old = Revisit.parse({ ...legacy, note });
  const normalized = { ...current, note: old.note };
  expect(apiSchemas.Revisit.parse(normalized)).toEqual(normalized);
  expect(
    apiSchemas.RevisitPage.parse({ items: [normalized], nextCursor: null }).items[0]!.note,
  ).toBe(note);
  expect(AnyRevisit.parse(normalized)).toEqual(normalized);
  expect(apiSchemas.RevisitWrite.safeParse({ editionId, note }).success).toBe(false);
  expect(apiSchemas.RevisitUpdate.safeParse({ note }).success).toBe(false);
});
