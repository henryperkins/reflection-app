import { env } from 'cloudflare:workers';
import { applyD1Migrations, runInDurableObject } from 'cloudflare:test';
import { beforeAll, expect, test } from 'vitest';
import {
  HostedCoordinator,
  backupInventoryManifestDigest,
  financialReconciliationDigest,
  type OfflineControl,
  type OfflineContext,
} from '../../src/worker/recovery/hosted-coordinator.ts';
import { ProtectedBackupInventory } from '../../src/worker/recovery/backup-inventory.ts';
import { canonicalJson } from '../../src/domain/json.ts';
import { encode } from '../../src/worker/identity/crypto.ts';
import { bytesDigest } from '../../src/worker/recovery/digest.ts';

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
const secret = 'synthetic-offline-control-token-not-a-deployed-secret';
function clients() {
  const environment = 'coord-' + crypto.randomUUID();
  return {
    environment,
    a: new HostedCoordinator(env.OFFLINE_COORDINATOR, secret, environment),
    b: new HostedCoordinator(env.OFFLINE_COORDINATOR, secret, environment),
  };
}

async function validationDocument(environment: string, lease: OfflineContext) {
  return {
    version: 1,
    producer: 'restore-validator.v1',
    status: 'passed',
    environmentId: environment,
    operationId: lease.operationId,
    epoch: lease.epoch,
    sourceDigest: 'a'.repeat(64),
    configurationDigest: 'b'.repeat(64),
    backupInventoryDigest: await backupInventoryManifestDigest(env.BACKUP_INVENTORY, environment),
    recoveryValidationDigest: 'd'.repeat(64),
    financialReconciliationDigest: await financialReconciliationDigest(env.DB),
    validatedAt: new Date().toISOString(),
    generation: 'off',
  };
}

async function storeSignedValidation(environment: string, lease: OfflineContext) {
  const document = await validationDocument(environment, lease);
  const key = await crypto.subtle.importKey(
    'jwk',
    JSON.parse(env.TEST_RECOVERY_VALIDATION_SIGNING_KEY),
    'Ed25519',
    false,
    ['sign'],
  );
  const envelope = {
    document,
    signature: encode(
      new Uint8Array(
        await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(canonicalJson(document))),
      ),
    ),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(envelope)),
    digest = await bytesDigest(bytes);
  await env.BACKUP_INVENTORY.put('recovery-validation/' + digest + '.json', bytes);
  return { document, digest };
}

async function markValidated(environment: string, lease: OfflineContext, digest: string) {
  await env.DB.prepare("INSERT INTO hosted_coordination VALUES(?,?,'validated',?,?)")
    .bind(environment, lease.epoch, digest, Date.now())
    .run();
  await env.DB.prepare(
    "INSERT INTO system_state(id,provider_policy_hash,restore_in_progress,generation_enabled,dispatch_mode,updated_at) VALUES(1,?,1,0,'off',?) ON CONFLICT(id) DO UPDATE SET restore_in_progress=1,generation_enabled=0,dispatch_mode='off'",
  )
    .bind('0'.repeat(64), Date.now())
    .run();
}

test('independent clients close ingress and drain a delayed writer before offline work', async () => {
  const { a, b } = clients();
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>((r) => (entered = r));
  const running = a.withWriter(async () => {
    entered();
    await new Promise<void>((r) => (release = r));
  });
  await ready;
  const lease = await b.acquire('restore');
  await expect(b.assertCurrent(lease)).rejects.toThrow();
  await expect(a.withWriter(async () => {})).rejects.toThrow();
  await expect(a.acquire('cleanup')).rejects.toThrow();
  release();
  await running;
  await b.assertCurrent(lease);
  await b.complete(lease, 'a'.repeat(64));
  await expect(a.withWriter(async () => {})).rejects.toThrow();
  await expect(b.resume(lease, 'a'.repeat(64))).rejects.toThrow();
});

test('epoch survives D1 rollback and a stale operator cannot write after a new epoch', async () => {
  const { a, b, environment } = clients();
  const first = await a.acquire('restore');
  await a.assertCurrent(first);
  await runInDurableObject(
    env.OFFLINE_COORDINATOR.getByName(environment),
    async (_: OfflineControl, state) => {
      state.storage.sql.exec('UPDATE control SET expires_at=1');
    },
  );
  const next = await b.acquire('rekey');
  expect(next.epoch).toBeGreaterThan(first.epoch);
  await env.DB.prepare('DELETE FROM hosted_coordination WHERE environment_id=?')
    .bind(environment)
    .run();
  await b.assertCurrent(next);
  await expect(a.assertCurrent(first)).rejects.toThrow();
  await expect(a.withOffline(first, async () => {})).rejects.toThrow();
  await expect(a.complete(first, 'b'.repeat(64))).rejects.toThrow();
});

