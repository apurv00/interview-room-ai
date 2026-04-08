import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import {
  getUploadPresignedUrl,
  getDownloadPresignedUrl,
  recordingKey,
  screenRecordingKey,
  documentKey,
  isR2Configured,
} from '@shared/storage/r2'
import { connectDB } from '@shared/db/connection'
import { InterviewSession } from '@shared/db/models/InterviewSession'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const PresignSchema = z.object({
  action: z.enum(['upload', 'download']),
  type: z.enum(['recording', 'screen-recording', 'document']).optional(),
  sessionId: z.string().max(100).optional(),
  docType: z.enum(['jd', 'resume']).optional(),
  fileName: z.string().max(500).optional(),
  key: z.string().max(1000).optional(),
})

/**
 * POST /api/storage/presign
 * Generate presigned URLs for R2 upload/download.
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!isR2Configured()) {
    return NextResponse.json({ error: 'Storage not configured' }, { status: 503 })
  }

  try {
    const body = await req.json()
    const parsed = PresignSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }
    const { action, type, sessionId, docType, fileName, key } = parsed.data
    const userId = session.user.id

    if (action === 'upload') {
      let r2Key: string
      let contentType: string

      if (type === 'recording' || type === 'screen-recording') {
        if (!sessionId) {
          return NextResponse.json({ error: 'sessionId required for recording upload' }, { status: 400 })
        }

        // Security: Validate that the user owns this interview session
        await connectDB()
        const ownsSession = await InterviewSession.exists({ _id: sessionId, userId })
        if (!ownsSession) {
          return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }

        r2Key =
          type === 'screen-recording'
            ? screenRecordingKey(userId, sessionId)
            : recordingKey(userId, sessionId)
        // Preserve the existing 'audio/webm' content type for the camera
        // recording so existing presign-signature behavior is unchanged.
        // The screen track is also a webm container.
        contentType = 'audio/webm'
      } else if (type === 'document') {
        if (!docType || !fileName) {
          return NextResponse.json({ error: 'docType and fileName required for document upload' }, { status: 400 })
        }
        r2Key = documentKey(userId, docType, fileName)
        contentType = 'application/octet-stream'
      } else {
        return NextResponse.json({ error: 'type must be "recording" or "document"' }, { status: 400 })
      }

      const url = await getUploadPresignedUrl(r2Key, contentType)
      return NextResponse.json({ url, key: r2Key })
    }

    if (action === 'download') {
      if (!key) {
        return NextResponse.json({ error: 'key required for download' }, { status: 400 })
      }

      // Security: Validate that the R2 key belongs to the requesting user.
      // Keys follow the pattern: recordings/{userId}/... or documents/{userId}/...
      const keySegments = key.split('/')
      if (
        keySegments.length < 3 ||
        !['recordings', 'documents'].includes(keySegments[0]) ||
        keySegments[1] !== userId
      ) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }

      const url = await getDownloadPresignedUrl(key)
      return NextResponse.json({ url })
    }

    return NextResponse.json({ error: 'action must be "upload" or "download"' }, { status: 400 })
  } catch {
    return NextResponse.json({ error: 'Presign failed' }, { status: 500 })
  }
}
