/** Proposed contracts, not an application. Zod 4 is authoritative for wire shapes.
 * Generate OpenAPI/JSON Schema from apiSchemas; never maintain parallel schemas.
 * Monetary values are integer USD microdollars; DB timestamps are UTC epoch ms.
 */
import { z } from 'zod';

export const Id = z.uuid();
export const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const Instant = z.iso.datetime({ offset: false });
export const Revision = z.number().int().min(1);
export const Base64url = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .max(65536);
export const JsonText = z.string().max(200000); // Parsed only by the owning versioned adapter.
export const Ciphertext = z.strictObject({
  v: z.literal(1),
  alg: z.literal('A256GCM'),
  keyVersion: Revision,
  aadRevision: Revision,
  nonce: Base64url,
  data: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .max(1500000),
}); // nonce decodes to 12 bytes; data includes the 16-byte authentication tag.
export type Ciphertext = z.infer<typeof Ciphertext>;
export const RequestState = z.enum([
  'reserved',
  'prepared',
  'dispatching',
  'received',
  'validating',
  'fallback_pending',
  'published',
  'cancelled',
  'expired',
  'blocked',
  'failed',
  'uncertain',
]);
export const ErrorCode = z.enum([
  'BAD_INPUT',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'PRECONDITION_REQUIRED',
  'IDEMPOTENCY_MISMATCH',
  'RATE_LIMITED',
  'QUOTA_EXCEEDED',
  'SPEND_LIMIT',
  'CONSENT_REQUIRED',
  'CONTEXT_CHANGED',
  'CONTENT_UNAVAILABLE',
  'INPUT_TOO_LARGE',
  'UNSUPPORTED_LANGUAGE',
  'SAFETY_REVIEW',
  'PROVIDER_REFUSAL',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_UNCERTAIN',
  'INVALID_CANDIDATE',
  'CANCELLED',
  'EXPIRED',
  'KEY_UNAVAILABLE',
  'ACCOUNT_FROZEN',
  'EXPORT_CHANGED',
  'IMPORT_INVALID',
  'DEPENDENCY_UNAVAILABLE',
  'INTERNAL',
]);
export const ErrorEnvelope = z.strictObject({
  error: z.strictObject({
    code: ErrorCode,
    message: z.string().max(240),
    correlationId: Id,
    retry: z.enum(['never', 'same_request', 'after_delay', 'refresh_then_retry']),
    retryAfterSeconds: z.number().int().min(1).max(3600).nullable(),
    currentRevision: Revision.nullable(),
  }),
});
export type ErrorCode = z.infer<typeof ErrorCode>;

export const Position = z.enum(['situation', 'tension', 'possibility']);
export const Orientation = z.enum(['upright', 'reversed']);
export const Suit = z.enum(['wands', 'cups', 'swords', 'pentacles']);
export const CardId = z
  .string()
  .regex(/^(major-(0[0-9]|1[0-9]|2[01])|(wands|cups|swords|pentacles)-(0[1-9]|1[0-4]))$/);
export const CardFact = z.strictObject({
  kind: z.literal('tarot.card'),
  id: z.string().regex(/^card:(situation|tension|possibility)$/),
  position: Position,
  cardId: CardId,
  orientation: Orientation,
});
export const CountFact = z.strictObject({
  kind: z.literal('tarot.suit_count'),
  id: z.string().regex(/^count:(wands|cups|swords|pentacles)$/),
  suit: Suit,
  count: z.number().int().min(0).max(3),
});
export const TarotBasis = z.strictObject({
  kind: z.literal('tarot.v1'),
  schemaVersion: z.literal(1),
  basisId: Id,
  deckEdition: Hash,
  spread: z.literal('situation-tension-possibility.v1'),
  drawAlgorithm: z.literal('hmac-sha256-fisher-yates-reject.v1'),
  seed: Base64url,
  reversals: z.boolean(),
  cards: z.array(CardFact).length(3),
  counts: z.array(CountFact).length(4),
  drawnAt: Instant,
}); // Relational checks: one of each position/suit; unique cards; IDs bind position/suit; counts recomputed.
export type TarotBasis = z.infer<typeof TarotBasis>;

