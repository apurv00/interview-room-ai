import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { saveBaseResume, getBaseResume } from '@jobs'
import { logger } from '@shared/logger'
import { checkJobsRateLimit } from '@jobs/services/rateLimit'
import {
  isJobsAccountActive,
  JobsAccountInactiveError,
} from '@shared/services/jobsAccountFence'

export const dynamic = 'force-dynamic'

const MAX_BASE_RESUME_BODY_BYTES = 1024 * 1024
const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  Pragma: 'no-cache',
} as const

function privateJson(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS })
}

function privateResponse(response: Response): Response {
  response.headers.set('Cache-Control', PRIVATE_HEADERS['Cache-Control'])
  response.headers.set('Pragma', PRIVATE_HEADERS.Pragma)
  return response
}

/**
 * Base-resume endpoints (Wave 3.2b; authed — anonymous uploads stay in page
 * memory, while reviewed matching inputs are tab-scoped; anonymous callers
 * get 401 here and the client treats that as "no import door").
 *
 * GET  — the import door: latest saved resume + flat skills.
 * POST — explicit-consent save as "Base Resume — {role}" (update-on-re-upload,
 *        cap-honest: {saved:false, reason:'cap'} keeps the client on review
 *        with an explicit tab-only fallback).
 */
export async function GET() {
  const session = await getServerSession(authOptions)
  const userId = (session?.user as { id?: string } | undefined)?.id
  if (!userId) return privateJson({ error: 'sign in required' }, 401)
  await connectDB()
  if (!(await isJobsAccountActive(userId))) {
    return privateJson(
      { error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' },
      401,
    )
  }
  const base = await getBaseResume(userId)
  if (!(await isJobsAccountActive(userId))) {
    return privateJson(
      { error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' },
      401,
    )
  }
  return privateJson({ base })
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  const userId = (session?.user as { id?: string } | undefined)?.id
  if (!userId) return privateJson({ error: 'sign in required' }, 401)
  const originUserId = req.headers.get('x-origin-user-id')
  if (originUserId !== userId) {
    return privateJson(
      { error: 'account changed', code: 'ACCOUNT_CHANGED' },
      409,
    )
  }
  const rateLimitBlock = await checkJobsRateLimit(userId)
  if (rateLimitBlock) return privateResponse(rateLimitBlock)
  const declaredLength = Number(req.headers.get('content-length') ?? 0)
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BASE_RESUME_BODY_BYTES) {
    return privateJson({ error: 'request too large' }, 413)
  }
  let raw: unknown
  try {
    const text = await req.text()
    if (new TextEncoder().encode(text).byteLength > MAX_BASE_RESUME_BODY_BYTES) {
      return privateJson({ error: 'request too large' }, 413)
    }
    raw = JSON.parse(text)
  } catch {
    return privateJson({ error: 'invalid JSON' }, 400)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return privateJson({ error: 'request object required' }, 400)
  }
  const body = raw as { resume?: Record<string, unknown>; targetRole?: string; fullText?: string }
  if (!body.resume || typeof body.resume !== 'object' || Array.isArray(body.resume)) {
    return privateJson({ error: 'resume required' }, 400)
  }
  await connectDB()
  if (!(await isJobsAccountActive(userId))) {
    return privateJson(
      { error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' },
      401,
    )
  }
  try {
    const result = await saveBaseResume(
      userId,
      body.resume,
      String(body.targetRole ?? '').slice(0, 80),
      // No jobs-side truncation: ResumeSchema owns the clamp (100k) — a 60k
      // slice here silently amputated legitimate long resumes (Codex #520).
      typeof body.fullText === 'string' ? body.fullText : undefined
    )
    if (result.saved === false && result.reason === 'invalid') {
      return privateJson({ error: 'resume failed validation' }, 400)
    }
    return privateJson(result)
  } catch (err) {
    if (err instanceof JobsAccountInactiveError) {
      return privateJson(
        { error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' },
        401,
      )
    }
    logger.warn({ err }, 'explicit base-resume save failed')
    return privateJson({ saved: false, reason: 'error' })
  }
}
