import { createHash } from 'node:crypto'
import mongoose from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { BillingConfig } from '../models/BillingConfig'
import { PlanCatalogVersion } from '../models/PlanCatalogVersion'
import type {
  BillingRolloutPolicy,
  BillingRolloutSurfaces,
} from '../models/BillingConfig'
import type { CmsAuditActor } from '../types/admin'
import type { BillingConfigPatchInput } from '../validators/billingConfig'
import { canonicalJson } from '../lib/canonicalJson'
import {
  AdminMutationConflictError,
  AdminMutationValidationError,
  runAuditedMutation,
} from './adminAuditService'

export interface BillingConfigView {
  persisted: boolean
  revision: number
  sellingMode: 'off' | 'qa' | 'all'
  enforcementMode: 'off' | 'shadow' | 'new_users' | 'all'
  couponMode: 'off' | 'qa' | 'all'
  qaUserIds: string[]
  newUserRolloutPercent: number
  enforcementStartedAt?: Date
  legacyGrandfatherEndsAt?: Date
  activeCatalogVersion?: string
  autoCouponRequired: boolean
  webhookProcessingEnabled: boolean
  reconciliationEnabled: boolean
  rolloutPolicy?: BillingRolloutPolicy
  updatedAt?: Date
}

export const ALL_OFF_BILLING_CONFIG: Readonly<BillingConfigView> = Object.freeze({
  persisted: false,
  revision: 0,
  sellingMode: 'off',
  enforcementMode: 'off',
  couponMode: 'off',
  qaUserIds: [],
  newUserRolloutPercent: 0,
  autoCouponRequired: true,
  webhookProcessingEnabled: false,
  reconciliationEnabled: false,
})

const POLICY_KEYS = [
  'version',
  'algorithm',
  'seedId',
  'policyHash',
  'surfaces',
] as const
const SURFACE_KEYS = [
  'selling',
  'enforcement',
  'copy',
  'analytics',
  'communications',
] as const
const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i
const SEED_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
const ROLLOUT_BOUND_PATCH_KEYS = new Set([
  'newUserRolloutPercent',
  'enforcementStartedAt',
  'legacyGrandfatherEndsAt',
  'activeCatalogVersion',
  'rolloutPolicy',
])

export const INERT_BILLING_ROLLOUT_SURFACES:
Readonly<BillingRolloutSurfaces> = Object.freeze({
  selling: false,
  enforcement: false,
  copy: false,
  analytics: false,
  communications: false,
})

function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === keys.length &&
    actual.every((key, index) => key === [...keys].sort()[index])
}

function normalizeRolloutPolicy(value: unknown):
  BillingRolloutPolicy | undefined {
  if (!value || typeof value !== 'object' ||
      !exactKeys(value, POLICY_KEYS)) return undefined
  const policy = value as Record<string, unknown>
  const surfaces = policy.surfaces
  if (!surfaces || typeof surfaces !== 'object' ||
      !exactKeys(surfaces, SURFACE_KEYS) ||
      !SURFACE_KEYS.every(
        (surface) =>
          typeof (surfaces as Record<string, unknown>)[surface] === 'boolean',
      )) return undefined
  if (
    policy.version !== 1 ||
    policy.algorithm !== 'sha256-v1' ||
    typeof policy.seedId !== 'string' ||
    !SEED_ID_PATTERN.test(policy.seedId) ||
    typeof policy.policyHash !== 'string' ||
    !SHA256_PATTERN.test(policy.policyHash)
  ) return undefined
  return {
    version: 1,
    algorithm: 'sha256-v1',
    seedId: policy.seedId,
    policyHash: policy.policyHash,
    surfaces: Object.fromEntries(
      SURFACE_KEYS.map((surface) => [
        surface,
        (surfaces as Record<string, boolean>)[surface],
      ]),
    ) as unknown as BillingRolloutSurfaces,
  }
}

