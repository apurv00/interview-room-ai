import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import mongoose from 'mongoose'
import { JobApplication, JobsEmailConfig, ProductEvent, User } from '@shared/db/models'
import { inngest } from '@shared/services/inngest'
import { isSuppressed } from '@jobs'

export const dynamic = 'force-dynamic'

/**
 * POST /api/jobs/[id]/practice-link-email — the E0 request (EMAILS.md §1:
 * "Email me tonight's practice link", PRODUCT_FLOW §4c's load-bearing
 * deferred CTA). Consent is the tap. Two honest refusals instead of a
 * silent accept (review R-blocker-2 / Codex #530): stream disabled and
 * suppressed both return their reason so the UI never pretends.
 */
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  const userId = (session?.user as { id?: string } | undefined)?.id
  if (!userId) return NextResponse.json({ error: 'sign in required' }, { status: 401 })
  if (!mongoose.Types.ObjectId.isValid(params.id)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  await connectDB()
  const [cfg, application, user] = await Promise.all([
    JobsEmailConfig.getConfig(),
    JobApplication.exists({ userId, jobPostingId: params.id }),
    User.findById(userId).select('emailPreferences.jobs.unsubscribedStreams').lean(),
  ])
  if (!application) return NextResponse.json({ error: 'no application for this job' }, { status: 404 })
  if (!cfg.e0Enabled) return NextResponse.json({ ok: false, reason: 'unavailable' }, { status: 200 })
  if (isSuppressed(user?.emailPreferences?.jobs?.unsubscribedStreams, 'e0')) {
    // "email is off for your account" — visible decline, never a silent
    // accept of a request we won't honor (EMAILS.md §3).
    return NextResponse.json({ ok: false, reason: 'email-off' }, { status: 200 })
  }

  const requestedAt = new Date()
  await inngest.send({
    name: 'jobs/email.requested',
    data: { userId, jobPostingId: params.id, requestedAt: requestedAt.toISOString() },
  })
  try {
    await ProductEvent.create({ name: 'jobs.prep_deferred_email', userId, jobPostingId: params.id, props: {}, ts: requestedAt })
  } catch { /* telemetry never breaks the flow */ }
  return NextResponse.json({ ok: true })
}
