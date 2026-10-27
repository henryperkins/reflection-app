import { z } from 'zod';
import { canonicalJson, sha256Json } from '../../domain/json.ts';
import { Ciphertext } from '../../contracts/index.ts';
import type { ApplicationRuntime } from '../runtime/application.ts';
import type { OfflineContext } from './hosted-coordinator.ts';
import type { BackupInventory } from './backup-inventory.ts';
import { OfflineRestore } from './restore.ts';
import { CleanupJournal, CLEANUP_STATE_KEY } from './cleanup-state.ts';
import { objects, erasureJobIds, type ErasureLedger } from './ledger.ts';
import { ACCOUNT_FIELD_HANDLERS } from './private-fields.ts';
import { privateFieldRegistryHash } from './account-rekey.ts';
import { RecordCrypto } from '../readings/crypto.ts';
import { bytesDigest } from './digest.ts';

export interface AccountKeyReference {
  ownerId: string;
  version: number;
  wrapKeyId: string;
  active: boolean;
  liveFields: number;
  operationalReferences: number;
  unfinishedJob: boolean;
  backupRequired: boolean;
}
export interface KeyReferenceInventory {
  version: 1;
  environmentId: string;
  coordinatorEpoch: number;
  registryHash: string;
  manifestDigest: string;
  referenceDigest: string;
  observedAt: string;
  referencedKeyIds: string[];
  accountKeys: AccountKeyReference[];
  counts: {
    wraps: number;
    fields: number;
    checkpoints: number;
    securityOperations: number;
    erasureChains: number;
    backups: number;
    unfinishedRekeys: number;
  };
  complete: boolean;
  digest: string;
  limitations: string[];
}
const emptyCounts = () => ({
  wraps: 0,
  fields: 0,
  checkpoints: 0,
  securityOperations: 0,
  erasureChains: 0,
  backups: 0,
  unfinishedRekeys: 0,
});
async function verifiedBackups(backups: BackupInventory, environment: string) {
  const manifests = await backups.list();
  for (const manifest of manifests)
    if (manifest.environmentId !== environment || !(await backups.verify(manifest)))
      throw new Error('Independent backup copy unavailable');
  return manifests;
}

