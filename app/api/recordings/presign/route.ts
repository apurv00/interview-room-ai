import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
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

  await connectDB()
  const interviewSession = await InterviewSession.findOne({
    _id: sessionId,
    userId: session.user.id,
  }).select('recordingR2Key')

  if (!interviewSession) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }

  if (!interviewSession.recordingR2Key) {
    return NextResponse.json({ error: 'No recording for this session' }, { status: 404 })
  }

  try {
    const url = await getDownloadPresignedUrl(interviewSession.recordingR2Key)
    return NextResponse.json({ url })
  } catch {
    return NextResponse.json({ error: 'Failed to generate download URL' }, { status: 500 })
  }
}
