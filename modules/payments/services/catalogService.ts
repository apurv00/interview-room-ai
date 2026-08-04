import { randomBytes } from 'node:crypto'
import mongoose, { type ClientSession } from 'mongoose'
import { connectDB } from '@shared/db/connection'
import { BillingConfig } from '../models/BillingConfig'
import { PlanCatalogVersion } from '../models/PlanCatalogVersion'
import { sha256CanonicalJson } from '../lib/canonicalJson'
import type {
  CatalogContent,
  CatalogStatus,
  ProviderMode,
  ProviderVerificationSnapshot,
} from '../types/catalog'
import type {
  CatalogWorkflowActionInput,
  CreateCatalogDraftInput,
  UpdateCatalogDraftInput,
} from '../validators/catalog'
import type { CmsAuditActor } from '../types/admin'
import {
  AdminMutationConflictError,
  AdminMutationValidationError,
  runAuditedMutation,
} from './adminAuditService'
import {
  buildInitialCatalogContent,
  validateCatalogContent,
} from './catalogValidation'
import {
  type PaymentBindingVerifier,
  unavailablePaymentBindingVerifier,
} from '../providers/bindingVerifier'

export class CatalogNotFoundError extends Error {
  constructor() {
    super('Catalog version not found')
    this.name = 'CatalogNotFoundError'
  }
}

export class CatalogWorkflowError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CatalogWorkflowError'
  }
}

export class CatalogPublicationBlockedError extends Error {
  readonly verification: ProviderVerificationSnapshot

  constructor(verification: ProviderVerificationSnapshot) {
    super(verification.errors.join('; ') || 'Catalog publication is blocked')
    this.name = 'CatalogPublicationBlockedError'
    this.verification = verification
  }
}

interface CatalogDocumentShape {
  version: string
  status: CatalogStatus
  editRevision: number
  effectiveAt?: Date
  content: CatalogContent
  contentHash: string
  validation?: {
    contentHash: string
    errors: string[]
    warnings: string[]
    validatedBy: mongoose.Types.ObjectId | string
    validatedAt: Date
  }
  approval?: {
    contentHash: string
    approvedBy: mongoose.Types.ObjectId | string
    approvedAt: Date
  }
  providerVerification?: Partial<
    Record<ProviderMode, ProviderVerificationSnapshot>
  >
  sourceVersion?: string
  createdBy: mongoose.Types.ObjectId | string
  publishedBy?: mongoose.Types.ObjectId | string
  changeReason: string
  publishedAt?: Date
  createdAt: Date
  updatedAt: Date
}

interface ActiveCatalogConfigShape {
  revision: number
  activeCatalogVersion?: string
}

export interface CatalogVersionView {
  version: string
  status: CatalogStatus
  editRevision: number
  effectiveAt?: Date
  content: CatalogContent
  contentHash: string
  validation?: {
    contentHash: string
    errors: string[]
    warnings: string[]
    validatedBy: string
    validatedAt: Date
  }
  approval?: {
    contentHash: string
    approvedBy: string
    approvedAt: Date
  }
  providerVerification?: Partial<
    Record<ProviderMode, ProviderVerificationSnapshot>
  >
  sourceVersion?: string
  createdBy: string
  publishedBy?: string
  changeReason: string
  publishedAt?: Date
  createdAt: Date
  updatedAt: Date
}

function toCatalogView(document: CatalogDocumentShape): CatalogVersionView {
  return {
    ...document,
    createdBy: document.createdBy.toString(),
    publishedBy: document.publishedBy?.toString(),
    validation: document.validation
      ? {
          ...document.validation,
          validatedBy: document.validation.validatedBy.toString(),
        }
      : undefined,
    approval: document.approval
      ? {
          ...document.approval,
          approvedBy: document.approval.approvedBy.toString(),
        }
      : undefined,
  }
}

function catalogVersionId(now = new Date()): string {
  const timestamp = now.toISOString().replaceAll(/[-:.TZ]/g, '').slice(0, 14)
  return `consumer-inr-${timestamp}-${randomBytes(4).toString('hex')}`
}

