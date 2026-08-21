import { z } from 'zod'

/**
 * Versioned wire contract between the Hire control plane and the isolated
 * interview runtime.  Candidate identity fields are intentionally absent:
 * the runtime receives only opaque Hire coordinates and the immutable engine
 * configuration needed to run one round.
 */

export const HIRE_ENGINE_BRIDGE_SCHEMA_VERSION = 1 as const
export const HIRE_ENGINE_HANDOFF_SCHEMA_VERSION = 2 as const

export const MongoObjectIdStringSchema = z
  .string()
  .regex(/^[a-f0-9]{24}$/i)
  .transform((value) => value.toLowerCase())

export const Sha256HexSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/i)
  .transform((value) => value.toLowerCase())

export const IsoDateTimeSchema = z.string().datetime({ offset: true })

export const HireEngineConfigSchema = z
  .object({
    role: z.string().trim().min(1).max(100),
    interviewType: z.string().trim().min(1).max(50),
    experience: z.enum(['0-2', '3-6', '7+']),
    // The unchanged engine's final authority currently rejects durations
    // above 30 minutes. Keep the bridge at that same boundary so an invalid
    // control-plane configuration cannot fail only after the guest signs in.
    duration: z.number().int().min(5).max(30),
    jobDescription: z.string().min(1).max(50_000),
    targetCompany: z.string().trim().max(200).optional(),
  })
  .strict()

export const HireEngineExchangeRequestSchema = z
  .object({
    code: z.string().regex(/^[a-f0-9]{24}\.[a-f0-9]{64}$/i),
    requestId: Sha256HexSchema,
  })
  .strict()

export const HireEngineHandoffEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(HIRE_ENGINE_HANDOFF_SCHEMA_VERSION),
    workspaceId: MongoObjectIdStringSchema,
    applicationId: MongoObjectIdStringSchema,
    roundId: MongoObjectIdStringSchema,
    // Monotonic per round and allocated by the control-plane transaction.
    // Runtime uses this durable ordering to reject an older handoff that
    // arrives after a newer recovery link has already rotated auth state.
    handoffGeneration: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    nonce: Sha256HexSchema,
    issuedAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
    inviteExpiresAt: IsoDateTimeSchema,
    consentVersion: z.string().trim().min(1).max(80),
    consentAt: IsoDateTimeSchema,
    config: HireEngineConfigSchema,
  })
  .strict()

export const HireEngineExchangeResponseSchema = z
  .object({
    envelope: HireEngineHandoffEnvelopeSchema,
  })
  .strict()

export const HireEnginePerQuestionResultSchema = z
  .object({
    questionIndex: z.number().int().min(0).max(500),
    question: z.string().max(5_000),
    answer: z.string().max(20_000).optional(),
    answerSummary: z.string().max(4_000).optional(),
    score: z.number().finite().min(0).max(100).nullable(),
    relevance: z.number().finite().min(0).max(100).nullable().optional(),
    structure: z.number().finite().min(0).max(100).nullable().optional(),
    specificity: z.number().finite().min(0).max(100).nullable().optional(),
    ownership: z.number().finite().min(0).max(100).nullable().optional(),
    jdAlignment: z.number().finite().min(0).max(100).nullable().optional(),
    flags: z.array(z.string().max(500)).max(40).optional(),
    evaluationFailed: z.boolean().optional(),
  })
  .strict()

export const HireEngineResultSchema = z
  .object({
    overallScore: z.number().finite().min(0).max(100).nullable(),
    passProbability: z.string().max(40).optional(),
    confidenceLevel: z.string().max(40).optional(),
    answerQualityScore: z.number().finite().min(0).max(100).nullable().optional(),
    communicationScore: z.number().finite().min(0).max(100).nullable().optional(),
    jdMatchScore: z.number().finite().min(0).max(100).nullable().optional(),
    redFlags: z.array(z.string().max(2_000)).max(50).optional(),
    topImprovements: z.array(z.string().max(2_000)).max(20).optional(),
    answeredCount: z.number().int().min(0).max(500).nullable().optional(),
    plannedQuestionCount: z.number().int().min(0).max(500).nullable().optional(),
    endReason: z.string().max(80).nullable().optional(),
    perQuestion: z.array(HireEnginePerQuestionResultSchema).max(500).optional(),
    pending: z.boolean().optional(),
    unscored: z.boolean().optional(),
    sessionCompletedAt: IsoDateTimeSchema.optional(),
  })
  .strict()

