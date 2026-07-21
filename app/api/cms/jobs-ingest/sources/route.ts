import { NextResponse } from 'next/server'
import { z } from 'zod'
import { logger } from '@shared/logger'
import { requireCurrentPlatformAdmin } from '@jobs/services/adminAuth'
import { checkJobsRateLimit } from '@jobs/services/rateLimit'
import {
  operateJobSource,
  SourceOperationError,
  type SourceOperationCommand,
} from '@jobs/services/sourceOperations'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const sourceIdSchema = z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9:_-]*$/)
const operationIdSchema = z.string().uuid()
const reasonSchema = z.string().trim().min(8).max(1000)

const settingsSchema = z.object({
  cadenceMinutes: z.number().int().min(15).max(10_080).optional(),
  minIndiaPostings: z.number().int().min(0).max(100_000).nullable().optional(),
  perRunRequestCap: z.number().int().min(0).max(100_000).optional(),
  dailyRequestCap: z.number().int().min(0).max(100_000).optional(),
  monthlyRequestCap: z.number().int().min(0).max(1_000_000).optional(),
  llmVerdictOptOut: z.boolean().optional(),
  notes: z.string().trim().max(2000).optional(),
}).strict().refine((settings) => Object.keys(settings).length > 0, {
  message: 'at least one setting is required',
})

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('bootstrap') }).strict(),
  z.object({
    action: z.enum(['enable', 'pause', 'validate']),
    sourceId: sourceIdSchema,
    expectedControlRevision: z.number().int().nonnegative(),
    expectedOperationalRevision: z.number().int().nonnegative(),
    reason: reasonSchema,
  }).strict(),
  z.object({
    action: z.literal('run-now'),
    sourceId: sourceIdSchema,
    expectedControlRevision: z.number().int().nonnegative(),
    expectedOperationalRevision: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    action: z.literal('update-settings'),
    sourceId: sourceIdSchema,
    expectedControlRevision: z.number().int().nonnegative(),
    expectedOperationalRevision: z.number().int().nonnegative(),
    reason: reasonSchema,
    settings: settingsSchema,
  }).strict(),
])

interface OperationFailureShape {
  status?: number
  code?: string
  retryable?: boolean
  currentControlRevision?: number
  currentOperationalRevision?: number
  message?: string
}

/**
 * POST /api/cms/jobs-ingest/sources
 *
 * One strict, idempotent command surface for operational source actions.
 * Legal revoke/restore deliberately remain on the separately audited
 * `/api/jobs/admin/source-control` contract.
 */
export async function POST(req: Request) {
  const startedAt = Date.now()
  const authorization = await requireCurrentPlatformAdmin({
    beforeAuthorityLookup: (actorUserId) => checkJobsRateLimit(actorUserId, 'admin-command'),
  })
  if (!authorization.ok) {
    if (authorization.response) return authorization.response
    if (authorization.cause) {
      logger.error({
        error: authorization.cause,
        actorUserId: authorization.actorUserId,
        durationMs: Date.now() - startedAt,
      }, 'jobs operations authorization lookup failed')
    }
    return NextResponse.json({
      error: authorization.error,
      code: authorization.code,
      retryable: authorization.status === 503,
    }, { status: authorization.status })
  }

  const operationId = req.headers.get('idempotency-key')
  const parsedOperationId = operationIdSchema.safeParse(operationId)
  if (!parsedOperationId.success) {
    return NextResponse.json({
      error: 'a UUID Idempotency-Key header is required',
      code: 'INVALID_IDEMPOTENCY_KEY',
    }, { status: 400 })
  }

  let input: unknown
  try {
    input = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON', code: 'INVALID_JSON' }, { status: 400 })
  }
  const parsed = bodySchema.safeParse(input)
  if (!parsed.success) {
    return NextResponse.json({
      error: 'invalid source operation',
      code: 'INVALID_SOURCE_OPERATION',
      issues: parsed.error.issues,
    }, { status: 400 })
  }

  const command = {
    ...parsed.data,
    operationId: parsedOperationId.data,
    actorUserId: authorization.actorUserId,
  } as SourceOperationCommand

  try {
    const result = await operateJobSource(command)
    logger.info({
      action: parsed.data.action,
      sourceId: 'sourceId' in parsed.data ? parsed.data.sourceId : undefined,
      operationId: parsedOperationId.data,
      durationMs: Date.now() - startedAt,
      idempotent: result.idempotent,
    }, 'jobs source operation accepted')
    const queued = parsed.data.action === 'run-now' || parsed.data.action === 'validate'
    return NextResponse.json({ ok: true, queued, result }, { status: queued ? 202 : 200 })
  } catch (error) {
    if (error instanceof SourceOperationError) {
      const known = error as SourceOperationError & OperationFailureShape
      const status = Number.isInteger(known.status) && (known.status as number) >= 400 && (known.status as number) <= 599
        ? known.status as number
        : 409
      const retryable = known.retryable ?? (status === 429 || status === 503)
      const response = {
        error: known.message || 'source operation failed',
        code: known.code || 'SOURCE_OPERATION_REJECTED',
        retryable,
        ...(known.currentControlRevision == null
          ? {}
          : { currentControlRevision: known.currentControlRevision }),
        ...(known.currentOperationalRevision == null
          ? {}
          : { currentOperationalRevision: known.currentOperationalRevision }),
      }
      const fields = {
        error,
        action: parsed.data.action,
        sourceId: 'sourceId' in parsed.data ? parsed.data.sourceId : undefined,
        operationId: parsedOperationId.data,
        durationMs: Date.now() - startedAt,
      }
      if (status >= 500) logger.error(fields, 'jobs source operation unavailable')
      else logger.warn(fields, 'jobs source operation rejected')
      return NextResponse.json(response, { status })
    }

    logger.error({
      error,
      action: parsed.data.action,
      sourceId: 'sourceId' in parsed.data ? parsed.data.sourceId : undefined,
      operationId: parsedOperationId.data,
      durationMs: Date.now() - startedAt,
    }, 'jobs source operation failed')
    return NextResponse.json({
      error: 'source operation failed',
      code: 'SOURCE_OPERATION_FAILED',
      retryable: false,
    }, { status: 500 })
  }
}