function toView(
  config: {
    revision: number
    sellingMode: BillingConfigView['sellingMode']
    enforcementMode: BillingConfigView['enforcementMode']
    couponMode: BillingConfigView['couponMode']
    qaUserIds?: Array<{ toString(): string } | string>
    newUserRolloutPercent: number
    enforcementStartedAt?: Date
    legacyGrandfatherEndsAt?: Date
    activeCatalogVersion?: string
    autoCouponRequired: boolean
    webhookProcessingEnabled: boolean
    reconciliationEnabled: boolean
    rolloutPolicy?: unknown
    updatedAt?: Date
  },
  persisted = true,
): BillingConfigView {
  return {
    persisted,
    revision: config.revision,
    sellingMode: config.sellingMode,
    enforcementMode: config.enforcementMode,
    couponMode: config.couponMode,
    qaUserIds: (config.qaUserIds ?? []).map((id) => id.toString()),
    newUserRolloutPercent: config.newUserRolloutPercent,
    enforcementStartedAt: config.enforcementStartedAt,
    legacyGrandfatherEndsAt: config.legacyGrandfatherEndsAt,
    activeCatalogVersion: config.activeCatalogVersion,
    autoCouponRequired: config.autoCouponRequired,
    webhookProcessingEnabled: config.webhookProcessingEnabled,
    reconciliationEnabled: config.reconciliationEnabled,
    rolloutPolicy: normalizeRolloutPolicy(config.rolloutPolicy),
    updatedAt: config.updatedAt,
  }
}

export async function getBillingConfig(): Promise<BillingConfigView> {
  await connectDB()
  const config = await BillingConfig.findOne({ key: 'singleton' }).lean()
  return config ? toView(config) : { ...ALL_OFF_BILLING_CONFIG }
}

/**
 * PR2 is preparatory: every commercial/recovery switch is schema-constrained
 * to remain off. QA user IDs and a future rollout percentage may be staged,
 * but they have no effect while the modes are off.
 */
export async function updateBillingConfig(input: {
  actor: CmsAuditActor
  request: BillingConfigPatchInput
  requestId?: string
}): Promise<BillingConfigView> {
  const { request, actor } = input
  return runAuditedMutation({
    actor,
    mutationId: request.mutationId,
    correlationId: request.correlationId,
    requestId: input.requestId,
    action: 'billing_config_updated',
    targetType: 'BillingConfig',
    targetId: 'singleton',
    reason: request.reason,
    mutate: async (dbSession) => {
      const existing = await BillingConfig.findOne({ key: 'singleton' })
        .session(dbSession)
        .lean()
      const before = existing
        ? toView(existing)
        : { ...ALL_OFF_BILLING_CONFIG }

      if (before.revision !== request.expectedRevision) {
        throw new AdminMutationConflictError(
          `Expected revision ${request.expectedRevision}, found ${before.revision}`,
        )
      }

      const patch = await prepareInertBillingConfigPatch({
        before,
        requestPatch: request.patch,
        actorUserId: actor.userId,
        dbSession,
      })

      let updated
      if (existing) {
        updated = await BillingConfig.findOneAndUpdate(
          { key: 'singleton', revision: request.expectedRevision },
          { $set: patch, $inc: { revision: 1 } },
          { new: true, session: dbSession, runValidators: true },
        ).lean()
      } else {
        const created = await BillingConfig.create([
          {
            key: 'singleton',
            revision: 1,
            ...patch,
          },
        ], { session: dbSession })
        updated = created[0].toObject()
      }

      if (!updated) {
        throw new AdminMutationConflictError(
          'Billing configuration changed concurrently',
        )
      }
      const after = toView(updated)
      return { before, after, result: after }
    },
  })
}

export interface BillingModeDecision {
  sellingAllowed: boolean
  enforcementEnabled: boolean
  shadowOnly: boolean
  copyEnabled: boolean
  analyticsEnabled: boolean
  communicationsEnabled: boolean
  qaUser: boolean
  audience: 'none' | 'qa' | 'public_control' | 'public_treatment'
  cohortIncluded: boolean
  cohortBucket?: number
  cohortPolicyVersion?: 1
  cohortPolicyHash?: string
  cohortSeedId?: string
  reason:
    | 'selling_off'
    | 'not_qa_user'
    | 'selling_allowed'
    | 'enforcement_off'
    | 'shadow'
    | 'enforcement_enabled'
    | 'rollout_policy_missing'
    | 'rollout_policy_invalid'
    | 'rollout_surface_off'
    | 'catalog_mismatch'
    | 'invalid_cohort_context'
    | 'before_enforcement_start'
    | 'grandfathered'
    | 'outside_cohort'
    | 'qa_user_separated'
}

