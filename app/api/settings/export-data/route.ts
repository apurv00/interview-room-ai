import { NextResponse } from 'next/server'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { generateDataExport } from '@shared/services/dataExportService'

export const dynamic = 'force-dynamic'

/**
 * GET /api/settings/export-data
 *
 * GDPR Article 20 — Data portability.
 * Returns all user data as a JSON download.
 * Rate limited to 3 requests per hour.
 */
export const GET = composeApiRoute({
  rateLimit: { windowMs: 3_600_000, maxRequests: 3, keyPrefix: 'rl:data-export' },

  async handler(_req, { user }) {
    const exportData = await generateDataExport(user.id)

    return new NextResponse(JSON.stringify(exportData, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="interviewprep-data-export-${new Date().toISOString().split('T')[0]}.json"`,
      },
    })
  },
})