export const BirthTime = z.discriminatedUnion('certainty', [
  z.strictObject({
    certainty: z.literal('exact'),
    localDateTime: z.string(),
    zone: z.string(),
    offsetSeconds: z.number().int(),
    fold: z.enum(['earlier', 'later', 'unambiguous']),
  }),
  z.strictObject({
    certainty: z.literal('approximate'),
    localDate: z.string(),
    zone: z.string(),
    earliestLocalTime: z.string(),
    latestLocalTime: z.string(),
  }),
  z.strictObject({ certainty: z.literal('unknown'), localDate: z.string(), zone: z.string() }),
]);
export const AstrologyInput = z.strictObject({
  kind: z.literal('astrology.natal.v1'),
  time: BirthTime,
  latitudeDeg: z.number().min(-90).max(90),
  longitudeEastDeg: z.number().min(-180).max(180),
  calendar: z.literal('gregorian'),
  zodiac: z.literal('tropical'),
  houses: z.literal('whole-sign'),
});
export const AstroEntity = z.enum([
  'sun',
  'moon',
  'mercury',
  'venus',
  'mars',
  'jupiter',
  'saturn',
  'uranus',
  'neptune',
  'pluto',
]);
export const AstroFact = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('astro.longitude'),
    id: z.string(),
    body: AstroEntity,
    degrees: z.number().min(0).lt(360),
    uncertaintyDeg: z.number().min(0).max(180),
  }),
  z.strictObject({
    kind: z.literal('astro.aspect'),
    id: z.string(),
    left: AstroEntity,
    right: AstroEntity,
    aspect: z.enum(['conjunction', 'sextile', 'square', 'trine', 'opposition']),
    orbDeg: z.number().min(0).max(10),
    leftFactId: z.string(),
    rightFactId: z.string(),
  }),
  z.strictObject({
    kind: z.literal('astro.window'),
    id: z.string(),
    aspectFactId: z.string(),
    startsAt: Instant,
    exactAt: Instant.nullable(),
    endsAt: Instant,
    phase: z.enum(['applying', 'exact', 'separating', 'indeterminate']),
    resolutionSeconds: z.number().int().positive(),
    referenceAt: Instant,
  }),
]);
export const AstrologyBasis = z.strictObject({
  kind: z.literal('astrology.natal.v1'),
  schemaVersion: z.literal(1),
  basisId: Id,
  calculationId: Id,
  engine: z.string(),
  engineVersion: z.string(),
  ephemerisHash: Hash,
  tzdbVersion: z.string(),
  requestHash: Hash,
  calculatedAt: Instant,
  facts: z.array(AstroFact).max(100),
  suppressed: z.array(z.enum(['houses', 'angles', 'moon_sign', 'aspects', 'timing'])),
  uncertainty: z.enum(['exact', 'approximate', 'unknown']),
}); // Later adapter only. No astrology route, DB method, execution service, or model schema in v1.
export type MethodBasis = z.infer<typeof TarotBasis> | z.infer<typeof AstrologyBasis>;

export const CanonSource = z.strictObject({
  id: z.string().max(100),
  version: Revision,
  hash: Hash,
  kind: z.literal('traditional_interpretation'),
  cardId: CardId,
  orientation: Orientation,
  position: Position.nullable(),
  text: z.string().min(1).max(1200),
  fallbackText: z.string().min(1).max(400),
  reflectionQuestion: z.string().min(1).max(180),
  rights: z.strictObject({
    status: z.enum(['cleared', 'unknown', 'disallowed']),
    evidence: z.string().max(1000),
    attribution: z.string().max(500),
    territory: z.string().max(200),
  }),
  review: z.strictObject({
    kind: z.enum(['unreviewed', 'agent_reviewed', 'human_approved']),
    reviewer: z.string().nullable(),
    reviewedHash: Hash.nullable(),
    reviewedAt: Instant.nullable(),
  }),
});
export const ContentBundle = z.strictObject({
  schemaVersion: z.literal(1),
  editionHash: Hash,
  deckEdition: Hash,
  deck: z
    .array(
      z.strictObject({
        id: CardId,
        name: z.string().max(80),
        imageHash: Hash.nullable(),
        imagePath: z.string().max(200).nullable(),
        attribution: z.string().max(500),
      }),
    )
    .length(78),
  positionFrames: z
    .array(z.strictObject({ position: Position, text: z.string().max(300) }))
    .length(3),
  productCopy: z.strictObject({
    unsupportedLanguage: z.string().max(1000),
    crisis: z.string().max(1000),
    uncertainSafety: z.string().max(1000),
    sensitiveAdvice: z.string().max(1000),
    providerRefusal: z.string().max(500),
  }),
  sources: z.array(CanonSource).min(156).max(1000),
  createdAt: Instant,
  licenseNotice: z.string().max(4000),
}); // Hash is SHA256(JCS(bundle without editionHash)). Approval must bind exact reviewedHash.
export const Selection = z.strictObject({
  grantId: Id,
  grantRevision: Revision,
  start: z.number().int().min(0),
  end: z.number().int().positive(),
  previewHash: Hash,
}); // Unicode code point offsets into exact plain text, not JS UTF-16 units. max 1200 each, 3000 total.
export const SelectedFragment = z.strictObject({
  ordinal: z.number().int().min(0).max(2),
  grantId: Id,
  grantRevision: Revision,
  sourceKind: z.enum(['edition', 'reflection_revision']),
  sourceId: Id,
  sourceRevision: Revision,
  start: z.number().int().min(0),
  end: z.number().int().positive(),
  text: z.string().max(1200).nullable(),
  textHash: Hash.nullable(),
  availability: z.enum(['retained', 'erased']),
  authorship: z.enum(['generated', 'user', 'legacy_unknown']),
});
export const PreparedPlan = z.strictObject({
  version: z.literal('tarot-plan.v1'),
  requestId: Id,
  basis: TarotBasis,
  contentHash: Hash,
  promptHash: Hash,
  validatorHash: Hash,
  question: z.string().max(500),
  language: z.literal('en'),
  operation: z.enum(['initial', 'followup']),
  parentEditionId: Id.nullable(),
  sources: z.array(CanonSource).length(3),
  selected: z.array(SelectedFragment).max(3),
  mandatoryFactIds: z.array(z.string()).length(7),
  permissionRevision: Revision,
  keyVersion: Revision,
  generationPolicyHash: Hash,
});
export type PreparedPlan = z.infer<typeof PreparedPlan>;