export interface BillingModeEvaluationContext {
  userCreatedAt?: Date
  now?: Date
  catalogVersion?: string
}

export interface BillingRolloutPolicyHashInput {
  version: 1
  algorithm: 'sha256-v1'
  seedId: string
  activeCatalogVersion?: string
  newUserRolloutPercent: number
  enforcementStartedAt?: Date
  legacyGrandfatherEndsAt?: Date
  surfaces: BillingRolloutSurfaces
}

export function billingRolloutPolicyHash(
  input: BillingRolloutPolicyHashInput,
): string {
  return createHash('sha256').update(canonicalJson({
    version: input.version,
    algorithm: input.algorithm,
    seedId: input.seedId,
    activeCatalogVersion: input.activeCatalogVersion ?? null,
    newUserRolloutPercent: input.newUserRolloutPercent,
    enforcementStartedAt: input.enforcementStartedAt?.toISOString() ?? null,
    legacyGrandfatherEndsAt:
      input.legacyGrandfatherEndsAt?.toISOString() ?? null,
    surfaces: input.surfaces,
  })).digest('hex')
}

export type BillingRolloutStagingIssue =
  | 'commercial_modes_not_off'
  | 'recovery_modes_not_off'
  | 'auto_coupon_not_required'
  | 'rollout_policy_missing'
  | 'rollout_policy_invalid'
  | 'rollout_surfaces_not_off'
  | 'active_catalog_missing'
  | 'active_catalog_not_published'
  | 'timeline_incomplete'
  | 'grandfather_window_not_30_days'
  | 'rollout_timeline_missing'
  | 'policy_hash_mismatch'

export interface BillingRolloutStagingView {
  status: 'not_staged' | 'valid_inert' | 'invalid'
  activationAvailable: false
  decisionReadReady: boolean
  allModesOff: boolean
  allSurfacesOff: boolean
  qaUserCount: number
  newUserRolloutPercent: number
  activeCatalog: {
    version?: string
    published: boolean
  }
  timeline: {
    enforcementStartedAt?: string
    legacyGrandfatherEndsAt?: string
    exactThirtyDays: boolean
  }
  policy: {
    present: boolean
    hashVerified: boolean
    version?: 1
    algorithm?: 'sha256-v1'
    seedId?: string
    policyHash?: string
  }
  issues: BillingRolloutStagingIssue[]
}

export interface BillingRolloutControlPlaneRead {
  config: BillingConfigView
  rollout: BillingRolloutStagingView
}

export interface BillingRolloutDecisionRead {
  schemaVersion: 'billing_rollout_decision_v1'
  configRevision: number
  configPersisted: boolean
  evaluatedAt: string
  catalogVersion?: string
  rollout: BillingRolloutStagingView
  decision: BillingModeDecision
}

function allRolloutSurfacesOff(
  surfaces: BillingRolloutSurfaces,
): boolean {
  return SURFACE_KEYS.every((surface) => surfaces[surface] === false)
}

function rolloutPolicyHashMatches(
  config: BillingConfigView,
  policy: BillingRolloutPolicy,
): boolean {
  return policy.policyHash === billingRolloutPolicyHash({
    version: policy.version,
    algorithm: policy.algorithm,
    seedId: policy.seedId,
    activeCatalogVersion: config.activeCatalogVersion,
    newUserRolloutPercent: config.newUserRolloutPercent,
    enforcementStartedAt: config.enforcementStartedAt,
    legacyGrandfatherEndsAt: config.legacyGrandfatherEndsAt,
    surfaces: policy.surfaces,
  })
}

