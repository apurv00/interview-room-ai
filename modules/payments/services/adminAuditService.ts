import mongoose, { type ClientSession } from 'mongoose'
import { connectDB } from '@shared/db/connection'
import {
  AdminAuditLog,
  type AdminAuditAction,
} from '../models/AdminAuditLog'
import type { CmsAuditActor } from '../types/admin'
import { canonicalJson } from '../lib/canonicalJson'

const REDACTED = '[REDACTED]'
const SENSITIVE_KEY =
  /(?:password|secret|signature|api.?key|raw.?payload|authorization|token|cookie|cvv|card.?number)/i
const MAX_OPERATION_ID_LENGTH = 200

export class AdminMutationConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AdminMutationConflictError'
  }
}

export class AdminMutationValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AdminMutationValidationError'
  }
}

function redactSnapshot(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSnapshot)
  if (!value || typeof value !== 'object') return value
  if (value instanceof Date) return value.toISOString()
  if (value instanceof mongoose.Types.ObjectId) return value.toString()
  const output: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactSnapshot(nested)
  }
  return output
}

function normalizeOperationId(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new AdminMutationValidationError(`${field} is required`)
  }
  const normalized = value.trim()
  if (!normalized) {
    throw new AdminMutationValidationError(`${field} is required`)
  }
  if (normalized.length > MAX_OPERATION_ID_LENGTH) {
    throw new AdminMutationValidationError(
      `${field} must not exceed ${MAX_OPERATION_ID_LENGTH} characters`,
    )
  }
  return normalized
}

function isDuplicateKeyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  if ('code' in error && error.code === 11000) return true
  return 'cause' in error && isDuplicateKeyError(error.cause)
}

export interface AuditedMutationResult<T> {
  before?: unknown
  after?: unknown
  result: T
}

export interface RunAuditedMutationInput<T> {
  actor: CmsAuditActor
  mutationId: string
  correlationId: string
  requestId?: string
  action: AdminAuditAction
  targetType: string
  targetId: string
  reason: string
  mutate: (session: ClientSession) => Promise<AuditedMutationResult<T>>
}

export interface AppendAdminAuditInSessionInput {
  actor: CmsAuditActor
  mutationId: string
  correlationId: string
  requestId?: string
  action: AdminAuditAction
  targetType: string
  targetId: string
  reason: string
  before?: unknown
  after?: unknown
}

/**
 * Appends or exactly replays one audit inside a caller-owned transaction.
 * This is reserved for financial finalizers that must atomically persist the
 * domain effect, audit evidence, and financial-operation finalization.
 */
export async function appendAdminAuditInSession(
  input: AppendAdminAuditInSessionInput,
  session: ClientSession,
): Promise<{ readonly reused: boolean }> {
  if (!session?.inTransaction()) {
    throw new AdminMutationValidationError(
      'An active transaction is required for an audit append',
    )
  }
  const reason =
    typeof input.reason === 'string' ? input.reason.trim() : ''
  if (reason.length < 10 || reason.length > 2000) {
    throw new AdminMutationValidationError(
      'An audit reason between 10 and 2000 characters is required',
    )
  }
  const mutationId = normalizeOperationId(
    input.mutationId,
    'mutationId',
  )
  const correlationId = normalizeOperationId(
    input.correlationId,
    'correlationId',
  )
  const expected = {
    mutationId,
    actorUserId: input.actor.userId,
    actorEmailSnapshot: input.actor.email,
    actorRoleSnapshot: input.actor.role,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    reason,
    beforeSnapshot: redactSnapshot(input.before),
    afterSnapshot: redactSnapshot(input.after),
    correlationId,
    requestId: input.requestId,
  }
  const existing = await AdminAuditLog.findOne({ mutationId })
    .select(
      'mutationId actorUserId actorEmailSnapshot actorRoleSnapshot ' +
      'action targetType targetId reason beforeSnapshot afterSnapshot ' +
      'correlationId requestId',
    )
    .session(session)
    .lean<{
      mutationId: string
      actorUserId: mongoose.Types.ObjectId
      actorEmailSnapshot: string
      actorRoleSnapshot: string
      action: AdminAuditAction
      targetType: string
      targetId: string
      reason: string
      beforeSnapshot?: unknown
      afterSnapshot?: unknown
      correlationId: string
      requestId?: string
    }>()
    .exec()
  if (existing) {
    const actual = {
      ...existing,
      actorUserId: existing.actorUserId.toString(),
    }
    if (
      canonicalJson(actual) !==
      canonicalJson(expected)
    ) {
      throw new AdminMutationConflictError(
        'mutationId has already been used for different audit evidence',
      )
    }
    return Object.freeze({ reused: true })
  }
  await AdminAuditLog.create([expected], { session })
  return Object.freeze({ reused: false })
}

