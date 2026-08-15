/** Member-only stream for a ready assessment PDF; no object URL is exposed. */

import { NextResponse } from 'next/server'
import { requireMembership } from '@hire'
import { downloadHireAssessmentExport } from '@hire-decisions'
import { composeHireApiRoute } from '../../../_lib/composeHireApiRoute'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export const GET = composeHireApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 30, keyPrefix: 'rl:hire-assessment-export-download' },
  async handler(_req, { user, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const download = await downloadHireAssessmentExport(ctx, params.exportId)
    // Materialize a standards-compatible browser body, rather than passing a
    // Node Buffer through the route boundary. The filename and content type
    // are fixed policy values rather than storage-service input.
    const body = new Uint8Array(download.body.byteLength)
    body.set(download.body)
    return new NextResponse(body, {
      headers: {
        'Cache-Control': 'private, no-store',
        'Content-Disposition': 'attachment; filename="candidate-assessment.pdf"',
        'Content-Type': 'application/pdf',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  },
})