export const HireEngineMediaArtifactSchema = z
  .object({
    kind: z.enum(['recording', 'screen', 'audio', 'transcript', 'landmarks']),
    sourceKey: z
      .string()
      .min(1)
      .max(1_024)
      .refine((value) => !value.includes('..') && !value.startsWith('/'), 'Unsafe object key'),
    contentType: z.string().trim().min(1).max(120),
    sizeBytes: z.number().int().min(0).max(5 * 1024 * 1024 * 1024),
    sha256: Sha256HexSchema,
  })
  .strict()

export const HireEngineTranscriptEntrySchema = z
  .object({
    speaker: z.enum(['interviewer', 'candidate']),
    text: z.string().max(20_000),
    timestampMs: z.number().int().min(0).max(24 * 60 * 60 * 1_000),
    questionIndex: z.number().int().min(0).max(500).nullable().optional(),
  })
  .strict()

export const HireEngineResultIngestionSchema = z
  .object({
    schemaVersion: z.literal(HIRE_ENGINE_BRIDGE_SCHEMA_VERSION),
    eventId: Sha256HexSchema,
    workspaceId: MongoObjectIdStringSchema,
    applicationId: MongoObjectIdStringSchema,
    roundId: MongoObjectIdStringSchema,
    runtimeSessionId: MongoObjectIdStringSchema,
    attempt: z.number().int().min(1).max(10),
    revision: z.number().int().min(1).max(10),
    status: z.literal('completed'),
    startedAt: IsoDateTimeSchema,
    completedAt: IsoDateTimeSchema,
    durationMs: z.number().int().min(1).max(24 * 60 * 60 * 1_000),
    resultDigest: Sha256HexSchema,
    results: HireEngineResultSchema,
    transcript: z.array(HireEngineTranscriptEntrySchema).max(5_000),
    media: z.array(HireEngineMediaArtifactSchema).max(8).default([]),
  })
  .strict()

export const HireEngineRevocationSchema = z
  .object({
    schemaVersion: z.literal(HIRE_ENGINE_BRIDGE_SCHEMA_VERSION),
    workspaceId: MongoObjectIdStringSchema,
    applicationId: MongoObjectIdStringSchema,
    roundId: MongoObjectIdStringSchema,
    revokedAt: IsoDateTimeSchema,
    reason: z.string().trim().min(1).max(500),
    // Ordinary invite revocation keeps the isolated engine record for the
    // control plane's configured retention window. A verified privacy request
    // upgrades the same durable revocation tombstone to a full runtime purge.
    purgePersonalData: z.boolean().default(false),
  })
  .strict()

export const HireRuntimeHandoffRequestSchema = z
  .object({
    code: z.string().regex(/^[a-f0-9]{24}\.[a-f0-9]{64}$/i),
    // Generated independently inside the candidate's browser and kept only in
    // this tab. The runtime folds it into the control-plane request binding so
    // the already-bound URL capability cannot be replayed from another tab.
    clientNonce: Sha256HexSchema,
  })
  .strict()

export const HireRuntimeBootstrapResponseSchema = z
  .object({
    // Both ids are runtime-scoped pseudonyms/coordinates. They let the client
    // apply the unchanged engine's existing owner guard without receiving a
    // candidate email, name, B2C user id, or any other identity attribute.
    principalId: MongoObjectIdStringSchema,
    roundId: MongoObjectIdStringSchema,
    config: HireEngineConfigSchema,
  })
  .strict()

export type HireEngineConfig = z.infer<typeof HireEngineConfigSchema>
export type HireEngineExchangeRequest = z.infer<typeof HireEngineExchangeRequestSchema>
export type HireEngineHandoffEnvelope = z.infer<typeof HireEngineHandoffEnvelopeSchema>
export type HireEngineResult = z.infer<typeof HireEngineResultSchema>
export type HireEngineResultIngestion = z.infer<typeof HireEngineResultIngestionSchema>
export type HireEngineRevocation = z.infer<typeof HireEngineRevocationSchema>
export type HireRuntimeBootstrapResponse = z.infer<
  typeof HireRuntimeBootstrapResponseSchema
>

/** Stable JSON representation used before hashing bridge payloads. */
export function canonicalBridgeJson(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalBridgeJson(entry)).join(',')}]`
  }
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalBridgeJson(record[key])}`)
    .join(',')}}`
}