test('an outstanding offline mutation cannot be assumed dead when its lease expires', async () => {
  const { a, b, environment } = clients();
  const lease = await a.acquire('cleanup');
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>((r) => (entered = r));
  const running = a.withOffline(lease, async () => {
    entered();
    await new Promise<void>((r) => (release = r));
  });
  await ready;
  await runInDurableObject(
    env.OFFLINE_COORDINATOR.getByName(environment),
    async (_: OfflineControl, state) => {
      state.storage.sql.exec('UPDATE control SET expires_at=1');
    },
  );
  await expect(b.acquire('restore')).rejects.toThrow();
  release();
  await expect(running).rejects.toThrow();
  const next = await b.acquire('restore');
  await b.assertCurrent(next);
});

test('invalid operator secrets and cross-environment contexts never establish authority', async () => {
  const { a, environment } = clients();
  const wrong = new HostedCoordinator(env.OFFLINE_COORDINATOR, 'wrong-secret', environment);
  await expect(wrong.acquire('restore')).rejects.toThrow();
  const lease = await a.acquire('restore');
  await expect(a.assertCurrent({ ...lease, environmentId: 'wrong-environment' })).rejects.toThrow();
  await expect(a.complete(lease, 'not-a-digest')).rejects.toThrow();
});

test('abandoned writer registrations survive coordinator instance replacement and do not expire open', async () => {
  const { a, b, environment } = clients();
  const stub = env.OFFLINE_COORDINATOR.getByName(environment);
  await stub.registerWriter(secret, environment, 'abandoned-writer');
  const lease = await a.acquire('restore');
  await expect(b.assertCurrent(lease)).rejects.toThrow();
  await runInDurableObject(stub, async (_: OfflineControl, state) => {
    expect(state.storage.sql.exec('SELECT count(*) n FROM writers').one().n).toBe(1);
  });
  await expect(b.withWriter(async () => {})).rejects.toThrow();
});

test('missing independent inventory and a listing without a signed complete index fail closed', async () => {
  const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const missing = new ProtectedBackupInventory(undefined, 'missing-inventory', keys.publicKey);
  await expect(missing.list()).rejects.toThrow();
  const absentIndex = new ProtectedBackupInventory(
    env.BACKUP_INVENTORY,
    'absent-' + crypto.randomUUID(),
    keys.publicKey,
  );
  await expect(absentIndex.list()).rejects.toThrow();
});

test('resume requires byte-verified recovery evidence and a matching validated database epoch, and retains generation off', async () => {
  const { a, environment } = clients(),
    lease = await a.acquire('restore');
  const { digest } = await storeSignedValidation(environment, lease);
  await a.complete(lease, digest);
  await expect(a.resume(lease, digest)).rejects.toThrow();
  await markValidated(environment, lease, digest);
  await a.resume(lease, digest);
  await expect(a.withWriter(async () => 42)).resolves.toBe(42);
  await expect(a.assertCurrent(lease)).rejects.toThrow();
});

test('resume rejects unsigned and digest-mismatched recovery evidence', async () => {
  for (const failure of ['unsigned', 'financial'] as const) {
    const { a, environment } = clients(),
      lease = await a.acquire('restore');
    let digest: string;
    if (failure === 'unsigned') {
      // The pre-fix artifact shape: a bare unsigned document.
      const document = await validationDocument(environment, lease);
      const bytes = new TextEncoder().encode(JSON.stringify(document));
      digest = await bytesDigest(bytes);
      await env.BACKUP_INVENTORY.put('recovery-validation/' + digest + '.json', bytes);
    } else {
      // Properly signed, but its financial digest does not match D1.
      const document = {
        ...(await validationDocument(environment, lease)),
        financialReconciliationDigest: 'f'.repeat(64),
      };
      const key = await crypto.subtle.importKey(
        'jwk',
        JSON.parse(env.TEST_RECOVERY_VALIDATION_SIGNING_KEY),
        'Ed25519',
        false,
        ['sign'],
      );
      const envelope = {
        document,
        signature: encode(
          new Uint8Array(
            await crypto.subtle.sign(
              'Ed25519',
              key,
              new TextEncoder().encode(canonicalJson(document)),
            ),
          ),
        ),
      };
      const bytes = new TextEncoder().encode(JSON.stringify(envelope));
      digest = await bytesDigest(bytes);
      await env.BACKUP_INVENTORY.put('recovery-validation/' + digest + '.json', bytes);
    }
    await markValidated(environment, lease, digest);
    await a.complete(lease, digest);
    await expect(a.resume(lease, digest)).rejects.toThrow();
    await expect(a.withWriter(async () => 42)).rejects.toThrow();
  }
});