// Model schema is deliberately small. No optional properties or open maps; no free technical assertions.
export const TarotFactId = z.enum([
  'card:situation',
  'card:tension',
  'card:possibility',
  'count:wands',
  'count:cups',
  'count:swords',
  'count:pentacles',
]);
export const ModelUnit = z.strictObject({
  position: Position,
  factIds: z.array(TarotFactId).min(1).max(3),
  sourceIds: z.array(z.string()).length(1),
  interpretation: z.string().min(1).max(650),
  reflectionQuestion: z.string().min(1).max(200),
});
export const ModelCandidate = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal('tarot.interpretation.v1'),
  units: z.array(ModelUnit).length(3),
  closing: z.string().max(250),
});
export const Rejection = z.enum([
  'SCHEMA',
  'ENTITY_NOT_SUPPLIED',
  'POSITION_BINDING',
  'ORIENTATION_BINDING',
  'COUNT_MISMATCH',
  'TECHNICAL_PROSE',
  'RELATIONSHIP_UNSUPPORTED',
  'BIOGRAPHY_UNSUPPORTED',
  'PREDICTION',
  'SENSITIVE_ADVICE',
  'LANGUAGE',
  'PROMPT_INJECTION',
  'REPETITION',
  'LENGTH',
  'CONTENT_CHANGED',
]);
export const AcceptedReading = z.strictObject({
  kind: z.literal('tarot.accepted.v1'),
  editionId: Id,
  sessionId: Id,
  editionNumber: Revision,
  parentEditionId: Id.nullable(),
  question: z.string().max(500),
  basis: TarotBasis,
  mode: z.enum(['model', 'template']),
  contentHash: Hash,
  planHash: Hash,
  sources: z.array(CanonSource).length(3),
  units: z
    .array(
      z.strictObject({
        position: Position,
        basisText: z.string().max(350),
        factIds: z.array(z.string()).min(1).max(3),
        sourceIds: z.array(z.string()).length(1),
        interpretation: z.string().max(650),
        reflectionQuestion: z.string().max(200),
      }),
    )
    .length(3),
  closing: z.string().max(250),
  acceptedAt: Instant,
  provenance: z.strictObject({
    requestId: Id,
    dispatchId: Id.nullable(),
    provider: z.literal('openai').nullable(),
    requestedModel: z.string().nullable(),
    returnedModel: z.string().nullable(),
    promptHash: Hash,
    validatorHash: Hash,
    policyHash: Hash,
    contentHash: Hash,
    selected: z.array(SelectedFragment).max(3),
    transmissionHash: Hash.nullable(),
    fallbackReason: z.enum(['OUTAGE', 'MALFORMED', 'VALIDATION', 'TIMEOUT_UNKNOWN']).nullable(),
  }),
});
export const LegacyBasis = z.strictObject({
  method: z.enum(['tarot', 'astrology', 'unknown']),
  cards: z
    .array(
      z.strictObject({
        name: z.string(),
        position: z.string().nullable(),
        orientation: z.enum(['upright', 'reversed', 'unknown']),
        canonicalCardId: CardId.nullable(),
      }),
    )
    .max(78),
  sourceIds: z.array(z.string()).max(100),
  rawBasisJson: JsonText.nullable(),
  verification: z.literal('legacy_unverified'),
});
export const ImportSource = z.strictObject({
  namespaceId: Id,
  revision: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/),
});
export const ImportRecordIdentity = z.strictObject({
  source: ImportSource,
  kind: z.enum([
    'session',
    'reading',
    'reflection',
    'revisit',
    'generation_receipt',
    'permission',
    'grant',
  ]),
  recordId: z.string().min(1).max(200),
  recordRevision: Revision,
});
export const ImportRecovery = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({ kind: z.literal('new_revision'), previousSource: ImportSource }),
  z.strictObject({ kind: z.literal('reimport_erased'), previousSource: ImportSource }),
]);
export const LegacyRecord = z.strictObject({
  format: z.literal('reflection-import.v1'),
  identity: ImportRecordIdentity,
  parentIdentity: ImportRecordIdentity.nullable(),
  source: z.enum(['tarot', 'patternlike', 'pixel-perfect', 'successor']),
  originalId: z.string().min(1).max(200).nullable(),
  originalParentId: z.string().max(200).nullable(),
  originalTimestamp: z.string().max(200).nullable(),
  occurredAt: Instant.nullable(),
  question: z.string().max(10000).nullable(),
  generatedText: z.string().max(30000).nullable(),
  userStatements: z
    .array(
      z.strictObject({
        originalId: z.string().nullable(),
        text: z.string().max(10000),
        originalTimestamp: z.string().nullable(),
        revision: Revision.nullable(),
      }),
    )
    .max(100),
  basis: LegacyBasis,
  originalJsonText: JsonText,
  originalSha256: Hash,
  provenanceGaps: z.array(
    z.enum([
      'basis',
      'content_edition',
      'model',
      'prompt',
      'validator',
      'review',
      'timestamp',
      'parent',
      'authorship',
      'original_id',
    ]),
  ),
  review: z.literal('legacy_unknown'),
});
export const ImportedReading = z.strictObject({
  kind: z.literal('legacy.imported.v1'),
  editionId: Id,
  sessionId: Id,
  editionNumber: Revision,
  record: LegacyRecord,
  importedAt: Instant,
});
export const UnavailableReading = z.strictObject({
  kind: z.literal('reading.unavailable.v1'),
  editionId: Id,
  sessionId: Id,
  editionNumber: Revision,
  parentEditionId: Id.nullable(),
  reason: z.enum(['deleted', 'source_erased', 'content_withdrawn']),
  unavailableAt: Instant,
});
export const Reading = z.discriminatedUnion('kind', [
  AcceptedReading,
  ImportedReading,
  UnavailableReading,
]);
export const Reflection = z.strictObject({
  id: Id,
  sessionId: Id,
  editionId: Id,
  revision: Revision,
  text: z.string().max(10000),
  stance: z.enum(['resonates', 'unsure', 'disagree', 'unspecified']),
  updatedAt: Instant,
});
export const ProgressEvent = z.strictObject({
  sequence: Revision,
  at: Instant,
  state: RequestState,
  code: z.enum([
    'QUEUED',
    'PREPARING',
    'WRITING',
    'CHECKING',
    'USING_TEMPLATE',
    'ACCEPTED',
    'STOPPED',
  ]),
  editionId: Id.nullable(),
  errorCode: ErrorCode.nullable(),
});
export const RequestStatus = z.strictObject({
  requestId: Id,
  sessionId: Id,
  state: RequestState,
  revision: Revision,
  events: z.array(ProgressEvent).max(20),
  nextSequence: z.number().int().min(0),
  editionId: Id.nullable(),
  errorCode: ErrorCode.nullable(),
  expiresAt: Instant,
});
export const StartRequest = z.strictObject({
  clientIntentId: Id,
  question: z.string().trim().min(1).max(500),
  languageConfirmed: z.literal('en'),
  reversals: z.boolean(),
  permissionRevision: Revision,
  parentEditionId: Id.nullable(),
  selection: z.array(Selection).max(3),
});
export const StartResponse = z.strictObject({
  requestId: Id,
  sessionId: Id,
  joined: z.boolean(),
  status: RequestStatus,
});
export const Permission = z.strictObject({
  revision: Revision,
  modelAllowed: z.boolean(),
  policyVersion: z.literal('egress.v1'),
});
export const Grant = z.strictObject({
  id: Id,
  revision: Revision,
  state: z.enum(['allowed', 'revoked']),
  source: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('edition'), editionId: Id }),
    z.strictObject({
      kind: z.literal('reflection_revision'),
      reflectionId: Id,
      revision: Revision,
    }),
  ]),
});

