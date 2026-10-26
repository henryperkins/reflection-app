import type { Env } from "../env.js";
import { exportObjectKey } from "./export-envelope.js";

export interface DeletionArtifactFamily {
  family: string;
  prefix: `${string}/`;
  collectKeys: (env: Env, userId: string) => Promise<string[]>;
}

/** User-owned R2 families must be registered here before deletion may ship. */
export const DELETION_ARTIFACT_FAMILIES: readonly DeletionArtifactFamily[] = [
  {
    family: "pattern_portrait_meshes",
    prefix: "portrait-meshes/",
    collectKeys: async (env: Env, userId: string): Promise<string[]> => {
      if (!await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='portrait_mesh_assets'").first()) return [];
      const { results } = await env.DB.prepare("SELECT object_key FROM portrait_mesh_assets WHERE user_id=? ORDER BY object_key").bind(userId).all<{object_key:string}>();return results.map(row=>row.object_key);
    },
  },
  {
    family: "pattern_portraits",
    prefix: "pattern-portraits/",
    async collectKeys(env, userId) {
      // A compatible Worker may be installed with portrait creation off before
      // 0026. Existing account deletion must not depend on the optional schema.
      if (!await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pattern_portrait_assets'").first()) return [];
      const { results } = await env.DB.prepare("SELECT object_key FROM pattern_portrait_assets WHERE user_id = ? ORDER BY object_key").bind(userId).all<{ object_key: string }>();
      return results.map((row) => row.object_key);
    },
  },
  {
    family: "account_exports",
    prefix: "exports/",
    async collectKeys(env, userId) {
      const { results } = await env.DB.prepare(
        "SELECT id FROM export_requests WHERE user_id = ? ORDER BY id",
      )
        .bind(userId)
        .all<{ id: string }>();
      return results.map((row) => exportObjectKey(row.id));
    },
  },
  {
    family: "pattern_generations",
    prefix: "pattern-generations/",
    async collectKeys(env, userId) {
      const { results } = await env.DB.prepare(
        `SELECT object_key FROM pattern_generation_artifacts
         WHERE user_id = ? ORDER BY object_key`,
      )
        .bind(userId)
        .all<{ object_key: string }>();
      return results.map((row) => row.object_key);
    },
  },
  {
    family: "codex_provider_jobs",
    prefix: "codex-provider-jobs/",
    async collectKeys(env, userId) {
      const { results } = await env.DB.prepare(
        `SELECT request_object_key, response_object_key
         FROM codex_provider_jobs WHERE user_id = ? ORDER BY id`,
      )
        .bind(userId)
        .all<{
          request_object_key: string;
          response_object_key: string | null;
        }>();
      const { results: uploads } = await env.DB.prepare(
        `SELECT upload.object_key
         FROM codex_provider_response_uploads upload
         JOIN codex_provider_jobs job ON job.id = upload.job_id
         WHERE job.user_id = ? ORDER BY upload.object_key`,
      ).bind(userId).all<{ object_key: string }>();
      return results.flatMap((row) => row.response_object_key === null
        ? [row.request_object_key]
        : [row.request_object_key, row.response_object_key])
        .concat(uploads.map((row) => row.object_key));
    },
  },
];

export async function collectDeletionArtifactKeys(
  env: Env,
  userId: string,
): Promise<string[]> {
  const keys = new Set<string>();
  for (const family of DELETION_ARTIFACT_FAMILIES) {
    for (const key of await family.collectKeys(env, userId)) {
      if (!key.startsWith(family.prefix)) {
        throw new Error(`Deletion artifact escaped ${family.family} prefix`);
      }
      keys.add(key);
    }
  }
  return [...keys].sort();
}

/**
 * Directly user-owned tables classified for account erasure.
 *
 * The order is dependency-safe: children precede parents. `users`,
 * `user_keys`, and `deletion_requests` are retained tombstone/proof state and
 * are therefore classified separately below rather than silently omitted.
 */
export const DELETED_USER_TABLES = [
  "reading_feedback_events",
  "reader_relationship_supports",
  "reading_saves",
  "reading_sources",
  "reading_feedback",
  "daily_readings",
  "cycle_passes",
  "cycle_instances",
  "cycle_scan_receipts",
  "time_travel_daily_usage",
  "timezone_changes",
  "natal_feature_sets",
  "natal_features",
  "codex_provider_jobs",
  "portrait_mesh_assets",
  "portrait_mesh_jobs",
  "portrait_start_outbox",
  "portrait_automation_grants",
  "pattern_portrait_assets",
  "pattern_portrait_jobs",
  "pattern_portraits",
  "pattern_generation_artifacts",
  "pattern_generation_artifact_keys",
  "pattern_documents",
  "pattern_generation_jobs",
  "pattern_generation_claims",
  "birth_calc_reservations",
  "birth_calc_daily_usage",
  "birth_profile_version_counters",
  "place_resolutions",
  "crypto_kek_rewrap_items",
  "crypto_operations",
  "chart_snapshots",
  "birth_profiles",
  "context_signals",
  "context_source_permissions",
  "connector_accounts",
  "device_tokens",
  "sessions",
  "identities",
  "consents",
  "export_requests",
] as const;

export const RETAINED_USER_TABLES = [
  "users",
  "user_keys",
  "deletion_requests",
] as const;

/**
 * Portability classification for every directly user-owned table.
 *
 * Deletion coverage alone does not answer the question a data-subject request
 * asks: it says the row goes away, not whether the reader was ever entitled to
 * a copy of it. Splitting the classification makes "this is derived cache, not
 * the reader's data" an explicit, reviewed claim per table rather than an
 * inference from whichever tables `buildAccountExport` happens to SELECT.
 *
 * A table listed as portable must be reachable through a section of the
 * current export document. M6 is frozen and cannot grow sections; M7's
 * successor adds `patterns` so `pattern_documents` projects there rather
 * than into readings.
 */
export const PORTABLE_USER_TABLES = [
  "reading_feedback_events",
  "users",
  "birth_profiles",
  "chart_snapshots",
  "timezone_changes",
  "consents",
  "context_source_permissions",
  "context_signals",
  "reading_saves",
  "daily_readings",
  "pattern_documents",
] as const;

export const NON_PORTABLE_USER_TABLES = [
  // Derived passage support, like reading_sources. Reader prose remains portable.
  "reader_relationship_supports",
  // Operational inventory; accepted images and graph are available through the
  // separate private /v1/pattern-portrait/download bundle, not frozen account export.
  "portrait_mesh_assets",
  "portrait_mesh_jobs",
  "portrait_start_outbox",
  "portrait_automation_grants",
  "pattern_portrait_assets",
  "pattern_portrait_jobs",
  "pattern_portraits",
  /** Prose evidence links; the reading itself is the portable artifact. */
  "reading_sources",
  /**
   * Resonance is an operational ranking signal. Optional notes are deleted
   * with the account; the frozen M6 export has no section that can carry them.
   */
  "reading_feedback",
  /** Deterministic calculation output, recomputable from the chart. */
  "cycle_passes",
  "cycle_instances",
  /** M4: deterministic derived Pattern facts and their completion receipt. */
  "natal_features",
  "natal_feature_sets",
  /** M7: operational generation state; the accepted Pattern is the portable artifact. */
  "pattern_generation_claims",
  "pattern_generation_jobs",
  "pattern_generation_artifact_keys",
  "pattern_generation_artifacts",
  "codex_provider_jobs",
  /** M4: bounded recomputable Time Travel calculation cache. */
  "cycle_scan_receipts",
  /** M4: operational spend ledger; no selected date or natal fact. */
  "time_travel_daily_usage",
  /** M8: birth-calc spend, invocation idempotency, and version-allocation state. */
  "birth_calc_reservations",
  "birth_calc_daily_usage",
  "birth_profile_version_counters",
  "place_resolutions",
  "crypto_kek_rewrap_items",
  "crypto_operations",
  /** Credentials, transport, and delivery state — not reader content. */
  "connector_accounts",
  "device_tokens",
  "sessions",
  "identities",
  "user_keys",
  /** Proof-of-request state about the export/deletion mechanism itself. */
  "export_requests",
  "deletion_requests",
] as const;

export const JOBS_TABLE = "jobs" as const;
export const AUDIT_TABLE = "audit_events" as const;

export async function deleteUserRows(
  env: Env,
  userId: string,
  deletionJobId: string,
): Promise<void> {
  // Break the daily-reading -> jobs parent link before deleting either side.
  await env.DB.prepare(
    "UPDATE daily_readings SET active_generation_job_id = NULL WHERE user_id = ?",
  )
    .bind(userId)
    .run();

  await env.DB.prepare(
    "UPDATE pattern_admin_access_events SET target_user_id = NULL WHERE target_user_id = ?",
  )
    .bind(userId)
    .run();

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE crypto_operations
       SET candidate_key_version = NULL, candidate_wrapped_dek = NULL,
           candidate_root_kek_id = NULL, lease_token_hash = NULL,
           lease_expires_at = NULL
       WHERE user_id = ? AND stage = 'abandoned_to_deletion'`,
    ).bind(userId),
    env.DB.prepare(
      `INSERT INTO assertion_probe (id, reason)
       SELECT 1, 'crypto operation not safe for deletion'
       WHERE EXISTS (
         SELECT 1 FROM crypto_operations
         WHERE user_id = ? AND (
           stage IN (
             'quiescing', 'reencrypting', 'finalizing',
             'verifying', 'blocked'
           )
           OR candidate_wrapped_dek IS NOT NULL
         )
       )`,
    ).bind(userId),
  ]);

  const optionalPortraitTables = new Set<string>([
    "pattern_portrait_assets", "pattern_portrait_jobs", "pattern_portraits",
    "portrait_mesh_assets", "portrait_mesh_jobs", "portrait_start_outbox", "portrait_automation_grants",
  ]);
  const { results: presentPortraitTables } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('pattern_portrait_assets','pattern_portrait_jobs','pattern_portraits','portrait_mesh_assets','portrait_mesh_jobs','portrait_start_outbox','portrait_automation_grants')",
  ).all<{ name: string }>();
  const present = new Set(presentPortraitTables.map((row) => row.name));
  for (const table of DELETED_USER_TABLES) {
    if (table === "crypto_operations") continue;
    if (optionalPortraitTables.has(table) && !present.has(table)) continue;
    await env.DB.prepare(`DELETE FROM ${table} WHERE user_id = ?`)
      .bind(userId)
      .run();
  }

  await env.DB.prepare(
    "DELETE FROM jobs WHERE user_id = ? AND id != ?",
  )
    .bind(userId, deletionJobId)
    .run();
  await env.DB.prepare(
    "DELETE FROM audit_events WHERE actor_id = ? OR resource_id = ?",
  )
    .bind(userId, userId)
    .run();
}

