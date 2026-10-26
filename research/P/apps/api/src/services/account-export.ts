import { FEEDBACK_EXPORT_SCHEMA_VERSION } from "@patternlike/shared";
import { b64, decryptJson } from "../crypto.js";
import type { Env } from "../env.js";
import { loadReadingEvidence } from "../db/readings.js";
import { loadUserKey, type UserIdentity } from "../db/users.js";
import {
  ExportTooLargeError,
  MAX_EXPORT_PLAINTEXT_BYTES,
} from "./export-envelope.js";
import { projectBirthPayloadForExport } from "./birth-command.js";

export const M6_SCHEMA_VERSION = "0.6.0" as const;
export const M7_EXPORT_SCHEMA_VERSION = "0.7.0" as const;
export const M8_EXPORT_SCHEMA_VERSION = "0.8.0" as const;
export type ExportSchemaVersion =
  | typeof M7_EXPORT_SCHEMA_VERSION
  | typeof M8_EXPORT_SCHEMA_VERSION
  | typeof FEEDBACK_EXPORT_SCHEMA_VERSION;
const M0_SCHEMA_VERSION = "0.2.0" as const;

export interface ExportOptions {
  include_readings: boolean;
  include_journal: boolean;
  include_patterns: boolean;
}

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function assertBounded(value: unknown): void {
  if (byteLength(value) > MAX_EXPORT_PLAINTEXT_BYTES) {
    throw new ExportTooLargeError();
  }
}

/**
 * Project a decrypted context-signal value into its portable form.
 *
 * `hash_salt` is the per-revision random value that keeps the clear
 * `normalized_hash` column from being a dictionary fingerprint of low-entropy
 * fields — check-in answers for USR-06, topic exclusions for USR-05,
 * dates/categories/titles for USR-09. It
 * lives inside the ciphertext precisely so it cannot be read beside the hash it
 * protects, and an export that copied the decrypted value verbatim would hand
 * the reader (and anyone they forward the file to) both halves.
 *
 * First-party writers wrap content differently and all are handled here
 * rather than at one call site: USR-05 and USR-06 nest the portable document
 * under `value`, USR-09 carries `event` plus its normalized window at the top
 * level. Everything the reader authored survives in each case.
 */
function portableSignalValue(
  sourceId: string,
  structured: Record<string, unknown>,
): Record<string, unknown> {
  const portable = typeof structured.hash_salt === "string"
    ? (({ hash_salt: _salt, ...rest }) => rest)(structured)
    : structured;
  if (
    (sourceId === "USR-05" || sourceId === "USR-06") &&
    portable.value &&
    typeof portable.value === "object" &&
    !Array.isArray(portable.value)
  ) {
    return portable.value as Record<string, unknown>;
  }
  return portable;
}

interface AccountRow {
  id: string;
  crypto_subject: string;
  status: "active" | "frozen";
  locale: string;
  locale_source: string;
  locale_updated_at: string | null;
  timezone: string;
  timezone_source: string;
  timezone_revision: number;
  timezone_updated_at: string | null;
  entitlement_tier: string;
  next_due_at: string | null;
  created_at: string;
}