test('separate invocations cannot mutate concurrently under the same offline context', async () => {
  const { a, b } = clients(),
    context = await a.acquire('rekey');
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>((r) => (entered = r));
  const first = a.withOffline(context, async () => {
    entered();
    await new Promise<void>((r) => (release = r));
  });
  await ready;
  try {
    await expect(b.withOffline(context, async () => 42)).rejects.toThrow();
  } finally {
    release();
    await first;
  }
});

test('completion freezes further mutations, allows another offline operation, and never opens ingress', async () => {
  const { a, b } = clients(),
    context = await a.acquire('rekey');
  await a.complete(context, 'a'.repeat(64));
  await expect(a.withOffline(context, async () => 42)).rejects.toThrow();
  const next = await b.acquire('restore');
  expect(next.epoch).toBeGreaterThan(context.epoch);
  await expect(a.withWriter(async () => 42)).rejects.toThrow();
});

test.each(['normal', 'offline'] as const)(
  'signed independent quiescence can reconcile a killed %s invocation without reopening ingress',
  async (kind) => {
    const { a, b, environment } = clients(),
      stub = env.OFFLINE_COORDINATOR.getByName(environment);
    let context: OfflineContext;
    if (kind === 'normal') {
      await stub.registerWriter(secret, environment, 'lost-process-registration');
      context = await a.acquire('restore');
    } else {
      context = await a.acquire('rekey');
      await stub.beginOffline(secret, context, 'lost-process-registration');
    }
    const snapshot = await a.inspectRegistrations();
    expect(snapshot.writers).toEqual([
      {
        id: 'lost-process-registration',
        operationId: kind === 'normal' ? null : context.operationId,
      },
    ]);
    const document = {
      version: 1,
      producer: 'platform-quiescence.v1',
      status: 'quiescent',
      environmentId: environment,
      operationId: context.operationId,
      epoch: context.epoch,
      registrationDigest: snapshot.registrationDigest,
      ingress: 'blocked',
      egress: 'blocked',
      terminationEvidenceDigest: 'a'.repeat(64),
      sourceDigest: 'b'.repeat(64),
      configurationDigest: 'c'.repeat(64),
      observedAt: new Date().toISOString(),
    };
    const key = await crypto.subtle.importKey(
      'jwk',
      JSON.parse(env.TEST_QUIESCENCE_SIGNING_KEY),
      'Ed25519',
      false,
      ['sign'],
    );
    const signed = {
      document,
      signature: encode(
        new Uint8Array(
          await crypto.subtle.sign(
            'Ed25519',
            key,
            new TextEncoder().encode(canonicalJson(document)),
          ),
        ),
      ),
    };
    async function store(envelope: unknown) {
      const bytes = new TextEncoder().encode(JSON.stringify(envelope)),
        digest = await bytesDigest(bytes);
      await env.BACKUP_INVENTORY.put('quiescence/' + digest + '.json', bytes);
      return digest;
    }
    await expect(
      a.reconcileRegistrations(await store({ ...signed, signature: encode(new Uint8Array(64)) })),
    ).rejects.toThrow();
    expect((await b.inspectRegistrations()).writers).toHaveLength(1);
    const next = await a.reconcileRegistrations(await store(signed));
    expect(next.epoch).toBeGreaterThan(context.epoch);
    await b.assertCurrent(next);
    await expect(a.assertCurrent(context)).rejects.toThrow();
    await expect(a.withWriter(async () => 42)).rejects.toThrow();
    expect((await b.inspectRegistrations()).writers).toEqual([]);
    await expect(a.reconcileRegistrations(await store(signed))).rejects.toThrow();
  },
);

