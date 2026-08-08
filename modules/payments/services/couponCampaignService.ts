import mongoose, { type ClientSession } from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { sha256CanonicalJson } from '../lib/canonicalJson'
import {
  buildCouponLifecycleTransition,
  couponLifecycleReplayDisposition,
  validateCouponLifecycleHistory,
  type CouponLifecycleTransition,
} from '../lib/couponLifecycleHistory'
import {
  CouponCampaign,
  type ICouponCampaign,
} from '../models/CouponCampaign'
import {
  CouponCampaignRevision,
  type ICouponCampaignRevision,
} from '../models/CouponCampaignRevision'
import {
  type PaymentBindingVerifier,
  unavailablePaymentBindingVerifier,
} from '../providers/bindingVerifier'
import type { CmsAuditActor } from '../types/admin'
import {
  COUPON_PROVIDER_VERIFICATION_MAX_AGE_MS,
  type CatalogApprovalSnapshot,
  type CatalogContent,
  type CouponCampaignMode,
  type CouponPolicyApprovalKind,
  type CouponPolicyApprovalSnapshot,
  type CouponRevisionStatus,
  type CouponRevisionTerms,
  type CouponValidationSnapshot,
  type ProviderMode,
  type ProviderVerificationSnapshot,
} from '../types/catalog'
import {
  CouponCatalogBoundActionSchema,
  CouponCodeSchema,
  CouponRevisionTermsSchema,
  CouponWorkflowActionSchema,
  CreateCouponCampaignSchema,
  UpdateCouponRevisionSchema,
  type CouponCatalogBoundActionInput,
  type CouponWorkflowActionInput,
  type CreateCouponCampaignInput,
  type UpdateCouponRevisionInput,
} from '../validators/coupon'
import {
  AdminMutationConflictError,
  AdminMutationValidationError,
  runAuditedMutation,
} from './adminAuditService'
import {
  validateCouponCampaignPolicy,
} from './couponValidation'
import {
  readCouponActivationGate,
  type CouponActivationGate,
} from './couponActivationGate'

export class CouponCampaignNotFoundError extends Error {
  constructor(message = 'Coupon campaign or revision not found') {
    super(message)
    this.name = 'CouponCampaignNotFoundError'
  }
}

export class CouponWorkflowError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CouponWorkflowError'
  }
}

export class CouponActivationBlockedError extends Error {
  readonly verification: ProviderVerificationSnapshot

  constructor(verification: ProviderVerificationSnapshot) {
    super(
      verification.errors.join('; ') ||
        'Coupon activation is blocked by provider verification',
    )
    this.name = 'CouponActivationBlockedError'
    this.verification = verification
  }
}

interface CouponCampaignDocumentShape {
  _id: mongoose.Types.ObjectId | string
  key: string
  name: string
  mode: CouponCampaignMode
  code?: string
  latestRevision: number
  createdBy: mongoose.Types.ObjectId | string
  createdAt: Date
  updatedAt: Date
}

interface CouponRevisionDocumentShape {
  _id: mongoose.Types.ObjectId | string
  campaignId: mongoose.Types.ObjectId | string
  revision: number
  status: CouponRevisionStatus
  editRevision: number
  terms: CouponRevisionTerms
  contentHash: string
  validation?: CouponValidationSnapshot
  approval?: CatalogApprovalSnapshot
  policyApprovals?: Partial<
    Record<CouponPolicyApprovalKind, CouponPolicyApprovalSnapshot>
  >
  providerVerification?: Partial<
    Record<ProviderMode, ProviderVerificationSnapshot>
  >
  lifecycleClaim?: 'live'
  lifecycleHistory?: CouponLifecycleTransition[]
  createdBy: mongoose.Types.ObjectId | string
  changeReason: string
  createdAt: Date
  updatedAt: Date
}

export interface CouponCampaignView {
  id: string
  key: string
  name: string
  mode: CouponCampaignMode
  code?: string
  latestRevision: number
  createdBy: string
  createdAt: Date
  updatedAt: Date
}

export interface CouponRevisionView {
  id: string
  campaignId: string
  revision: number
  status: CouponRevisionStatus
  editRevision: number
  terms: CouponRevisionTerms
  contentHash: string
  validation?: CouponValidationSnapshot
  approval?: CatalogApprovalSnapshot
  policyApprovals?: Partial<
    Record<CouponPolicyApprovalKind, CouponPolicyApprovalSnapshot>
  >
  providerVerification?: Partial<
    Record<ProviderMode, ProviderVerificationSnapshot>
  >
  lifecycleClaim?: 'live'
  lifecycleHistory: CouponLifecycleTransition[]
  createdBy: string
  changeReason: string
  createdAt: Date
  updatedAt: Date
}

export interface CouponCampaignRevisionView {
  campaign: CouponCampaignView
  revision: CouponRevisionView
}

export interface CouponCampaignDetailView {
  campaign: CouponCampaignView
  revisions: CouponRevisionView[]
}

function toCampaignView(
  campaign: CouponCampaignDocumentShape,
): CouponCampaignView {
  return {
    id: campaign._id.toString(),
    key: campaign.key,
    name: campaign.name,
    mode: campaign.mode,
    code: campaign.code,
    latestRevision: campaign.latestRevision,
    createdBy: campaign.createdBy.toString(),
    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt,
  }
}

