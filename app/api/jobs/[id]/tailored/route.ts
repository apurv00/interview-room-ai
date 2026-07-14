import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import mongoose from 'mongoose'
import { saveTailoredVersion } from '@jobs'
import { ProductEvent } from '@shared/db/models'
import { logger } from '@shared/logger'

export const dynamic = 'force-dynamic'

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
  if (!mongoose.Types.ObjectId.isValid(params.id)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 })
  }
  if (typeof body.tailoredText !== 'string' || !body.tailoredText.trim()) {
    return NextResponse.json({ error: 'tailoredText required' }, { status: 400 })
  }
  await connectDB()
  const result = await saveTailoredVersion(userId, params.id, {
    tailoredText: body.tailoredText.slice(0, 100_000),
    sourceResumeId: typeof body.sourceResumeId === 'string' && body.sourceResumeId ? body.sourceResumeId.slice(0, 100) : undefined,
    matchScore: typeof body.matchScore === 'number' ? Math.max(0, Math.min(100, body.matchScore)) : undefined,
    addedKeywords: Array.isArray(body.addedKeywords) ? (body.addedKeywords as string[]).slice(0, 30).map((k) => String(k).slice(0, 60)) : [],
    missingKeywords: Array.isArray(body.missingKeywords) ? (body.missingKeywords as string[]).slice(0, 30).map((k) => String(k).slice(0, 60)) : [],
  })
  if (!result.ok) return NextResponse.json({ error: 'posting not found' }, { status: 404 })
  try {
    await ProductEvent.create({ name: 'jobs.tailor_run', userId, jobPostingId: params.id, props: { matchScore: body.matchScore }, ts: new Date() })
  } catch (err) {
    logger.warn({ err }, 'tailor_run telemetry write failed')
  }
  return NextResponse.json({ ok: true })
}
