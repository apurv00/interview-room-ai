import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import mongoose from 'mongoose'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { InterviewSession } from '@shared/db/models'
import { canViewSession } from '@shared/auth/permissions'
import { AppError, NotFoundError, ForbiddenError } from '@shared/errors'
import { logger } from '@shared/logger'

export const dynamic = 'force-dynamic'

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    if (!mongoose.Types.ObjectId.isValid(params.id)) {
      return NextResponse.json({ error: 'Invalid session ID format' }, { status: 400 })
    }

    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    await connectDB()

    const interviewSession = await InterviewSession.findById(params.id)
      .select('userId organizationId transcript')
      .lean()

    if (!interviewSession) {
      return NextResponse.json({ error: 'Interview session not found' }, { status: 404 })
    }

    if (!canViewSession(
      { userId: interviewSession.userId.toString(), organizationId: interviewSession.organizationId?.toString() },
      { id: session.user.id, role: session.user.role, organizationId: session.user.organizationId }
    )) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    return NextResponse.json({ transcript: interviewSession.transcript || [] })
  } catch (err) {
    if (err instanceof AppError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.statusCode })
    }
    logger.error({ err, sessionId: params.id }, 'Failed to get transcript')
    return NextResponse.json({ error: 'Failed to get transcript' }, { status: 500 })
  }
}