export interface AdminAuditListInput {
  cursor?: string
  limit?: number
  action?: AdminAuditAction
  targetType?: string
  actorUserId?: string
}

export interface AdminAuditListItem {
  id: string
  mutationId: string
  actorUserId: string
  actorEmailSnapshot: string
  actorRoleSnapshot: string
  action: AdminAuditAction
  targetType: string
  targetId: string
  reason: string
  beforeSnapshot?: unknown
  afterSnapshot?: unknown
  correlationId: string
  requestId?: string
  createdAt: Date
}

export interface AdminAuditListPage {
  items: AdminAuditListItem[]
  nextCursor?: string
}

/**
 * Cursor-paginated audit reader for the billing CMS. Audit documents are
 * append-only, so descending ObjectId order is stable and avoids skip()
 * degradation as the collection grows.
 */
export async function listAdminAuditLogs(
  input: AdminAuditListInput = {},
): Promise<AdminAuditListPage> {
  await connectDB()
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100)
  const filter: {
    _id?: { $lt: mongoose.Types.ObjectId }
    action?: AdminAuditAction
    targetType?: string
    actorUserId?: mongoose.Types.ObjectId
  } = {}

  if (input.cursor) {
    filter._id = { $lt: new mongoose.Types.ObjectId(input.cursor) }
  }
  if (input.action) filter.action = input.action
  if (input.targetType) filter.targetType = input.targetType
  if (input.actorUserId) {
    filter.actorUserId = new mongoose.Types.ObjectId(input.actorUserId)
  }

  const documents = await AdminAuditLog.find(filter)
    .sort({ _id: -1 })
    .limit(limit + 1)
    .lean()
  const hasMore = documents.length > limit
  const page = documents.slice(0, limit)

  return {
    items: page.map((document) => ({
      id: document._id.toString(),
      mutationId: document.mutationId,
      actorUserId: document.actorUserId.toString(),
      actorEmailSnapshot: document.actorEmailSnapshot,
      actorRoleSnapshot: document.actorRoleSnapshot,
      action: document.action,
      targetType: document.targetType,
      targetId: document.targetId,
      reason: document.reason,
      beforeSnapshot: document.beforeSnapshot,
      afterSnapshot: document.afterSnapshot,
      correlationId: document.correlationId,
      requestId: document.requestId,
      createdAt: document.createdAt,
    })),
    nextCursor: hasMore ? page.at(-1)?._id.toString() : undefined,
  }
}

/**
 * The domain write and append-only audit row share one Mongo transaction.
 * Deployments without transaction support must fail the mutation; silently
 * degrading to a best-effort financial audit is not allowed.
 */
export async function runAuditedMutation<T>(
  input: RunAuditedMutationInput<T>,
): Promise<T> {
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  if (reason.length < 10 || reason.length > 2000) {
    throw new AdminMutationValidationError(
      'An audit reason between 10 and 2000 characters is required',
    )
  }
  const mutationId = normalizeOperationId(input.mutationId, 'mutationId')
  const correlationId = normalizeOperationId(
    input.correlationId,
    'correlationId',
  )

  await connectDB()
  const dbSession = await mongoose.startSession()
  let result: T | undefined
  let auditCreated = false

  try {
    try {
      await dbSession.withTransaction(async () => {
        // withTransaction may retry the callback after transient errors. Reset
        // the completion state so a prior aborted attempt cannot look successful.
        auditCreated = false
        result = undefined

        const duplicate = await AdminAuditLog.exists({
          mutationId,
        }).session(dbSession)
        if (duplicate) {
          throw new AdminMutationConflictError(
            'mutationId has already been used',
          )
        }

        const mutation = await input.mutate(dbSession)
        await AdminAuditLog.create([
          {
            mutationId,
            actorUserId: input.actor.userId,
            actorEmailSnapshot: input.actor.email,
            actorRoleSnapshot: input.actor.role,
            action: input.action,
            targetType: input.targetType,
            targetId: input.targetId,
            reason,
            beforeSnapshot: redactSnapshot(mutation.before),
            afterSnapshot: redactSnapshot(mutation.after),
            correlationId,
            requestId: input.requestId,
          },
        ], { session: dbSession })

        // Do not expose the domain result until the corresponding audit insert
        // has succeeded in the same transaction callback.
        result = mutation.result
        auditCreated = true
      })
    } catch (error) {
      if (
        error instanceof AdminMutationConflictError ||
        error instanceof AdminMutationValidationError
      ) {
        throw error
      }
      if (isDuplicateKeyError(error)) {
        throw new AdminMutationConflictError(
          'The mutation conflicts with a concurrently created record',
        )
      }
      throw error
    }
  } finally {
    await dbSession.endSession()
  }

  if (!auditCreated || result === undefined) {
    throw new Error('Audited mutation transaction did not commit')
  }
  return result
}
