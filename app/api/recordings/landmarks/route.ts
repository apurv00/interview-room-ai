import { NextResponse } from 'next/server'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { connectDB } from '@shared/db/connection'
import { InterviewSession } from '@shared/db/models/InterviewSession'
import { uploadToR2, isR2Configured } from '@shared/storage/r2'
import { aiLogger } from '@shared/logger'
import { LandmarksUploadSchema } from '@interview/validators/multimodal'
import type { FacialFrame } from '@shared/types/multimodal'

export const dynamic = 'force-dynamic'

interface LandmarksPayload {
  sessionId: string
  frames: FacialFrame[]
}

export const POST = composeApiRoute<LandmarksPayload>({
  schema: LandmarksUploadSchema,
  rateLimit: {
    windowMs: 60_000,
    maxRequests: 5,
    keyPrefix: 'rl:landmarks',
  },
  handler: async (_req, ctx) => {
    const { sessionId, frames } = ctx.body
    const userId = ctx.user.id

    if (!isR2Configured()) {
      return NextResponse.json({ error: 'Storage not configured' }, { status: 503 })
    }

    // Verify session ownership
    await connectDB()
    const session = await InterviewSession.findOne({
      _id: sessionId,
      userId,
    })
    if (!session) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Serialize and upload to R2
    const key = `landmarks/${userId}/${sessionId}.json`
    const buffer = Buffer.from(JSON.stringify(frames))
    await uploadToR2(key, buffer, 'application/json')

    // Update session
    session.facialLandmarksR2Key = key
    await session.save()

    aiLogger.info(
      { key, frames: frames.length, sessionId },
      'Facial landmarks uploaded to R2'
    )

    return NextResponse.json({ success: true, key, frameCount: frames.length })
  },
})
