import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import mongoose from 'mongoose'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { InterviewSession } from '@shared/db/models/InterviewSession'
import { isJobsAccountActive } from '@shared/services/jobsAccountFence'
import { getDownloadPresignedUrl, isR2Configured } from '@shared/storage/r2'
import {
  isSessionRecordingKey,
  type RecordingArtifactType,
} from '@interview/services/core/recordingArtifactService'

export const dynamic = 'force-dynamic'

const accountUnavailableResponse = () => NextResponse.json(
  { error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' },
  { status: 401 },
)

/**
 * GET /api/recordings/presign?sessionId=xxx
 * Returns a presigned download URL for the recording associated with a session.
 * Validates that the requesting user owns the session.
 */
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const requesterUserId = session.user.id

  try {
    await connectDB()
    if (!(await isJobsAccountActive(requesterUserId))) {
      return accountUnavailableResponse()
    }

    if (!isR2Configured()) {
      return NextResponse.json({ error: 'Storage not configured' }, { status: 503 })
    }

    const sessionId = req.nextUrl.searchParams.get('sessionId')
    if (!sessionId) {
      return NextResponse.json({ error: 'sessionId required' }, { status: 400 })
    }

    if (!mongoose.Types.ObjectId.isValid(sessionId)) {
      return NextResponse.json({ error: 'Invalid session ID format' }, { status: 400 })
    }

    // Optional `kind` query param: 'camera' (default) | 'screen' | 'audio'.
    // 'audio' serves the audio-only webm (mixed candidate + AI voice, ~14MB for
    // 30 min) so the feedback page's audio replay stops streaming the full
    // camera video (~157MB for 30 min) just to play sound.
    const kindParam = req.nextUrl.searchParams.get('kind')
    const kind = kindParam === 'screen' || kindParam === 'audio' ? kindParam : 'camera'

    const interviewSession = await InterviewSession.findOne({
      _id: sessionId,
      userId: requesterUserId,
    }).select('recordingR2Key screenRecordingR2Key audioRecordingR2Key privacyMode')

    // Prefer the durable account result over a concurrent session sweep's 404,
    // and never continue from a document captured before deletion began.
    if (!(await isJobsAccountActive(requesterUserId))) {
      return accountUnavailableResponse()
    }

    if (!interviewSession) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }

    // Privacy-mode sessions keep an audio artifact for the analysis pipeline,
    // but audio REPLAY for them is an unmade product decision — the feedback
    // page doesn't offer it, and this server-side gate stops a direct API call
    // from minting a replay URL anyway (Codex P2 #555). Same 404 as
    // no-recording so the response doesn't oracle the privacy flag.
    if (kind === 'audio' && interviewSession.privacyMode === true) {
      return NextResponse.json({ error: 'No recording for this session' }, { status: 404 })
    }

    const r2Key =
      kind === 'screen'
        ? interviewSession.screenRecordingR2Key
        : kind === 'audio'
          ? interviewSession.audioRecordingR2Key
          : interviewSession.recordingR2Key

    const artifactType: RecordingArtifactType = kind === 'screen'
      ? 'screen-recording'
      : kind === 'audio'
      ? 'audio-recording'
      : 'recording'
    const keyField = kind === 'screen'
      ? 'screenRecordingR2Key'
      : kind === 'audio'
      ? 'audioRecordingR2Key'
      : 'recordingR2Key'

    if (
      !r2Key ||
      !isSessionRecordingKey(r2Key, artifactType, requesterUserId, sessionId)
    ) {
      return NextResponse.json({ error: 'No recording for this session' }, { status: 404 })
    }

    // 30 min: long enough that a normal replay session never sees an expired
    // URL, short enough to bound leaked-URL exposure. The players recover from
    // expiry via their media-error → re-presign handler, so this is a
    // comfort margin, not a correctness bound. expiresInSeconds is returned so
    // the client derives its cache TTL from the server instead of hardcoding a
    // second constant that must be manually kept below this one.
    const REPLAY_PRESIGN_TTL_SECONDS = 1800

    const url = await getDownloadPresignedUrl(r2Key, REPLAY_PRESIGN_TTL_SECONDS)
    // Signing is async. Withhold a URL produced while deletion crossed the
    // account boundary, even though the signer itself cannot retract it.
    if (!(await isJobsAccountActive(requesterUserId))) {
      return accountUnavailableResponse()
    }
    const stillReferenced = await InterviewSession.exists({
      _id: sessionId,
      userId: requesterUserId,
      [keyField]: r2Key,
    })
    if (!stillReferenced) {
      if (!(await isJobsAccountActive(requesterUserId))) {
        return accountUnavailableResponse()
      }
      return NextResponse.json({ error: 'No recording for this session' }, { status: 404 })
    }
    return NextResponse.json(
      { url, kind, expiresInSeconds: REPLAY_PRESIGN_TTL_SECONDS },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  } catch {
    try {
      if (!(await isJobsAccountActive(requesterUserId))) {
        return accountUnavailableResponse()
      }
    } catch {
      // Preserve the original route failure if the diagnostic check fails.
    }
    return NextResponse.json({ error: 'Failed to generate download URL' }, { status: 500 })
  }
}
