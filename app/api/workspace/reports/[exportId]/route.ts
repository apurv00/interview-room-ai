/** Member-only opaque lifecycle status for a report export. */

import { NextResponse } from 'next/server'
import { requireMembership } from '@hire/services/workspaceService'
import { getHireReportExportStatus } from '@/modules/hire-reports/services/hireReportExportService'
import { composeHireApiRoute } from '../../_lib/composeHireApiRoute'
import { serializeHireReportExport } from '../_lib/reportExportResponse'

export const dynamic = 'force-dynamic'

export const GET = composeHireApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 60, keyPrefix: 'rl:hire-report-export-status' },
  async handler(_req, { user, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const reportExport = await getHireReportExportStatus(ctx, params.exportId)
    return NextResponse.json(
      { reportExport: serializeHireReportExport(reportExport) },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  },
})
