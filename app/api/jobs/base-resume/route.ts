import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { saveBaseResume, getBaseResume } from '@jobs'
import { logger } from '@shared/logger'
import { checkJobsRateLimit } from '@jobs/services/rateLimit'

export const dynamic = 'force-dynamic'

/**
 * Base-resume endpoints (Wave 3.2b; authed — anonymous strangers keep their
 * structure in sessionStorage only and get 401 here, which the client
 * treats as "skip silently").
 *
 * GET  — the import door: latest saved resume + flat skills.
 * POST — confirm-bar auto-save as "Base Resume — {role}" (update-on-re-upload,
 *        cap-honest: {saved:false, reason:'cap'} never blocks anything).
 */
export async function GET() {
  const session = await getServerSession(authOptions)
  const userId = (session?.user as { id?: string } | undefined)?.id
  if (!userId) return NextResponse.json({ error: 'sign in required' }, { status: 401 })
  await connectDB()
  const base = await getBaseResume(userId)
  return NextResponse.json({ base })
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  const userId = (session?.user as { id?: string } | undefined)?.id
  if (!userId) return NextResponse.json({ error: 'sign in required' }, { status: 401 })
  const rateLimitBlock = await checkJobsRateLimit(userId)
  if (rateLimitBlock) return rateLimitBlock
  let body: { resume?: Record<string, unknown>; targetRole?: string; fullText?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 })
  }
  if (!body.resume || typeof body.resume !== 'object') {
    return NextResponse.json({ error: 'resume required' }, { status: 400 })
  }
  await connectDB()
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
      return NextResponse.json({ error: 'resume failed validation' }, { status: 400 })
    }
    return NextResponse.json(result)
  } catch (err) {
    logger.warn({ err }, 'base-resume auto-save failed — onboarding continues without it')
    return NextResponse.json({ saved: false, reason: 'error' })
  }
}
