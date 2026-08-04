import { z } from 'zod'
import {
  BillingRolloutRequestedStateSchema,
  billingRolloutCohortContinuityHash,
  billingRolloutDigest,
  billingRolloutRequestedPolicyHash,
  billingRolloutSubjectHash,
  billingRolloutSubjectManifestHash,
  type BillingRolloutRequestedState,
  type BillingRolloutRuntimeSnapshot,
} from '@/modules/payment-rollout-control'

export const BILLING_ROLLOUT_SUBJECT_MANIFEST_SCHEMA_VERSION =
  'billing_rollout_subject_manifest_v1' as const
export const BILLING_ROLLOUT_SUBJECT_MANIFEST_PURGE_SCHEMA_VERSION =
  'billing_rollout_subject_manifest_purge_v1' as const
export const BILLING_ROLLOUT_RUNTIME_PROJECTION_SCHEMA_VERSION =
  'billing_rollout_runtime_projection_v1' as const
export const BILLING_ROLLOUT_SUBJECT_MANIFEST_RETENTION_DAYS =
  90 as const

const SAFE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{2,199}$/
const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/
const DIGEST_PATTERN = /^[a-f0-9]{64}$/
const COMMIT_SHA_PATTERN = /^[a-f0-9]{7,64}$/

const CanonicalUtcTimestampSchema = z.string().refine((value) => {
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString() === value
}, 'Must be a canonical UTC timestamp')

export const StageBillingRolloutSubjectManifestCommandSchema = z.object({
  schemaVersion:
    z.literal(BILLING_ROLLOUT_SUBJECT_MANIFEST_SCHEMA_VERSION),
  commandId: z.string().regex(SAFE_ID_PATTERN),
  correlationId: z.string().regex(SAFE_ID_PATTERN),
  userIds: z.array(z.string().regex(OBJECT_ID_PATTERN))
    .min(1)
    .max(500),
  expiresAt: CanonicalUtcTimestampSchema,
  reason: z.string().trim().min(20).max(2000),
  confirmation: z.string().min(1).max(256),
}).strict()

export type StageBillingRolloutSubjectManifestCommand = z.infer<
  typeof StageBillingRolloutSubjectManifestCommandSchema
>

export const PurgeBillingRolloutSubjectManifestsCommandSchema =
  z.object({
    schemaVersion: z.literal(
      BILLING_ROLLOUT_SUBJECT_MANIFEST_PURGE_SCHEMA_VERSION,
    ),
    commandId: z.string().regex(SAFE_ID_PATTERN),
    correlationId: z.string().regex(SAFE_ID_PATTERN),
    expectedActiveConfigHash: z.string().regex(DIGEST_PATTERN),
    retentionCutoff: CanonicalUtcTimestampSchema,
    maxDeleteCount: z.number().int().min(1).max(100),
    reason: z.string().trim().min(20).max(2000),
    confirmation: z.string().min(1).max(512),
  }).strict()

export type PurgeBillingRolloutSubjectManifestsCommand = z.infer<
  typeof PurgeBillingRolloutSubjectManifestsCommandSchema
>

export interface BillingRolloutSubjectManifestView {
  readonly schemaVersion:
    typeof BILLING_ROLLOUT_SUBJECT_MANIFEST_SCHEMA_VERSION
  readonly manifestHash: string
  readonly commandId: string
  readonly correlationId: string
  readonly subjectHashes: readonly string[]
  readonly subjectCount: number
  readonly expiresAt: Date
  readonly reason: string
  readonly confirmation: string
  readonly stagedByUserId: string
  readonly stagedAt: Date
}

export interface BillingRolloutSubjectManifestPurgeEvidence {
  readonly schemaVersion:
    typeof BILLING_ROLLOUT_SUBJECT_MANIFEST_PURGE_SCHEMA_VERSION
  readonly commandId: string
  readonly correlationId: string
  readonly commandDigest: string
  readonly activeConfigHash: string
  readonly retentionCutoff: Date
  readonly retentionFloor: Date
  readonly examinedCount: number
  readonly purgedCount: number
  readonly purgedEvidenceHashes: readonly string[]
  readonly performedAt: Date
}

export function billingRolloutSubjectManifestPurgeConfirmation(
  command: Pick<
    PurgeBillingRolloutSubjectManifestsCommand,
    'expectedActiveConfigHash' | 'retentionCutoff' | 'maxDeleteCount'
  >,
): string {
  return 'PURGE EXPIRED BILLING ROLLOUT AUDIENCES THROUGH ' +
    `${command.retentionCutoff} LIMIT ${command.maxDeleteCount} ` +
    `FROM ${command.expectedActiveConfigHash}`
}

export interface BillingRolloutArtifactSnapshot {
  readonly deploymentId: string
  readonly commitSha: string
  readonly activeCatalogVersion: string
  readonly activeCatalogHash: string
  readonly providerBindingHash: string
  readonly couponPolicyHash: string
  readonly copyBundleHash: string
}

export interface BillingRolloutRuntimeProjectionView
  extends BillingRolloutRuntimeSnapshot {
  readonly schemaVersion:
    typeof BILLING_ROLLOUT_RUNTIME_PROJECTION_SCHEMA_VERSION
  readonly persisted: boolean
}

function sortedSubjectHashes(
  hashes: readonly string[],
): readonly string[] {
  return Object.freeze([...hashes].sort())
}

