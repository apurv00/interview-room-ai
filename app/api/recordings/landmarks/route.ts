import { NextResponse } from 'next/server'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { connectDB } from '@shared/db/connection'
import { InterviewSession } from '@shared/db/models/InterviewSession'
import { deleteFromR2, uploadToR2, isR2Configured } from '@shared/storage/r2'
import {
  isJobsAccountActive,
  JobsAccountInactiveError,
  JobsAccountTransactionsRequiredError,
  withActiveJobsAccountWrite,
} from '@shared/services/jobsAccountFence'
import { aiLogger } from '@shared/logger'
import { LandmarksUploadSchema } from '@interview/validators/multimodal'
import type { FacialFrame } from '@shared/types/multimodal'

export const dynamic = 'force-dynamic'

interface LandmarksPayload {
  sessionId: string
  frames: FacialFrame[]
}

class LandmarksSessionNotFoundError extends Error {}

const accountUnavailableResponse = () => NextResponse.json(
  { error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' },
  { status: 401 },
)

async function compensateLandmarksUpload(
  key: string,
  ownerUserId: string,
  sessionId: string,
): Promise<void> {
  try {
    await deleteFromR2(key, { ownerUserId, sessionId })
  } catch (error) {
    aiLogger.warn(
      { error, key, sessionId },
      'Failed to compensate facial-landmarks upload after account boundary',
    )
  }
}

export const POST = composeApiRoute<LandmarksPayload>({
  schema: LandmarksUploadSchema,
  rateLimit: {
    windowMs: 60_000,
    maxRequests: 5,
    keyPrefix: 'rl:landmarks',
  },
  handler: async (req, ctx) => {
    const { sessionId, frames } = ctx.body
    const userId = ctx.user.id

    const originUserId = req.headers.get('x-origin-user-id')
    if (originUserId !== null && originUserId !== userId) {
      return NextResponse.json(
        { error: 'Session changed', code: 'SESSION_CHANGED' },
        { status: 409 },
      )
    }

    await connectDB()
    if (!(await isJobsAccountActive(userId))) {
      return accountUnavailableResponse()
    }

    if (!isR2Configured()) {
      return NextResponse.json({ error: 'Storage not configured' }, { status: 503 })
    }

    const key = `landmarks/${userId}/${sessionId}.json`
    const buffer = Buffer.from(JSON.stringify(frames))
    let uploadAttempted = false
    try {
      // Verify session ownership, then prefer the durable lifecycle result if
      // account deletion removes the session while this lookup is in flight.
      const ownedSession = await InterviewSession.exists({
        _id: sessionId,
        userId,
      })
      if (!(await isJobsAccountActive(userId))) {
        return accountUnavailableResponse()
      }
      if (!ownedSession) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }

      // This is compensating, not atomic: R2 and Mongo cannot participate in
      // one transaction, so the durable upload ledger/prefix sweep is a
      // separate phase. Rechecks and deletion only close the common races.
      uploadAttempted = true
      await uploadToR2(key, buffer, 'application/json')
      if (!(await isJobsAccountActive(userId))) {
        await compensateLandmarksUpload(key, userId, sessionId)
        return accountUnavailableResponse()
      }

      try {
        await withActiveJobsAccountWrite(userId, async (mongoSession) => {
          const updated = await InterviewSession.updateOne(
            { _id: sessionId, userId },
            { $set: { facialLandmarksR2Key: key } },
            { session: mongoSession },
          )
          if ((updated.matchedCount ?? 0) !== 1) {
            throw new LandmarksSessionNotFoundError()
          }
        })
      } catch (associationError) {
        await compensateLandmarksUpload(key, userId, sessionId)
        if (associationError instanceof JobsAccountInactiveError) {
          return accountUnavailableResponse()
        }
        if (associationError instanceof JobsAccountTransactionsRequiredError) {
          return NextResponse.json(
            { error: 'Landmarks finalization requires MongoDB transactions', code: 'TRANSACTIONS_REQUIRED' },
            { status: 503 },
          )
        }
        if (associationError instanceof LandmarksSessionNotFoundError) {
          if (!(await isJobsAccountActive(userId))) {
            return accountUnavailableResponse()
          }
          return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }
        throw associationError
      }

      if (!(await isJobsAccountActive(userId))) {
        await compensateLandmarksUpload(key, userId, sessionId)
        return accountUnavailableResponse()
      }

      aiLogger.info(
        { key, frames: frames.length, sessionId },
        'Facial landmarks uploaded to R2',
      )

      return NextResponse.json({ success: true, key, frameCount: frames.length })
    } catch (error) {
      try {
        if (!(await isJobsAccountActive(userId))) {
          if (uploadAttempted) {
            await compensateLandmarksUpload(key, userId, sessionId)
          }
          return accountUnavailableResponse()
        }
      } catch {
        // Preserve the original storage/database error if lifecycle lookup is
        // unavailable; composeApiRoute will retain its normal 500 contract.
      }
      throw error
    }
  },
})