export function inspectBillingRolloutStaging(
  config: BillingConfigView,
  input: { activeCatalogPublished: boolean },
): BillingRolloutStagingView {
  const issues: BillingRolloutStagingIssue[] = []
  const policyPresent = config.rolloutPolicy !== undefined
  const policy = normalizeRolloutPolicy(config.rolloutPolicy)
  const enforcementStart = config.enforcementStartedAt
  const grandfatherEnd = config.legacyGrandfatherEndsAt
  const hasStart = validDate(enforcementStart)
  const hasGrandfatherEnd = validDate(grandfatherEnd)
  const timelinePresent = hasStart || hasGrandfatherEnd
  const exactThirtyDays =
    !timelinePresent ||
    (
      hasStart &&
      hasGrandfatherEnd &&
      grandfatherEnd.getTime() -
        enforcementStart.getTime() === THIRTY_DAYS_MS
    )
  const allModesOff =
    config.sellingMode === 'off' &&
    config.enforcementMode === 'off' &&
    config.couponMode === 'off' &&
    config.webhookProcessingEnabled === false &&
    config.reconciliationEnabled === false &&
    config.autoCouponRequired === true
  const allSurfacesOff =
    policy === undefined || allRolloutSurfacesOff(policy.surfaces)
  const rolloutStaged =
    policyPresent ||
    timelinePresent ||
    config.newUserRolloutPercent > 0

  if (
    config.sellingMode !== 'off' ||
    config.enforcementMode !== 'off' ||
    config.couponMode !== 'off'
  ) issues.push('commercial_modes_not_off')
  if (
    config.webhookProcessingEnabled !== false ||
    config.reconciliationEnabled !== false
  ) issues.push('recovery_modes_not_off')
  if (config.autoCouponRequired !== true) {
    issues.push('auto_coupon_not_required')
  }
  if (policyPresent && !policy) issues.push('rollout_policy_invalid')
  if (rolloutStaged && !policyPresent) issues.push('rollout_policy_missing')
  if (policy && !allRolloutSurfacesOff(policy.surfaces)) {
    issues.push('rollout_surfaces_not_off')
  }
  if (policy && !config.activeCatalogVersion) {
    issues.push('active_catalog_missing')
  }
  if (
    policy &&
    config.activeCatalogVersion &&
    !input.activeCatalogPublished
  ) issues.push('active_catalog_not_published')
  if (hasStart !== hasGrandfatherEnd) issues.push('timeline_incomplete')
  if (timelinePresent && !exactThirtyDays) {
    issues.push('grandfather_window_not_30_days')
  }
  if (
    config.newUserRolloutPercent > 0 &&
    (!hasStart || !hasGrandfatherEnd)
  ) issues.push('rollout_timeline_missing')
  const hashVerified = Boolean(
    policy && rolloutPolicyHashMatches(config, policy),
  )
  if (policy && !hashVerified) issues.push('policy_hash_mismatch')

  const status = !rolloutStaged
    ? 'not_staged'
    : issues.length === 0
      ? 'valid_inert'
      : 'invalid'
  return {
    status,
    activationAvailable: false,
    decisionReadReady: status === 'valid_inert',
    allModesOff,
    allSurfacesOff,
    qaUserCount: config.qaUserIds.length,
    newUserRolloutPercent: config.newUserRolloutPercent,
    activeCatalog: {
      version: config.activeCatalogVersion,
      published:
        Boolean(config.activeCatalogVersion) &&
        input.activeCatalogPublished,
    },
    timeline: {
      enforcementStartedAt:
        hasStart ? enforcementStart.toISOString() : undefined,
      legacyGrandfatherEndsAt:
        hasGrandfatherEnd
          ? grandfatherEnd.toISOString()
          : undefined,
      exactThirtyDays,
    },
    policy: {
      present: policyPresent,
      hashVerified,
      version: policy?.version,
      algorithm: policy?.algorithm,
      seedId: policy?.seedId,
      policyHash: policy?.policyHash,
    },
    issues,
  }
}

async function publishedCatalogExists(
  version: string | undefined,
  dbSession?: mongoose.ClientSession,
): Promise<boolean> {
  if (!version) return false
  const query = PlanCatalogVersion.exists({
    version,
    status: 'published',
  })
  if (dbSession) query.session(dbSession)
  return Boolean(await query)
}

export async function readBillingRolloutControlPlane(
  configInput?: BillingConfigView,
): Promise<BillingRolloutControlPlaneRead> {
  const config = configInput ?? await getBillingConfig()
  if (configInput) await connectDB()
  const activeCatalogPublished = await publishedCatalogExists(
    config.activeCatalogVersion,
  )
  return {
    config,
    rollout: inspectBillingRolloutStaging(config, {
      activeCatalogPublished,
    }),
  }
}