async function findCatalogForMutation(
  version: string,
  session: ClientSession,
): Promise<CatalogDocumentShape> {
  const document = await PlanCatalogVersion.findOne({ version })
    .session(session)
    .lean<CatalogDocumentShape>()
  if (!document) throw new CatalogNotFoundError()
  return document
}

function requireDraft(
  catalog: CatalogDocumentShape,
  expectedRevision: number,
): void {
  if (catalog.status !== 'draft') {
    throw new CatalogWorkflowError('Only a draft catalog can be changed')
  }
  if (catalog.editRevision !== expectedRevision) {
    throw new AdminMutationConflictError(
      `Expected revision ${expectedRevision}, found ${catalog.editRevision}`,
    )
  }
}

function requireValidatedAndApproved(catalog: CatalogDocumentShape): void {
  if (
    !catalog.validation ||
    catalog.validation.contentHash !== catalog.contentHash ||
    catalog.validation.errors.length > 0
  ) {
    throw new CatalogWorkflowError(
      'The current catalog content must pass validation',
    )
  }
  if (
    !catalog.approval ||
    catalog.approval.contentHash !== catalog.contentHash
  ) {
    throw new CatalogWorkflowError(
      'The current catalog content must have a valid independent approval',
    )
  }
}

async function promoteActiveCatalogPointer(input: {
  version: string
  actorUserId: string
  session: ClientSession
}): Promise<{ before?: string; after: string }> {
  const existing = await BillingConfig.findOne({ key: 'singleton' })
    .session(input.session)
    .lean<ActiveCatalogConfigShape>()
  const actorId = new mongoose.Types.ObjectId(input.actorUserId)
  if (!existing) {
    await BillingConfig.create([{
      key: 'singleton',
      revision: 1,
      activeCatalogVersion: input.version,
      updatedBy: actorId,
    }], { session: input.session })
    return { after: input.version }
  }

  const updated = await BillingConfig.findOneAndUpdate(
    {
      key: 'singleton',
      revision: existing.revision,
    },
    {
      $set: {
        activeCatalogVersion: input.version,
        updatedBy: actorId,
      },
      $inc: { revision: 1 },
    },
    {
      new: true,
      runValidators: true,
      session: input.session,
    },
  ).lean<ActiveCatalogConfigShape>()
  if (!updated || updated.activeCatalogVersion !== input.version) {
    throw new AdminMutationConflictError(
      'Active catalog pointer changed concurrently',
    )
  }
  return {
    before: existing.activeCatalogVersion,
    after: input.version,
  }
}

export async function listCatalogVersions(input: {
  status?: CatalogStatus
  limit?: number
} = {}): Promise<CatalogVersionView[]> {
  await connectDB()
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100)
  const rows = await PlanCatalogVersion.find(
    input.status ? { status: input.status } : {},
  )
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean<CatalogDocumentShape[]>()
  return rows.map(toCatalogView)
}

export async function getCatalogVersion(
  version: string,
): Promise<CatalogVersionView | null> {
  await connectDB()
  const row = await PlanCatalogVersion.findOne({ version })
    .lean<CatalogDocumentShape>()
  return row ? toCatalogView(row) : null
}

export async function createCatalogDraft(input: {
  actor: CmsAuditActor
  request: CreateCatalogDraftInput
  requestId?: string
}): Promise<CatalogVersionView> {
  const validated = validateCatalogContent(
    input.request.content ?? buildInitialCatalogContent(),
  )
  if (!validated.valid || !validated.content || !validated.contentHash) {
    throw new AdminMutationValidationError(validated.errors.join('; '))
  }
  const version = catalogVersionId()

  return runAuditedMutation({
    actor: input.actor,
    mutationId: input.request.mutationId,
    correlationId: input.request.correlationId,
    requestId: input.requestId,
    action: 'catalog_draft_created',
    targetType: 'PlanCatalogVersion',
    targetId: version,
    reason: input.request.reason,
    mutate: async (session) => {
      const created = await PlanCatalogVersion.create([
        {
          version,
          status: 'draft',
          editRevision: 0,
          content: validated.content,
          contentHash: validated.contentHash,
          sourceVersion: input.request.sourceVersion,
          createdBy: new mongoose.Types.ObjectId(input.actor.userId),
          changeReason: input.request.reason,
        },
      ], { session })
      const after = toCatalogView(
        created[0].toObject() as unknown as CatalogDocumentShape,
      )
      return { after, result: after }
    },
  })
}

