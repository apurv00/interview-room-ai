import { NextResponse } from 'next/server'
import {
  confirmJobScreeningGate,
  requireMembership,
  type ConfirmScreeningGateRequest,
} from '@hire'
import { composeHireApiRoute } from '../../../../_lib/composeHireApiRoute'
import {
  serializeInvitationBatch,
  serializeScreeningGate,
} from '../_lib/serialize'
import {
  screeningConfirmRequestSchema,
  type ScreeningConfirmRouteBody,
} from '../_lib/schemas'

export const dynamic = 'force-dynamic'

/** Freeze the reviewed ranking into an unsent wave-one batch. */
export const POST = composeHireApiRoute<ScreeningConfirmRouteBody>({
  schema: screeningConfirmRequestSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 10, keyPrefix: 'rl:hire-screening-confirm' },
  async handler(_req, { user, body, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const result = await confirmJobScreeningGate(
      ctx,
      params.jobId,
      body as ConfirmScreeningGateRequest,
    )
    // The committed command above is authoritative. History identity and
    // delivery details are loaded separately, so no fallible post-commit read
    // can turn this successful mutation into a misleading failed response.
    return NextResponse.json(
      {
        gate: serializeScreeningGate(result.gate, [result.batch]),
        batch: serializeInvitationBatch(result.batch),
        itemCount: result.itemCount,
        requirementVersion: result.requirementVersion,
        previewFingerprint: result.previewFingerprint,
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  },
})