function decisionHasEnabledSurface(decisionValue: BillingModeDecision): boolean {
  return decisionValue.sellingAllowed ||
    decisionValue.enforcementEnabled ||
    decisionValue.shadowOnly ||
    decisionValue.copyEnabled ||
    decisionValue.analyticsEnabled ||
    decisionValue.communicationsEnabled
}

export async function readBillingRolloutDecision(input: {
  userId: string
  userCreatedAt?: Date
  now?: Date
  catalogVersion?: string
}): Promise<BillingRolloutDecisionRead> {
  const controlPlane = await readBillingRolloutControlPlane()
  const now = input.now ?? new Date()
  const catalogVersion =
    input.catalogVersion ?? controlPlane.config.activeCatalogVersion
  const configForEvaluation =
    controlPlane.rollout.status === 'valid_inert'
      ? controlPlane.config
      : {
          ...ALL_OFF_BILLING_CONFIG,
          persisted: controlPlane.config.persisted,
          revision: controlPlane.config.revision,
        }
  let evaluated = evaluateBillingModes(
    configForEvaluation,
    input.userId,
    {
      userCreatedAt: input.userCreatedAt,
      now,
      catalogVersion,
    },
  )
  if (decisionHasEnabledSurface(evaluated)) {
    evaluated = evaluateBillingModes(
      { ...ALL_OFF_BILLING_CONFIG },
      input.userId,
    )
  }
  return {
    schemaVersion: 'billing_rollout_decision_v1',
    configRevision: controlPlane.config.revision,
    configPersisted: controlPlane.config.persisted,
    evaluatedAt: now.toISOString(),
    catalogVersion,
    rollout: controlPlane.rollout,
    decision: evaluated,
  }
}

async function prepareInertBillingConfigPatch(input: {
  before: BillingConfigView
  requestPatch: BillingConfigPatchInput['patch']
  actorUserId: string
  dbSession: mongoose.ClientSession
}) {
  const { before, requestPatch } = input
  const qaUserIds = (
    requestPatch.qaUserIds ?? before.qaUserIds
  ).map((id) => id.toLowerCase()).sort()
  const newUserRolloutPercent =
    requestPatch.newUserRolloutPercent ??
    before.newUserRolloutPercent
  const enforcementStartedAt = requestPatch.enforcementStartedAt
    ? new Date(requestPatch.enforcementStartedAt)
    : before.enforcementStartedAt
  const legacyGrandfatherEndsAt = requestPatch.legacyGrandfatherEndsAt
    ? new Date(requestPatch.legacyGrandfatherEndsAt)
    : before.legacyGrandfatherEndsAt
  const activeCatalogVersion =
    requestPatch.activeCatalogVersion ??
    before.activeCatalogVersion
  const previousPolicy = normalizeRolloutPolicy(before.rolloutPolicy)
  const policyBasis = requestPatch.rolloutPolicy ?? previousPolicy
  const rolloutPolicy: BillingRolloutPolicy | undefined = policyBasis
    ? {
        version: policyBasis.version,
        algorithm: policyBasis.algorithm,
        seedId: policyBasis.seedId,
        surfaces: policyBasis.surfaces,
        policyHash: billingRolloutPolicyHash({
          version: policyBasis.version,
          algorithm: policyBasis.algorithm,
          seedId: policyBasis.seedId,
          activeCatalogVersion,
          newUserRolloutPercent,
          enforcementStartedAt,
          legacyGrandfatherEndsAt,
          surfaces: policyBasis.surfaces,
        }),
      }
    : undefined
  const candidate: BillingConfigView = {
    ...before,
    sellingMode: 'off',
    enforcementMode: 'off',
    couponMode: 'off',
    qaUserIds,
    newUserRolloutPercent,
    enforcementStartedAt,
    legacyGrandfatherEndsAt,
    activeCatalogVersion,
    autoCouponRequired: true,
    webhookProcessingEnabled: false,
    reconciliationEnabled: false,
    rolloutPolicy,
  }
  const activeCatalogPublished = await publishedCatalogExists(
    activeCatalogVersion,
    input.dbSession,
  )
  const staging = inspectBillingRolloutStaging(candidate, {
    activeCatalogPublished,
  })
  const rolloutBoundPatch = Object.keys(requestPatch)
    .some((key) => ROLLOUT_BOUND_PATCH_KEYS.has(key))

  if (
    requestPatch.activeCatalogVersion !== undefined &&
    !activeCatalogPublished
  ) {
    throw new AdminMutationValidationError(
      'activeCatalogVersion must reference a published catalog',
    )
  }
  if (!staging.allSurfacesOff) {
    throw new AdminMutationValidationError(
      'Every rollout surface must remain false in preparatory staging',
    )
  }
  if (rolloutBoundPatch && staging.status === 'invalid') {
    throw new AdminMutationValidationError(
      `Invalid inert rollout staging: ${staging.issues.join(', ')}`,
    )
  }

  return {
    sellingMode: 'off' as const,
    enforcementMode: 'off' as const,
    couponMode: 'off' as const,
    qaUserIds: qaUserIds.map(
      (id) => new mongoose.Types.ObjectId(id),
    ),
    newUserRolloutPercent,
    ...(enforcementStartedAt && { enforcementStartedAt }),
    ...(legacyGrandfatherEndsAt && { legacyGrandfatherEndsAt }),
    ...(activeCatalogVersion && { activeCatalogVersion }),
    autoCouponRequired: true as const,
    webhookProcessingEnabled: false as const,
    reconciliationEnabled: false as const,
    ...(rolloutPolicy && { rolloutPolicy }),
    updatedBy: new mongoose.Types.ObjectId(input.actorUserId),
  }
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime())
}