/** Private operational inventory; publish only counts/digests, never its account identities. */
export async function inventoryKeyReferences(
  runtime: ApplicationRuntime,
  context: OfflineContext,
  backups: BackupInventory,
): Promise<KeyReferenceInventory> {
  const environment = runtime.environmentId,
    registryHash = await privateFieldRegistryHash();
  const unavailable = async (): Promise<KeyReferenceInventory> => {
    const value = {
      version: 1 as const,
      environmentId: environment,
      coordinatorEpoch: context.epoch,
      registryHash,
      manifestDigest: '0'.repeat(64),
      referenceDigest: '0'.repeat(64),
      observedAt: new Date().toISOString(),
      referencedKeyIds: [runtime.identity.crypt, ...runtime.identity.crypt.retainedKeys()]
        .map((k) => k.secrets.keyId)
        .sort(),
      accountKeys: [],
      counts: emptyCounts(),
      complete: false,
      limitations: ['INVENTORY_INCOMPLETE'],
    };
    return { ...value, digest: await sha256Json(value) };
  };
  try {
    if (!runtime.coordinator || context.environmentId !== environment)
      throw new Error('Offline coordinator required');
    return await runtime.coordinator.withOffline(context, async () => {
      const restore = new OfflineRestore(
        { DB: runtime.base.db, RECOVERY: runtime.recoveryBucket, RESTORE_MODE: 'offline' },
        {
          runtime,
          offline: { coordinator: runtime.coordinator!, context },
          validateContent: async () => false,
        },
      );
      await restore.fence();
      const scan = async () => {
        const manifests = await verifiedBackups(backups, environment),
          counts = emptyCounts(),
          refs = new Set<string>(),
          owners = new Set<string>();
        const accounts = (
          await runtime.base.db
            .prepare('SELECT id,key_version,auth_epoch FROM accounts ORDER BY id')
            .all<{ id: string; key_version: number; auth_epoch: number }>()
        ).results;
        const accountVersions = new Map(accounts.map((a) => [a.id, a.key_version]));
        for (const account of accounts) owners.add(account.id);
        const wraps: unknown[] = [];
        const keyRows: AccountKeyReference[] = [],
          keyByIdentity = new Map<string, AccountKeyReference>();
        for (let offset = 0; ; offset += 100) {
          const rows = (
            await runtime.base.db
              .prepare('SELECT * FROM account_keys ORDER BY owner_id,version LIMIT 100 OFFSET ?')
              .bind(offset)
              .all<{
                owner_id: string;
                version: number;
                wrap_key_id: string;
                wrapped_key_enc: string;
                wrapped_index_key_enc: string;
              }>()
          ).results;
          for (const row of rows) {
            for (const [purpose, body] of [
              ['data', row.wrapped_key_enc],
              ['index', row.wrapped_index_key_enc],
            ] as const) {
              if (runtime.identity.crypt.envelopeKeyId(body) !== row.wrap_key_id)
                throw new Error('Account wrap identity changed');
              await runtime.identity.crypt.unwrapAccountKey(
                row.owner_id,
                body,
                purpose,
                row.version,
              );
            }
            wraps.push({
              ownerId: row.owner_id,
              version: row.version,
              wrapKeyId: row.wrap_key_id,
              dataHash: await bytesDigest(new TextEncoder().encode(row.wrapped_key_enc)),
              indexHash: await bytesDigest(new TextEncoder().encode(row.wrapped_index_key_enc)),
            });
            refs.add(row.wrap_key_id);
            owners.add(row.owner_id);
            const key = {
              ownerId: row.owner_id,
              version: row.version,
              wrapKeyId: row.wrap_key_id,
              active: accountVersions.get(row.owner_id) === row.version,
              liveFields: 0,
              operationalReferences: 0,
              unfinishedJob: false,
              backupRequired: false,
            };
            keyRows.push(key);
            keyByIdentity.set(row.owner_id + ':' + row.version, key);
            counts.wraps++;
          }
          if (rows.length < 100) break;
        }
        for (const table of new Set(
          ACCOUNT_FIELD_HANDLERS.filter((f) => f.table !== 'reading_sessions').map((f) => f.table),
        )) {
          const rows = (
            await runtime.base.db
              .prepare(
                `SELECT owner_id,key_version,count(*) n FROM ${table} GROUP BY owner_id,key_version`,
              )
              .all<{ owner_id: string; key_version: number; n: number }>()
          ).results;
          for (const row of rows) {
            const key = keyByIdentity.get(row.owner_id + ':' + row.key_version);
            if (!key) throw new Error('Unregistered operational key reference');
            key.operationalReferences += row.n;
          }
        }
        const recordCrypto = new RecordCrypto(runtime.base.db, runtime.identity.crypt),
          fieldDescriptors: unknown[] = [];
        for (const field of ACCOUNT_FIELD_HANDLERS)
          for (let offset = 0; ; offset += 100) {
            const rows = (
              await runtime.base.db
                .prepare(
                  `SELECT * FROM ${field.table} WHERE ${field.column} IS NOT NULL ORDER BY owner_id,${field.keyColumns.join(',')} LIMIT 100 OFFSET ?`,
                )
                .bind(offset)
                .all<Record<string, unknown>>()
            ).results;
            for (const row of rows) {
              const body = z.string().parse(row[field.column]),
                identity = field.identity(row, body),
                version = Ciphertext.parse(JSON.parse(body)).keyVersion,
                key = keyByIdentity.get(identity.ownerId + ':' + version);
              if (!key) throw new Error('Unregistered field key');
              await recordCrypto.open(identity, body, z.unknown());
              key.liveFields++;
              counts.fields++;
              fieldDescriptors.push({
                identity,
                version,
                ciphertextHash: await bytesDigest(new TextEncoder().encode(body)),
              });
            }
            if (rows.length < 100) break;
          }
        const jobs = (
          await runtime.base.db
            .prepare(
              "SELECT owner_id,expected_version,target_version,phase,registry_hash FROM account_rekey_jobs WHERE phase!='complete' ORDER BY id",
            )
            .all<{
              owner_id: string;
              expected_version: number;
              target_version: number;
              phase: string;
              registry_hash: string;
            }>()
        ).results;
        for (const job of jobs) {
          if (job.registry_hash !== registryHash)
            throw new Error('Unfinished rekey registry changed');
          for (const version of [job.expected_version, job.target_version]) {
            const key = keyByIdentity.get(job.owner_id + ':' + version);
            if (!key) throw new Error('Unfinished rekey key missing');
            key.unfinishedJob = true;
          }
          counts.unfinishedRekeys++;
        }
        for (const manifest of manifests) {
          counts.backups++;
          for (const keyId of manifest.requiredEnvironmentKeyIds) {
            runtime.identity.crypt.forKey(keyId);
            refs.add(keyId);
          }
          for (const key of manifest.requiredAccountKeys) {
            owners.add(key.ownerId);
            const found = keyByIdentity.get(key.ownerId + ':' + key.version);
            if (found) found.backupRequired = true;
          }
        }
        const inventory = await restore.inventory();
        for (const id of erasureJobIds(inventory.erasures)) {
          const chain = await restore.erasure.ledger.load(id);
          owners.add(chain.target.subjectId);
          refs.add(chain.intent.hmacKeyId);
          refs.add(chain.intent.target.keyId);
          counts.erasureChains++;
        }
        const deletionJobs = (
          await runtime.base.db
            .prepare('SELECT * FROM deletion_jobs ORDER BY id')
            .all<Parameters<ErasureLedger['fromPending']>[0] & { state: string }>()
        ).results;
        for (const job of deletionJobs) {
          if (job.target_enc) {
            const intent = await restore.erasure.ledger.fromPending(job);
            refs.add(intent.hmacKeyId);
            refs.add(intent.target.keyId);
            owners.add((await restore.erasure.ledger.target(intent)).subjectId);
          }
          if (job.state !== 'complete')
            throw new Error('Pending erasure must finish before retirement');
        }
        const checkpointValues = new Map();
        const current = await restore.checkpoints(
          inventory.identity,
          [...owners],
          new Set(),
          checkpointValues,
        );
        counts.checkpoints = checkpointValues.size;
        for (const account of accounts)
          if (!current.has(account.id) || current.get(account.id)!.epoch < account.auth_epoch)
            throw new Error('Current identity checkpoint missing');
        const security = (
          await runtime.base.db
            .prepare('SELECT * FROM security_operations ORDER BY owner_id,epoch')
            .all<{
              id: string;
              owner_id: string;
              epoch: number;
              state: string;
              snapshot_enc: string;
              ledger_key: string;
            }>()
        ).results;
        for (const operation of security) {
          const crypt = runtime.identity.crypt.forKey(
            runtime.identity.crypt.envelopeKeyId(operation.snapshot_enc),
          );
          await crypt.openCheckpoint(
            operation.owner_id,
            operation.epoch,
            operation.id,
            operation.snapshot_enc,
          );
          refs.add(crypt.secrets.keyId);
          counts.securityOperations++;
          if (operation.state !== 'applied')
            throw new Error('Pending security work must finish before retirement');
          if (!inventory.identity.some((o) => o.key === operation.ledger_key))
            throw new Error('Independent checkpoint copy missing');
        }
        const cleanup = await new CleanupJournal(restore.erasure.ledger).requireRestorable(
          runtime.base.db,
        );
        if (cleanup) refs.add(cleanup.value.keyId);
        const attested = manifests.filter(
          (m) =>
            m.kind === 'recovery' &&
            m.purpose === 'inventory' &&
            m.coordinatorEpoch === context.epoch,
        );
        if (attested.length !== 1 || !attested[0]!.recoveryObjects)
          throw new Error('Current independently attested object inventory required');
        const expected = new Map(attested[0]!.recoveryObjects!.map((o) => [o.key, o.sha256]));
        if (expected.size !== attested[0]!.recoveryObjects!.length)
          throw new Error('Duplicate recovery object identity');
        const listed = await objects(runtime.recoveryBucket, ''),
          rawDescriptors = [];
        if (listed.length !== expected.size)
          throw new Error('Recovery store differs from independent inventory');
        for (const object of listed) {
          if (!expected.has(object.key)) throw new Error('Unattested recovery object');
          const body = await runtime.recoveryBucket.get(object.key);
          if (!body || body.etag !== object.etag) throw new Error('Recovery store changed');
          const bytes = await body.arrayBuffer(),
            sha256 = await bytesDigest(bytes);
          if (sha256 !== expected.get(object.key))
            throw new Error('Recovery object differs from attested bytes');
          rawDescriptors.push({ key: object.key, sha256 });
          if (object.key.startsWith('identity/'))
            refs.add(runtime.identity.crypt.envelopeKeyId(new TextDecoder().decode(bytes)));
          if (object.key.startsWith('erasures/')) {
            const doc = JSON.parse(new TextDecoder().decode(bytes)) as { hmacKeyId: string };
            runtime.identity.crypt.forKey(doc.hmacKeyId);
            refs.add(doc.hmacKeyId);
          }
          if (
            object.key !== CLEANUP_STATE_KEY &&
            !object.key.startsWith('identity/') &&
            !object.key.startsWith('erasures/')
          )
            throw new Error('Unknown recovery object');
        }
        const securityDescriptors = [];
        for (const { snapshot_enc, ...row } of security)
          securityDescriptors.push({
            ...row,
            ciphertextHash: await bytesDigest(new TextEncoder().encode(snapshot_enc)),
          });
        const descriptor = {
          manifests,
          accounts,
          keyRows,
          wraps,
          fieldDescriptors,
          jobs,
          security: securityDescriptors,
          recovery: rawDescriptors.sort((a, b) => a.key.localeCompare(b.key)),
          cleanup: cleanup?.value ?? null,
        };
        return { descriptor, manifests, counts, refs: [...refs].sort(), accountKeys: keyRows };
      };
      const first = await scan(),
        second = await scan();
      if (canonicalJson(first.descriptor) !== canonicalJson(second.descriptor))
        throw new Error('Key inventory changed between scans');
      await runtime.coordinator!.assertCurrent(context);
      const value = {
        version: 1 as const,
        environmentId: environment,
        coordinatorEpoch: context.epoch,
        registryHash,
        manifestDigest: await sha256Json(first.manifests),
        referenceDigest: await sha256Json(first.descriptor),
        observedAt: new Date().toISOString(),
        referencedKeyIds: first.refs,
        accountKeys: first.accountKeys,
        counts: first.counts,
        complete: true,
        limitations: [
          'Private operational inventory; store outside public evidence.',
          'Physical/offline copies are supported only when registered in the signed independent inventory.',
        ],
      };
      return { ...value, digest: await sha256Json(value) };
    });
  } catch {
    return unavailable();
  }
}

