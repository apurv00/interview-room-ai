import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import mongoose from 'mongoose'
import { getTailoredVersion, saveTailoredVersion } from '@jobs'
import { logger } from '@shared/logger'
import { MAX_JOB_TAILORED_TEXT_CHARS } from '@shared/jobsContract'
import { checkJobsRateLimit } from '@jobs/services/rateLimit'
import { recordJobsUserEvent } from '@jobs/services/userEventService'
import { JobsAccountInactiveError } from '@shared/services/jobsAccountFence'

export const dynamic = 'force-dynamic'
const PRIVATE_NO_STORE = { 'Cache-Control': 'private, no-store' }

/** GET returns full Tailor text only to the owning active account. */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  const userId = (session?.user as { id?: string } | undefined)?.id
  if (!userId) return NextResponse.json({ error: 'sign in required' }, { status: 401, headers: PRIVATE_NO_STORE })
  // This is a bounded authenticated read, not a mutation/LLM action. Charging
  // the shared write limiter here lets refreshes block Save/Apply/status.
  if (!mongoose.Types.ObjectId.isValid(params.id)) {
    return NextResponse.json({ error: 'not found' }, { status: 404, headers: PRIVATE_NO_STORE })
  }
  try {
    await connectDB()
    const version = await getTailoredVersion(userId, params.id)
    if (!version) return NextResponse.json({ error: 'not found' }, { status: 404, headers: PRIVATE_NO_STORE })
    return NextResponse.json(version, {
      headers: PRIVATE_NO_STORE,
    })
  } catch (error) {
    if (error instanceof JobsAccountInactiveError) {
      return NextResponse.json(
        { error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' },
        { status: 401, headers: PRIVATE_NO_STORE },
      )
    }
    logger.warn({ error }, 'tailored resume recovery failed')
    return NextResponse.json(
      { error: 'temporary recovery failure', code: 'TAILORED_RECOVERY_TEMPORARY' },
      { status: 503, headers: PRIVATE_NO_STORE },
    )
  }
}

/**
 * POST /api/jobs/[id]/tailored — persist the tailored version on the
 * application row (§2: latest-wins, NOT counted against the 3-resume cap;
 * the row absorbs per-job volume). Tailoring without a saved row implicitly
 * saves the job first — a tailored resume is the strongest save signal.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  const userId = (session?.user as { id?: string } | undefined)?.id
  if (!userId) return NextResponse.json({ error: 'sign in required' }, { status: 401 })
  const rateLimitBlock = await checkJobsRateLimit(userId)
  if (rateLimitBlock) return rateLimitBlock
  if (!mongoose.Types.ObjectId.isValid(params.id)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 })
  }
  // The Tailor run captures the authenticated user before generation. A
  // provider sign-in/account switch can replace the cookie while the model is
  // running; never let that result mutate the newly active account.
  if (typeof body.originUserId !== 'string' || body.originUserId !== userId) {
    return NextResponse.json(
      { error: 'sign-in session changed', code: 'SESSION_CHANGED' },
      { status: 409 },
    )
  }
  if (typeof body.tailoredText !== 'string' || !body.tailoredText.trim()) {
    return NextResponse.json({ error: 'tailoredText required' }, { status: 400 })
  }
  if (body.tailoredText.length > MAX_JOB_TAILORED_TEXT_CHARS) {
    return NextResponse.json(
      {
        error: `tailoredText must be ${MAX_JOB_TAILORED_TEXT_CHARS.toLocaleString('en-US')} characters or fewer`,
        code: 'TAILORED_TEXT_TOO_LARGE',
        identityVerified: true,
      },
      { status: 413 },
    )
  }
  if (typeof body.sourceJdHash !== 'string' || !/^[a-f0-9]{64}$/.test(body.sourceJdHash)) {
    return NextResponse.json(
      { error: 'sourceJdHash required', code: 'SOURCE_JD_HASH_REQUIRED' },
      { status: 400 },
    )
  }
  let result: Awaited<ReturnType<typeof saveTailoredVersion>>
  try {
    await connectDB()
    result = await saveTailoredVersion(userId, params.id, {
      tailoredText: body.tailoredText,
      sourceResumeId: typeof body.sourceResumeId === 'string' && body.sourceResumeId ? body.sourceResumeId.slice(0, 100) : undefined,
      matchScore: typeof body.matchScore === 'number' ? Math.max(0, Math.min(100, body.matchScore)) : undefined,
      addedKeywords: Array.isArray(body.addedKeywords) ? (body.addedKeywords as string[]).slice(0, 30).map((k) => String(k).slice(0, 60)) : [],
      missingKeywords: Array.isArray(body.missingKeywords) ? (body.missingKeywords as string[]).slice(0, 30).map((k) => String(k).slice(0, 60)) : [],
      sourceJdHash: body.sourceJdHash,
    })
  } catch (err) {
    if (err instanceof JobsAccountInactiveError) {
      return NextResponse.json(
        { error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' },
        { status: 401 },
      )
    }
    logger.warn({ err }, 'tailored resume attachment failed after identity verification')
    return NextResponse.json(
      { error: 'temporary attachment failure', code: 'ATTACHMENT_TEMPORARY', identityVerified: true },
      { status: 503 },
    )
  }
  if (!result.ok) {
    if (result.reason === 'invalid-payload') {
      return NextResponse.json(
        { error: 'invalid tailored resume', code: 'INVALID_TAILORED_PAYLOAD' },
        { status: 400 },
      )
    }
    if (result.reason === 'jd-mismatch') {
      return NextResponse.json(
        { error: 'job description changed', code: 'JOB_DESCRIPTION_CHANGED' },
        { status: 409 },
      )
    }
    if (result.reason === 'context-unavailable') {
      return NextResponse.json(
        { error: 'job context unavailable', code: 'JOB_CONTEXT_UNAVAILABLE' },
        { status: 409 },
      )
    }
    return NextResponse.json({ error: 'posting not found', code: 'JOB_NOT_FOUND' }, { status: 404 })
  }
  try {
    await recordJobsUserEvent({ name: 'jobs.tailor_run', userId, jobPostingId: params.id, props: { matchScore: body.matchScore }, ts: new Date() })
  } catch (err) {
    logger.warn({ err }, 'tailor_run telemetry write failed')
  }
  return NextResponse.json({ ok: true })
}
