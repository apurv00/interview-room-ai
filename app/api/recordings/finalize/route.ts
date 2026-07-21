import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { z } from 'zod'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { aiLogger } from '@shared/logger'
import {
  isJobsAccountActive,
  JobsAccountInactiveError,
  JobsAccountTransactionsRequiredError,
} from '@shared/services/jobsAccountFence'
import { deleteFromR2 } from '@shared/storage/r2'
import {
  associateRecordingArtifact,
  cleanupSupersededRecordingArtifact,
  RecordingArtifactKeyRejectedError,
  RecordingArtifactSessionNotFoundError,
} from '@interview/services/core/recordingArtifactService'

export const dynamic = 'force-dynamic'

const FinalizeRecordingSchema = z.object({
  type: z.enum(['recording', 'screen-recording', 'audio-recording']),
  sessionId: z.string().max(100),
  key: z.string().max(1000),
  sizeBytes: z.number().int().min(0),
  durationSeconds: z.number().min(1).max(14_400).optional(),
}).superRefine((value, ctx) => {
  if (value.type !== 'recording' && value.durationSeconds !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['durationSeconds'],
      message: 'durationSeconds is only valid for camera recordings',
    })
  }
})

const PRIVATE_NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' }

function privateJson(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: PRIVATE_NO_STORE_HEADERS })
}

function accountUnavailableResponse() {
  return privateJson(
    { error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' },
    401,
  )
}

async function bestEffortDelete(
  key: string,
  ownerUserId: string,
  sessionId: string,
): Promise<void> {
  try {
    await deleteFromR2(key, { ownerUserId, sessionId })
  } catch (error) {
    aiLogger.warn({ error, key }, 'Recording finalization compensation failed')
  }
}

/** POST /api/recordings/finalize — durable owner/session association. */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return privateJson({ error: 'Unauthorized' }, 401)

  const userId = session.user.id
  const originUserId = req.headers.get('x-origin-user-id')
  if (originUserId !== userId) {
    return privateJson(
      { error: 'sign-in session changed', code: 'SESSION_CHANGED' },
      409,
    )
  }

  let cleanupKey: string | undefined
  let cleanupSessionId: string | undefined
  try {
    await connectDB()
    if (!(await isJobsAccountActive(userId))) return accountUnavailableResponse()

    const parsed = FinalizeRecordingSchema.safeParse(await req.json())
    if (!parsed.success) return privateJson({ error: 'Invalid request' }, 400)
    cleanupKey = parsed.data.key
    cleanupSessionId = parsed.data.sessionId

    const result = await associateRecordingArtifact({ userId, ...parsed.data })
    if (!result.accepted) {
      await bestEffortDelete(parsed.data.key, userId, parsed.data.sessionId)
      return privateJson({ success: true, superseded: true })
    }
    await cleanupSupersededRecordingArtifact(
      result.previousKey,
      parsed.data.key,
      userId,
      parsed.data.sessionId,
    )

    // The transaction orders the durable write against deletion. This last
    // check only provides the exact terminal HTTP signal to a stale client.
    if (!(await isJobsAccountActive(userId))) {
      await bestEffortDelete(parsed.data.key, userId, parsed.data.sessionId)
      return accountUnavailableResponse()
    }

    return privateJson({ success: true })
  } catch (error) {
    if (error instanceof RecordingArtifactKeyRejectedError) {
      return privateJson({ error: 'Forbidden' }, 403)
    }
    if (error instanceof JobsAccountInactiveError) {
      if (cleanupKey && cleanupSessionId) {
        await bestEffortDelete(cleanupKey, userId, cleanupSessionId)
      }
      return accountUnavailableResponse()
    }
    if (error instanceof RecordingArtifactSessionNotFoundError) {
      if (cleanupKey && cleanupSessionId) {
        await bestEffortDelete(cleanupKey, userId, cleanupSessionId)
      }
      if (!(await isJobsAccountActive(userId))) return accountUnavailableResponse()
      return privateJson({ error: 'Interview session not found' }, 404)
    }
    if (error instanceof JobsAccountTransactionsRequiredError) {
      if (cleanupKey && cleanupSessionId) {
        await bestEffortDelete(cleanupKey, userId, cleanupSessionId)
      }
      return privateJson(
        { error: 'Recording finalization requires MongoDB transactions', code: 'TRANSACTIONS_REQUIRED' },
        503,
      )
    }

    try {
      if (!(await isJobsAccountActive(userId))) {
        if (cleanupKey && cleanupSessionId) {
          await bestEffortDelete(cleanupKey, userId, cleanupSessionId)
        }
        return accountUnavailableResponse()
      }
    } catch {
      // Preserve the unknown association failure below.
    }
    aiLogger.error({ error, userId }, 'Recording finalization failed')
    return privateJson({ error: 'Failed to finalize recording' }, 500)
  }
}