export async function updateCatalogDraft(input: {
  actor: CmsAuditActor
  version: string
  request: UpdateCatalogDraftInput
  requestId?: string
}): Promise<CatalogVersionView> {
  const validated = validateCatalogContent(input.request.content)
  if (!validated.valid || !validated.content || !validated.contentHash) {
    throw new AdminMutationValidationError(validated.errors.join('; '))
  }

  return runAuditedMutation({
    actor: input.actor,
    mutationId: input.request.mutationId,
    correlationId: input.request.correlationId,
    requestId: input.requestId,
    action: 'catalog_draft_updated',
    targetType: 'PlanCatalogVersion',
    targetId: input.version,
    reason: input.request.reason,
    mutate: async (session) => {
      const beforeDocument = await findCatalogForMutation(input.version, session)
      requireDraft(beforeDocument, input.request.expectedRevision)
      const updated = await PlanCatalogVersion.findOneAndUpdate(
        {
          version: input.version,
          status: 'draft',
          editRevision: input.request.expectedRevision,
        },
        {
          $set: {
            content: validated.content,
            contentHash: validated.contentHash,
            changeReason: input.request.reason,
          },
          $unset: {
            validation: 1,
            approval: 1,
            providerVerification: 1,
          },
          $inc: { editRevision: 1 },
        },
        { new: true, session, runValidators: true },
      ).lean<CatalogDocumentShape>()
      if (!updated) {
        throw new AdminMutationConflictError(
          'Catalog draft changed concurrently',
        )
      }
      const before = toCatalogView(beforeDocument)
      const after = toCatalogView(updated)
      return { before, after, result: after }
    },
  })
}

export async function validateCatalogDraft(input: {
  actor: CmsAuditActor
  version: string
  request: CatalogWorkflowActionInput
  requestId?: string
}): Promise<CatalogVersionView> {
  return runAuditedMutation({
    actor: input.actor,
    mutationId: input.request.mutationId,
    correlationId: input.request.correlationId,
    requestId: input.requestId,
    action: 'catalog_validated',
    targetType: 'PlanCatalogVersion',
    targetId: input.version,
    reason: input.request.reason,
    mutate: async (session) => {
      const beforeDocument = await findCatalogForMutation(input.version, session)
      requireDraft(beforeDocument, input.request.expectedRevision)
      const validation = validateCatalogContent(beforeDocument.content)
      const snapshot = {
        contentHash: beforeDocument.contentHash,
        errors: validation.errors,
        warnings: validation.warnings,
        validatedBy: new mongoose.Types.ObjectId(input.actor.userId),
        validatedAt: new Date(),
      }
      const updated = await PlanCatalogVersion.findOneAndUpdate(
        {
          version: input.version,
          status: 'draft',
          editRevision: input.request.expectedRevision,
        },
        { $set: { validation: snapshot }, $unset: { approval: 1 } },
        { new: true, session },
      ).lean<CatalogDocumentShape>()
      if (!updated) {
        throw new AdminMutationConflictError(
          'Catalog draft changed concurrently',
        )
      }
      const before = toCatalogView(beforeDocument)
      const after = toCatalogView(updated)
      return { before, after, result: after }
    },
  })
}