export async function assembleAccountExport(
  env: Env,
  identity: UserIdentity,
  exportId: string,
  generatedAt: string,
  options: ExportOptions,
  exportSchemaVersion: ExportSchemaVersion = FEEDBACK_EXPORT_SCHEMA_VERSION,
): Promise<Uint8Array> {
  const account = await env.DB.prepare(
    `SELECT id, crypto_subject, status, locale, locale_source, locale_updated_at,
            timezone, timezone_source, timezone_revision, timezone_updated_at,
            entitlement_tier, next_due_at, created_at
     FROM users
     WHERE id = ? AND status IN ('active', 'frozen')`,
  )
    .bind(identity.userId)
    .first<AccountRow>();
  if (!account) throw new Error("export account is no longer eligible");

  const { dek } = await loadUserKey(env, identity);
  const document: Record<string, unknown> = {
    schema_version: exportSchemaVersion,
    export_id: exportId,
    generated_at: generatedAt,
    account: {
      user_id: account.id,
      status: account.status,
      locale: account.locale,
      timezone: account.timezone,
      entitlement_tier: account.entitlement_tier,
      created_at: account.created_at,
    },
  };

  const birthRows = await env.DB.prepare(
    `SELECT version, accuracy, status, timezone, payload_enc,
            payload_key_version, payload_nonce
     FROM birth_profiles WHERE user_id = ? ORDER BY version`,
  )
    .bind(identity.userId)
    .all<{
      version: number;
      accuracy: string;
      status: string;
      timezone: string | null;
      payload_enc: ArrayBuffer | null;
      payload_key_version: number | null;
      payload_nonce: string | null;
    }>();
  document.birth_profiles = [];
  for (const row of birthRows.results) {
    if (
      row.payload_enc === null ||
      row.payload_key_version === null ||
      row.payload_nonce === null
    ) {
      throw new Error("birth profile payload is unavailable");
    }
    const storedBirth = await decryptJson<unknown>(
      {
        key_version: row.payload_key_version,
        nonce: row.payload_nonce,
        ciphertext: b64(row.payload_enc),
      },
      dek,
      {
        subject: identity.cryptoSubject,
        field: "birth_profiles.payload_enc",
        recordId: String(row.version),
      },
    );
    const birth = projectBirthPayloadForExport(storedBirth);
    (document.birth_profiles as unknown[]).push({
      version: row.version,
      accuracy: row.accuracy,
      status: row.status,
      timezone: row.timezone,
      birth,
    });
    assertBounded(document);
  }

  const chartRows = await env.DB.prepare(
    `SELECT id, profile_version, fingerprint, contract_id, contract_version,
            calculated_at, snapshot_json, birth_enc, birth_key_version,
            birth_nonce, uncertainty_json
     FROM chart_snapshots WHERE user_id = ? ORDER BY calculated_at, id`,
  )
    .bind(identity.userId)
    .all<{
      id: string;
      profile_version: number;
      fingerprint: string;
      contract_id: string;
      contract_version: string;
      calculated_at: string;
      snapshot_json: string;
      birth_enc: ArrayBuffer;
      birth_key_version: number;
      birth_nonce: string;
      uncertainty_json: string;
    }>();
  document.chart_snapshots = [];
  for (const row of chartRows.results) {
    const birth = await decryptJson<Record<string, unknown>>(
      {
        key_version: row.birth_key_version,
        nonce: row.birth_nonce,
        ciphertext: b64(row.birth_enc),
      },
      dek,
      {
        subject: identity.cryptoSubject,
        field: "chart_snapshots.birth_enc",
        recordId: row.id,
      },
    );
    (document.chart_snapshots as unknown[]).push({
      id: row.id,
      profile_version: row.profile_version,
      fingerprint: row.fingerprint,
      contract_id: row.contract_id,
      contract_version: row.contract_version,
      calculated_at: row.calculated_at,
      snapshot: parseJson(row.snapshot_json),
      birth,
      uncertainty: parseJson(row.uncertainty_json),
    });
    assertBounded(document);
  }

  document.preferences = {
    locale: account.locale,
    locale_source: account.locale_source,
    timezone: account.timezone,
    timezone_source: account.timezone_source,
    timezone_revision: account.timezone_revision,
    entitlement_tier: account.entitlement_tier,
    next_due_at: account.next_due_at,
  };

  const timezoneChanges = await env.DB.prepare(
    `SELECT id, previous_zone, next_zone, source, revision, changed_at
     FROM timezone_changes WHERE user_id = ? ORDER BY revision`,
  )
    .bind(identity.userId)
    .all<Record<string, unknown>>();
  document.timezone_changes = timezoneChanges.results;
  assertBounded(document);

  const consentRows = await env.DB.prepare(
    `SELECT id, kind, status, source_id, permission_tier, allowed_uses_json,
            scopes_json, provider, connector_account_id, policy_version,
            ui_surface, granted_at, revoked_at, paused_at, expires_at, version,
            supersedes_consent_id, created_at, updated_at
     FROM consents WHERE user_id = ? ORDER BY created_at, version, id`,
  )
    .bind(identity.userId)
    .all<{
      id: string;
      kind: string;
      status: string;
      source_id: string | null;
      permission_tier: number;
      allowed_uses_json: string;
      scopes_json: string;
      provider: string | null;
      connector_account_id: string | null;
      policy_version: string;
      ui_surface: string | null;
      granted_at: string | null;
      revoked_at: string | null;
      paused_at: string | null;
      expires_at: string | null;
      version: number;
      supersedes_consent_id: string | null;
      created_at: string;
      updated_at: string;
    }>();
  document.consents = consentRows.results.map((row) => ({
    schema_version: M0_SCHEMA_VERSION,
    id: row.id,
    user_id: identity.userId,
    kind: row.kind,
    status: row.status,
    source_id: row.source_id,
    permission_tier: row.permission_tier,
    allowed_uses: parseJson(row.allowed_uses_json),
    scopes: parseJson(row.scopes_json),
    provider: row.provider,
    connector_account_id: row.connector_account_id,
    policy_version: row.policy_version,
    ui_surface: row.ui_surface,
    granted_at: row.granted_at,
    revoked_at: row.revoked_at,
    paused_at: row.paused_at,
    expires_at: row.expires_at,
    version: row.version,
    supersedes_consent_id: row.supersedes_consent_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
  assertBounded(document);

  const permissionRows = await env.DB.prepare(
    `SELECT source_id, enabled, permission_state, allowed_uses_json,
            permission_tier, consent_id, scopes_json, connector_status,
            last_signal_id, updated_at
     FROM context_source_permissions WHERE user_id = ? ORDER BY source_id`,
  )
    .bind(identity.userId)
    .all<{
      source_id: string;
      enabled: number;
      permission_state: string;
      allowed_uses_json: string;
      permission_tier: number;
      consent_id: string | null;
      scopes_json: string;
      connector_status: string | null;
      last_signal_id: string | null;
      updated_at: string;
    }>();
  document.context_sources = permissionRows.results.map((row) => ({
    schema_version: M0_SCHEMA_VERSION,
    user_id: identity.userId,
    source_id: row.source_id,
    enabled: row.enabled === 1,
    permission_state: row.permission_state,
    allowed_uses: parseJson(row.allowed_uses_json),
    permission_tier: row.permission_tier,
    consent_id: row.consent_id,
    scopes: parseJson(row.scopes_json),
    connector_status: row.connector_status,
    last_signal_id: row.last_signal_id,
    updated_at: row.updated_at,
  }));
  assertBounded(document);

  const signalRows = await env.DB.prepare(
    `SELECT s.id, s.source_id, s.source_window, s.evidence_lane,
            s.allowed_uses_json, s.confidence, s.sensitivity,
            s.permission_state, s.conflict_status, s.consent_id,
            s.freshness_status, s.observed_at, s.ingested_at, s.expires_at,
            s.value_encoding, s.value_json, s.value_enc, s.value_key_version,
            s.value_nonce, s.labels_json, s.provenance_json,
            s.supersedes_signal_id, s.normalized_hash, s.created_at, s.updated_at,
            c.permission_tier AS consent_permission_tier
     FROM context_signals s
     LEFT JOIN consents c ON c.id = s.consent_id AND c.user_id = s.user_id
     WHERE s.user_id = ? ORDER BY s.observed_at, s.id`,
  )
    .bind(identity.userId)
    .all<Record<string, unknown>>();
  document.context_signals = [];
  for (const source of signalRows.results) {
    const row = source as Record<string, unknown> & {
      id: string;
      source_id: string;
      value_encoding: string;
      value_json: string | null;
      value_enc: ArrayBuffer | null;
      value_key_version: number | null;
      value_nonce: string | null;
      consent_id: string | null;
    };
    if (!row.consent_id) throw new Error("context signal has no consent snapshot");
    let structured: Record<string, unknown>;
    if (row.value_encoding === "encrypted") {
      if (
        row.value_enc === null ||
        row.value_key_version === null ||
        row.value_nonce === null
      ) {
        throw new Error("context signal ciphertext is incomplete");
      }
      structured = await decryptJson<Record<string, unknown>>(
        {
          key_version: row.value_key_version,
          nonce: row.value_nonce,
          ciphertext: b64(row.value_enc),
        },
        dek,
        {
          subject: identity.cryptoSubject,
          field: "context_signals.value_enc",
          recordId: row.id,
        },
      );
    } else {
      structured = parseJson(row.value_json ?? "{}");
    }
    const exportedValue = portableSignalValue(row.source_id, structured);
    (document.context_signals as unknown[]).push({
      schema_version: M0_SCHEMA_VERSION,
      id: row.id,
      user_id: identity.userId,
      source_id: row.source_id,
      source_window: row.source_window,
      evidence_lane: row.evidence_lane,
      allowed_uses: parseJson(String(row.allowed_uses_json)),
      confidence: row.confidence,
      sensitivity: row.sensitivity,
      permission_state: row.permission_state,
      conflict_status: row.conflict_status,
      freshness: {
        status: row.freshness_status,
        observed_at: row.observed_at,
        ingested_at: row.ingested_at,
        expires_at: row.expires_at,
      },
      consent: {
        consent_id: row.consent_id,
        status: row.permission_state,
        valid_for_uses: parseJson(String(row.allowed_uses_json)),
        permission_tier: row.consent_permission_tier ?? 0,
        validated_at: row.ingested_at,
      },
      value: { encoding: "structured", structured: exportedValue },
      labels: parseJson(String(row.labels_json)),
      provenance:
        row.provenance_json === null
          ? undefined
          : parseJson(String(row.provenance_json)),
      supersedes_signal_id: row.supersedes_signal_id,
      normalized_hash: row.normalized_hash,
      created_at: row.created_at,
      updated_at: row.updated_at,
    });
    assertBounded(document);
  }

  if (options.include_readings) {
    // reader_relationship_supports is the non-portable derived join sidecar,
    // like reading_sources' internal coordinates. Export readable artifacts and
    // their existing evidence shape without widening frozen export contracts.
    const readingRows = await env.DB.prepare(
      `SELECT r.id, r.local_date, r.release_version, r.chart_fingerprint,
              r.contract_id, r.assembly_mode, r.status, r.revision,
              r.revision_reason, r.supersedes_reading_id, r.invalidated_at,
              r.reading_enc, r.reading_key_version, r.reading_nonce,
              r.created_at, r.updated_at, s.saved_at
       FROM daily_readings r
       LEFT JOIN reading_saves s
         ON s.reading_id = r.id AND s.user_id = r.user_id
       WHERE r.user_id = ? ORDER BY r.local_date, r.revision`,
    )
      .bind(identity.userId)
      .all<Record<string, unknown>>();
    const items: unknown[] = [];
    for (const source of readingRows.results) {
      const row = source as Record<string, unknown> & {
        id: string;
        reading_enc: ArrayBuffer | null;
        reading_key_version: number | null;
        reading_nonce: string | null;
        saved_at: string | null;
      };
      let artifact: unknown = null;
      if (
        row.reading_enc !== null &&
        row.reading_key_version !== null &&
        row.reading_nonce !== null
      ) {
        artifact = await decryptJson(
          {
            key_version: row.reading_key_version,
            nonce: row.reading_nonce,
            ciphertext: b64(row.reading_enc),
          },
          dek,
          {
            subject: identity.cryptoSubject,
            field: "daily_readings.reading_enc",
            recordId: row.id,
          },
        );
      }
      const {
        reading_enc: _readingEnc,
        reading_key_version: _readingKeyVersion,
        reading_nonce: _readingNonce,
        saved_at: savedAt,
        ...metadata
      } = row;
      const loadedEvidence = artifact === null
        ? null
        : await loadReadingEvidence(env, identity, row.id);
      if (artifact !== null && loadedEvidence === null) {
        throw new Error("saved reading evidence is unavailable");
      }
      const evidence = loadedEvidence === null
        ? null
        : {
            schema_version: loadedEvidence.schemaVersion,
            header: loadedEvidence.header,
            paragraphs: loadedEvidence.paragraphs,
          };
      items.push(exportSchemaVersion !== M7_EXPORT_SCHEMA_VERSION
        ? { ...metadata, artifact, evidence, saved_at: savedAt }
        : { ...metadata, artifact, evidence });
      document.readings = { status: "included", items };
      assertBounded(document);
    }
    document.readings = { status: "included", items };
  } else {
    document.readings = { status: "omitted_by_request", items: [] };
  }

  // Frozen M7/M8 jobs keep their original document shape. Only the successor
  // exports the new encrypted categorical records and their authored notes.
  if (exportSchemaVersion === FEEDBACK_EXPORT_SCHEMA_VERSION) {
    const { loadReadingFeedbackEventExports } = await import("../db/reading-feedback-events.js");
    document.reading_feedback_events = options.include_readings
      ? { status: "included", items: await loadReadingFeedbackEventExports(env, identity, new Date(generatedAt)) }
      : { status: "omitted_by_request", items: [] };
    assertBounded(document);
  }

  document.journal = options.include_journal
    ? { status: "not_available", items: [] }
    : { status: "omitted_by_request", items: [] };

  // The Pattern is the one section whose prose is written by a model on the
  // reader's behalf, so it takes an omission flag like readings and journal do.
  // The contract already models the state -- `patterns` is the same
  // portableSection, and the package ships an invalid fixture proving
  // omitted_by_request must carry no items -- it was simply unreachable.
  if (!options.include_patterns) {
    document.patterns = { status: "omitted_by_request", items: [] };
  } else {
    // Gated exactly as the reader route is. `exportedPattern.status` is
    // `const: "active"` in the contract and the spec says the export carries
    // only active accepted artifacts, so a document the reader is refused --
    // withdrawn with its ontology, deleted, or left behind by a chart
    // correction -- has no representable status and must not ship at all.
    const { decryptPatternDocument, loadActiveChart, loadActivePatternDocument } = await import(
      "./pattern-state.js"
    );
    const { hashChartFingerprint, loadClaimForFingerprint } = await import("../db/pattern-claims.js");
    const { isOntologyRecalled } = await import("../db/pattern-ontology.js");

    const chart = await loadActiveChart(env, identity.userId);
    const fingerprintHash = chart ? await hashChartFingerprint(chart.fingerprint) : null;
    const patternRow = fingerprintHash
      ? await loadActivePatternDocument(env, identity.userId, fingerprintHash)
      : null;
    const claim = fingerprintHash
      ? await loadClaimForFingerprint(env, identity.userId, fingerprintHash)
      : null;
    const withheld =
      !patternRow ||
      claim?.status === "deleted" ||
      claim?.status === "superseded" ||
      claim?.status === "withdrawn" ||
      (await isOntologyRecalled(env, patternRow.ontology_version));

    if (withheld || !patternRow) {
      document.patterns = { status: "not_available", items: [] };
    } else {
      const { projectPublicPattern } = await import("@patternlike/pattern-engine");
      const internal = await decryptPatternDocument(env, identity, patternRow);
      document.patterns = {
        status: "included",
        items: [
          {
            pattern_id: patternRow.id,
            status: "active",
            generated_at: patternRow.generated_at,
            locale: patternRow.locale,
            effective_accuracy: patternRow.effective_accuracy,
            artifact: projectPublicPattern(internal, patternRow.generated_at),
          },
        ],
      };
    }
  }
  assertBounded(document);

  const plaintext = new TextEncoder().encode(JSON.stringify(document));
  if (plaintext.byteLength > MAX_EXPORT_PLAINTEXT_BYTES) {
    throw new ExportTooLargeError();
  }
  return plaintext;
}

