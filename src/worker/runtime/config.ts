import { z } from 'zod';

const Name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const RuntimeResources = z.strictObject({
  databaseId: z.uuid(),
  recoveryBucket: Name,
  coordinatorId: Name,
  backupInventoryBucket: Name,
  qualificationBucket: Name,
});
const Manifest = z.strictObject({
  version: z.literal(1),
  mode: z.enum(['synthetic-local', 'hosted-synthetic', 'production']),
  environmentId: Name,
  workerName: Name,
  origin: z.url(),
  rpId: z.string().min(1).max(253),
  resources: RuntimeResources,
  isolatedFrom: z.array(RuntimeResources.extend({ environmentId: Name })).max(32),
  generation: z.enum(['off', 'intercepted', 'qualified']),
  ingress: z.enum(['off', 'on']),
  policyHash: Hash,
  contentHash: Hash,
  qualificationEvidenceDigest: Hash.nullable(),
});
export type RuntimeManifest = z.infer<typeof Manifest>;

/** Trusted server configuration only. Validation errors never echo the supplied manifest. */
export function validateRuntimeManifest(value: unknown): RuntimeManifest {
  try {
    const manifest = Manifest.parse(value);
    const origin = new URL(manifest.origin);
    if (
      origin.origin !== manifest.origin ||
      origin.hostname !== manifest.rpId ||
      origin.username ||
      origin.password ||
      (manifest.mode === 'synthetic-local'
        ? origin.hostname !== 'localhost' || !['http:', 'https:'].includes(origin.protocol)
        : origin.protocol !== 'https:' ||
          origin.hostname === 'localhost' ||
          manifest.isolatedFrom.length === 0) ||
      (manifest.generation === 'qualified' &&
        (manifest.mode !== 'production' || !manifest.qualificationEvidenceDigest)) ||
      (manifest.mode === 'production' && manifest.generation === 'intercepted')
    )
      throw new Error();
    const resources = [
      { environmentId: manifest.environmentId, ...manifest.resources },
      ...manifest.isolatedFrom,
    ];
    for (const key of ['environmentId', ...Object.keys(manifest.resources)] as const) {
      const values = resources.map((resource) => resource[key as keyof typeof resource]);
      if (new Set(values).size !== values.length) throw new Error();
    }
    const buckets = resources.flatMap((resource) => [
      resource.recoveryBucket,
      resource.backupInventoryBucket,
      resource.qualificationBucket,
    ]);
    if (new Set(buckets).size !== buckets.length) throw new Error();
    return manifest;
  } catch {
    throw new Error('Runtime configuration unavailable');
  }
}

/** Renders a reviewable artifact; this function neither provisions resources nor installs secrets. */
export function renderHostedConfig(value: unknown) {
  const manifest = validateRuntimeManifest(value);
  if (manifest.mode === 'synthetic-local') throw new Error('Hosted manifest required');
  const installed =
    manifest.mode === 'production'
      ? { ...manifest, ingress: 'off' as const, generation: 'off' as const }
      : manifest;
  return {
    $schema: 'node_modules/wrangler/config-schema.json',
    name: manifest.workerName,
    main: 'src/worker/runtime/application.ts',
    compatibility_date: '2026-10-23',
    compatibility_flags: ['nodejs_compat'],
    workers_dev: manifest.mode !== 'production',
    preview_urls: false,
    assets: {
      directory: './dist/client',
      binding: 'ASSETS',
      run_worker_first: true,
      not_found_handling: 'single-page-application',
    },
    vars: {
      RUNTIME_MANIFEST: JSON.stringify(installed),
      RUNTIME_RESOURCE_IDENTITIES: JSON.stringify(manifest.resources),
    },
    d1_databases: [
      {
        binding: 'DB',
        database_name: manifest.workerName,
        database_id: manifest.resources.databaseId,
        migrations_dir: 'src/worker/db/migrations',
      },
    ],
    r2_buckets: [
      { binding: 'RECOVERY', bucket_name: manifest.resources.recoveryBucket },
      { binding: 'BACKUP_INVENTORY', bucket_name: manifest.resources.backupInventoryBucket },
      { binding: 'QUALIFICATION_ARTIFACTS', bucket_name: manifest.resources.qualificationBucket },
    ],
    durable_objects: { bindings: [{ name: 'OFFLINE_COORDINATOR', class_name: 'OfflineControl' }] },
    migrations: [{ tag: 'offline-control-v1', new_sqlite_classes: ['OfflineControl'] }],
    triggers: { crons: ['* * * * *'] },
    observability: {
      enabled: true,
      head_sampling_rate: 1,
      redact_query_string: true,
      logs: { enabled: true, head_sampling_rate: 1, invocation_logs: false },
      traces: { enabled: false },
    },
    send_metrics: false,
  };
}