export async function approveCatalogDraft(input: {
  actor: CmsAuditActor
  version: string
  request: CatalogWorkflowActionInput
  requestId?: string
}): Promise<CatalogVersionView> {
  return runAuditedMutation({
    actor: input.actor,
    mutationId: input.request.mutationId,
    correlationId: input.request.correlationId,
    requestId: input.requestId,
    action: 'catalog_approved',
    targetType: 'PlanCatalogVersion',
    targetId: input.version,
    reason: input.request.reason,
    mutate: async (session) => {
      const beforeDocument = await findCatalogForMutation(input.version, session)
      requireDraft(beforeDocument, input.request.expectedRevision)
      if (beforeDocument.createdBy.toString() === input.actor.userId) {
        throw new CatalogWorkflowError(
          'The catalog creator cannot approve their own draft',
        )
      }
      if (
        !beforeDocument.validation ||
        beforeDocument.validation.contentHash !== beforeDocument.contentHash ||
        beforeDocument.validation.errors.length > 0
      ) {
        throw new CatalogWorkflowError(
          'The current catalog content must pass validation before approval',
        )
      }
      const approval = {
        contentHash: beforeDocument.contentHash,
        approvedBy: new mongoose.Types.ObjectId(input.actor.userId),
        approvedAt: new Date(),
      }
      const updated = await PlanCatalogVersion.findOneAndUpdate(
        {
          version: input.version,
          status: 'draft',
          editRevision: input.request.expectedRevision,
        },
        { $set: { approval } },
        { new: true, session },
      ).lean<CatalogDocumentShape>()
      if (!updated) {
        throw new AdminMutationConflictError(
          'Catalog draft changed concurrently',
        )
      }
      const before = toCatalogView(beforeDocument)
      const after = toCatalogView(updated)
      return { before, after, result: after }
    },
  })
}

async function publishOrScheduleCatalog(input: {
  actor: CmsAuditActor
  version: string
  request: CatalogWorkflowActionInput
  requestId?: string
  targetStatus: 'published' | 'scheduled'
  verifier?: PaymentBindingVerifier
}): Promise<CatalogVersionView> {
  const expectedConfirmation = input.targetStatus === 'published'
    ? `PUBLISH ${input.version}`
    : `SCHEDULE ${input.version}`
  if (input.request.confirmation !== expectedConfirmation) {
    throw new AdminMutationValidationError(
      `confirmation must exactly equal "${expectedConfirmation}"`,
    )
  }
  if (input.targetStatus === 'scheduled' && (!input.request.effectiveAt || input.request.effectiveAt <= new Date())) {
    throw new AdminMutationValidationError(
      'effectiveAt must be in the future to schedule a catalog',
    )
  }
  const mode = input.request.providerMode ?? 'test'
  await connectDB()
  const current = await PlanCatalogVersion.findOne({ version: input.version })
    .lean<CatalogDocumentShape>()
  if (!current) throw new CatalogNotFoundError()
  requireDraft(current, input.request.expectedRevision)
  requireValidatedAndApproved(current)

  const verification = await (
    input.verifier ?? unavailablePaymentBindingVerifier
  ).verifyCatalog({
    mode,
    content: current.content,
    contentHash: current.contentHash,
  })
  if (
    verification.status !== 'verified' ||
    verification.normalizedTermsHash !== current.contentHash ||
    verification.errors.length > 0
  ) {
    throw new CatalogPublicationBlockedError({
      ...verification,
      status:
        verification.status === 'verified' ? 'failed' : verification.status,
      errors: verification.errors.length
        ? verification.errors
        : [
            'Razorpay Plan verification did not bind the current catalog hash',
          ],
    })
  }
  return runAuditedMutation({
    actor: input.actor,
    mutationId: input.request.mutationId,
    correlationId: input.request.correlationId,
    requestId: input.requestId,
    action: 'catalog_published',
    targetType: 'PlanCatalogVersion',
    targetId: input.version,
    reason: input.request.reason,
    mutate: async (session) => {
      const beforeDocument = await findCatalogForMutation(input.version, session)
      requireDraft(beforeDocument, input.request.expectedRevision)
      requireValidatedAndApproved(beforeDocument)
      if (beforeDocument.contentHash !== current.contentHash) {
        throw new AdminMutationConflictError(
          'Catalog content changed during provider verification',
        )
      }
      const publishedAt = input.targetStatus === 'published'
        ? new Date()
        : undefined
      const updated = await PlanCatalogVersion.findOneAndUpdate(
        {
          version: input.version,
          status: 'draft',
          editRevision: input.request.expectedRevision,
          contentHash: current.contentHash,
        },
        {
          $set: {
            status: input.targetStatus,
            effectiveAt: input.request.effectiveAt,
            [`providerVerification.${mode}`]: verification,
            publishedBy: new mongoose.Types.ObjectId(input.actor.userId),
            ...(publishedAt && { publishedAt }),
          },
        },
        { new: true, session },
      ).lean<CatalogDocumentShape>()
      if (!updated) {
        throw new AdminMutationConflictError(
          'Catalog changed during publication',
        )
      }
      const before = toCatalogView(beforeDocument)
      const after = toCatalogView(updated)
      const pointer = publishedAt
        ? await promoteActiveCatalogPointer({
            version: input.version,
            actorUserId: input.actor.userId,
            session,
          })
        : undefined
      return {
        before: pointer
          ? {
              catalog: before,
              activeCatalogVersion: pointer.before,
            }
          : before,
        after: pointer
          ? {
              catalog: after,
              activeCatalogVersion: pointer.after,
            }
          : after,
        result: after,
      }
    },
  })
}

