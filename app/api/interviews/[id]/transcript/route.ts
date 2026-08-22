import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import mongoose from 'mongoose'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { InterviewSession } from '@shared/db/models'
import { canViewSession } from '@shared/auth/permissions'
import { AppError } from '@shared/errors'
import { logger } from '@shared/logger'
import {
  activeJobsAccountIds,
  isJobsAccountActive,
} from '@shared/services/jobsAccountFence'

export const dynamic = 'force-dynamic'

function accountUnavailable() {
  return NextResponse.json(
    { error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' },
    { status: 401 },
  )
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  let requesterUserId: string | undefined
  try {
    if (!mongoose.Types.ObjectId.isValid(params.id)) {
      return NextResponse.json({ error: 'Invalid session ID format' }, { status: 400 })
    }

    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    requesterUserId = session.user.id

    await connectDB()
    if (!(await isJobsAccountActive(session.user.id))) {
      return accountUnavailable()
    }

    const interviewSession = await InterviewSession.findById(params.id)
      .select('userId organizationId transcript')
      .lean()

    if (!interviewSession) {
      if (!(await isJobsAccountActive(requesterUserId))) {
        return accountUnavailable()
      }
      return NextResponse.json({ error: 'Interview session not found' }, { status: 404 })
    }

    if (!canViewSession(
      { userId: interviewSession.userId.toString(), organizationId: interviewSession.organizationId?.toString() },
      { id: session.user.id, role: session.user.role, organizationId: session.user.organizationId }
    )) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const ownerId = interviewSession.userId.toString()
    const isOwner = ownerId === session.user.id
    if (!isOwner && !(await isJobsAccountActive(ownerId))) {
      return NextResponse.json({ error: 'Interview session not found' }, { status: 404 })
    }

    // Re-check immediately before disclosure so a stale JWT cannot release a
    // captured transcript after deletion moved either account out of active.
    const finalActiveAccountIds = await activeJobsAccountIds(
      isOwner ? [session.user.id] : [session.user.id, ownerId],
    )
    if (!finalActiveAccountIds.has(session.user.id)) {
      return accountUnavailable()
    }
    if (!isOwner && !finalActiveAccountIds.has(ownerId)) {
      return NextResponse.json({ error: 'Interview session not found' }, { status: 404 })
    }

    return NextResponse.json({ transcript: interviewSession.transcript || [] })
  } catch (err) {
    if (requesterUserId) {
      try {
        if (!(await isJobsAccountActive(requesterUserId))) {
          return accountUnavailable()
        }
      } catch {
        // Preserve the original route error when the diagnostic recheck fails.
      }
    }
    if (err instanceof AppError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.statusCode })
    }
    logger.error({ err, sessionId: params.id }, 'Failed to get transcript')
    return NextResponse.json({ error: 'Failed to get transcript' }, { status: 500 })
  }
}
