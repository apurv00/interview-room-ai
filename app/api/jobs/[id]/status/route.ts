import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import mongoose from 'mongoose'
import { transitionStatus, USER_SETTABLE_STATUSES, type UserSettableStatus } from '@jobs'
import { checkJobsRateLimit } from '@jobs/services/rateLimit'
import { JobsAccountInactiveError } from '@shared/services/jobsAccountFence'

export const dynamic = 'force-dynamic'

/**
 * POST /api/jobs/[id]/status — USER status transitions (PRODUCT_FLOW §2:
 * loose machine — forward jumps and backward corrections both allowed;
 * `applied` here is the user CLAIM the return-sheet captures, distinct from
 * the machine fact `apply_clicked`, which is never settable through this
 * route). Emits jobs.status_changed / jobs.apply_confirmed server-side.
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
  let to: string | undefined
  let latencyMs: number | undefined
  let viaNudge = false
  let inferredFromPrep = false
  let rawAppliedWith: unknown
  try {
    const body = await req.json()
    to = body?.status
    if (typeof body?.latencyMs === 'number' && body.latencyMs >= 0) latencyMs = Math.floor(body.latencyMs)
    viaNudge = body?.viaNudge === true
    inferredFromPrep = body?.inferredFromPrep === true
    rawAppliedWith = body?.appliedWith
  } catch { /* fallthrough to validation */ }
  if (!to || !(USER_SETTABLE_STATUSES as readonly string[]).includes(to)) {
    return NextResponse.json({ error: `status must be one of ${USER_SETTABLE_STATUSES.join(', ')}` }, { status: 400 })
  }
  let appliedWith:
    | { wasTailored: false }
    | { wasTailored: true; tailoredAt: Date }
    | undefined
  if (rawAppliedWith !== undefined) {
    if (to !== 'applied' || !rawAppliedWith || typeof rawAppliedWith !== 'object') {
      return NextResponse.json({ error: 'appliedWith is only valid for applied status' }, { status: 400 })
    }
    const claim = rawAppliedWith as { wasTailored?: unknown; tailoredAt?: unknown }
    if (claim.wasTailored === false) {
      appliedWith = { wasTailored: false }
    } else if (claim.wasTailored === true && typeof claim.tailoredAt === 'string') {
      const tailoredAt = new Date(claim.tailoredAt)
      if (!Number.isNaN(tailoredAt.getTime())) appliedWith = { wasTailored: true, tailoredAt }
    }
    if (!appliedWith) {
      return NextResponse.json({ error: 'invalid appliedWith claim' }, { status: 400 })
    }
  }

  await connectDB()
  // jobs.interview_scheduled has ONE emitter — applicationService.
  // transitionStatus, on the EDGE (from != to). This route is a thin
  // caller: the inference door, the tracker chip, and the email-action
  // endpoint all converge on the service, so one scheduled interview is
  // one event regardless of channel (EMAILS.md §4; Codex on #525/#530).
  let result: Awaited<ReturnType<typeof transitionStatus>>
  try {
    result = await transitionStatus(userId, params.id, to as UserSettableStatus, {
      channel: 'web',
      latencyMs,
      viaNudge,
      inferredFromPrep,
      appliedWith,
    })
  } catch (error) {
    if (error instanceof JobsAccountInactiveError) {
      return NextResponse.json(
        { error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' },
        { status: 401 },
      )
    }
    throw error
  }
  if (!result.ok) {
    if (result.reason === 'tailored-version-unavailable' || result.reason === 'applied-with-conflict') {
      return NextResponse.json(
        result.reason === 'tailored-version-unavailable'
          ? { error: 'tailored version changed or is unavailable', code: 'TAILORED_VERSION_UNAVAILABLE' }
          : { error: 'a different resume choice is already recorded', code: 'APPLIED_WITH_CONFLICT' },
        { status: 409 },
      )
    }
    return NextResponse.json({ error: 'no application for this job' }, { status: 404 })
  }
  return NextResponse.json({ ok: true, status: result.status })
}