function toRevisionView(
  revision: CouponRevisionDocumentShape,
): CouponRevisionView {
  return {
    id: revision._id.toString(),
    campaignId: revision.campaignId.toString(),
    revision: revision.revision,
    status: revision.status,
    editRevision: revision.editRevision,
    terms: revision.terms,
    contentHash: revision.contentHash,
    validation: revision.validation
      ? {
          ...revision.validation,
          validatedBy: revision.validation.validatedBy.toString(),
        }
      : undefined,
    approval: revision.approval
      ? {
          ...revision.approval,
          approvedBy: revision.approval.approvedBy.toString(),
        }
      : undefined,
    policyApprovals: revision.policyApprovals
      ? Object.fromEntries(
          Object.entries(revision.policyApprovals).map(([kind, approval]) => [
            kind,
            approval
              ? {
                  ...approval,
                  approvedBy: approval.approvedBy.toString(),
                }
              : undefined,
          ]),
        ) as CouponRevisionView['policyApprovals']
      : undefined,
    providerVerification: revision.providerVerification,
    lifecycleClaim: revision.lifecycleClaim,
    lifecycleHistory: (revision.lifecycleHistory ?? []).map(
      (transition) => ({
        ...transition,
        effectiveAt: new Date(transition.effectiveAt),
        recordedAt: new Date(transition.recordedAt),
        scheduledStartAt: transition.scheduledStartAt
          ? new Date(transition.scheduledStartAt)
          : null,
        scheduledEndAt: transition.scheduledEndAt
          ? new Date(transition.scheduledEndAt)
          : null,
      }),
    ),
    createdBy: revision.createdBy.toString(),
    changeReason: revision.changeReason,
    createdAt: revision.createdAt,
    updatedAt: revision.updatedAt,
  }
}

function couponTargetId(campaignId: string, revision: number): string {
  return `${campaignId}:${revision}`
}

function parseTerms(input: unknown): CouponRevisionTerms {
  const parsed = CouponRevisionTermsSchema.safeParse(input)
  if (!parsed.success) {
    throw new AdminMutationValidationError(
      parsed.error.issues
        .map(
          (issue) =>
            `${issue.path.join('.') || 'terms'}: ${issue.message}`,
        )
        .join('; '),
    )
  }
  return parsed.data as CouponRevisionTerms
}

function parseCreateRequest(
  input: CreateCouponCampaignInput,
): CreateCouponCampaignInput {
  const parsed = CreateCouponCampaignSchema.safeParse(input)
  if (!parsed.success) {
    throw new AdminMutationValidationError(
      parsed.error.issues.map((issue) => issue.message).join('; '),
    )
  }
  return parsed.data
}

function parseUpdateRequest(
  input: UpdateCouponRevisionInput,
): UpdateCouponRevisionInput {
  const parsed = UpdateCouponRevisionSchema.safeParse(input)
  if (!parsed.success) {
    throw new AdminMutationValidationError(
      parsed.error.issues.map((issue) => issue.message).join('; '),
    )
  }
  return parsed.data
}

function parseWorkflowRequest(
  input: CouponWorkflowActionInput,
): CouponWorkflowActionInput {
  const parsed = CouponWorkflowActionSchema.safeParse(input)
  if (!parsed.success) {
    throw new AdminMutationValidationError(
      parsed.error.issues.map((issue) => issue.message).join('; '),
    )
  }
  return parsed.data
}

function parseCatalogBoundRequest(
  input: CouponCatalogBoundActionInput,
): CouponCatalogBoundActionInput {
  const parsed = CouponCatalogBoundActionSchema.safeParse(input)
  if (!parsed.success) {
    throw new AdminMutationValidationError(
      parsed.error.issues.map((issue) => issue.message).join('; '),
    )
  }
  return parsed.data
}

async function findCampaignForMutation(
  campaignId: string,
  session: ClientSession,
): Promise<CouponCampaignDocumentShape> {
  const campaign = await CouponCampaign.findOne({ _id: campaignId })
    .session(session)
    .lean<CouponCampaignDocumentShape>()
  if (!campaign) {
    throw new CouponCampaignNotFoundError('Coupon campaign not found')
  }
  return campaign
}

async function findRevisionForMutation(
  campaignId: string,
  revision: number,
  session: ClientSession,
): Promise<CouponRevisionDocumentShape> {
  const document = await CouponCampaignRevision.findOne({
    campaignId,
    revision,
  })
    .session(session)
    .lean<CouponRevisionDocumentShape>()
  if (!document) {
    throw new CouponCampaignNotFoundError('Coupon revision not found')
  }
  return document
}

function requireExpectedEditRevision(
  revision: CouponRevisionDocumentShape,
  expectedEditRevision: number,
): void {
  if (revision.editRevision !== expectedEditRevision) {
    throw new AdminMutationConflictError(
      `Expected revision ${expectedEditRevision}, found ${revision.editRevision}`,
    )
  }
}

function requireDraft(
  revision: CouponRevisionDocumentShape,
  expectedEditRevision: number,
): void {
  if (revision.status !== 'draft') {
    throw new CouponWorkflowError(
      'Only a draft coupon revision can be changed',
    )
  }
  requireExpectedEditRevision(revision, expectedEditRevision)
}

function requirePolicyApprovals(
  revision: CouponRevisionDocumentShape,
  validation: CouponValidationSnapshot,
): void {
  if (!Array.isArray(validation.requiredPolicyApprovals)) {
    throw new CouponWorkflowError(
      'The coupon must be revalidated against a pinned catalog and provider mode',
    )
  }
  for (const kind of validation.requiredPolicyApprovals) {
    const approval = revision.policyApprovals?.[kind]
    if (
      !approval ||
      approval.kind !== kind ||
      approval.couponContentHash !== revision.contentHash ||
      approval.catalogVersion !== validation.catalogVersion ||
      approval.catalogContentHash !== validation.catalogContentHash ||
      approval.providerMode !== validation.providerMode
    ) {
      throw new CouponWorkflowError(
        kind === 'economics'
          ? 'The current coupon requires a valid unit-economics approval'
          : 'The current coupon requires a valid extended-cycle approval',
      )
    }
  }
}

function requireValidatedAndApproved(
  revision: CouponRevisionDocumentShape,
  binding?: {
    catalogVersion: string
    catalogContentHash: string
    providerMode: ProviderMode
  },
): void {
  if (
    !revision.validation ||
    revision.validation.contentHash !== revision.contentHash ||
    revision.validation.errors.length > 0
  ) {
    throw new CouponWorkflowError(
      'The current coupon terms must pass validation',
    )
  }
  if (
    binding &&
    (revision.validation.catalogVersion !== binding.catalogVersion ||
      revision.validation.catalogContentHash !== binding.catalogContentHash ||
      revision.validation.providerMode !== binding.providerMode)
  ) {
    throw new CouponWorkflowError(
      'Coupon validation does not match the selected catalog and provider mode',
    )
  }
  requirePolicyApprovals(revision, revision.validation)
  if (
    !revision.approval ||
    revision.approval.contentHash !== revision.contentHash
  ) {
    throw new CouponWorkflowError(
      'The current coupon terms must have a valid independent approval',
    )
  }
}

