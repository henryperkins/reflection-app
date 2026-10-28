import { Ciphertext } from '../../contracts/index.ts';
import type { RecordFieldIdentity } from '../readings/crypto.ts';

export interface AccountPrivateField {
  family: 'account-data';
  table: string;
  column: string;
  aadRule: string;
  keyColumns: readonly string[];
  identity(row: Record<string, unknown>, ciphertext: string): RecordFieldIdentity;
}
interface RecoveryPrivateField {
  family: 'recovery';
  table: string;
  column: string;
  aadRule: string;
}
function account(
  table: string,
  column: string,
  keyColumns: readonly string[],
  parts: readonly string[],
  expression: string,
): AccountPrivateField {
  return {
    family: 'account-data',
    table,
    column,
    keyColumns,
    aadRule: `[env,${table},${column},owner_id,${expression},envelope.aadRevision,1,envelope.keyVersion]`,
    identity(row, ciphertext) {
      if (typeof row.owner_id !== 'string' || row.owner_id.length !== 36)
        throw new Error('Encrypted field owner unavailable');
      const ids = parts.map((part) => {
        const value = row[part];
        if ((typeof value !== 'string' && typeof value !== 'number') || value === '')
          throw new Error('Encrypted field identity unavailable');
        return String(value);
      });
      return {
        ownerId: row.owner_id,
        table,
        column,
        recordId: ids.join(':'),
        aadRevision: Ciphertext.parse(JSON.parse(ciphertext)).aadRevision,
      };
    },
  };
}
/** Explicit reviewed closure, including fields whose product routes remain deferred. */
export const PRIVATE_FIELD_HANDLERS: readonly (AccountPrivateField | RecoveryPrivateField)[] = [
  account('basis_snapshots', 'body_enc', ['id'], ['id'], 'id'),
  account(
    'generation_context',
    'fragment_enc',
    ['request_id', 'ordinal'],
    ['request_id', 'ordinal'],
    'request_id || : || ordinal',
  ),
  account('generation_requests', 'input_enc', ['id'], ['id'], 'id'),
  account('generation_requests', 'plan_enc', ['id'], ['id'], 'id'),
  account(
    'import_identities',
    'source_record_enc',
    ['owner_id', 'source_key_hmac'],
    ['source_key_hmac'],
    'source_key_hmac',
  ),
  account(
    'import_items',
    'body_enc',
    ['batch_id', 'item_index'],
    ['batch_id', 'item_index'],
    'batch_id || : || item_index',
  ),
  account('provider_dispatches', 'provider_response_id_enc', ['id'], ['id'], 'id'),
  account('provider_dispatches', 'transmission_enc', ['id'], ['id'], 'id'),
  account('provider_dispatches', 'candidate_enc', ['id'], ['id'], 'id'),
  account('reading_editions', 'body_enc', ['id'], ['id'], 'id'),
  account('reading_sessions', 'question_enc', ['id'], ['id'], 'id'),
  account(
    'reflection_revisions',
    'body_enc',
    ['reflection_id', 'revision'],
    ['reflection_id', 'revision'],
    'reflection_id || : || revision',
  ),
  account('revisits', 'note_enc', ['id'], ['id'], 'id'),
  {
    family: 'recovery',
    table: 'deletion_jobs',
    column: 'target_enc',
    aadRule:
      "JCS([env,'erasure-target.v1',jobId,scope,subjectHmac,targetHmac,hmacKeyId,requestedAt,target.keyId]); same RecoveryCiphertext as R2 intent",
  },
  {
    family: 'recovery',
    table: 'security_operations',
    column: 'snapshot_enc',
    aadRule: '[env,identity-checkpoint,HMAC(subjectId),epoch,id,1] under RECOVERY_KEK',
  },
];
export const ACCOUNT_FIELD_HANDLERS = PRIVATE_FIELD_HANDLERS.filter(
  (field): field is AccountPrivateField => field.family === 'account-data',
);
