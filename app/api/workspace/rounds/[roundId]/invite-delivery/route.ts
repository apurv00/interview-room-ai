import { NextResponse } from 'next/server'
import {
  deliverAiInvite,
  getAiInviteDeliveryViews,
  HireRound,
  requireMembership,
} from '@hire'
import { NotFoundError } from '@shared/errors'
import { composeHireApiRoute } from '../../../_lib/composeHireApiRoute'

export const dynamic = 'force-dynamic'

async function loadDelivery(
  user: { id: string; email: string },
  roundId: string,
) {
  const ctx = await requireMembership({ userId: user.id, email: user.email })
  const round = await HireRound.findOne({
    _id: roundId,
    workspaceId: ctx.workspace._id,
  })
  if (!round) throw new NotFoundError('Round')
  const views = await getAiInviteDeliveryViews(ctx, [round])
  const delivery = views.get(round._id.toString())
  if (!delivery) throw new NotFoundError('AI invite delivery')
  return { ctx, delivery }
}

export const GET = composeHireApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 30, keyPrefix: 'rl:hire-invite-delivery' },
  async handler(_req, { user, params }) {
    const { delivery } = await loadDelivery(user, params.roundId)
    return NextResponse.json(
      { delivery },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  },
})

export const POST = composeHireApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 5, keyPrefix: 'rl:hire-invite-retry' },
  async handler(_req, { user, params }) {
    const { ctx } = await loadDelivery(user, params.roundId)
    const result = await deliverAiInvite(ctx, params.roundId, { manualRetry: true })
    return NextResponse.json(
      { delivery: result.view, emailSent: result.emailSent },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  },
})
