import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import mongoose from 'mongoose'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { InterviewSession } from '@shared/db/models/InterviewSession'
import { getDownloadPresignedUrl, isR2Configured } from '@shared/storage/r2'

export const dynamic = 'force-dynamic'

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

  await connectDB()
  const interviewSession = await InterviewSession.findOne({
    _id: sessionId,
    userId: session.user.id,
  }).select('recordingR2Key screenRecordingR2Key audioRecordingR2Key')

  if (!interviewSession) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }

  const r2Key =
    kind === 'screen'
      ? interviewSession.screenRecordingR2Key
      : kind === 'audio'
        ? interviewSession.audioRecordingR2Key
        : interviewSession.recordingR2Key

  if (!r2Key) {
    return NextResponse.json({ error: 'No recording for this session' }, { status: 404 })
  }

  // 30 min: long enough that a normal replay session never sees an expired
  // URL, short enough to bound leaked-URL exposure. The players recover from
  // expiry via their media-error → re-presign handler, so this is a
  // comfort margin, not a correctness bound. expiresInSeconds is returned so
  // the client derives its cache TTL from the server instead of hardcoding a
  // second constant that must be manually kept below this one.
  const REPLAY_PRESIGN_TTL_SECONDS = 1800

  try {
    const url = await getDownloadPresignedUrl(r2Key, REPLAY_PRESIGN_TTL_SECONDS)
    return NextResponse.json({ url, kind, expiresInSeconds: REPLAY_PRESIGN_TTL_SECONDS })
  } catch {
    return NextResponse.json({ error: 'Failed to generate download URL' }, { status: 500 })
  }
}