function requirePinnedValidation(
  revision: CouponRevisionDocumentShape,
  binding: {
    catalogVersion: string
    catalogContentHash: string
    providerMode: ProviderMode
  },
): CouponValidationSnapshot {
  if (
    !revision.validation ||
    revision.validation.contentHash !== revision.contentHash ||
    revision.validation.errors.length > 0 ||
    revision.validation.catalogVersion !== binding.catalogVersion ||
    revision.validation.catalogContentHash !== binding.catalogContentHash ||
    revision.validation.providerMode !== binding.providerMode
  ) {
    throw new CouponWorkflowError(
      'The current coupon must be validated against this catalog and provider mode',
    )
  }
  return revision.validation
}

function requireVerifiedProviderBinding(
  revision: CouponRevisionDocumentShape,
  providerMode: ProviderMode,
  now: Date,
): ProviderVerificationSnapshot {
  const verification = revision.providerVerification?.[providerMode]
  const fetchedAt = verification?.fetchedAt
  if (
    !verification ||
    verification.status !== 'verified' ||
    verification.normalizedTermsHash !== revision.contentHash ||
    verification.errors.length > 0 ||
    !(fetchedAt instanceof Date) ||
    !Number.isFinite(fetchedAt.getTime()) ||
    fetchedAt > now ||
    now.getTime() - fetchedAt.getTime() >
      COUPON_PROVIDER_VERIFICATION_MAX_AGE_MS
  ) {
    throw new CouponActivationBlockedError({
      status: verification?.status ?? 'unavailable',
      fetchedAt: verification?.fetchedAt ?? new Date(),
      normalizedTermsHash: verification?.normalizedTermsHash,
      errors: verification?.errors.length
        ? verification.errors
        : [
            'The selected provider mode needs a fresh verified coupon and catalog Plan binding',
          ],
    })
  }
  return verification
}

function requireConfirmation(
  request: CouponWorkflowActionInput,
  operation: 'ACTIVATE' | 'SCHEDULE' | 'PAUSE' | 'EXPIRE',
  campaignId: string,
  revision: number,
): void {
  const expected = `${operation} ${couponTargetId(campaignId, revision)}`
  if (request.confirmation !== expected) {
    throw new AdminMutationValidationError(
      `confirmation must exactly equal "${expected}"`,
    )
  }
}

function assertActivationDates(
  revision: CouponRevisionDocumentShape,
  targetStatus: 'active' | 'scheduled',
  now: Date,
): void {
  if (revision.terms.endsAt && revision.terms.endsAt <= now) {
    throw new CouponWorkflowError('An expired coupon cannot be activated')
  }
  if (targetStatus === 'scheduled') {
    if (!revision.terms.startsAt || revision.terms.startsAt <= now) {
      throw new AdminMutationValidationError(
        'A scheduled coupon requires a future startsAt',
      )
    }
  } else if (revision.terms.startsAt && revision.terms.startsAt > now) {
    throw new CouponWorkflowError(
      'A coupon cannot activate before startsAt; automatic scheduling is unavailable',
    )
  }
}

type LifecycleRequest = Pick<
  CouponWorkflowActionInput,
  'mutationId' | 'correlationId' | 'reason'
>

function internalLifecycleNow(testOnlyNow?: Date): Date {
  const value =
    process.env.NODE_ENV === 'test' && testOnlyNow
      ? testOnlyNow
      : new Date()
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new AdminMutationValidationError(
      'Coupon lifecycle clock is invalid',
    )
  }
  return new Date(value)
}

function exactLifecycleReplay(input: {
  revision: CouponRevisionDocumentShape
  actor: CmsAuditActor
  request: LifecycleRequest
  campaignId: string
  targetStatus: CouponRevisionStatus
}): CouponRevisionView | undefined {
  const history = validateCouponLifecycleHistory({
    campaignId: input.campaignId,
    revision: input.revision.revision,
    value: input.revision.lifecycleHistory ?? [],
    terms: input.revision.terms,
    currentStatus: input.revision.status,
    allowEmpty: true,
  })
  if (!history) {
    throw new CouponWorkflowError(
      'Coupon lifecycle history is malformed',
    )
  }
  const disposition = couponLifecycleReplayDisposition({
    campaignId: input.campaignId,
    revision: input.revision.revision,
    actor: input.actor,
    mutationId: input.request.mutationId,
    correlationId: input.request.correlationId,
    reason: input.request.reason,
    toStatus: input.targetStatus,
    terms: input.revision.terms,
    history,
    currentStatus: input.revision.status,
  })
  if (disposition === 'conflict') {
    throw new AdminMutationConflictError(
      'mutationId has conflicting coupon lifecycle evidence',
    )
  }
  return disposition === 'exact'
    ? toRevisionView(input.revision)
    : undefined
}

function lifecycleHistoryCas(
  history: readonly CouponLifecycleTransition[],
): Record<string, unknown> {
  const last = history.at(-1)
  return last
    ? {
        lifecycleHistory: { $size: history.length },
        [`lifecycleHistory.${history.length - 1}.transitionDigest`]:
          last.transitionDigest,
      }
    : {
        $or: [
          { lifecycleHistory: { $exists: false } },
          { lifecycleHistory: { $size: 0 } },
        ],
      }
}

function lifecycleTransition(input: {
  revision: CouponRevisionDocumentShape
  actor: CmsAuditActor
  request: LifecycleRequest
  campaignId: string
  targetStatus: CouponRevisionStatus
  recordedAt: Date
}): CouponLifecycleTransition {
  return buildCouponLifecycleTransition({
    campaignId: input.campaignId,
    revision: input.revision.revision,
    actor: input.actor,
    mutationId: input.request.mutationId,
    correlationId: input.request.correlationId,
    reason: input.request.reason,
    fromStatus: input.revision.status,
    toStatus: input.targetStatus,
    terms: input.revision.terms,
    history: input.revision.lifecycleHistory,
    recordedAt: input.recordedAt,
  })
}

