/** Member-only, read-only decision action inbox for one job. */

import { NextRequest, NextResponse } from 'next/server'
import { requireMembership } from '@hire'
import { readHireDecisionActionInbox } from '@hire-decisions'
import { AppError } from '@shared/errors'
import { composeHireApiRoute } from '../../../_lib/composeHireApiRoute'

export const dynamic = 'force-dynamic'

function externalVerdictsSince(req: NextRequest): Date | undefined {
  const raw = req.nextUrl.searchParams.get('externalVerdictsSince')
  if (!raw) return undefined
  const value = new Date(raw)
  if (Number.isNaN(value.getTime())) {
    throw new AppError('Invalid external verdict cursor', 400, 'INVALID_VERDICT_CURSOR')
  }
  return value
}

export const GET = composeHireApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 60, keyPrefix: 'rl:hire-decision-inbox' },
  async handler(req, { user, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const inbox = await readHireDecisionActionInbox({
      workspaceId: ctx.workspace._id.toString(),
      jobId: params.jobId,
      externalVerdictsSince: externalVerdictsSince(req),
    })
    return NextResponse.json(inbox, { headers: { 'Cache-Control': 'private, no-store' } })
  },
})