export function publishCatalog(input: {
  actor: CmsAuditActor
  version: string
  request: CatalogWorkflowActionInput
  requestId?: string
  verifier?: PaymentBindingVerifier
}): Promise<CatalogVersionView> {
  return publishOrScheduleCatalog({ ...input, targetStatus: 'published' })
}

export function scheduleCatalog(input: {
  actor: CmsAuditActor
  version: string
  request: CatalogWorkflowActionInput
  requestId?: string
  verifier?: PaymentBindingVerifier
}): Promise<CatalogVersionView> {
  return publishOrScheduleCatalog({ ...input, targetStatus: 'scheduled' })
}

export async function cloneCatalogToDraft(input: {
  actor: CmsAuditActor
  version: string
  mutationId: string
  correlationId: string
  reason: string
  requestId?: string
}): Promise<CatalogVersionView> {
  const source = await getCatalogVersion(input.version)
  if (!source) throw new CatalogNotFoundError()
  return createCatalogDraft({
    actor: input.actor,
    request: {
      mutationId: input.mutationId,
      correlationId: input.correlationId,
      reason: input.reason,
      content: source.content,
      sourceVersion: source.version,
    },
    requestId: input.requestId,
  })
}

export async function archiveCatalog(input: {
  actor: CmsAuditActor
  version: string
  request: CatalogWorkflowActionInput
  requestId?: string
}): Promise<CatalogVersionView> {
  if (input.request.confirmation !== `ARCHIVE ${input.version}`) {
    throw new AdminMutationValidationError(
      `confirmation must exactly equal "ARCHIVE ${input.version}"`,
    )
  }
  return runAuditedMutation({
    actor: input.actor,
    mutationId: input.request.mutationId,
    correlationId: input.request.correlationId,
    requestId: input.requestId,
    action: 'catalog_archived',
    targetType: 'PlanCatalogVersion',
    targetId: input.version,
    reason: input.request.reason,
    mutate: async (session) => {
      const beforeDocument = await findCatalogForMutation(input.version, session)
      if (beforeDocument.status !== 'published') {
        throw new CatalogWorkflowError(
          'Only a published catalog can be archived',
        )
      }
      const updated = await PlanCatalogVersion.findOneAndUpdate(
        { version: input.version, status: 'published' },
        { $set: { status: 'archived' } },
        { new: true, session },
      ).lean<CatalogDocumentShape>()
      if (!updated) {
        throw new AdminMutationConflictError(
          'Catalog changed during archive',
        )
      }
      const before = toCatalogView(beforeDocument)
      const after = toCatalogView(updated)
      return { before, after, result: after }
    },
  })
}

export function calculateCatalogContentHash(content: CatalogContent): string {
  return sha256CanonicalJson(content)
}
