import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { InterviewSession } from '@shared/db/models/InterviewSession'
import { aiLogger } from '@shared/logger'
import { uploadToR2, recordingKey, isR2Configured } from '@shared/storage/r2'

export const dynamic = 'force-dynamic'

const MAX_SIZE = 50 * 1024 * 1024 // 50MB

export async function POST(req: NextRequest) {
  try {
    // Auth required
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const formData = await req.formData()
    const recording = formData.get('recording') as File | null
    const sessionId = formData.get('sessionId') as string | null

    if (!recording) {
      return NextResponse.json({ error: 'No recording file provided' }, { status: 400 })
    }

    if (!sessionId) {
      return NextResponse.json({ error: 'No sessionId provided' }, { status: 400 })
    }

    // Size check
    if (recording.size > MAX_SIZE) {
      return NextResponse.json({ error: 'File too large (max 50MB)' }, { status: 413 })
    }

    const buffer = Buffer.from(await recording.arrayBuffer())

    if (!isR2Configured()) {
      return NextResponse.json({ error: 'Storage not configured' }, { status: 503 })
    }

    // Security: Verify the user owns this interview session before uploading
    await connectDB()
    const interviewSession = await InterviewSession.findOne({
      _id: sessionId,
      userId: session.user.id,
    })
    if (!interviewSession) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Upload to R2 — detect content type from the uploaded file
    const key = recordingKey(session.user.id, sessionId)
    const contentType = recording.type || 'video/webm'
    await uploadToR2(key, buffer, contentType)

    // Update interview session with R2 key
    try {
      interviewSession.recordingR2Key = key
      interviewSession.recordingSizeBytes = buffer.length
      await interviewSession.save()
    } catch (dbErr) {
      aiLogger.error({ err: dbErr }, 'Failed to update session with recording R2 key')
    }

    aiLogger.info({ key, size: recording.size, sessionId }, 'Recording uploaded to R2')

    return NextResponse.json({
      success: true,
      key,
    })
  } catch (err) {
    aiLogger.error({ err }, 'Recording upload error')
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 })
  }
}
