import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/authOptions'
import { connectDB } from '@/lib/db/connection'
import { InterviewSession } from '@/lib/db/models/InterviewSession'
import { aiLogger } from '@/lib/logger'
import { writeFile, mkdir } from 'fs/promises'
import path from 'path'

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

    // Save to uploads directory
    const uploadsDir = path.join(process.cwd(), 'uploads', 'recordings')
    await mkdir(uploadsDir, { recursive: true })

    const timestamp = Date.now()
    const filename = `${sessionId}-${timestamp}.webm`
    const filePath = path.join(uploadsDir, filename)

    const buffer = Buffer.from(await recording.arrayBuffer())
    await writeFile(filePath, buffer)

    // Update interview session with recording URL
    try {
      await connectDB()
      await InterviewSession.findByIdAndUpdate(sessionId, {
        recordingUrl: `/api/recordings/${filename}`,
      })
    } catch (dbErr) {
      aiLogger.error({ err: dbErr }, 'Failed to update session with recording URL')
      // File is saved, just DB update failed — not critical
    }

    aiLogger.info({ filename, size: recording.size, sessionId }, 'Recording uploaded')

    return NextResponse.json({
      success: true,
      filename,
      url: `/api/recordings/${filename}`,
    })
  } catch (err) {
    aiLogger.error({ err }, 'Recording upload error')
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 })
  }
}
