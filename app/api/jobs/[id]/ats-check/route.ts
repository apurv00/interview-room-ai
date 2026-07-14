import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import mongoose from 'mongoose'
import { JobApplication } from '@shared/db/models'
import { inngest } from '@shared/services/inngest'
import { getBaseResume } from '@jobs'

export const dynamic = 'force-dynamic'

/**
 * POST /api/jobs/[id]/ats-check — queue the Save-gated background ATS check
 * (Wave 3.3). Never runs the ~35s model call inline: sets the pending
 * marker, emits the Inngest event, returns immediately. 409s carry a
 * `reason` the detail page turns into the right CTA (save first / attach a
 * resume first).
 */
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  const userId = (session?.user as { id?: string } | undefined)?.id
  if (!userId) return NextResponse.json({ error: 'sign in required' }, { status: 401 })
  if (!mongoose.Types.ObjectId.isValid(params.id)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  await connectDB()

  const app = await JobApplication.findOne({ userId, jobPostingId: params.id }).select('atsResult atsRequestedAt').lean()
  if (!app) return NextResponse.json({ reason: 'save-first' }, { status: 409 })
  if (!(await getBaseResume(userId))) return NextResponse.json({ reason: 'no-resume' }, { status: 409 })

  // Already running (marker younger than 3 minutes) — don't double-queue.
  if (app.atsRequestedAt && Date.now() - new Date(app.atsRequestedAt).getTime() < 3 * 60_000) {
    return NextResponse.json({ status: 'pending' })
  }

  await JobApplication.updateOne({ userId, jobPostingId: params.id }, { $set: { atsRequestedAt: new Date() } })
  try {
    await inngest.send({ name: 'jobs/ats.requested', data: { userId, jobPostingId: params.id } })
  } catch (err) {
    // Marker without a job = three minutes of polling a check that cannot
    // complete, and re-clicks swallowed by the duplicate guard (Codex on
    // #521). Roll it back so the button works on the next click.
    await JobApplication.updateOne({ userId, jobPostingId: params.id }, { $unset: { atsRequestedAt: 1 } }).catch(() => {})
    throw err
  }
  return NextResponse.json({ status: 'pending' })
}
