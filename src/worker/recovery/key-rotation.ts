import type { Env } from '../index.ts';
import { canonicalJson, sha256Json } from '../../domain/json.ts';
import {
  IdentityCrypto,
  parseIdentitySecrets,
  type IdentityKeyring,
  type IdentitySecrets,
} from '../identity/crypto.ts';
import { statement as q, assertion } from '../identity/checkpoint.ts';
import { OfflineRestore } from './restore.ts';
import { erasureJobIds } from './ledger.ts';
import { CleanupJournal } from './cleanup-state.ts';
import { recoveryExclusive } from './coordination.ts';

interface KeyRow {
  owner_id: string;
  version: number;
  wrap_key_id: string;
  wrapped_key_enc: string;
  wrapped_index_key_enc: string;
}

/** Add-only local operator: retirement needs backup evidence this runner does not possess. */
export function validateKeyringTransition(current: IdentityCrypto, candidate: IdentityCrypto) {
  if (
    current.secrets.environment !== 'synthetic-local' ||
    candidate.secrets.environment !== current.secrets.environment
  )
    throw new Error('Key rotation requires the synthetic local environment');
  if (current.identityHmacKey !== candidate.identityHmacKey)
    throw new Error('Stable identity HMAC rotation requires a verifier migration');
  for (const previous of [current, ...current.retainedKeys()]) {
    let next: IdentityCrypto;
    try {
      next = candidate.forKey(previous.secrets.keyId);
    } catch {
      throw new Error(
        'Key retirement is disabled until backup and recovery references can be proven absent',
      );
    }
    if (canonicalJson(previous.secrets) !== canonicalJson(next.secrets))
      throw new Error('Existing key IDs cannot be assigned different key material');
  }
}

