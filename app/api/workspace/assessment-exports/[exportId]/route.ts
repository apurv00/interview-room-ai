/** Member-only opaque status for an assessment export. */

import { NextResponse } from 'next/server'
import { requireMembership } from '@hire'
import {
  getHireAssessmentExportStatus,
  type HireAssessmentExportMemberView,
} from '@hire-decisions'
import { composeHireApiRoute } from '../../_lib/composeHireApiRoute'

export const dynamic = 'force-dynamic'

function serializeAssessmentExport(view: HireAssessmentExportMemberView) {
  return {
    id: view.id,
    status: view.status,
    requestedAt: view.requestedAt,
    expiresAt: view.expiresAt,
    readyAt: view.readyAt,
  }
}

export const GET = composeHireApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 60, keyPrefix: 'rl:hire-assessment-export-status' },
  async handler(_req, { user, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const assessmentExport = await getHireAssessmentExportStatus(ctx, params.exportId)
    return NextResponse.json(
      { assessmentExport: serializeAssessmentExport(assessmentExport) },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  },
})