function decision(
  reason: BillingModeDecision['reason'],
  qaUser: boolean,
  extra: Partial<BillingModeDecision> = {},
): BillingModeDecision {
  return {
    sellingAllowed: false,
    enforcementEnabled: false,
    shadowOnly: false,
    copyEnabled: false,
    analyticsEnabled: false,
    communicationsEnabled: false,
    qaUser,
    audience: 'none',
    cohortIncluded: false,
    reason,
    ...extra,
  }
}

function validatedPolicy(config: BillingConfigView):
  BillingRolloutPolicy | undefined {
  const policy = normalizeRolloutPolicy(config.rolloutPolicy)
  if (
    !policy ||
    typeof config.activeCatalogVersion !== 'string' ||
    config.activeCatalogVersion.length === 0 ||
    !Number.isInteger(config.newUserRolloutPercent) ||
    config.newUserRolloutPercent < 0 ||
    config.newUserRolloutPercent > 100
  ) return undefined
  const start = config.enforcementStartedAt
  const end = config.legacyGrandfatherEndsAt
  const hasStart = validDate(start)
  const hasEnd = validDate(end)
  if (
    hasStart !== hasEnd ||
    (hasStart && hasEnd &&
      end.getTime() - start.getTime() !== THIRTY_DAYS_MS)
  ) return undefined
  return policy.policyHash === billingRolloutPolicyHash({
    version: policy.version,
    algorithm: policy.algorithm,
    seedId: policy.seedId,
    activeCatalogVersion: config.activeCatalogVersion,
    newUserRolloutPercent: config.newUserRolloutPercent,
    enforcementStartedAt: config.enforcementStartedAt,
    legacyGrandfatherEndsAt: config.legacyGrandfatherEndsAt,
    surfaces: policy.surfaces,
  }) ? policy : undefined
}

function cohortBucket(input: {
  userId: string
  catalogVersion: string
  policy: BillingRolloutPolicy
}): number {
  const digest = createHash('sha256').update(canonicalJson({
    algorithm: input.policy.algorithm,
    version: input.policy.version,
    seedId: input.policy.seedId,
    catalogVersion: input.catalogVersion,
    userId: input.userId.toLowerCase(),
  })).digest('hex')
  return Number.parseInt(digest.slice(0, 12), 16) % 10_000
}