export const RegistrationCredential = z.strictObject({
  id: Base64url,
  rawId: Base64url,
  type: z.literal('public-key'),
  response: z.strictObject({
    clientDataJSON: Base64url,
    attestationObject: Base64url,
    transports: z
      .array(z.enum(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']))
      .max(7),
  }),
  clientExtensionResults: z.strictObject({
    credProps: z.strictObject({ rk: z.boolean() }).optional(),
  }),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
});
export const AuthenticationCredential = z.strictObject({
  id: Base64url,
  rawId: Base64url,
  type: z.literal('public-key'),
  response: z.strictObject({
    clientDataJSON: Base64url,
    authenticatorData: Base64url,
    signature: Base64url,
    userHandle: Base64url.nullable(),
  }),
  clientExtensionResults: z.strictObject({}),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
});
export const AuthOptions = z.strictObject({
  challengeId: Id,
  challenge: Base64url,
  rpId: z.string(),
  user: z.strictObject({ id: Base64url, name: z.string(), displayName: z.string() }).nullable(),
  rpName: z.literal('Reflection'),
  timeout: z.literal(300000),
  userVerification: z.literal('required'),
  residentKey: z.literal('required'),
  attestation: z.literal('none'),
  algorithms: z.array(z.number().int()),
  excludeCredentialIds: z.array(Base64url),
});
export const AuthResult = z.strictObject({
  subjectId: Id,
  csrfToken: Base64url,
  recoveryHandle: z.string().nullable(),
  recoveryCodes: z.array(Base64url).max(10),
  recentAuthUntil: Instant,
});
export const SessionView = z.strictObject({
  subjectId: Id,
  csrfToken: Base64url,
  permission: Permission,
  remainingDay: z.number().int().min(0),
  remainingMonth: z.number().int().min(0),
  recentAuthUntil: Instant,
});
export const SessionRecord = z.strictObject({
  id: Id,
  revision: Revision,
  status: z.enum(['open', 'saved']),
  question: z.string().max(10000).nullable(),
  editionIds: z.array(Id),
  reflectionIds: z.array(Id),
  savedAt: Instant.nullable(),
  createdAt: Instant,
  requests: z.array(z.strictObject({ requestId: Id, state: RequestState })).max(51),
});
export const HistoryItem = z.strictObject({
  id: Id,
  revision: Revision,
  questionPreview: z.string().max(500).nullable(),
  questionTruncated: z.boolean(),
  createdAt: Instant,
  savedAt: Instant.nullable(),
  latestEditionId: Id.nullable(),
  requestId: Id.nullable(),
  imported: z.boolean(),
});
export const HistoryPage = z.strictObject({
  items: z.array(HistoryItem).max(50),
  nextCursor: z.string().nullable(),
});
export const ExportTicket = z.strictObject({
  id: Id,
  snapshotRevision: Revision,
  expiresAt: Instant,
});
export const Revisit = z.strictObject({
  id: Id,
  editionId: Id,
  note: z.string().max(2000),
  createdAt: Instant,
});
export const GenerationReceipt = z.strictObject({
  requestId: Id,
  state: RequestState,
  createdAt: Instant,
  inputTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  cachedInputTokens: z.number().int().min(0).nullable().default(null),
  cacheWriteTokens: z.number().int().min(0).nullable().default(null),
  reasoningTokens: z.number().int().min(0).nullable().default(null),
  serviceTier: z.string().min(1).max(32).nullable().default(null),
  actualCostMicroUsd: z.number().int().nullable(),
  costState: z.enum(['none', 'reserved', 'actual', 'unknown', 'expired']),
  transmission: JsonText.nullable(),
  reproduction: z.enum(['complete', 'redacted', 'legacy_unknown']),
});
export const PortableRecord = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('session'),
    identity: ImportRecordIdentity,
    originalId: z.string(),
    value: SessionRecord,
  }),
  z.strictObject({
    kind: z.literal('reading'),
    identity: ImportRecordIdentity,
    originalId: z.string(),
    value: Reading,
  }),
  z.strictObject({
    kind: z.literal('reflection'),
    identity: ImportRecordIdentity,
    originalId: z.string(),
    value: Reflection,
  }),
  z.strictObject({
    kind: z.literal('revisit'),
    identity: ImportRecordIdentity,
    originalId: z.string(),
    value: Revisit,
  }),
  z.strictObject({
    kind: z.literal('generation_receipt'),
    identity: ImportRecordIdentity,
    originalId: z.string(),
    value: GenerationReceipt,
  }),
  z.strictObject({
    kind: z.literal('permission'),
    identity: ImportRecordIdentity,
    originalId: z.string(),
    value: Permission,
  }),
  z.strictObject({
    kind: z.literal('grant'),
    identity: ImportRecordIdentity,
    originalId: z.string(),
    value: Grant,
  }),
]);
export const ExportPage = z.strictObject({
  format: z.literal('reflection-export.v1'),
  exportId: Id,
  snapshotRevision: Revision,
  records: z.array(PortableRecord).max(100),
  nextCursor: z.string().nullable(),
  exportedAt: Instant,
  account: z
    .strictObject({
      subjectId: Id,
      createdAt: Instant,
      credentials: z
        .array(z.strictObject({ id: Base64url, createdAt: Instant, backedUp: z.boolean() }))
        .max(10),
    })
    .nullable(),
});
export const ImportPreview = z.strictObject({
  id: Id,
  expiresAt: Instant,
  source: ImportSource,
  recovery: ImportRecovery,
  previewHash: Hash,
  items: z
    .array(
      z.strictObject({
        index: z.number().int().min(0),
        status: z.enum(['ready', 'duplicate', 'conflict', 'erased', 'invalid']),
        identity: ImportRecordIdentity.nullable(),
        originalId: z.string().nullable(),
        error: z.string().nullable(),
      }),
    )
    .max(100),
});
export const ImportResult = z.strictObject({
  id: Id,
  items: z
    .array(
      z.strictObject({
        index: z.number().int().min(0),
        identity: ImportRecordIdentity.nullable(),
        status: z.enum(['imported', 'duplicate', 'failed']),
        sessionId: Id.nullable(),
        errorCode: ErrorCode.nullable(),
      }),
    )
    .max(100),
});
export const DeletionReceipt = z.strictObject({
  receiptId: Id,
  receiptToken: Base64url,
  state: z.enum(['fencing', 'ledger_pending', 'erasing', 'complete']),
  backupExpiresBy: Instant.nullable(),
});

