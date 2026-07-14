import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import mongoose from 'mongoose'
import { ProductEvent } from '@shared/db/models'
import { reportBrokenLink } from '@jobs'
import { logger } from '@shared/logger'

export const dynamic = 'force-dynamic'

/**
 * POST /api/jobs/[id]/broken-link — dead-click report (§4b). Records on the
 * caller's application AND increments the posting-level rung counter: one
 * user's dead click demotes that rung for everyone (the ladder sort sinks
 * reported rungs; never hides them).
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  const userId = (session?.user as { id?: string } | undefined)?.id
  if (!userId) return NextResponse.json({ error: 'sign in required' }, { status: 401 })
  if (!mongoose.Types.ObjectId.isValid(params.id)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  let url: string | undefined
  let tier: string | undefined
  let hadFailover = false
  try {
    const body = await req.json()
    if (typeof body?.url === 'string') url = body.url
    if (typeof body?.tier === 'string') tier = body.tier.slice(0, 40)
    hadFailover = body?.hadFailover === true
  } catch { /* fallthrough */ }
  if (!url) return NextResponse.json({ error: 'url required' }, { status: 400 })

  await connectDB()
  const result = await reportBrokenLink(userId, params.id, url)
  if (!result.ok) return NextResponse.json({ error: 'no application for this job' }, { status: 404 })
  try {
    await ProductEvent.create({ name: 'jobs.broken_link', userId, jobPostingId: params.id, props: { tier, hadFailover }, ts: new Date() })
  } catch (err) {
    logger.warn({ err }, 'broken-link telemetry write failed')
  }
  return NextResponse.json({ ok: true })
}
