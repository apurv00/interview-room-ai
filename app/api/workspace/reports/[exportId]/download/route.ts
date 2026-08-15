/** Member-only Node stream for a ready private report artifact. */

import { NextResponse } from 'next/server'
import { AppError } from '@shared/errors'
import { requireMembership } from '@hire/services/workspaceService'
import { downloadHireReportExport } from '@/modules/hire-reports/services/hireReportExportService'
import { HIRE_REPORT_EXPORT_CONTENT_TYPES } from '@/modules/hire-reports/services/hireReportExportStorage'
import { composeHireApiRoute } from '../../../_lib/composeHireApiRoute'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function safeDownloadPolicy(contentType: string): {
  contentType: string
  filename: string
} {
  if (contentType === HIRE_REPORT_EXPORT_CONTENT_TYPES.pdf) {
    return { contentType, filename: 'hire-report.pdf' }
  }
  if (contentType === HIRE_REPORT_EXPORT_CONTENT_TYPES.xlsx) {
    return { contentType, filename: 'hire-report.xlsx' }
  }
  throw new AppError('The report export is unavailable', 410, 'REPORT_EXPORT_UNAVAILABLE')
}

/**
 * The service owns private object access. This route receives bytes only and
 * materializes a browser body with fixed response policy values; it never
 * serializes or redirects to a storage URL.
 */
export const GET = composeHireApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 30, keyPrefix: 'rl:hire-report-export-download' },
  async handler(_req, { user, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const download = await downloadHireReportExport(ctx, params.exportId)
    const policy = safeDownloadPolicy(download.contentType)
    const body = new Uint8Array(download.body.byteLength)
    body.set(download.body)
    return new NextResponse(body, {
      headers: {
        'Cache-Control': 'private, no-store',
        'Content-Disposition': `attachment; filename="${policy.filename}"`,
        'Content-Type': policy.contentType,
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  },
})
