import { NextResponse } from 'next/server'
import { requireMembership } from '@hire/services/workspaceService'
import { buildWorkspaceCandidatesCsv } from '@hire/services/workspaceCsvExportService'
import { composeHireApiRoute } from '../../_lib/composeHireApiRoute'

export const dynamic = 'force-dynamic'

function attachmentName(workspaceName: string): string {
  const slug = workspaceName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'workspace'
  return `${slug}-candidates.csv`
}

export const GET = composeHireApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 5, keyPrefix: 'rl:hire-csv-export' },
  async handler(_req, { user }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    const csv = await buildWorkspaceCandidatesCsv(ctx)
    return new NextResponse(`\uFEFF${csv}`, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${attachmentName(ctx.workspace.name)}"`,
        'Cache-Control': 'private, no-store, max-age=0',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  },
})