export async function listCouponCampaigns(input: {
  mode?: CouponCampaignMode
  code?: string
  limit?: number
} = {}): Promise<CouponCampaignView[]> {
  await connectDB()
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100)
  const filter: {
    mode?: CouponCampaignMode
    code?: string
  } = {}
  if (input.mode) filter.mode = input.mode
  if (input.code) filter.code = input.code.trim().toUpperCase()

  const campaigns = await CouponCampaign.find(filter)
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean<CouponCampaignDocumentShape[]>()
  return campaigns.map(toCampaignView)
}

export async function getCouponCampaign(
  campaignId: string,
): Promise<CouponCampaignDetailView | null> {
  await connectDB()
  const campaign = await CouponCampaign.findOne({ _id: campaignId })
    .lean<CouponCampaignDocumentShape>()
  if (!campaign) return null

  const revisions = await CouponCampaignRevision.find({
    campaignId,
  })
    .sort({ revision: -1 })
    .lean<CouponRevisionDocumentShape[]>()
  return {
    campaign: toCampaignView(campaign),
    revisions: revisions.map(toRevisionView),
  }
}

export async function getCouponRevision(
  campaignId: string,
  revision: number,
): Promise<CouponRevisionView | null> {
  await connectDB()
  const document = await CouponCampaignRevision.findOne({
    campaignId,
    revision,
  }).lean<CouponRevisionDocumentShape>()
  return document ? toRevisionView(document) : null
}

export async function createCouponCampaign(input: {
  actor: CmsAuditActor
  request: CreateCouponCampaignInput
  requestId?: string
}): Promise<CouponCampaignRevisionView> {
  const request = parseCreateRequest(input.request)
  const terms = parseTerms(request.terms)
  const campaignId = new mongoose.Types.ObjectId()
  const revisionId = new mongoose.Types.ObjectId()
  const normalizedCode = request.code?.trim().toUpperCase()
  const contentHash = sha256CanonicalJson(terms)

  return runAuditedMutation({
    actor: input.actor,
    mutationId: request.mutationId,
    correlationId: request.correlationId,
    requestId: input.requestId,
    action: 'coupon_created',
    targetType: 'CouponCampaign',
    targetId: campaignId.toString(),
    reason: request.reason,
    mutate: async (session) => {
      const campaigns = await CouponCampaign.create([
        {
          _id: campaignId,
          key: request.key.trim().toLowerCase(),
          name: request.name.trim(),
          mode: request.mode,
          code: normalizedCode,
          latestRevision: 1,
          createdBy: new mongoose.Types.ObjectId(input.actor.userId),
        },
      ], { session })
      const revisions = await CouponCampaignRevision.create([
        {
          _id: revisionId,
          campaignId,
          revision: 1,
          status: 'draft',
          editRevision: 0,
          terms,
          contentHash,
          createdBy: new mongoose.Types.ObjectId(input.actor.userId),
          changeReason: request.reason,
        },
      ], { session })
      const after = {
        campaign: toCampaignView(
          campaigns[0].toObject() as unknown as CouponCampaignDocumentShape,
        ),
        revision: toRevisionView(
          revisions[0].toObject() as unknown as CouponRevisionDocumentShape,
        ),
      }
      return { after, result: after }
    },
  })
}

/**
 * Immutable or historical revisions are changed by creating a new draft under
 * the stable campaign identity. The campaign's optimistic latestRevision
 * claim and the unique (campaignId, revision) index make races fail closed.
 */
export async function createCouponDraftRevision(input: {
  actor: CmsAuditActor
  campaignId: string
  sourceRevision: number
  request: UpdateCouponRevisionInput
  requestId?: string
}): Promise<CouponCampaignRevisionView> {
  const request = parseUpdateRequest(input.request)
  const terms = parseTerms(request.terms)
  const contentHash = sha256CanonicalJson(terms)

  return runAuditedMutation({
    actor: input.actor,
    mutationId: request.mutationId,
    correlationId: request.correlationId,
    requestId: input.requestId,
    action: 'coupon_updated',
    targetType: 'CouponCampaign',
    targetId: input.campaignId,
    reason: request.reason,
    mutate: async (session) => {
      const campaign = await findCampaignForMutation(input.campaignId, session)
      const source = await findRevisionForMutation(
        input.campaignId,
        input.sourceRevision,
        session,
      )
      requireExpectedEditRevision(source, request.expectedEditRevision)

      const nextRevision = campaign.latestRevision + 1
      const claimedCampaign = await CouponCampaign.findOneAndUpdate(
        {
          _id: input.campaignId,
          latestRevision: campaign.latestRevision,
        },
        { $inc: { latestRevision: 1 } },
        { new: true, session },
      ).lean<CouponCampaignDocumentShape>()
      if (!claimedCampaign) {
        throw new AdminMutationConflictError(
          'Coupon campaign changed concurrently',
        )
      }

      const revisions = await CouponCampaignRevision.create([
        {
          campaignId: input.campaignId,
          revision: nextRevision,
          status: 'draft',
          editRevision: 0,
          terms,
          contentHash,
          createdBy: new mongoose.Types.ObjectId(input.actor.userId),
          changeReason: request.reason,
        },
      ], { session })
      const before = {
        campaign: toCampaignView(campaign),
        revision: toRevisionView(source),
      }
      const after = {
        campaign: toCampaignView(claimedCampaign),
        revision: toRevisionView(
          revisions[0].toObject() as unknown as CouponRevisionDocumentShape,
        ),
      }
      return { before, after, result: after }
    },
  })
}