export async function rolloverIdentityCheckpoint(
  runtime: ApplicationRuntime,
  context: OfflineContext,
  ownerId: string,
) {
  if (!runtime.coordinator || context.environmentId !== runtime.environmentId)
    throw new Error('Offline coordinator required');
  return runtime.coordinator.withOffline(context, async () => {
    const restore = new OfflineRestore(
      { DB: runtime.base.db, RECOVERY: runtime.recoveryBucket, RESTORE_MODE: 'offline' },
      {
        runtime,
        offline: { coordinator: runtime.coordinator!, context },
        validateContent: async () => false,
      },
    );
    await restore.fence();
    const previous = await runtime.identity.snapshot(ownerId),
      snapshot = {
        ...previous,
        epoch: previous.epoch + 1,
        operationId: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
      };
    await runtime.identity.checkpoints.commit(snapshot, {
      expected: previous,
      lease: { coordinator: runtime.coordinator!, context },
    });
    return {
      operationId: snapshot.operationId,
      epoch: snapshot.epoch,
      stillOffline: true as const,
    };
  });
}

export function summarizeKeyInventory(inventory: KeyReferenceInventory) {
  const counts: Record<string, number> = {};
  for (const key of [
    'wraps',
    'fields',
    'checkpoints',
    'securityOperations',
    'erasureChains',
    'backups',
    'unfinishedRekeys',
  ] as const)
    counts[key] = z.number().int().nonnegative().parse(inventory.counts[key]);
  return {
    complete: z.boolean().parse(inventory.complete),
    observedAt: z.iso.datetime().parse(inventory.observedAt),
    digest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(inventory.digest),
    counts,
  };
}
