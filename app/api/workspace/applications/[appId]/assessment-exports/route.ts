/** Member-only request for a durable, private candidate assessment PDF. */

import { NextResponse } from 'next/server'
import { requireMembership } from '@hire'
import {
  RequestHireAssessmentExportSchema,
  requestHireAssessmentExport,
  type HireAssessmentExportMemberView,
  type RequestHireAssessmentExportPayload,
} from '@hire-decisions'
import { composeHireApiRoute } from '../../../_lib/composeHireApiRoute'

export const dynamic = 'force-dynamic'

// Application identity belongs exclusively to the scoped path. Requiring a
// second client-supplied copy would either reject the normal request or add a
// mismatched-coordinate surface before the service can authorize it.
const RequestAssessmentExportRouteSchema = RequestHireAssessmentExportSchema.pick({
  operationId: true,
})
type RequestAssessmentExportRoutePayload = Pick<
  RequestHireAssessmentExportPayload,
  'operationId'
>

function serializeAssessmentExport(view: HireAssessmentExportMemberView) {
  return {
    id: view.id,
    status: view.status,
    requestedAt: view.requestedAt,
    expiresAt: view.expiresAt,
    readyAt: view.readyAt,
  }
}

/**
 * The response deliberately contains only the opaque member lifecycle DTO.
 * Object storage details, the immutable decision snapshot, and worker errors
 * stay inside the Hire control plane.
 */
export const POST = composeHireApiRoute<RequestAssessmentExportRoutePayload>({
  schema: RequestAssessmentExportRouteSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 10, keyPrefix: 'rl:hire-assessment-export-request' },
  async handler(_req, { user, body, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const result = await requestHireAssessmentExport(ctx, {
      applicationId: params.appId,
      operationId: body.operationId,
    })
    return NextResponse.json(
      { assessmentExport: serializeAssessmentExport(result.export) },
      {
        status: result.created ? 201 : 200,
        headers: { 'Cache-Control': 'private, no-store' },
      },
    )
  },
})