export async function updateCouponDraftRevision(input: {
  actor: CmsAuditActor
  campaignId: string
  revision: number
  request: UpdateCouponRevisionInput
  requestId?: string
}): Promise<CouponRevisionView> {
  const request = parseUpdateRequest(input.request)
  const terms = parseTerms(request.terms)
  const contentHash = sha256CanonicalJson(terms)

  return runAuditedMutation({
    actor: input.actor,
    mutationId: request.mutationId,
    correlationId: request.correlationId,
    requestId: input.requestId,
    action: 'coupon_updated',
    targetType: 'CouponCampaignRevision',
    targetId: couponTargetId(input.campaignId, input.revision),
    reason: request.reason,
    mutate: async (session) => {
      const beforeDocument = await findRevisionForMutation(
        input.campaignId,
        input.revision,
        session,
      )
      requireDraft(beforeDocument, request.expectedEditRevision)
      const updated = await CouponCampaignRevision.findOneAndUpdate(
        {
          campaignId: input.campaignId,
          revision: input.revision,
          status: 'draft',
          editRevision: request.expectedEditRevision,
        },
        {
          $set: {
            terms,
            contentHash,
            changeReason: request.reason,
          },
          $unset: {
            validation: 1,
            approval: 1,
            policyApprovals: 1,
            providerVerification: 1,
          },
          $inc: { editRevision: 1 },
        },
        { new: true, session, runValidators: true },
      ).lean<CouponRevisionDocumentShape>()
      if (!updated) {
        throw new AdminMutationConflictError(
          'Coupon draft changed concurrently',
        )
      }
      const before = toRevisionView(beforeDocument)
      const after = toRevisionView(updated)
      return { before, after, result: after }
    },
  })
}

export async function validateCouponDraft(input: {
  actor: CmsAuditActor
  campaignId: string
  revision: number
  request: CouponCatalogBoundActionInput
  catalog: CatalogContent
  catalogContentHash: string
  requestId?: string
}): Promise<CouponRevisionView> {
  const request = parseCatalogBoundRequest(input.request)

  return runAuditedMutation({
    actor: input.actor,
    mutationId: request.mutationId,
    correlationId: request.correlationId,
    requestId: input.requestId,
    // The audit model's existing vocabulary has no coupon_validated action.
    action: 'coupon_updated',
    targetType: 'CouponCampaignRevision',
    targetId: couponTargetId(input.campaignId, input.revision),
    reason: request.reason,
    mutate: async (session) => {
      const campaign = await findCampaignForMutation(
        input.campaignId,
        session,
      )
      const beforeDocument = await findRevisionForMutation(
        input.campaignId,
        input.revision,
        session,
      )
      requireDraft(beforeDocument, request.expectedEditRevision)
      const validationResult = validateCouponCampaignPolicy(
        beforeDocument.terms,
        input.catalog,
        {
          campaignMode: campaign.mode,
          providerMode: request.providerMode,
          couponContentHash: beforeDocument.contentHash,
          catalogVersion: request.catalogVersion,
          catalogContentHash: input.catalogContentHash,
          policyApprovals: beforeDocument.policyApprovals,
          requireApprovals: false,
        },
      )
      const errors = [...validationResult.errors]
      const validation: CouponValidationSnapshot = {
        contentHash:
          validationResult.contentHash ?? beforeDocument.contentHash,
        errors,
        warnings: validationResult.warnings,
        validatedBy: input.actor.userId,
        validatedAt: new Date(),
        catalogVersion: request.catalogVersion,
        catalogContentHash: input.catalogContentHash,
        providerMode: request.providerMode,
        requiredPolicyApprovals:
          validationResult.requiredPolicyApprovals,
      }
      const updated = await CouponCampaignRevision.findOneAndUpdate(
        {
          campaignId: input.campaignId,
          revision: input.revision,
          status: 'draft',
          editRevision: request.expectedEditRevision,
          contentHash: beforeDocument.contentHash,
        },
        {
          $set: { validation },
          $unset: {
            approval: 1,
            policyApprovals: 1,
            providerVerification: 1,
          },
        },
        { new: true, session },
      ).lean<CouponRevisionDocumentShape>()
      if (!updated) {
        throw new AdminMutationConflictError(
          'Coupon draft changed concurrently',
        )
      }
      const before = toRevisionView(beforeDocument)
      const after = toRevisionView(updated)
      return { before, after, result: after }
    },
  })
}

export async function approveCouponDraft(input: {
  actor: CmsAuditActor
  campaignId: string
  revision: number
  request: CouponWorkflowActionInput
  requestId?: string
}): Promise<CouponRevisionView> {
  const request = parseWorkflowRequest(input.request)

  return runAuditedMutation({
    actor: input.actor,
    mutationId: request.mutationId,
    correlationId: request.correlationId,
    requestId: input.requestId,
    action: 'coupon_approved',
    targetType: 'CouponCampaignRevision',
    targetId: couponTargetId(input.campaignId, input.revision),
    reason: request.reason,
    mutate: async (session) => {
      const beforeDocument = await findRevisionForMutation(
        input.campaignId,
        input.revision,
        session,
      )
      requireDraft(beforeDocument, request.expectedEditRevision)
      if (beforeDocument.createdBy.toString() === input.actor.userId) {
        throw new CouponWorkflowError(
          'The coupon revision creator cannot approve their own draft',
        )
      }
      if (
        !beforeDocument.validation ||
        beforeDocument.validation.contentHash !== beforeDocument.contentHash ||
        beforeDocument.validation.errors.length > 0
      ) {
        throw new CouponWorkflowError(
          'The current coupon terms must pass validation before approval',
        )
      }
      requirePolicyApprovals(beforeDocument, beforeDocument.validation)
      const approval: CatalogApprovalSnapshot = {
        contentHash: beforeDocument.contentHash,
        approvedBy: input.actor.userId,
        approvedAt: new Date(),
      }
      const updated = await CouponCampaignRevision.findOneAndUpdate(
        {
          campaignId: input.campaignId,
          revision: input.revision,
          status: 'draft',
          editRevision: request.expectedEditRevision,
          contentHash: beforeDocument.contentHash,
        },
        { $set: { approval } },
        { new: true, session },
      ).lean<CouponRevisionDocumentShape>()
      if (!updated) {
        throw new AdminMutationConflictError(
          'Coupon draft changed concurrently',
        )
      }
      const before = toRevisionView(beforeDocument)
      const after = toRevisionView(updated)
      return { before, after, result: after }
    },
  })
}

