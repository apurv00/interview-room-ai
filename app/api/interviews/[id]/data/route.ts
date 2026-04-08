import { NextRequest, NextResponse } from 'next/server'
import mongoose from 'mongoose'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { InterviewSession } from '@shared/db/models/InterviewSession'
import { MultimodalAnalysis } from '@shared/db/models/MultimodalAnalysis'
import { deleteFromR2 } from '@shared/storage/r2'
import { logger } from '@shared/logger'

export const dynamic = 'force-dynamic'

/**
 * DELETE /api/interviews/[id]/data
 *
 * Deletes all sensitive data for a session:
 * - Recording from R2
 * - Facial landmarks from R2
 * - Resume/JD documents from R2
 * - Multimodal analysis record
 * - Clears sensitive fields from session (keeps config + scores for history)
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    if (!mongoose.Types.ObjectId.isValid(params.id)) {
      return NextResponse.json({ error: 'Invalid session ID' }, { status: 400 })
    }

    const authSession = await getServerSession(authOptions)
    if (!authSession?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    await connectDB()

    const session = await InterviewSession.findById(params.id)
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }

    // Ownership check: only session owner or platform admin can delete
    if (
      session.userId.toString() !== authSession.user.id &&
      authSession.user.role !== 'platform_admin'
    ) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Delete R2 objects (non-blocking, collect errors)
    const r2Deletions: Promise<void>[] = []
    if (session.recordingR2Key) {
      r2Deletions.push(
        deleteFromR2(session.recordingR2Key).catch((err) =>
          logger.warn({ err, key: session.recordingR2Key }, 'Failed to delete recording from R2')
        )
      )
    }
    if (session.screenRecordingR2Key) {
      r2Deletions.push(
        deleteFromR2(session.screenRecordingR2Key).catch((err) =>
          logger.warn({ err, key: session.screenRecordingR2Key }, 'Failed to delete screen recording from R2')
        )
      )
    }
    if (session.audioRecordingR2Key) {
      r2Deletions.push(
        deleteFromR2(session.audioRecordingR2Key).catch((err) =>
          logger.warn({ err, key: session.audioRecordingR2Key }, 'Failed to delete audio recording from R2')
        )
      )
    }
    if (session.facialLandmarksR2Key) {
      r2Deletions.push(
        deleteFromR2(session.facialLandmarksR2Key).catch((err) =>
          logger.warn({ err, key: session.facialLandmarksR2Key }, 'Failed to delete landmarks from R2')
        )
      )
    }
    if (session.resumeR2Key) {
      r2Deletions.push(
        deleteFromR2(session.resumeR2Key).catch((err) =>
          logger.warn({ err, key: session.resumeR2Key }, 'Failed to delete resume from R2')
        )
      )
    }
    if (session.jdR2Key) {
      r2Deletions.push(
        deleteFromR2(session.jdR2Key).catch((err) =>
          logger.warn({ err, key: session.jdR2Key }, 'Failed to delete JD from R2')
        )
      )
    }

    await Promise.all(r2Deletions)

    // Delete multimodal analysis
    await MultimodalAnalysis.deleteOne({ sessionId: params.id })

    // Clear sensitive fields from session (keep config + feedback for history)
    await InterviewSession.findByIdAndUpdate(params.id, {
      $unset: {
        recordingUrl: 1,
        recordingR2Key: 1,
        recordingSizeBytes: 1,
        screenRecordingR2Key: 1,
        screenRecordingSizeBytes: 1,
        audioRecordingR2Key: 1,
        audioRecordingSizeBytes: 1,
        facialLandmarksR2Key: 1,
        resumeR2Key: 1,
        jdR2Key: 1,
        resumeText: 1,
        jobDescription: 1,
        transcript: 1,
        multimodalAnalysisId: 1,
      },
      $set: {
        userAgent: '[deleted]',
      },
    })

    logger.info({ sessionId: params.id, userId: authSession.user.id }, 'Session data deleted')

    return NextResponse.json({ success: true, message: 'Session data deleted' })
  } catch (err) {
    logger.error({ err, sessionId: params.id }, 'Failed to delete session data')
    return NextResponse.json({ error: 'Failed to delete data' }, { status: 500 })
  }
}