export function prepareBillingRolloutSubjectManifest(input: {
  readonly command: StageBillingRolloutSubjectManifestCommand
  readonly actorUserId: string
  readonly authoritySecretBase64: string
  readonly now: Date
}): BillingRolloutSubjectManifestView {
  const command = StageBillingRolloutSubjectManifestCommandSchema.parse(
    input.command,
  )
  const actorUserId = input.actorUserId.toLowerCase()
  if (!OBJECT_ID_PATTERN.test(actorUserId)) {
    throw new Error('Manifest actor must be an authoritative user ID')
  }
  if (!Number.isFinite(input.now.getTime())) {
    throw new Error('Manifest staging time is invalid')
  }
  const expiresAt = new Date(command.expiresAt)
  if (
    expiresAt <= input.now ||
    expiresAt.getTime() - input.now.getTime() >
      31 * 24 * 60 * 60 * 1000
  ) {
    throw new Error('Manifest expiry must be within the next 31 days')
  }
  const normalizedUserIds = [...command.userIds]
    .map((userId) => userId.toLowerCase())
    .sort()
  if (normalizedUserIds.some(
    (userId, index) =>
      index > 0 && normalizedUserIds[index - 1] === userId,
  )) {
    throw new Error('Manifest user IDs must be unique')
  }
  const subjectHashes = sortedSubjectHashes(
    normalizedUserIds.map((userId) =>
      billingRolloutSubjectHash({
        userId,
        authoritySecretBase64: input.authoritySecretBase64,
      })),
  )
  const manifestHash =
    billingRolloutSubjectManifestHash(subjectHashes)
  if (
    command.confirmation !==
      `STAGE BILLING ROLLOUT AUDIENCE ${manifestHash}`
  ) {
    throw new Error('Exact manifest confirmation is required')
  }
  return Object.freeze({
    schemaVersion: BILLING_ROLLOUT_SUBJECT_MANIFEST_SCHEMA_VERSION,
    manifestHash,
    commandId: command.commandId,
    correlationId: command.correlationId,
    subjectHashes,
    subjectCount: subjectHashes.length,
    expiresAt,
    reason: command.reason,
    confirmation: command.confirmation,
    stagedByUserId: actorUserId,
    stagedAt: new Date(input.now),
  })
}

export function billingRolloutRuntimeProjectionHash(input: {
  readonly configRevision: number
  readonly deploymentId: string
  readonly commitSha: string
  readonly state: BillingRolloutRequestedState
  readonly allowlistSubjectHashes: readonly string[]
}): string {
  const state = BillingRolloutRequestedStateSchema.parse(input.state)
  if (
    !Number.isSafeInteger(input.configRevision) ||
    input.configRevision < 0 ||
    !SAFE_ID_PATTERN.test(input.deploymentId) ||
    !COMMIT_SHA_PATTERN.test(input.commitSha)
  ) throw new Error('Runtime projection identity is invalid')
  const hashes = sortedSubjectHashes(input.allowlistSubjectHashes)
  if (
    hashes.some((hash) => !DIGEST_PATTERN.test(hash)) ||
    hashes.some(
      (hash, index) => index > 0 && hashes[index - 1] === hash,
    ) ||
    hashes.length !== state.allowlistCount ||
    billingRolloutSubjectManifestHash(hashes) !== state.allowlistHash ||
    billingRolloutCohortContinuityHash(state) !==
      state.cohortContinuityHash ||
    billingRolloutRequestedPolicyHash(state) !== state.rolloutPolicyHash
  ) throw new Error('Runtime projection state is not self-verifying')
  return billingRolloutDigest({
    domain: BILLING_ROLLOUT_RUNTIME_PROJECTION_SCHEMA_VERSION,
    configRevision: input.configRevision,
    deploymentId: input.deploymentId,
    commitSha: input.commitSha,
    state,
    allowlistSubjectHashes: hashes,
  })
}

export function inertBillingRolloutState(input: {
  readonly artifacts: BillingRolloutArtifactSnapshot
  readonly rolloutSeedId: string
}): BillingRolloutRequestedState {
  const state: BillingRolloutRequestedState = {
    providerMode: 'none',
    sellingMode: 'off',
    enforcementMode: 'off',
    couponMode: 'off',
    allowlistCount: 0,
    allowlistHash: billingRolloutSubjectManifestHash([]),
    allowlistExpiresAt: null,
    skuScope: [],
    newUserRolloutPercent: 0,
    enforcementStartedAt: null,
    legacyGrandfatherEndsAt: null,
    activeCatalogVersion: input.artifacts.activeCatalogVersion,
    activeCatalogHash: input.artifacts.activeCatalogHash,
    providerBindingHash: input.artifacts.providerBindingHash,
    couponPolicyHash: input.artifacts.couponPolicyHash,
    copyBundleHash: input.artifacts.copyBundleHash,
    rolloutSeedId: input.rolloutSeedId,
    rolloutPolicyHash: '0'.repeat(64),
    cohortContinuityHash: '0'.repeat(64),
    autoCouponRequired: true,
    webhookProcessingEnabled: false,
    reconciliationEnabled: false,
    surfaces: {
      selling: false,
      enforcement: false,
      copy: false,
      analytics: false,
      communications: false,
    },
  }
  state.cohortContinuityHash =
    billingRolloutCohortContinuityHash(state)
  state.rolloutPolicyHash = billingRolloutRequestedPolicyHash(state)
  return BillingRolloutRequestedStateSchema.parse(state)
}