export function evaluateBillingModes(
  config: BillingConfigView,
  userId: string,
  context: BillingModeEvaluationContext = {},
): BillingModeDecision {
  const qaUser = config.qaUserIds.includes(userId.toLowerCase())
  const rawPolicyPresent = config.rolloutPolicy !== undefined
  const policy = validatedPolicy(config)
  if (!policy) {
    return decision(
      !rawPolicyPresent
        ? config.sellingMode === 'off' && config.enforcementMode === 'off'
          ? 'selling_off'
          : 'rollout_policy_missing'
        : 'rollout_policy_invalid',
      qaUser,
    )
  }
  const policyEvidence = {
    cohortPolicyVersion: policy.version,
    cohortPolicyHash: policy.policyHash,
    cohortSeedId: policy.seedId,
  } as const
  if (
    typeof context.catalogVersion !== 'string' ||
    context.catalogVersion !== config.activeCatalogVersion
  ) {
    return decision('catalog_mismatch', qaUser, policyEvidence)
  }

  if (config.sellingMode === 'qa') {
    if (!qaUser) return decision('not_qa_user', false, policyEvidence)
    const shadowOnly =
      config.enforcementMode === 'shadow' && policy.surfaces.enforcement
    const sellingAllowed = policy.surfaces.selling
    return decision(
      shadowOnly
        ? 'shadow'
        : sellingAllowed
          ? config.enforcementMode === 'off'
            ? 'enforcement_off'
            : 'selling_allowed'
          : 'rollout_surface_off',
      true,
      {
        ...policyEvidence,
        audience: 'qa',
        sellingAllowed,
        shadowOnly,
        copyEnabled: policy.surfaces.copy,
        analyticsEnabled: policy.surfaces.analytics,
        communicationsEnabled: policy.surfaces.communications,
      },
    )
  }
  if (qaUser) return decision('qa_user_separated', true, policyEvidence)

  const now = context.now ?? new Date()
  const createdAt = context.userCreatedAt
  const start = config.enforcementStartedAt
  const grandfatherEnd = config.legacyGrandfatherEndsAt
  if (
    !validDate(now) ||
    !validDate(createdAt) ||
    !validDate(start) ||
    !validDate(grandfatherEnd) ||
    !OBJECT_ID_PATTERN.test(userId)
  ) return decision('invalid_cohort_context', false, policyEvidence)
  if (now < start) {
    return decision('before_enforcement_start', false, policyEvidence)
  }
  if (createdAt > now) {
    return decision('invalid_cohort_context', false, policyEvidence)
  }
  if (
    config.enforcementMode === 'all' &&
    config.newUserRolloutPercent !== 100
  ) return decision('rollout_policy_invalid', false, policyEvidence)

  const bucket = cohortBucket({
    userId,
    catalogVersion: context.catalogVersion,
    policy,
  })
  const newUser = createdAt >= start
  const postGrandfather =
    !newUser && now >= grandfatherEnd &&
    config.enforcementMode === 'all'
  if (!newUser && !postGrandfather) {
    return decision('grandfathered', false, {
      ...policyEvidence,
      audience: 'public_control',
      cohortBucket: bucket,
    })
  }
  const included =
    bucket < config.newUserRolloutPercent * 100
  if (!included) {
    return decision('outside_cohort', false, {
      ...policyEvidence,
      audience: 'public_control',
      cohortBucket: bucket,
    })
  }

  const enforcementEnabled =
    policy.surfaces.enforcement &&
    (config.enforcementMode === 'all' ||
      (config.enforcementMode === 'new_users' && newUser))
  const sellingAllowed =
    config.sellingMode === 'all' &&
    policy.surfaces.selling &&
    enforcementEnabled
  const shadowOnly =
    policy.surfaces.enforcement && config.enforcementMode === 'shadow'
  const reason: BillingModeDecision['reason'] =
    enforcementEnabled
      ? 'enforcement_enabled'
      : shadowOnly
        ? 'shadow'
        : sellingAllowed
          ? config.enforcementMode === 'off'
            ? 'enforcement_off'
            : 'selling_allowed'
          : config.sellingMode === 'off'
            ? 'selling_off'
            : 'rollout_surface_off'
  return decision(reason, false, {
    ...policyEvidence,
    audience: 'public_treatment',
    cohortIncluded: true,
    cohortBucket: bucket,
    sellingAllowed,
    enforcementEnabled,
    shadowOnly,
    copyEnabled: policy.surfaces.copy,
    analyticsEnabled: policy.surfaces.analytics,
    communicationsEnabled: policy.surfaces.communications,
  })
}
