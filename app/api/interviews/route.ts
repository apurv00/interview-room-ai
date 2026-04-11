import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { CreateSessionSchema } from '@interview/validators/interview'
import { createSession, listSessions } from '@interview/services/core/interviewService'
import { logger } from '@shared/logger'
import { AppError } from '@shared/errors'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await req.json()
    const validated = CreateSessionSchema.parse(body)

    const interviewSession = await createSession({
      userId: session.user.id,
      organizationId: session.user.organizationId,
      config: validated.config,
      templateId: validated.templateId,
      candidateEmail: validated.candidateEmail,
      candidateName: validated.candidateName,
      userAgent: req.headers.get('user-agent') || undefined,
      jobDescription: validated.config.jobDescription,
      resumeText: validated.config.resumeText,
      jdFileName: validated.config.jdFileName,
      resumeFileName: validated.config.resumeFileName,
      parentSessionId: validated.parentSessionId,
    })

    return NextResponse.json(
      { sessionId: interviewSession._id.toString() },
      { status: 201 }
    )
  } catch (err) {
    if (err instanceof AppError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.statusCode })
    }
    logger.error({ err }, 'Failed to create interview session')
    return NextResponse.json({ error: 'Failed to create session' }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(req.url)
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1)
    const limit = Math.min(50, Math.max(1, parseInt(searchParams.get('limit') || '20', 10) || 20))
    const rawStatus = searchParams.get('status')
    const VALID_STATUSES = ['created', 'in_progress', 'completed', 'abandoned']
    const status = rawStatus && VALID_STATUSES.includes(rawStatus) ? rawStatus : undefined

    const result = await listSessions({
      userId: session.user.id,
      organizationId: session.user.organizationId,
      role: session.user.role,
      page,
      limit,
      status,
    })

    // Strip internal R2 keys, expose hasRecording boolean instead
    const sanitizedSessions = result.sessions.map((s: any) => { // eslint-disable-line
      const obj = s.toObject ? s.toObject() : { ...s }
      const hasRecording = !!obj.recordingR2Key
      const hasScreenRecording = !!obj.screenRecordingR2Key
      delete obj.recordingR2Key
      delete obj.screenRecordingR2Key
      delete obj.audioRecordingR2Key
      return { ...obj, hasRecording, hasScreenRecording }
    })

    return NextResponse.json({ ...result, sessions: sanitizedSessions })
  } catch (err) {
    logger.error({ err }, 'Failed to list interview sessions')
    return NextResponse.json({ error: 'Failed to list sessions' }, { status: 500 })
  }
}
