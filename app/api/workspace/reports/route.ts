/** Member-only pipeline-report request and opaque report-history boundary. */

import { NextResponse } from 'next/server'
import { requireMembership } from '@hire/services/workspaceService'
import {
  listHireReportExports,
  requestHirePipelineStatusReport,
  type HireReportExportMemberView,
} from '@/modules/hire-reports/services/hireReportExportService'
import { buildHirePipelineStatusReportSnapshotFromControlRecords } from '@/modules/hire-reports/services/hirePipelineStatusReportSnapshotFactory'
import {
  RequestHirePipelineStatusReportSchema,
  type RequestHirePipelineStatusReportPayload,
} from '@/modules/hire-reports/validators/hireReports'
import { composeHireApiRoute } from '../_lib/composeHireApiRoute'
import { serializeHireReportExport } from './_lib/reportExportResponse'

export const dynamic = 'force-dynamic'

function serializeReportExports(rows: HireReportExportMemberView[]) {
  return rows.map(serializeHireReportExport)
}

/**
 * The list contains only opaque report lifecycle fields. It deliberately does
 * not provide a snapshot, requester actor, storage location, cleanup state,
 * object key, or worker error detail.
 */
export const GET = composeHireApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 60, keyPrefix: 'rl:hire-report-export-list' },
  async handler(_req, { user }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const reportExports = await listHireReportExports(ctx)
    return NextResponse.json(
      { reportExports: serializeReportExports(reportExports) },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  },
})

/**
 * The request body carries scope, format, and idempotency only. The frozen
 * aggregate snapshot is calculated server-side inside the membership/write
 * transaction by the dedicated report-safe factory.
 */
export const POST = composeHireApiRoute<RequestHirePipelineStatusReportPayload>({
  schema: RequestHirePipelineStatusReportSchema,
  rateLimit: { windowMs: 60_000, maxRequests: 10, keyPrefix: 'rl:hire-report-export-request' },
  async handler(_req, { user, body }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const result = await requestHirePipelineStatusReport(
      ctx,
      body,
      buildHirePipelineStatusReportSnapshotFromControlRecords,
    )
    return NextResponse.json(
      { reportExport: serializeHireReportExport(result.export) },
      {
        status: result.created ? 201 : 200,
        headers: { 'Cache-Control': 'private, no-store' },
      },
    )
  },
})
