import { NextResponse } from 'next/server'
import { requireMembership } from '@hire/services/workspaceService'
import {
  HireMediaAccessError,
  createHireMediaDownloadCapability,
} from '@hire/services/mediaAccessService'
import { composeHireApiRoute } from '../../../../_lib/composeHireApiRoute'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export const GET = composeHireApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 60, keyPrefix: 'rl:hire-media-download' },
  async handler(_req, { user, params }) {
    const ctx = await requireMembership({ userId: user.id, email: user.email })
    try {
      const capability = await createHireMediaDownloadCapability({
        workspaceId: ctx.workspace._id.toString(),
        applicationId: params.appId,
        assetId: params.assetId,
      })
      return NextResponse.json(capability, {
        headers: { 'Cache-Control': 'private, no-store' },
      })
    } catch (error) {
      if (error instanceof HireMediaAccessError) {
        return NextResponse.json({ error: 'Media not found' }, { status: 404 })
      }
      throw error
    }
  },
})