export const apiSchemas = {
  ErrorEnvelope,
  StartRequest,
  StartResponse,
  RequestStatus,
  ProgressEvent,
  Permission,
  Grant,
  Reflection,
  Reading,
  SessionRecord,
  HistoryPage,
  ExportTicket,
  ExportPage,
  ImportPreview,
  ImportResult,
  DeletionReceipt,
  SessionView,
  Empty: z.strictObject({}),
  AuthOptions,
  AuthResult,
  AuthBegin: z.strictObject({
    purpose: z.enum(['register', 'authenticate', 'reauthenticate', 'add']),
  }),
  RegisterFinish: z.strictObject({ challengeId: Id, credential: RegistrationCredential }),
  AuthenticateFinish: z.strictObject({ challengeId: Id, credential: AuthenticationCredential }),
  Recover: z.strictObject({ recoveryHandle: z.string().min(1).max(100), code: Base64url }),
  RecoveryGrant: z.strictObject({ challengeId: Id, options: AuthOptions }),
  Credentials: z.strictObject({
    items: z
      .array(z.strictObject({ id: Base64url, createdAt: Instant, backedUp: z.boolean() }))
      .max(10),
  }),
  RecoveryCodes: z.strictObject({
    codes: z.array(Base64url).length(10),
    recoveryHandle: z.string(),
  }),
  PermissionWrite: z.strictObject({
    modelAllowed: z.boolean(),
    policyVersion: z.literal('egress.v1'),
  }),
  GrantWrite: z.strictObject({ source: Grant.shape.source }),
  GrantPage: z.strictObject({ items: z.array(Grant).max(50), nextCursor: z.string().nullable() }),
  ContextPreviewWrite: z.strictObject({
    items: z
      .array(
        z.strictObject({
          grantId: Id,
          grantRevision: Revision,
          start: z.number().int().min(0),
          end: z.number().int().positive(),
        }),
      )
      .max(3),
  }),
  ContextPreview: z.strictObject({
    items: z
      .array(
        z.strictObject({
          selection: Selection,
          text: z.string().max(1200),
          authorship: z.enum(['generated', 'user', 'legacy_unknown']),
        }),
      )
      .max(3),
  }),
  SaveWrite: z.strictObject({ saved: z.boolean() }),
  ReflectionWrite: z.strictObject({
    text: z.string().max(10000),
    stance: Reflection.shape.stance,
    editionId: Id,
  }),
  RevisitWrite: z.strictObject({ editionId: Id, note: z.string().max(2000) }),
  Revisit,
  RevisitPage: z.strictObject({
    items: z.array(Revisit).max(50),
    nextCursor: z.string().nullable(),
  }),
  ImportWrite: z.strictObject({
    format: z.enum([
      'reflection-import.v1',
      'reflection-export.v1',
      'tarot-json',
      'patternlike-export',
      'pixel-json',
    ]),
    source: ImportSource,
    recovery: ImportRecovery,
    document: JsonText,
  }),
  ImportCommit: z.strictObject({
    indices: z.array(z.number().int().min(0).max(99)).min(1).max(100),
    previewHash: Hash,
    confirmedRecovery: ImportRecovery,
  }),
  DeleteRequest: z.strictObject({
    receiptId: Id.regex(/^[0-9a-f-]+$/),
    receiptToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  }),
  DeletionStatus: z.strictObject({
    state: DeletionReceipt.shape.state,
    backupExpiresBy: Instant.nullable(),
  }),
} as const;

