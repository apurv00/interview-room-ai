import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import mongoose from 'mongoose'
import { z } from 'zod'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { InterviewSession } from '@shared/db/models/InterviewSession'
import {
  abortMultipartUpload,
  audioRecordingKey,
  completeMultipartUpload,
  createMultipartUpload,
  getMultipartPartPresignedUrl,
  isR2Configured,
  recordingKey,
  screenRecordingKey,
} from '@shared/storage/r2'

export const dynamic = 'force-dynamic'

const PART_SIZE_BYTES = 8 * 1024 * 1024

const MultipartSchema = z.object({
  action: z.enum(['create', 'sign-part', 'complete', 'abort']),
  type: z.enum(['recording', 'screen-recording', 'audio-recording']).optional(),
  sessionId: z.string().max(100).optional(),
  key: z.string().max(1000).optional(),
  uploadId: z.string().max(1000).optional(),
  partNumber: z.number().int().min(1).max(10_000).optional(),
  sizeBytes: z.number().int().min(0).optional(),
  parts: z.array(
    z.object({
      partNumber: z.number().int().min(1).max(10_000),
      etag: z.string().min(1).max(500),
    })
  ).max(10_000).optional(),
})

type RecordingType = 'recording' | 'screen-recording' | 'audio-recording'

function contentTypeFor(type: RecordingType): string {
  return type === 'audio-recording' ? 'audio/webm' : 'video/webm'
}

function keyFor(type: RecordingType, userId: string, sessionId: string): string {
  if (type === 'screen-recording') return screenRecordingKey(userId, sessionId)
  if (type === 'audio-recording') return audioRecordingKey(userId, sessionId)
  return recordingKey(userId, sessionId)
}

function patchFor(type: RecordingType, key: string, sizeBytes: number) {
  if (type === 'screen-recording') {
    return { screenRecordingR2Key: key, screenRecordingSizeBytes: sizeBytes }
  }
  if (type === 'audio-recording') {
    return { audioRecordingR2Key: key, audioRecordingSizeBytes: sizeBytes }
  }
  return { recordingR2Key: key, recordingSizeBytes: sizeBytes }
}

function isOwnedRecordingKey(key: string, userId: string): boolean {
  const segments = key.split('/')
  return (
    segments.length >= 3 &&
    segments[0] === 'recordings' &&
    segments[1] === userId &&
    !key.includes('..')
  )
}

function isSessionRecordingKey(key: string, userId: string, sessionId: string): boolean {
  return isOwnedRecordingKey(key, userId) && key.startsWith(`recordings/${userId}/${sessionId}`)
}

async function requireOwnedSession(sessionId: string | undefined, userId: string) {
  if (!sessionId || !mongoose.Types.ObjectId.isValid(sessionId)) {
    return null
  }
  await connectDB()
  return InterviewSession.exists({ _id: sessionId, userId })
}

/**
 * POST /api/storage/multipart
 * R2 multipart upload orchestration for large replay recordings.
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
    const parsed = MultipartSchema.safeParse(await req.json())
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }

    const { action, type, sessionId, key, uploadId, partNumber, parts, sizeBytes } = parsed.data
    const userId = session.user.id

    if (action === 'create') {
      if (!type || !sessionId) {
        return NextResponse.json({ error: 'type and sessionId required' }, { status: 400 })
      }
      const ownsSession = await requireOwnedSession(sessionId, userId)
      if (!ownsSession) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }

      const r2Key = keyFor(type, userId, sessionId)
      const contentType = contentTypeFor(type)
      const created = await createMultipartUpload(r2Key, contentType)
      return NextResponse.json({
        key: created.key,
        uploadId: created.uploadId,
        contentType,
        partSizeBytes: PART_SIZE_BYTES,
      })
    }

    if (!key || !uploadId || !isOwnedRecordingKey(key, userId)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    if (action === 'sign-part') {
      if (!partNumber) {
        return NextResponse.json({ error: 'partNumber required' }, { status: 400 })
      }
      const url = await getMultipartPartPresignedUrl(key, uploadId, partNumber)
      return NextResponse.json({ url })
    }

    if (action === 'complete') {
      if (!type || !sessionId || !parts?.length || sizeBytes === undefined) {
        return NextResponse.json({ error: 'type, sessionId, parts, and sizeBytes required' }, { status: 400 })
      }
      const ownsSession = await requireOwnedSession(sessionId, userId)
      if (!ownsSession || !isSessionRecordingKey(key, userId, sessionId)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }

      await completeMultipartUpload(
        key,
        uploadId,
        parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag }))
      )
      await InterviewSession.findOneAndUpdate(
        { _id: sessionId, userId },
        { $set: patchFor(type, key, sizeBytes) }
      )
      return NextResponse.json({ key })
    }

    await abortMultipartUpload(key, uploadId)
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Multipart upload failed' }, { status: 500 })
  }
}
