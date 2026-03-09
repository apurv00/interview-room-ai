import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/authOptions'
import { CreateSessionSchema } from '@/lib/validators/interview'
import { createSession, listSessions } from '@/lib/services/interviewService'
import { logger } from '@/lib/logger'
import { AppError } from '@/lib/errors'

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
    const page = parseInt(searchParams.get('page') || '1', 10)
    const limit = parseInt(searchParams.get('limit') || '20', 10)
    const status = searchParams.get('status') || undefined

    const result = await listSessions({
      userId: session.user.id,
      organizationId: session.user.organizationId,
      role: session.user.role,
      page,
      limit,
      status,
    })

    return NextResponse.json(result)
  } catch (err) {
    logger.error({ err }, 'Failed to list interview sessions')
    return NextResponse.json({ error: 'Failed to list sessions' }, { status: 500 })
  }
}
