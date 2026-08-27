/**
 * POST /api/workspace/applications/[appId]/stage — advance or reject.
 * Every move records the acting member + timestamp in the application's
 * event log; marking Hired requires a decision note. The AI never calls this.
 */

import { NextResponse } from 'next/server'
import {
  HIRE_STAGE_REASON_CODES,
  requireMembership,
  moveStage,
  MoveStageSchema,
  type MoveStagePayload,
} from '@hire'
import { composeHireApiRoute } from '../../../_lib/composeHireApiRoute'

export const dynamic = 'force-dynamic'

const STAGE_REASON_LABELS: Record<(typeof HIRE_STAGE_REASON_CODES)[number], string> = {
  requirements_mismatch: 'Requirements mismatch',
  position_closed: 'Position closed',
  duplicate_application: 'Duplicate application',
  candidate_withdrew: 'Candidate withdrew',
  role_filled: 'Role filled',
}

export const POST = composeHireApiRoute<MoveStagePayload>({
  schema: MoveStageSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 30, keyPrefix: 'rl:hire-stage' },
  async handler(_req, { user, body, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const { reasonCode, ...command } = body
    const application = await moveStage(ctx, params.appId, {
      ...command,
      ...(reasonCode ? { note: `Decision reason: ${STAGE_REASON_LABELS[reasonCode]}` } : {}),
      // Candidate-list reads are only a presentation snapshot. Reclaim the
      // candidate row and recheck an active privacy request in the stage
      // transaction before any recruiter decision or note can be written.
      requirePrivacyAvailable: true,
    })
    return NextResponse.json({
      application: { id: application._id.toString(), stage: application.stage },
    })
  },
})
