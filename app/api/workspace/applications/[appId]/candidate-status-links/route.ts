/** Member-controlled candidate-status link issue/list routes. No delivery side effect. */

import { NextResponse } from 'next/server'
import { requireMembership } from '@hire/services/workspaceService'
import {
  IssueCandidateStatusLinkSchema,
  type IssueCandidateStatusLinkPayload,
} from '@/modules/hire-status/validators/hireStatus'
import {
  issueCandidateStatusLink,
  listCandidateStatusLinks,
} from '@/modules/hire-status/services/candidateStatusLinkService'
import { composeHireApiRoute } from '../../../_lib/composeHireApiRoute'

export const dynamic = 'force-dynamic'

// The application coordinate is owned by the path. Accepting it again in a
// body would create a mismatched-coordinate surface before authorization.
const IssueCandidateStatusLinkRouteSchema = IssueCandidateStatusLinkSchema.pick({
  operationId: true,
  expiresInDays: true,
})
type IssueCandidateStatusLinkRoutePayload = Pick<
  IssueCandidateStatusLinkPayload,
  'operationId' | 'expiresInDays'
>

/** Lists only opaque, member-safe lifecycle state; never a capability/hash. */
export const GET = composeHireApiRoute({
  rateLimit: {
    windowMs: 60_000,
    maxRequests: 60,
    keyPrefix: 'rl:hire-candidate-status-link-list',
  },
  async handler(_req, { user, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const candidateStatusLinks = await listCandidateStatusLinks({
      workspaceId: ctx.workspace._id.toString(),
      applicationId: params.appId,
    })
    return NextResponse.json(
      { candidateStatusLinks },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  },
})

/**
 * Issue a copy-once URL that a member can provide through their own channel.
 * There is intentionally no email/outbox/provider action in this phase.
 */
export const POST = composeHireApiRoute<IssueCandidateStatusLinkRoutePayload>({
  schema: IssueCandidateStatusLinkRouteSchema,
  rateLimit: {
    windowMs: 60_000,
    maxRequests: 10,
    keyPrefix: 'rl:hire-candidate-status-link-issue',
  },
  async handler(_req, { user, body, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const result = await issueCandidateStatusLink(
      {
        workspaceId: ctx.workspace._id.toString(),
        memberId: ctx.membership._id.toString(),
        memberName: ctx.membership.name || ctx.membership.email,
      },
      { applicationId: params.appId, ...body },
    )
    return NextResponse.json(
      {
        candidateStatusLink: result.link,
        // A retry returns null: the stored digest cannot reconstruct a raw
        // fragment capability and delivery remains member-controlled.
        statusUrl: result.statusUrl,
        created: result.created,
      },
      {
        status: result.created ? 201 : 200,
        headers: { 'Cache-Control': 'private, no-store' },
      },
    )
  },
})