test('resume reserves persistent exclusion while awaiting evidence and refuses a changed D1 epoch atomically', async () => {
  const { a, b, environment } = clients(),
    context = await a.acquire('restore'),
    stub = env.OFFLINE_COORDINATOR.getByName(environment);
  const { digest } = await storeSignedValidation(environment, context);
  await markValidated(environment, context, digest);
  await a.complete(context, digest);
  await runInDurableObject(stub, async (instance: OfflineControl) => {
    const binding = (instance as unknown as { env: { DB: D1Database } }).env,
      original = binding.DB;
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((r) => (entered = r)),
      gate = new Promise<void>((r) => (release = r));
    binding.DB = {
      prepare: original.prepare.bind(original),
      batch: async (statements: D1PreparedStatement[]) => {
        entered();
        await gate;
        return original.batch(statements);
      },
    } as D1Database;
    const resuming = a.resume(context, digest);
    resuming.catch(() => {});
    await ready;
    try {
      await expect(b.acquire('rekey')).rejects.toThrow();
      await env.DB.prepare(
        "UPDATE hosted_coordination SET epoch=epoch+1,state='offline' WHERE environment_id=?",
      )
        .bind(environment)
        .run();
    } finally {
      release();
    }
    await expect(resuming).rejects.toThrow();
    binding.DB = original;
  });
  expect(
    await env.DB.prepare('SELECT restore_in_progress FROM system_state').first(
      'restore_in_progress',
    ),
  ).toBe(1);
  expect(
    await env.DB.prepare('SELECT state FROM hosted_coordination WHERE environment_id=?')
      .bind(environment)
      .first('state'),
  ).toBe('offline');
});

test('a legacy writer expiry cannot drain the fence without actual cleanup or quiescence proof', async () => {
  const { a, b, environment } = clients();
  const stub = env.OFFLINE_COORDINATOR.getByName(environment);
  await stub.registerWriter(secret, environment, 'leaked-writer');
  const lease = await b.acquire('restore');
  // The live leak holds the fence in closing, exactly as before.
  await expect(b.assertCurrent(lease)).rejects.toThrow();
  await runInDurableObject(stub, async (_: OfflineControl, state) => {
    state.storage.sql.exec('UPDATE writers SET expires_at=1 WHERE id=?', 'leaked-writer');
  });
  expect((await a.inspectRegistrations()).writers).toEqual([
    { id: 'leaked-writer', operationId: null },
  ]);
  await expect(b.assertCurrent(lease)).rejects.toThrow();
  await stub.finishWriter(secret, environment, 'leaked-writer');
  await b.assertCurrent(lease);
  await expect(a.withWriter(async () => 42)).rejects.toThrow();
});

test('registration inspection pages past the former 10,000 row cap', async () => {
  const { a, environment } = clients();
  const stub = env.OFFLINE_COORDINATOR.getByName(environment);
  await runInDurableObject(stub, async (_: OfflineControl, state) => {
    for (let i = 0; i < 10001; i++)
      state.storage.sql.exec(
        'INSERT INTO writers(id,operation_id,expires_at) VALUES(?,NULL,?)',
        'writer-' + String(i).padStart(5, '0'),
        Date.now() + 3600000,
      );
  });
  const snapshot = await a.inspectRegistrations();
  expect(snapshot.writers).toHaveLength(10001);
  expect(snapshot.writers[0]!.id).toBe('writer-00000');
  expect(snapshot.writers[10000]!.id).toBe('writer-10000');
});

test('a writer cleanup failure never masks the work result or its own error, and cleanup is offered to waitUntil', async () => {
  let finishes = 0;
  const extended: Promise<unknown>[] = [];
  const namespace = {
    getByName: () => ({
      async registerWriter() {
        return 0;
      },
      async finishWriter() {
        finishes++;
        throw new Error('cleanup unavailable');
      },
    }),
  };
  const coordinator = new HostedCoordinator(
    namespace as unknown as DurableObjectNamespace<OfflineControl>,
    secret,
    'fake-environment',
  );
  await expect(
    coordinator.withWriter(
      async () => 42,
      (promise) => extended.push(promise),
    ),
  ).resolves.toBe(42);
  await expect(
    coordinator.withWriter(async () => {
      throw new Error('work failed');
    }),
  ).rejects.toThrow('work failed');
  // Both the direct path and the waitUntil chain share one release attempt each.
  expect(finishes).toBe(2);
  expect(extended).toHaveLength(1);
  await extended[0];
});

test('abort reopens only an operation that never began a mutation', async () => {
  const { a, b } = clients();
  const abandoned = await a.acquire('restore');
  await b.abort(abandoned);
  await expect(a.withWriter(async () => 42)).resolves.toBe(42);

  const mutated = await a.acquire('rekey');
  await a.withOffline(mutated, async () => {});
  await expect(b.abort(mutated)).rejects.toThrow();
  await expect(a.withWriter(async () => 42)).rejects.toThrow();
});
