import { NextRequest, NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { CreateSessionSchema } from '@interview/validators/interview'
import { createSession, listSessions } from '@interview/services/core/interviewService'
import { logger } from '@shared/logger'
import {
  activeJobsAccountIds,
  isJobsAccountActive,
} from '@shared/services/jobsAccountFence'
import { connectDB } from '@shared/db/connection'
import { AppError } from '@shared/errors'
import { practiceHandoffHashOf, resolvePracticeHandoff } from '@jobs/services/practiceHandoff'

export const dynamic = 'force-dynamic'

function accountUnavailable() {
  return NextResponse.json(
    { error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' },
    { status: 401 },
  )
}

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
    let beforeJobDescriptionProviderCall: (() => Promise<boolean>) | undefined
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
      // The handoff check above proves authority at request time. JD parsing
      // can start later and modelRouter may try more than one adapter, so
      // re-resolve the same server token before every provider attempt. A
      // revoked posting, ownership change, expired token, or CMS role outage
      // therefore closes the model boundary instead of authorizing from this
      // stale in-memory handoff.
      beforeJobDescriptionProviderCall = async () => {
        const current = await resolvePracticeHandoff(
          validated.jobsHandoffToken!,
          session.user.id
        )
        return !!current &&
          current.jobId === handoff.jobId &&
          current.jdHash === handoff.jdHash &&
          current.role === handoff.role
      }
    }

    const interviewSession = await createSession({
      userId: session.user.id,
      organizationId: session.user.organizationId,
      config,
      verifiedJobsAttribution,
      beforeJobDescriptionProviderCall,
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
    if (err instanceof Error && err.name === 'ModelProviderPreconditionError') {
      return NextResponse.json(
        {
          error: 'This job practice link expired or changed. Return to the job and start again.',
          code: 'JOBS_HANDOFF_INVALID',
        },
        { status: 409 }
      )
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
  let requesterUserId: string | undefined
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    requesterUserId = session.user.id

    await connectDB()
    if (!(await isJobsAccountActive(session.user.id))) {
      return accountUnavailable()
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
    let sanitizedSessions = result.sessions.map((s: any) => { // eslint-disable-line
      const obj = s.toObject ? s.toObject() : { ...s }
      const hasRecording = !!obj.recordingR2Key
      const hasScreenRecording = !!obj.screenRecordingR2Key
      const hasAnalysisSource = Boolean(obj.hasLiveTranscriptWords || obj.hasStoredTranscript)
      delete obj.recordingR2Key
      delete obj.screenRecordingR2Key
      delete obj.audioRecordingR2Key
      delete obj.facialLandmarksR2Key
      delete obj.resumeR2Key
      delete obj.jdR2Key
      delete obj.inviteTokenHash
      delete obj.inviteTokenExpiry
      delete obj.hasLiveTranscriptWords
      delete obj.hasStoredTranscript
      // Match the detail-route privacy boundary. Organization viewers need
      // scores and session metadata, never another candidate's raw resume,
      // JD, email address, or browser fingerprint.
      if (obj.userId?.toString() !== session.user.id) {
        delete obj.resumeText
        delete obj.userAgent
        delete obj.candidateEmail
        delete obj.jobDescription
        delete obj.parsedResume
        delete obj.parsedJobDescription
        delete obj.resumeFileName
        delete obj.jdFileName
        delete obj.recordingUrl
        delete obj.shareToken
      }
      return {
        ...obj,
        hasRecording,
        hasScreenRecording,
        hasAnalysisSource,
      }
    })

    if (!(await isJobsAccountActive(session.user.id))) {
      return accountUnavailable()
    }

    // The active-owner ID set used by listSessions can become stale while its
    // aggregate is in flight. Re-check only the returned foreign owners at
    // the final disclosure boundary and prune raced/malformed rows instead of
    // failing the recruiter's entire page.
    const foreignOwnerIds = Array.from(new Set(
      sanitizedSessions
        .map((row: { userId?: unknown }) => row.userId?.toString())
        .filter((ownerId: string | undefined): ownerId is string => !!ownerId && ownerId !== session.user.id),
    ))
    const finalActiveAccountIds = await activeJobsAccountIds([
      session.user.id,
      ...foreignOwnerIds,
    ])
    if (!finalActiveAccountIds.has(session.user.id)) {
      return accountUnavailable()
    }
    sanitizedSessions = sanitizedSessions.filter((row: { userId?: unknown }) => {
      const ownerId = row.userId?.toString()
      return !!ownerId && finalActiveAccountIds.has(ownerId)
    })

    return NextResponse.json({ ...result, sessions: sanitizedSessions })
  } catch (err) {
    if (requesterUserId) {
      try {
        if (!(await isJobsAccountActive(requesterUserId))) {
          return accountUnavailable()
        }
      } catch {
        // Preserve the original list failure when the diagnostic check fails.
      }
    }
    logger.error({ err }, 'Failed to list interview sessions')
    return NextResponse.json({ error: 'Failed to list sessions' }, { status: 500 })
  }
}
