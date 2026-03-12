import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth/authOptions'
import {
  getUploadPresignedUrl,
  getDownloadPresignedUrl,
  recordingKey,
  documentKey,
  isR2Configured,
} from '@/lib/storage/r2'
import { connectDB } from '@/lib/db/connection'
import { InterviewSession } from '@/lib/db/models/InterviewSession'

export const dynamic = 'force-dynamic'

/**
 * POST /api/storage/presign
 * Generate presigned URLs for R2 upload/download.
 *
 * Body: { action: 'upload' | 'download', type: 'recording' | 'document', sessionId?, docType?, fileName?, key? }
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
    const { action, type, sessionId, docType, fileName, key } = body
    const userId = session.user.id

    if (action === 'upload') {
      let r2Key: string
      let contentType: string

      if (type === 'recording') {
        if (!sessionId) {
          return NextResponse.json({ error: 'sessionId required for recording upload' }, { status: 400 })
        }

        // Security: Validate that the user owns this interview session
        await connectDB()
        const ownsSession = await InterviewSession.exists({ _id: sessionId, userId })
        if (!ownsSession) {
          return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }

        r2Key = recordingKey(userId, sessionId)
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
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Presign failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
