import { NextRequest, NextResponse } from 'next/server'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { getDueCompetencies } from '@learn/services/spacedRepetitionService'

export const GET = composeApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 30, keyPrefix: 'learn:due-reviews' },
  handler: async (req: NextRequest, { user }) => {
    const domain = req.nextUrl.searchParams.get('domain') || undefined
    const dueItems = await getDueCompetencies(user.id, domain)

    return NextResponse.json({
      dueCount: dueItems.length,
      items: dueItems,
    })
  },
})
