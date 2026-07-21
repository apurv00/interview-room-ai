import { NextResponse } from 'next/server'
import { z } from 'zod'
import { inngest } from '@shared/services/inngest'
import { requireCurrentPlatformAdmin } from '@jobs/services/adminAuth'
import { checkJobsRateLimit } from '@jobs/services/rateLimit'
import { operateJobSource, SourceOperationError } from '@jobs/services/sourceOperations'

export const dynamic = 'force-dynamic'

const operationIdSchema = z.string().uuid()
const sourceRunSchema = z.object({
  mode: z.literal('sync').optional(),
  sourceId: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9:_-]*$/),
  expectedControlRevision: z.number().int().nonnegative(),
  expectedOperationalRevision: z.number().int().nonnegative(),
}).strict()
const verdictSweepSchema = z.object({
  mode: z.literal('verdict-sweep'),
  limit: z.number().positive().max(10_000).transform(Math.floor).optional(),
}).strict()

/**
 * POST /api/jobs/admin/sync — legacy break-glass dispatcher.
 *
 * Source runs now delegate to the same idempotent, revision-bound, permanently
 * audited operation as the CMS. Routine operators use `/cms/jobs-ingest`.
 * The verdict-sweep branch remains a separate bounded subsystem command.
 */
export async function POST(req: Request) {
  const authorization = await requireCurrentPlatformAdmin({
    beforeAuthorityLookup: async (actorUserId) => {
      const limited = await checkJobsRateLimit(actorUserId, 'admin-command')
      return limited
    },
  })
  if (!authorization.ok) {
    if (authorization.response) return authorization.response
    return NextResponse.json({
      error: authorization.error,
      code: authorization.code,
      retryable: authorization.status === 503,
    }, { status: authorization.status })
  }

  let input: unknown
  try {
    input = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON', code: 'INVALID_JSON' }, { status: 400 })
  }

  const verdictSweep = verdictSweepSchema.safeParse(input)
  if (verdictSweep.success) {
    await inngest.send({
      name: 'jobs/verdict.sweep',
      data: { limit: verdictSweep.data.limit },
    })
    return NextResponse.json({ dispatched: 'verdict-sweep' })
  }

  const sourceRun = sourceRunSchema.safeParse(input)
  if (!sourceRun.success) {
    return NextResponse.json({
      error: 'source sync requires sourceId and both current revisions',
      code: 'INVALID_SOURCE_SYNC',
      issues: sourceRun.error.issues,
    }, { status: 400 })
  }

  const operationId = operationIdSchema.safeParse(req.headers.get('idempotency-key'))
  if (!operationId.success) {
    return NextResponse.json({
      error: 'a UUID Idempotency-Key header is required',
      code: 'INVALID_IDEMPOTENCY_KEY',
    }, { status: 400 })
  }

  try {
    const result = await operateJobSource({
      operationId: operationId.data,
      actorUserId: authorization.actorUserId,
      action: 'run-now',
      sourceId: sourceRun.data.sourceId,
      expectedControlRevision: sourceRun.data.expectedControlRevision,
      expectedOperationalRevision: sourceRun.data.expectedOperationalRevision,
    })
    return NextResponse.json({ ok: true, queued: true, result }, { status: 202 })
  } catch (error) {
    if (error instanceof SourceOperationError) {
      return NextResponse.json({
        error: error.message,
        code: error.code,
        retryable: error.status === 503,
        ...(error.currentControlRevision == null
          ? {}
          : { currentControlRevision: error.currentControlRevision }),
        ...(error.currentOperationalRevision == null
          ? {}
          : { currentOperationalRevision: error.currentOperationalRevision }),
      }, { status: error.status })
    }
    return NextResponse.json({
      error: 'source operation failed',
      code: 'SOURCE_OPERATION_FAILED',
      retryable: false,
    }, { status: 500 })
  }
}