interface CouponCatalogBinding {
  version: string
  contentHash: string
  content: CatalogContent
}

export async function approveCouponPolicy(input: {
  actor: CmsAuditActor
  campaignId: string
  revision: number
  kind: CouponPolicyApprovalKind
  request: CouponCatalogBoundActionInput
  catalog: CouponCatalogBinding
  requestId?: string
}): Promise<CouponRevisionView> {
  const request = parseCatalogBoundRequest(input.request)
  if (request.catalogVersion !== input.catalog.version) {
    throw new AdminMutationValidationError(
      'Catalog version does not match the loaded catalog',
    )
  }

  return runAuditedMutation({
    actor: input.actor,
    mutationId: request.mutationId,
    correlationId: request.correlationId,
    requestId: input.requestId,
    action: 'coupon_approved',
    targetType: `CouponPolicyApproval:${input.kind}`,
    targetId: couponTargetId(input.campaignId, input.revision),
    reason: request.reason,
    mutate: async (session) => {
      const beforeDocument = await findRevisionForMutation(
        input.campaignId,
        input.revision,
        session,
      )
      requireDraft(beforeDocument, request.expectedEditRevision)
      if (beforeDocument.createdBy.toString() === input.actor.userId) {
        throw new CouponWorkflowError(
          'The coupon revision creator cannot approve their own policy exception',
        )
      }
      const validation = requirePinnedValidation(beforeDocument, {
        catalogVersion: input.catalog.version,
        catalogContentHash: input.catalog.contentHash,
        providerMode: request.providerMode,
      })
      if (!validation.requiredPolicyApprovals.includes(input.kind)) {
        throw new CouponWorkflowError(
          `This coupon does not require a ${input.kind} approval`,
        )
      }
      if (beforeDocument.policyApprovals?.[input.kind]) {
        throw new AdminMutationConflictError(
          `The ${input.kind} approval has already been recorded`,
        )
      }

      const approval: CouponPolicyApprovalSnapshot = {
        kind: input.kind,
        couponContentHash: beforeDocument.contentHash,
        catalogVersion: input.catalog.version,
        catalogContentHash: input.catalog.contentHash,
        providerMode: request.providerMode,
        approvedBy: input.actor.userId,
        approvedAt: new Date(),
        reason: request.reason,
      }
      const approvalPath = `policyApprovals.${input.kind}`
      const updated = await CouponCampaignRevision.findOneAndUpdate(
        {
          campaignId: input.campaignId,
          revision: input.revision,
          status: 'draft',
          editRevision: request.expectedEditRevision,
          contentHash: beforeDocument.contentHash,
          [approvalPath]: { $exists: false },
        },
        { $set: { [approvalPath]: approval } },
        { new: true, session },
      ).lean<CouponRevisionDocumentShape>()
      if (!updated) {
        throw new AdminMutationConflictError(
          'Coupon policy approval changed concurrently',
        )
      }
      return {
        before: toRevisionView(beforeDocument),
        after: toRevisionView(updated),
        result: toRevisionView(updated),
      }
    },
  })
}

export async function verifyCouponProviderBinding(input: {
  actor: CmsAuditActor
  campaignId: string
  revision: number
  request: CouponCatalogBoundActionInput
  catalog: CouponCatalogBinding
  requestId?: string
  verifier?: PaymentBindingVerifier
}): Promise<CouponRevisionView> {
  const request = parseCatalogBoundRequest(input.request)
  if (request.catalogVersion !== input.catalog.version) {
    throw new AdminMutationValidationError(
      'Catalog version does not match the loaded catalog',
    )
  }

  await connectDB()
  const current = await CouponCampaignRevision.findOne({
    campaignId: input.campaignId,
    revision: input.revision,
  }).lean<CouponRevisionDocumentShape>()
  if (!current) {
    throw new CouponCampaignNotFoundError('Coupon revision not found')
  }
  current.status === 'scheduled' || current.status === 'paused'
    ? requireExpectedEditRevision(current, request.expectedEditRevision)
    : requireDraft(current, request.expectedEditRevision)
  requirePinnedValidation(current, {
    catalogVersion: input.catalog.version,
    catalogContentHash: input.catalog.contentHash,
    providerMode: request.providerMode,
  })
  if (
    sha256CanonicalJson(input.catalog.content) !== input.catalog.contentHash
  ) {
    throw new CouponWorkflowError(
      'Loaded catalog content does not match its canonical hash',
    )
  }
  const applicablePlanIds = current.terms.applicablePlanKeys.flatMap(
    (planKey) => {
      const planId = input.catalog.content.plans[planKey]
        .razorpayPlanIdByMode?.[request.providerMode]
      return planId ? [planId] : []
    },
  )

  const verification = await (
    input.verifier ?? unavailablePaymentBindingVerifier
  ).verifyCoupon({
    mode: request.providerMode,
    terms: current.terms,
    contentHash: current.contentHash,
    catalogContentHash: input.catalog.contentHash,
    applicablePlanIds,
  })
  if (
    verification.status !== 'verified' ||
    verification.normalizedTermsHash !== current.contentHash ||
    verification.errors.length > 0
  ) {
    throw new CouponActivationBlockedError({
      ...verification,
      status:
        verification.status === 'verified' ? 'failed' : verification.status,
      errors: verification.errors.length
        ? verification.errors
        : [
            'Coupon verification did not bind the current coupon hash and catalog Plans',
          ],
    })
  }

  return runAuditedMutation({
    actor: input.actor,
    mutationId: request.mutationId,
    correlationId: request.correlationId,
    requestId: input.requestId,
    action: 'coupon_updated',
    targetType: 'CouponProviderVerification',
    targetId: couponTargetId(input.campaignId, input.revision),
    reason: request.reason,
    mutate: async (session) => {
      const beforeDocument = await findRevisionForMutation(
        input.campaignId,
        input.revision,
        session,
      )
      beforeDocument.status === 'scheduled' || beforeDocument.status === 'paused'
        ? requireExpectedEditRevision(
            beforeDocument,
            request.expectedEditRevision,
          )
        : requireDraft(beforeDocument, request.expectedEditRevision)
      requirePinnedValidation(beforeDocument, {
        catalogVersion: input.catalog.version,
        catalogContentHash: input.catalog.contentHash,
        providerMode: request.providerMode,
      })
      if (beforeDocument.contentHash !== current.contentHash) {
        throw new AdminMutationConflictError(
          'Coupon terms changed during provider verification',
        )
      }
      const verificationPath =
        `providerVerification.${request.providerMode}`
      const updated = await CouponCampaignRevision.findOneAndUpdate(
        {
          campaignId: input.campaignId,
          revision: input.revision,
          status: beforeDocument.status,
          editRevision: request.expectedEditRevision,
          contentHash: current.contentHash,
        },
        { $set: { [verificationPath]: verification } },
        { new: true, session },
      ).lean<CouponRevisionDocumentShape>()
      if (!updated) {
        throw new AdminMutationConflictError(
          'Coupon terms changed during provider verification',
        )
      }
      return {
        before: toRevisionView(beforeDocument),
        after: toRevisionView(updated),
        result: toRevisionView(updated),
      }
    },
  })
}