export class LocalKeyRotation {
  constructor(
    readonly env: Env,
    readonly candidate: IdentitySecrets | IdentityKeyring,
  ) {}
  private setup() {
    const current = new IdentityCrypto(parseIdentitySecrets(this.env.IDENTITY_SECRETS ?? '')),
      candidate = new IdentityCrypto(this.candidate);
    validateKeyringTransition(current, candidate);
    return {
      current,
      candidate,
      restore: new OfflineRestore({
        ...this.env,
        IDENTITY_SECRETS: JSON.stringify(this.candidate),
      }),
    };
  }
  private async offline() {
    const state = await q(
      this.env.DB,
      "SELECT 1 AS ok FROM system_state WHERE id=1 AND restore_in_progress=1 AND generation_enabled=0 AND dispatch_mode='off'",
    ).first();
    if (!state)
      throw new Error('Key rotation requires an offline database with generation disabled');
    if (
      await q(
        this.env.DB,
        "SELECT 1 FROM security_operations WHERE state!='applied' UNION ALL SELECT 1 FROM deletion_jobs WHERE state!='complete' LIMIT 1",
      ).first()
    )
      throw new Error('Flush pending security and erasure operations before key rotation');
  }
  private async validate(restore: OfflineRestore) {
    await this.offline();
    await new CleanupJournal(restore.erasure.ledger).requireRestorable(this.env.DB);
    const inventory = await restore.inventory(),
      owners = (
        await q(this.env.DB, 'SELECT id,auth_epoch,key_version FROM accounts').all<{
          id: string;
          auth_epoch: number;
          key_version: number;
        }>()
      ).results,
      knownOwners = new Set(owners.map((owner) => owner.id)),
      erasedAccounts = new Set<string>();
    for (const id of erasureJobIds(inventory.erasures)) {
      const { target } = await restore.erasure.ledger.load(id);
      knownOwners.add(target.subjectId);
      if (target.scope === 'account') erasedAccounts.add(target.subjectId);
    }
    const checkpoints = await restore.checkpoints(
      inventory.identity,
      [...knownOwners],
      erasedAccounts,
    );
    for (const account of owners) {
      if (!checkpoints.has(account.id) || checkpoints.get(account.id)!.epoch < account.auth_epoch)
        throw new Error('Missing current identity checkpoint');
      await restore.validateAccountKeys(account.id, account.key_version);
    }
    let keyRows = 0;
    for (;;) {
      const page = (
        await q(
          this.env.DB,
          'SELECT * FROM account_keys ORDER BY owner_id,version LIMIT 100 OFFSET ?',
          keyRows,
        ).all<KeyRow>()
      ).results;
      if (!page.length) break;
      for (const key of page) {
        for (const encrypted of [key.wrapped_key_enc, key.wrapped_index_key_enc])
          if (restore.base.identity.crypt.envelopeKeyId(encrypted) !== key.wrap_key_id)
            throw new Error('Account wrap identity mismatch');
      }
      keyRows += page.length;
    }
    for (const operation of (
      await q(
        this.env.DB,
        'SELECT id,owner_id,epoch,snapshot_enc,ledger_key FROM security_operations',
      ).all<{
        id: string;
        owner_id: string;
        epoch: number;
        snapshot_enc: string;
        ledger_key: string;
      }>()
    ).results) {
      const crypt = restore.base.identity.crypt.forKey(
          restore.base.identity.crypt.envelopeKeyId(operation.snapshot_enc),
        ),
        snapshot = await crypt.openCheckpoint(
          operation.owner_id,
          operation.epoch,
          operation.id,
          operation.snapshot_enc,
        );
      if ((await crypt.checkpointKey(snapshot)) !== operation.ledger_key)
        throw new Error('Security checkpoint identity mismatch');
    }
    const inventorySha256 = await sha256Json(inventory);
    if (inventorySha256 !== (await sha256Json(await restore.inventory())))
      throw new Error('Recovery inventory changed');
    return {
      keyRows,
      recoveryObjects: inventory.erasures.length + inventory.identity.length,
      inventorySha256,
    };
  }
  private summary(
    crypt: IdentityCrypto,
    checked: Awaited<ReturnType<LocalKeyRotation['validate']>>,
  ) {
    return {
      scope: 'synthetic-local-only' as const,
      activeKeyId: crypt.secrets.keyId,
      retainedKeyIds: crypt
        .retainedKeys()
        .map((key) => key.secrets.keyId)
        .sort(),
      ...checked,
      stillOffline: true as const,
      deploymentAllowed: false as const,
      keyRetirementAllowed: false as const,
    };
  }
  async check() {
    const { candidate, restore } = this.setup();
    return recoveryExclusive(candidate.secrets.environment, async () =>
      this.summary(candidate, await this.validate(restore)),
    );
  }
  async rewrap() {
    const { candidate, restore } = this.setup();
    return recoveryExclusive(candidate.secrets.environment, async () => {
      await this.validate(restore);
      let changedRows = 0;
      for (;;) {
        const page = (
          await q(
            this.env.DB,
            'SELECT * FROM account_keys WHERE wrap_key_id!=? ORDER BY owner_id,version LIMIT 20',
            candidate.secrets.keyId,
          ).all<KeyRow>()
        ).results;
        if (!page.length) break;
        const writes = [
          assertion(
            this.env.DB,
            "EXISTS(SELECT 1 FROM system_state WHERE id=1 AND restore_in_progress=1 AND generation_enabled=0 AND dispatch_mode='off')",
          ),
        ];
        for (const previous of page) {
          const next = await candidate.rewrapAccountKeys(previous.owner_id, previous.version, {
            wrapKeyId: previous.wrap_key_id,
            wrappedKey: previous.wrapped_key_enc,
            wrappedIndexKey: previous.wrapped_index_key_enc,
          });
          writes.push(
            assertion(
              this.env.DB,
              'EXISTS(SELECT 1 FROM account_keys WHERE owner_id=? AND version=? AND wrap_key_id=? AND wrapped_key_enc=? AND wrapped_index_key_enc=?)',
              previous.owner_id,
              previous.version,
              previous.wrap_key_id,
              previous.wrapped_key_enc,
              previous.wrapped_index_key_enc,
            ),
            q(
              this.env.DB,
              'UPDATE account_keys SET wrap_key_id=?,wrapped_key_enc=?,wrapped_index_key_enc=? WHERE owner_id=? AND version=?',
              next.wrapKeyId,
              next.wrappedKey,
              next.wrappedIndexKey,
              previous.owner_id,
              previous.version,
            ),
          );
        }
        await this.env.DB.batch(writes);
        changedRows += page.length;
      }
      return { ...this.summary(candidate, await this.validate(restore)), changedRows };
    });
  }
}
