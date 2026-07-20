import { NextRequest, NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { CreateSessionSchema } from '@interview/validators/interview'
import { createSession, listSessions } from '@interview/services/core/interviewService'
import { logger } from '@shared/logger'
import { AppError } from '@shared/errors'
import { practiceHandoffHashOf, resolvePracticeHandoff } from '@jobs/services/practiceHandoff'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await req.json()
    const validated = CreateSessionSchema.parse(body)

    let config = validated.config
    let jobDescription = validated.config.jobDescription
    let verifiedJobsAttribution:
      | {
          source: 'jobs'
          jobId: string
          applicationId?: string
          handoffVersion: 1
          jdHash: string
          verifiedAt: Date
        }
      | undefined
    const claimedAttribution = validated.config.attribution
    if (claimedAttribution || validated.jobsHandoffToken) {
      if (!claimedAttribution || !validated.jobsHandoffToken) {
        throw new AppError(
          'This job practice link is invalid. Return to the job and start again.',
          409,
          'JOBS_HANDOFF_INVALID'
        )
      }
      const handoff = await resolvePracticeHandoff(
        validated.jobsHandoffToken,
        session.user.id
      )
      if (
        !handoff ||
        !handoff.role ||
        claimedAttribution.jobId !== handoff.jobId ||
        !validated.config.jobDescription ||
        practiceHandoffHashOf(validated.config.jobDescription) !== handoff.jdHash ||
        validated.config.role !== handoff.role
      ) {
        throw new AppError(
          'This job practice link expired or changed. Return to the job and start again.',
          409,
          'JOBS_HANDOFF_INVALID'
        )
      }
      const canonicalAttribution = {
        source: 'jobs' as const,
        jobId: handoff.jobId,
        ...(handoff.applicationId ? { applicationId: handoff.applicationId } : {}),
      }
      config = {
        ...validated.config,
        role: handoff.role,
        jobDescription: handoff.jobDescription,
        targetCompany: handoff.company,
        attribution: canonicalAttribution,
      }
      jobDescription = handoff.jobDescription
      verifiedJobsAttribution = {
        ...canonicalAttribution,
        handoffVersion: 1,
        jdHash: handoff.jdHash,
        verifiedAt: new Date(),
      }
    }

    const interviewSession = await createSession({
      userId: session.user.id,
      organizationId: session.user.organizationId,
      config,
      verifiedJobsAttribution,
      templateId: validated.templateId,
      candidateEmail: validated.candidateEmail,
      candidateName: validated.candidateName,
      userAgent: req.headers.get('user-agent') || undefined,
      jobDescription,
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
    if (err instanceof ZodError) {
      return NextResponse.json(
        { error: 'Invalid session configuration', code: 'VALIDATION_ERROR' },
        { status: 400 }
      )
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

    // Strip internal R2 keys, expose hasRecording boolean instead.
    // hasAnalysisSource mirrors the gate in /api/analysis/start (transcript
    // or live words only — evaluations alone do NOT drive analysis, see
    // Codex P2 on PR #332). Existence booleans are computed server-side
    // in listSessions() via aggregation so the response never carries the
    // heavy liveTranscriptWords / transcript arrays.
    const sanitizedSessions = result.sessions.map((s: any) => { // eslint-disable-line
      const obj = s.toObject ? s.toObject() : { ...s }
      const hasRecording = !!obj.recordingR2Key
      const hasScreenRecording = !!obj.screenRecordingR2Key
      const hasAnalysisSource = Boolean(obj.hasLiveTranscriptWords || obj.hasStoredTranscript)
      delete obj.recordingR2Key
      delete obj.screenRecordingR2Key
      delete obj.audioRecordingR2Key
      delete obj.hasLiveTranscriptWords
      delete obj.hasStoredTranscript
      return {
        ...obj,
        hasRecording,
        hasScreenRecording,
        hasAnalysisSource,
      }
    })

    return NextResponse.json({ ...result, sessions: sanitizedSessions })
  } catch (err) {
    logger.error({ err }, 'Failed to list interview sessions')
    return NextResponse.json({ error: 'Failed to list sessions' }, { status: 500 })
  }
}