async function activateOrScheduleCoupon(input: {
  actor: CmsAuditActor
  campaignId: string
  revision: number
  request: CouponCatalogBoundActionInput
  catalog: CatalogContent
  catalogContentHash: string
  requestId?: string
  activationGate?: CouponActivationGate
  now?: Date
  targetStatus: 'active' | 'scheduled'
}): Promise<CouponRevisionView> {
  const request = parseCatalogBoundRequest(input.request)
  const operation = input.targetStatus === 'active' ? 'ACTIVATE' : 'SCHEDULE'
  requireConfirmation(
    request,
    operation,
    input.campaignId,
    input.revision,
  )
  const mode = request.providerMode
  const now = internalLifecycleNow(input.now)
  await connectDB()
  const current = await CouponCampaignRevision.findOne({
    campaignId: input.campaignId,
    revision: input.revision,
  }).lean<CouponRevisionDocumentShape>()
  if (current) {
    const replay = exactLifecycleReplay({
      revision: current,
      actor: input.actor,
      request,
      campaignId: input.campaignId,
      targetStatus: input.targetStatus,
    })
    if (replay) return replay
  }
  const activationGate = input.targetStatus === 'active' &&
    (input.activationGate ?? await readCouponActivationGate())
  if (activationGate && !activationGate.pr5Ready) {
    throw new CouponActivationBlockedError({
      status: 'unavailable',
      fetchedAt: now,
      errors: [
        'Coupon activation remains disabled until the PR5 quote and reservation path is ready',
      ],
    })
  }
  if (activationGate && activationGate.couponMode === 'off') {
    throw new CouponActivationBlockedError({
      status: 'unavailable',
      fetchedAt: now,
      errors: ['Coupon activation is disabled by BillingConfig.couponMode'],
    })
  }
  const campaign = await CouponCampaign.findOne({
    _id: input.campaignId,
  }).lean<CouponCampaignDocumentShape>()
  if (!campaign || !current) {
    throw new CouponCampaignNotFoundError('Coupon revision not found')
  }
  if (
    campaign.mode === 'code' &&
    !CouponCodeSchema.safeParse(campaign.code).success
  ) {
    throw new CouponActivationBlockedError({
      status: 'unavailable',
      fetchedAt: now,
      errors: ['The stored coupon code is not customer-redeemable'],
    })
  }
  if (
    current.terms.eligibility.acquisitionSources.length > 0 ||
    current.terms.eligibility.segments.some((segment) => segment !== 'all')
  ) {
    throw new CouponActivationBlockedError({
      status: 'unavailable',
      fetchedAt: now,
      errors: [
        'Segment and acquisition-source coupons require a server-owned eligibility resolver',
      ],
    })
  }
  const allowedStatuses: CouponRevisionStatus[] =
    input.targetStatus === 'active'
      ? ['draft', 'scheduled', 'paused']
      : ['draft', 'paused']
  if (!allowedStatuses.includes(current.status)) {
    throw new CouponWorkflowError(
      `A ${current.status} coupon cannot transition to ${input.targetStatus}`,
    )
  }
  requireExpectedEditRevision(current, request.expectedEditRevision)
  const binding = {
    catalogVersion: request.catalogVersion,
    catalogContentHash: input.catalogContentHash,
    providerMode: mode,
  }
  requireValidatedAndApproved(current, binding)
  requireVerifiedProviderBinding(current, mode, now)
  const validation = validateCouponCampaignPolicy(
    current.terms,
    input.catalog,
    {
      campaignMode: campaign.mode,
      providerMode: mode,
      couponContentHash: current.contentHash,
      catalogVersion: request.catalogVersion,
      catalogContentHash: input.catalogContentHash,
      policyApprovals: current.policyApprovals,
      requireApprovals: true,
    },
  )
  if (!validation.valid || validation.contentHash !== current.contentHash) {
    throw new CouponWorkflowError(
      validation.errors.join('; ') ||
        'The current coupon terms no longer pass validation',
    )
  }
  assertActivationDates(current, input.targetStatus, now)

  return runAuditedMutation({
    actor: input.actor,
    mutationId: request.mutationId,
    correlationId: request.correlationId,
    requestId: input.requestId,
    action: 'coupon_activated',
    targetType: 'CouponCampaignRevision',
    targetId: couponTargetId(input.campaignId, input.revision),
    reason: request.reason,
    mutate: async (session) => {
      const beforeDocument = await findRevisionForMutation(
        input.campaignId,
        input.revision,
        session,
      )
      if (!allowedStatuses.includes(beforeDocument.status)) {
        throw new CouponWorkflowError(
          `A ${beforeDocument.status} coupon cannot transition to ${input.targetStatus}`,
        )
      }
      requireExpectedEditRevision(
        beforeDocument,
        request.expectedEditRevision,
      )
      requireValidatedAndApproved(beforeDocument, binding)
      requireVerifiedProviderBinding(beforeDocument, mode, now)
      if (beforeDocument.contentHash !== current.contentHash) {
        throw new AdminMutationConflictError(
          'Coupon terms changed during activation',
        )
      }

      const history = beforeDocument.lifecycleHistory ?? []
      const transition = lifecycleTransition({
        revision: beforeDocument,
        actor: input.actor,
        request,
        campaignId: input.campaignId,
        targetStatus: input.targetStatus,
        recordedAt: internalLifecycleNow(input.now),
      })
      const set: Record<string, unknown> = {
        status: input.targetStatus,
        lifecycleClaim: 'live',
      }
      const updated = await CouponCampaignRevision.findOneAndUpdate(
        {
          campaignId: input.campaignId,
          revision: input.revision,
          status: beforeDocument.status,
          editRevision: request.expectedEditRevision,
          contentHash: current.contentHash,
          ...lifecycleHistoryCas(history),
        },
        {
          $set: set,
          $push: { lifecycleHistory: transition },
        },
        { new: true, session, runValidators: true },
      ).lean<CouponRevisionDocumentShape>()
      if (!updated) {
        throw new AdminMutationConflictError(
          'Coupon lifecycle changed concurrently',
        )
      }
      const before = toRevisionView(beforeDocument)
      const after = toRevisionView(updated)
      return { before, after, result: after }
    },
  })
}

