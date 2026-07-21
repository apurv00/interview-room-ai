import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import mongoose from 'mongoose'
import { JobApplication, JobPosting } from '@shared/db/models'
import { inngest } from '@shared/services/inngest'
import { checkJobsRateLimit } from '@jobs/services/rateLimit'
import {
  getBaseResume,
  claimAtsRun,
  releaseAtsClaim,
  jobPostingStateOf,
  preparePracticeHandoffPosting,
} from '@jobs'
import { isJobsAccountActive } from '@shared/services/jobsAccountFence'

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
  const rateLimitBlock = await checkJobsRateLimit(userId, 'ats-check')
  if (rateLimitBlock) return rateLimitBlock
  if (!mongoose.Types.ObjectId.isValid(params.id)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  await connectDB()
  if (!(await isJobsAccountActive(userId))) {
    return NextResponse.json(
      { error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' },
      { status: 401 },
    )
  }

  const [app, posting] = await Promise.all([
    JobApplication.findOne({ userId, jobPostingId: params.id }).select('atsResult atsRequestedAt').lean(),
    JobPosting.findById(params.id)
      .select('domain status closedReason parsedJD parsedJDHash parsedJDRoleVersion jdCompressed jdDisplayCompressed')
      .lean(),
  ])
  if (!app) return NextResponse.json({ reason: 'save-first' }, { status: 409 })
  if (!posting || jobPostingStateOf(posting) === 'restricted') {
    return NextResponse.json({ reason: 'posting-unavailable' }, { status: 409 })
  }
  const prepared = await preparePracticeHandoffPosting(posting)
  if (!prepared.jdHash) {
    return NextResponse.json({ reason: 'posting-unavailable' }, { status: 409 })
  }
  if (!(await getBaseResume(userId))) return NextResponse.json({ reason: 'no-resume' }, { status: 409 })

  // ATOMIC claim (Codex on #521): concurrent POSTs must not both enqueue —
  // only the request that actually flipped the marker sends the event; the
  // loser reports pending. Claim failure on a >3min-stale marker retries
  // via the same conditional.
  const { claimed, claimedAt } = await claimAtsRun(userId, params.id)
  if (!claimed) {
    if (!(await isJobsAccountActive(userId))) {
      return NextResponse.json(
        { error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' },
        { status: 401 },
      )
    }
    return NextResponse.json({ status: 'pending' })
  }
  try {
    await inngest.send({ name: 'jobs/ats.requested', data: { userId, jobPostingId: params.id, claimedAt: claimedAt.toISOString() } })
  } catch (err) {
    // Claim without a job = three minutes of polling a check that cannot
    // complete. Release so the next click works; the original error still 500s.
    await releaseAtsClaim(userId, params.id)
    throw err
  }
  return NextResponse.json({ status: 'pending' })
}
