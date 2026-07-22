import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import mongoose from 'mongoose'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import {
  INTERVIEW_OUTCOME_RESULTS,
  INTERVIEW_OUTCOME_CORRECTION_STATUSES,
  recordInterviewOutcome,
  type InterviewOutcomeCorrectionStatus,
  type InterviewOutcomeResult,
  type RecordInterviewOutcomeInput,
} from '@jobs'
import { checkJobsRateLimit } from '@jobs/services/rateLimit'
import { JobsAccountInactiveError } from '@shared/services/jobsAccountFence'

export const dynamic = 'force-dynamic'

const MAX_INTERVIEW_ROUND = 100
const MAX_OUTCOME_BODY_BYTES = 1024

async function readBoundedBody(req: Request): Promise<string | null> {
  if (!req.body) return ''
  const reader = req.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_OUTCOME_BODY_BYTES) {
        await reader.cancel()
        return null
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'private, no-store' },
  })
}

function parseBody(value: unknown): RecordInterviewOutcomeInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const body = value as Record<string, unknown>
  const keys = Object.keys(body).sort()
  if (
    typeof body.result !== 'string' ||
    !(INTERVIEW_OUTCOME_RESULTS as readonly string[]).includes(body.result) ||
    typeof body.round !== 'number' || !Number.isSafeInteger(body.round) ||
    body.round < 1 || body.round > MAX_INTERVIEW_ROUND
  ) {
    return null
  }

  const result = body.result as InterviewOutcomeResult
  if (keys.length === 2 && keys[0] === 'result' && keys[1] === 'round') {
    return { result, round: body.round }
  }

  if (
    result !== 'skip' &&
    keys.length === 4 &&
    keys[0] === 'expectedRevision' && keys[1] === 'expectedStatus' &&
    keys[2] === 'result' && keys[3] === 'round' &&
    typeof body.expectedRevision === 'number' &&
    Number.isSafeInteger(body.expectedRevision) && body.expectedRevision >= 1 &&
    typeof body.expectedStatus === 'string' &&
    (INTERVIEW_OUTCOME_CORRECTION_STATUSES as readonly string[]).includes(body.expectedStatus)
  ) {
    return {
      result,
      round: body.round,
      expectedRevision: body.expectedRevision,
      expectedStatus: body.expectedStatus as InterviewOutcomeCorrectionStatus,
    }
  }
  return null
}

/** POST /api/jobs/[id]/outcome — owner-authored interview check-in. */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  const userId = (session?.user as { id?: string } | undefined)?.id
  if (!userId) return json({ error: 'sign in required' }, 401)

  const rateLimitBlock = await checkJobsRateLimit(userId)
  if (rateLimitBlock) {
    rateLimitBlock.headers.set('Cache-Control', 'private, no-store')
    return rateLimitBlock
  }
  if (!mongoose.Types.ObjectId.isValid(params.id)) return json({ error: 'not found' }, 404)

  const declaredLength = Number(req.headers.get('content-length') ?? 0)
  if (Number.isFinite(declaredLength) && declaredLength > MAX_OUTCOME_BODY_BYTES) {
    return json({ error: 'request too large', code: 'OUTCOME_REQUEST_TOO_LARGE' }, 413)
  }
  let rawBody: unknown
  try {
    const text = await readBoundedBody(req)
    if (text === null) {
      return json({ error: 'request too large', code: 'OUTCOME_REQUEST_TOO_LARGE' }, 413)
    }
    rawBody = JSON.parse(text)
  } catch {
    return json({ error: 'invalid JSON body', code: 'INVALID_OUTCOME' }, 400)
  }
  const input = parseBody(rawBody)
  if (!input) {
    return json({
      error: `body must contain a result (${INTERVIEW_OUTCOME_RESULTS.join(', ')}) and an integer round from 1 to ${MAX_INTERVIEW_ROUND}; corrections also require the exact latest revision and lifecycle status`,
      code: 'INVALID_OUTCOME',
    }, 400)
  }

  await connectDB()
  let result: Awaited<ReturnType<typeof recordInterviewOutcome>>
  try {
    result = await recordInterviewOutcome(userId, params.id, input)
  } catch (error) {
    if (error instanceof JobsAccountInactiveError) {
      return json({ error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' }, 401)
    }
    throw error
  }

  if (!result.ok) {
    if (result.reason === 'round-conflict') {
      return json({
        error: 'interview outcome changed; refresh and try again',
        code: 'OUTCOME_STATE_CONFLICT',
        currentRound: result.currentRound,
      }, 409)
    }
    return json({ error: 'not found' }, 404)
  }

  return json(result)
}