export function activateCouponRevision(input: {
  actor: CmsAuditActor
  campaignId: string
  revision: number
  request: CouponCatalogBoundActionInput
  catalog: CatalogContent
  catalogContentHash: string
  requestId?: string
  activationGate?: CouponActivationGate
  now?: Date
}): Promise<CouponRevisionView> {
  return activateOrScheduleCoupon({ ...input, targetStatus: 'active' })
}

export function scheduleCouponRevision(input: {
  actor: CmsAuditActor
  campaignId: string
  revision: number
  request: CouponCatalogBoundActionInput
  catalog: CatalogContent
  catalogContentHash: string
  requestId?: string
  activationGate?: CouponActivationGate
  now?: Date
}): Promise<CouponRevisionView> {
  return activateOrScheduleCoupon({ ...input, targetStatus: 'scheduled' })
}

async function endCouponLifecycle(input: {
  actor: CmsAuditActor
  campaignId: string
  revision: number
  request: CouponWorkflowActionInput
  requestId?: string
  targetStatus: 'paused' | 'expired'
}): Promise<CouponRevisionView> {
  const request = parseWorkflowRequest(input.request)
  requireConfirmation(
    request,
    input.targetStatus === 'paused' ? 'PAUSE' : 'EXPIRE',
    input.campaignId,
    input.revision,
  )

  await connectDB()
  const current = await CouponCampaignRevision.findOne({
    campaignId: input.campaignId,
    revision: input.revision,
  }).lean<CouponRevisionDocumentShape>()
  if (!current) {
    throw new CouponCampaignNotFoundError('Coupon revision not found')
  }
  const replay = exactLifecycleReplay({
    revision: current,
    actor: input.actor,
    request,
    campaignId: input.campaignId,
    targetStatus: input.targetStatus,
  })
  if (replay) return replay

  return runAuditedMutation({
    actor: input.actor,
    mutationId: request.mutationId,
    correlationId: request.correlationId,
    requestId: input.requestId,
    action:
      input.targetStatus === 'paused' ? 'coupon_paused' : 'coupon_expired',
    targetType: 'CouponCampaignRevision',
    targetId: couponTargetId(input.campaignId, input.revision),
    reason: request.reason,
    mutate: async (session) => {
      const beforeDocument = await findRevisionForMutation(
        input.campaignId,
        input.revision,
        session,
      )
      requireExpectedEditRevision(
        beforeDocument,
        request.expectedEditRevision,
      )
      const allowedStatuses: CouponRevisionStatus[] =
        input.targetStatus === 'paused'
          ? ['scheduled', 'active']
          : ['scheduled', 'active', 'paused']
      if (!allowedStatuses.includes(beforeDocument.status)) {
        throw new CouponWorkflowError(
          `A ${beforeDocument.status} coupon cannot transition to ${input.targetStatus}`,
        )
      }
      const history = beforeDocument.lifecycleHistory ?? []
      const transition = lifecycleTransition({
        revision: beforeDocument,
        actor: input.actor,
        request,
        campaignId: input.campaignId,
        targetStatus: input.targetStatus,
        recordedAt: internalLifecycleNow(),
      })
      const updated = await CouponCampaignRevision.findOneAndUpdate(
        {
          campaignId: input.campaignId,
          revision: input.revision,
          status: beforeDocument.status,
          editRevision: request.expectedEditRevision,
          ...lifecycleHistoryCas(history),
        },
        {
          $set: { status: input.targetStatus },
          $unset: { lifecycleClaim: 1 },
          $push: { lifecycleHistory: transition },
        },
        { new: true, session, runValidators: true },
      ).lean<CouponRevisionDocumentShape>()
      if (!updated) {
        throw new AdminMutationConflictError(
          'Coupon lifecycle changed concurrently',
        )
      }
      const before = toRevisionView(beforeDocument)
      const after = toRevisionView(updated)
      return { before, after, result: after }
    },
  })
}

export function pauseCouponRevision(input: {
  actor: CmsAuditActor
  campaignId: string
  revision: number
  request: CouponWorkflowActionInput
  requestId?: string
}): Promise<CouponRevisionView> {
  return endCouponLifecycle({ ...input, targetStatus: 'paused' })
}

export function expireCouponRevision(input: {
  actor: CmsAuditActor
  campaignId: string
  revision: number
  request: CouponWorkflowActionInput
  requestId?: string
}): Promise<CouponRevisionView> {
  return endCouponLifecycle({ ...input, targetStatus: 'expired' })
}

export type {
  ICouponCampaign,
  ICouponCampaignRevision,
}
