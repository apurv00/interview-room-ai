import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import {
  getUploadPresignedUrl,
  getDownloadPresignedUrl,
  recordingKey,
  screenRecordingKey,
  audioRecordingKey,
  isR2Configured,
} from '@shared/storage/r2'
import { connectDB } from '@shared/db/connection'
import { InterviewSession } from '@shared/db/models/InterviewSession'
import { User } from '@shared/db/models/User'
import { isJobsAccountActive } from '@shared/services/jobsAccountFence'
import { z } from 'zod'
import { isCanonicalR2Key } from '@shared/storage/r2'

export const dynamic = 'force-dynamic'

const PresignSchema = z.object({
  action: z.enum(['upload', 'download']),
  type: z.enum(['recording', 'screen-recording', 'audio-recording', 'document']).optional(),
  sessionId: z.string().max(100).optional(),
  key: z.string().max(1000).optional(),
})

const accountUnavailableResponse = () => NextResponse.json(
  { error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' },
  { status: 401 },
)

async function isReferencedArtifact(key: string, userId: string): Promise<boolean> {
  const namespace = key.split('/')[0]
  if (namespace === 'recordings') {
    return Boolean(await InterviewSession.exists({
      userId,
      $or: [
        { recordingR2Key: key },
        { screenRecordingR2Key: key },
        { audioRecordingR2Key: key },
      ],
    }))
  }
  if (namespace !== 'documents') return false
  const references = await Promise.all([
    InterviewSession.exists({
      userId,
      $or: [{ resumeR2Key: key }, { jdR2Key: key }],
    }),
    User.exists({ _id: userId, resumeR2Key: key }),
  ])
  return references.some(Boolean)
}

/**
 * POST /api/storage/presign
 * Generate presigned URLs for R2 upload/download.
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const userId = session.user.id
  const originUserId = req.headers.get('x-origin-user-id')
  if (originUserId !== null && originUserId !== userId) {
    return NextResponse.json(
      { error: 'sign-in session changed', code: 'SESSION_CHANGED' },
      { status: 409 },
    )
  }

  try {
    await connectDB()
    if (!(await isJobsAccountActive(userId))) {
      return accountUnavailableResponse()
    }

    if (!isR2Configured()) {
      return NextResponse.json({ error: 'Storage not configured' }, { status: 503 })
    }

    const body = await req.json()
    const parsed = PresignSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }
    const { action, type, sessionId, key } = parsed.data

    if (action === 'upload') {
      let r2Key: string
      let contentType: string

      if (
        type === 'recording' ||
        type === 'screen-recording' ||
        type === 'audio-recording'
      ) {
        if (!sessionId) {
          return NextResponse.json({ error: 'sessionId required for recording upload' }, { status: 400 })
        }

        // Security: Validate that the user owns this interview session
        const ownsSession = await InterviewSession.exists({ _id: sessionId, userId })
        // The lookup is asynchronous. Prefer the terminal account signal over
        // a retained/missing-session result when deletion crosses it, and do
        // not proceed to the signer from a pre-deletion ownership snapshot.
        if (!(await isJobsAccountActive(userId))) {
          return accountUnavailableResponse()
        }
        if (!ownsSession) {
          return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }

        if (type === 'screen-recording') {
          r2Key = screenRecordingKey(userId, sessionId)
          contentType = 'video/webm'
        } else if (type === 'audio-recording') {
          r2Key = audioRecordingKey(userId, sessionId)
          contentType = 'audio/webm'
        } else {
          r2Key = recordingKey(userId, sessionId)
          contentType = 'video/webm'
        }
      } else if (type === 'document') {
        // Document parsing is intentionally stateless. Minting an upload URL
        // here would create an object with no durable Mongo reference, so
        // account deletion could neither discover nor verify its removal.
        return NextResponse.json(
          {
            error: 'Document originals are no longer retained',
            code: 'DOCUMENT_STORAGE_DISABLED',
          },
          { status: 410 },
        )
      } else {
        return NextResponse.json({ error: 'type must be "recording" or "document"' }, { status: 400 })
      }

      const url = await getUploadPresignedUrl(r2Key, contentType)
      // This withholds the URL when deletion wins during signing. It does not
      // make an already issued R2 capability revocable or transactionally
      // atomic with account deletion.
      if (!(await isJobsAccountActive(userId))) {
        return accountUnavailableResponse()
      }
      return NextResponse.json(
        { url, key: r2Key, contentType },
        { headers: { 'Cache-Control': 'private, no-store' } },
      )
    }

    if (action === 'download') {
      if (!key) {
        return NextResponse.json({ error: 'key required for download' }, { status: 400 })
      }

      // Prefix checks are insufficient: AWS signing normalizes dot segments.
      // Require an application-minted canonical key and a live Mongo owner
      // reference so deleted-session orphans cannot be re-authorized.
      if (!isCanonicalR2Key(key)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
      const keySegments = key.split('/')
      if (
        keySegments.length < 3 ||
        !['recordings', 'documents'].includes(keySegments[0]) ||
        keySegments[1] !== userId
      ) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }

      const isReferenced = await isReferencedArtifact(key, userId)
      if (!isReferenced) {
        if (!(await isJobsAccountActive(userId))) {
          return accountUnavailableResponse()
        }
        return NextResponse.json({ error: 'Artifact not found' }, { status: 404 })
      }

      if (!(await isJobsAccountActive(userId))) {
        return accountUnavailableResponse()
      }
      const url = await getDownloadPresignedUrl(key)
      if (!(await isJobsAccountActive(userId))) {
        return accountUnavailableResponse()
      }
      if (!(await isReferencedArtifact(key, userId))) {
        if (!(await isJobsAccountActive(userId))) {
          return accountUnavailableResponse()
        }
        return NextResponse.json({ error: 'Artifact not found' }, { status: 404 })
      }
      return NextResponse.json(
        { url },
        { headers: { 'Cache-Control': 'private, no-store' } },
      )
    }

    return NextResponse.json({ error: 'action must be "upload" or "download"' }, { status: 400 })
  } catch {
    // If signing/lookup failed because deletion crossed the request, retain
    // the exact terminal client signal. A failed diagnostic recheck must not
    // hide the original generic presign failure.
    try {
      if (!(await isJobsAccountActive(userId))) {
        return accountUnavailableResponse()
      }
    } catch {
      // Preserve the original failure below.
    }
    return NextResponse.json({ error: 'Presign failed' }, { status: 500 })
  }
}