export type Principal = { subjectId: string; sessionHash: string; recentAuth: boolean };
const TokenCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const ProviderReceipt = z.strictObject({
  responseId: z.string().min(1).max(300).nullable(),
  returnedModel: z.string().min(1).max(200),
  serviceTier: z.string().min(1).max(32),
  durationMs: TokenCount,
  usage: z
    .strictObject({
      inputTokens: TokenCount,
      cachedInputTokens: TokenCount,
      cacheWriteTokens: TokenCount,
      outputTokens: TokenCount,
      reasoningTokens: TokenCount,
    })
    .refine(
      (v) =>
        v.cachedInputTokens <= v.inputTokens &&
        v.cacheWriteTokens <= v.inputTokens - v.cachedInputTokens &&
        v.reasoningTokens <= v.outputTokens &&
        Number.isSafeInteger(v.inputTokens + v.outputTokens),
    ),
});
export type ProviderReceipt = z.infer<typeof ProviderReceipt>;
export type WriterOutcome = (
  | {
      kind: 'candidate';
      candidate: unknown;
    }
  | { kind: 'refusal' }
  | { kind: 'rejected'; status: 400 | 401 | 403 | 429 | 500 | 503 }
  | { kind: 'invalid'; reason: 'malformed' | 'incomplete' }
  | { kind: 'uncertain'; reason: 'timeout' | 'network' | 'lost_response'; haltGeneration?: true }
) & { receipt: ProviderReceipt | null };
export interface WritingProvider {
  write(input: {
    dispatchId: string;
    model: 'gpt-6.1-terra';
    payload: Uint8Array;
    timeoutMs: 18000;
    maxOutputTokens: 1600;
    store: false;
    reasoning: 'none';
    signal: AbortSignal;
  }): Promise<WriterOutcome>;
} // One call; no SDK auto-retries, tools, moderation call, or implicit provider state.
export interface GenerationService {
  start(
    p: Principal,
    key: string,
    input: z.infer<typeof StartRequest>,
  ): Promise<z.infer<typeof StartResponse>>;
  observe(p: Principal, id: string, after: number): Promise<z.infer<typeof RequestStatus>>;
  cancel(
    p: Principal,
    id: string,
    expectedRevision: number,
  ): Promise<z.infer<typeof RequestStatus>>;
  recover(nowMs: number, limit: 20): Promise<{ claimed: number; terminalized: number }>;
}
export interface Entitlements {
  generationAllowance(
    subjectId: string,
    at: string,
  ): Promise<{ day: 3; month: 30; billing: 'disabled'; policy: 'free.v1' }>;
}
export interface CalculationService {
  // Later; not instantiated in v1.
  natal(
    input: z.infer<typeof AstrologyInput>,
    requestId: string,
  ): Promise<
    | { kind: 'calculated'; basis: z.infer<typeof AstrologyBasis> }
    | { kind: 'needs_time_resolution'; reason: 'fold' | 'gap' | 'zone_unknown' }
    | { kind: 'unavailable'; retryAfterSeconds: number }
  >;
}
// Non-HTTP internal service boundaries. Errors are typed ServiceFailure; adapters map them to ErrorEnvelope.
export type ServiceFailure = {
  code: ErrorCode;
  httpStatus: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 422 | 428 | 429 | 500 | 503;
  retry: z.infer<typeof ErrorEnvelope>['error']['retry'];
  currentRevision: number | null;
  retryAfterSeconds: number | null;
};
export type Mutation = { idempotencyKey: string; expectedRevision: number };
export interface IdentityService {
  options(
    principal: Principal | null,
    input: z.infer<typeof apiSchemas.AuthBegin>,
    browserHash: string,
  ): Promise<z.infer<typeof AuthOptions>>;
  finishRegistration(
    input: z.infer<typeof apiSchemas.RegisterFinish>,
    browserHash: string,
  ): Promise<z.infer<typeof AuthResult>>;
  authenticate(
    input: z.infer<typeof apiSchemas.AuthenticateFinish>,
    browserHash: string,
  ): Promise<z.infer<typeof AuthResult>>;
  recover(
    input: z.infer<typeof apiSchemas.Recover>,
    browserHash: string,
  ): Promise<z.infer<typeof apiSchemas.RecoveryGrant>>;
  revokeSession(p: Principal, all: boolean): Promise<void>;
  rotateRecovery(p: Principal): Promise<z.infer<typeof apiSchemas.RecoveryCodes>>;
  removeCredential(p: Principal, id: string): Promise<void>;
}
export interface ReflectionService {
  create(
    p: Principal,
    sessionId: string,
    key: string,
    input: z.infer<typeof apiSchemas.ReflectionWrite>,
  ): Promise<z.infer<typeof Reflection>>;
  update(
    p: Principal,
    id: string,
    m: Mutation,
    input: z.infer<typeof apiSchemas.ReflectionWrite>,
  ): Promise<z.infer<typeof Reflection>>;
  read(p: Principal, id: string, revision: number | null): Promise<z.infer<typeof Reflection>>;
  revisit(
    p: Principal,
    key: string,
    input: z.infer<typeof apiSchemas.RevisitWrite>,
  ): Promise<z.infer<typeof Revisit>>;
}
export interface PermissionService {
  changeModel(p: Principal, m: Mutation, allowed: boolean): Promise<z.infer<typeof Permission>>;
  grant(
    p: Principal,
    key: string,
    source: z.infer<typeof Grant>['source'],
  ): Promise<z.infer<typeof Grant>>;
  revoke(p: Principal, id: string, m: Mutation): Promise<z.infer<typeof Grant>>;
  list(
    p: Principal,
    cursor: string | null,
    limit: number,
    editionId: string | null,
  ): Promise<z.infer<typeof apiSchemas.GrantPage>>;
  preview(
    p: Principal,
    input: z.infer<typeof apiSchemas.ContextPreviewWrite>,
  ): Promise<z.infer<typeof apiSchemas.ContextPreview>>;
}
export interface PortabilityService {
  createExport(p: Principal, key: string): Promise<z.infer<typeof ExportTicket>>;
  exportPage(p: Principal, id: string, cursor: string | null): Promise<z.infer<typeof ExportPage>>;
  previewImport(
    p: Principal,
    key: string,
    input: z.infer<typeof apiSchemas.ImportWrite>,
  ): Promise<z.infer<typeof ImportPreview>>;
  commitImport(
    p: Principal,
    id: string,
    key: string,
    input: z.infer<typeof apiSchemas.ImportCommit>,
  ): Promise<z.infer<typeof ImportResult>>;
}
export const LedgerKeyId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const RecoveryCiphertext = z.strictObject({
  v: z.literal(1),
  alg: z.literal('A256GCM'),
  keyId: LedgerKeyId,
  nonce: Base64url,
  data: Base64url.max(8192),
});
export const ErasureTarget = z.discriminatedUnion('scope', [
  z.strictObject({ scope: z.literal('account'), subjectId: Id }),
  z.strictObject({ scope: z.literal('session'), subjectId: Id, sessionId: Id }),
  z.strictObject({
    scope: z.literal('reflection_revision'),
    subjectId: Id,
    reflectionId: Id,
    revision: Revision,
  }),
  z.strictObject({ scope: z.literal('context_copy'), subjectId: Id, source: Grant.shape.source }),
]);
export const ErasureIntent = z.strictObject({
  v: z.literal(1),
  jobId: Id,
  scope: z.enum(['account', 'session', 'reflection_revision', 'context_copy']),
  subjectHmac: Hash,
  targetHmac: Hash,
  hmacKeyId: LedgerKeyId,
  target: RecoveryCiphertext,
  receiptTokenHmac: Hash.nullable(),
  requestedAt: Instant,
  operationMac: Hash,
});
export const ErasurePass = z.strictObject({
  v: z.literal(1),
  jobId: Id,
  revision: Revision,
  intentSha256: Hash,
  previousCompletionSha256: Hash.nullable(),
  startedAt: Instant,
  hmacKeyId: LedgerKeyId,
  operationMac: Hash,
});
export const ErasureCompletion = z.strictObject({
  v: z.literal(1),
  jobId: Id,
  revision: Revision,
  passSha256: Hash,
  erasedAt: Instant,
  backupExpiresBy: Instant,
  purgeAfter: Instant,
  intentSha256: Hash,
  hmacKeyId: LedgerKeyId,
  operationMac: Hash,
});
export const IdentityCheckpoint = z.strictObject({
  v: z.literal(1),
  operationId: Id,
  subjectId: Id,
  epoch: Revision,
  createdAt: Instant,
  recoveryHandleHash: Hash,
  recoveryAcknowledgedAt: Instant.nullable(),
  credentials: z
    .array(
      z.strictObject({
        id: Base64url,
        publicKey: Base64url,
        signCount: z.number().int().min(0),
        backedUp: z.boolean(),
        transports: z.array(z.string()).max(7),
        createdAt: Instant,
      }),
    )
    .max(10),
  recoveryCodes: z
    .array(z.strictObject({ codeHash: Hash, usedAt: Instant.nullable(), createdAt: Instant }))
    .max(10),
});
export interface RecoveryLedger {
  putErasure(input: z.infer<typeof ErasureIntent>): Promise<void>; // conditional same-byte idempotency
  beginErasurePass(input: z.infer<typeof ErasurePass>): Promise<void>;
  putIdentity(input: z.infer<typeof IdentityCheckpoint>): Promise<void>; // encrypt under independent recovery KEK
  completeErasure(input: z.infer<typeof ErasureCompletion>): Promise<void>;
  listErasures(cursor: string | null): Promise<{
    objects: Array<{
      key: string;
      value:
        | z.infer<typeof ErasureIntent>
        | z.infer<typeof ErasurePass>
        | z.infer<typeof ErasureCompletion>;
    }>;
    nextCursor: string | null;
  }>; // At most 100 objects/page; validate the complete per-job chain before replay/purge.
}
export interface ContentService {
  stage(bundle: z.infer<typeof ContentBundle>): Promise<{ hash: string }>;
  activate(hash: string, expectedSystemRevision: number): Promise<{ revision: number }>;
  withdraw(
    hash: string,
    expectedPolicyRevision: number,
    kind: 'editorial' | 'rights' | 'safety',
  ): Promise<void>;
} // Operator-only; authenticated release/operator capability, no public v1 HTTP routes.
export const ContractVersions = {
  api: 1,
  database: 1,
  tarotBasis: 1,
  plan: 'tarot-plan.v1',
  modelOutput: 1,
  ciphertext: 1,
  export: 'reflection-export.v1',
  import: 'reflection-import.v1',
} as const;
