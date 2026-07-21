import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { z } from 'zod'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { User } from '@shared/db/models'
import { logger } from '@shared/logger'
import { checkJobsRateLimit } from '@jobs/services/rateLimit'
import {
  controlJobSource,
  SourceControlCapacityError,
  SourceControlConflictError,
  SourceControlIntegrityError,
  SourceLineageMigrationRequiredError,
  SourceControlNotFoundError,
  SourceTransactionsRequiredError,
} from '@jobs/services/sourceControl'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const bodySchema = z.object({
  sourceId: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9:_-]*$/),
  action: z.enum(['revoke', 'restore']),
  expectedRevision: z.number().int().nonnegative(),
  reason: z.string().trim().min(8).max(1000),
}).strict()

const operationIdSchema = z.string().uuid()
const actorIdSchema = z.string().regex(/^[a-f\d]{24}$/i)

/**
 * POST /api/jobs/admin/source-control
 *
 * Minimal A02 legal-control primitive. The broader enable/pause/quota/CMS
 * control plane remains A08. The role is re-read from Mongo because NextAuth
 * JWT roles are sign-in snapshots and a demoted admin token can be stale.
 */
export async function POST(req: Request) {
  const startedAt = Date.now()
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'platform_admin required' }, { status: 401 })
  }

  const actorUserId = (session.user as { id?: string }).id
  if (!actorUserId || !actorIdSchema.safeParse(actorUserId).success) {
    return NextResponse.json({ error: 'platform_admin required' }, { status: 403 })
  }
  const rateLimitBlock = await checkJobsRateLimit(actorUserId, 'admin-command')
  if (rateLimitBlock) return rateLimitBlock

  let currentAdmin: unknown
  try {
    await connectDB()
    currentAdmin = await User.findOne({ _id: actorUserId, role: 'platform_admin' }).select('_id').lean()
  } catch (error) {
    logger.error({
      error,
      actorUserId,
      durationMs: Date.now() - startedAt,
    }, 'jobs source-control authorization lookup failed')
    return NextResponse.json({
      error: 'source-control authorization unavailable',
      code: 'AUTHORITY_UNAVAILABLE',
    }, { status: 503 })
  }
  if (!currentAdmin) {
    return NextResponse.json({ error: 'platform_admin required' }, { status: 403 })
  }

  let input: unknown
  try {
    input = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 })
  }
  const parsed = bodySchema.safeParse(input)
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid source-control request', issues: parsed.error.issues }, { status: 400 })
  }

  const operationId = req.headers.get('idempotency-key')
  const parsedOperationId = operationIdSchema.safeParse(operationId)
  if (!parsedOperationId.success) {
    return NextResponse.json({ error: 'a UUID Idempotency-Key header is required' }, { status: 400 })
  }

  try {
    const result = await controlJobSource({
      ...parsed.data,
      operationId: parsedOperationId.data,
      actorUserId,
    })
    logger.info({
      sourceId: result.sourceId,
      action: result.action,
      operationId: result.operationId,
      revision: result.revision,
      affectedPostings: result.affectedPostings,
      unknownLineagePostings: result.unknownLineagePostings,
      idempotent: result.idempotent,
      durationMs: Date.now() - startedAt,
    }, 'jobs source-control transition committed')
    return NextResponse.json({ ok: true, result })
  } catch (error) {
    if (error instanceof SourceControlNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 })
    }
    if (error instanceof SourceControlConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 })
    }
    if (error instanceof SourceControlIntegrityError) {
      logger.error({
        error,
        sourceId: parsed.data.sourceId,
        action: parsed.data.action,
        operationId: parsedOperationId.data,
        durationMs: Date.now() - startedAt,
      }, 'jobs source-control transition blocked by integrity failure')
      return NextResponse.json({
        error: error.message,
        code: 'SOURCE_CONTROL_INTEGRITY',
      }, { status: 503 })
    }
    if (
      error instanceof SourceTransactionsRequiredError ||
      error instanceof SourceLineageMigrationRequiredError ||
      error instanceof SourceControlCapacityError
    ) {
      logger.warn({
        error,
        sourceId: parsed.data.sourceId,
        action: parsed.data.action,
        operationId: parsedOperationId.data,
        durationMs: Date.now() - startedAt,
      }, 'jobs source-control transition blocked by deployment invariant')
      return NextResponse.json({
        error: error.message,
        code: 'SOURCE_CONTROL_UNAVAILABLE',
      }, { status: 503 })
    }
    logger.error({ error, sourceId: parsed.data.sourceId, action: parsed.data.action }, 'jobs source-control transition failed')
    return NextResponse.json({ error: 'source-control transition failed' }, { status: 500 })
  }
}
