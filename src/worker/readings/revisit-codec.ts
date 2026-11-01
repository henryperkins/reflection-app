import type { z } from 'zod';
import { AnyRevisit, Ciphertext, RevisitV2, type RevisitNote } from '../../contracts/index.ts';
import { type RecordBase, RecordError } from './base.ts';

export function revisitField(ownerId: string, id: string, revision: number, historical = false) {
  return {
    ownerId,
    table: historical ? 'revisit_revisions' : 'revisits',
    column: historical ? 'body_enc' : 'note_enc',
    recordId: historical ? `${id}:${revision}` : id,
    aadRevision: revision,
  };
}

/** Shared authenticated decoding for current, archived and portable snapshots. */
export async function decodeRevisit(
  base: RecordBase,
  ownerId: string,
  row: { id: string; edition_id: string; session_id: string; created_at: number },
  revision: number,
  body: string,
  keyVersion: number,
  updatedAt: number,
  historical: boolean,
): Promise<RevisitNote> {
  try {
    const envelope = Ciphertext.parse(JSON.parse(body!));
    if (envelope.keyVersion !== keyVersion) throw new Error('Column/envelope key mismatch');
    const stored = await base.opened<z.infer<typeof AnyRevisit>>(
      revisitField(ownerId, row.id, revision, historical),
      body!,
      AnyRevisit,
    );
    if (
      stored.id !== row.id ||
      stored.editionId !== row.edition_id ||
      Date.parse(stored.createdAt) !== row.created_at
    )
      throw new Error('Stored identity mismatch');
    if (!('kind' in stored)) {
      if (revision !== 1 || updatedAt !== row.created_at)
        throw new Error('Invalid legacy revision');
      return RevisitV2.parse({
        ...stored,
        kind: 'revisit.v2',
        sessionId: row.session_id,
        revision: 1,
        stance: 'unspecified',
        updatedAt: stored.createdAt,
      });
    }
    if (
      stored.sessionId !== row.session_id ||
      stored.revision !== revision ||
      Date.parse(stored.updatedAt) !== updatedAt
    )
      throw new Error('Stored revision mismatch');
    return stored;
  } catch {
    throw new RecordError(503, 'KEY_UNAVAILABLE');
  }
}
