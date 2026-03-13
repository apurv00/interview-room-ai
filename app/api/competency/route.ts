import { NextResponse } from 'next/server'
import { composeApiRoute } from '@shared/middleware/composeApiRoute'
import { getUserCompetencySummary, getUserWeaknesses, getCompetenciesForDomain } from '@/lib/services/competencyService'
import { getRecentSummaries } from '@/lib/services/sessionSummaryService'

export const dynamic = 'force-dynamic'

export const GET = composeApiRoute({
  rateLimit: { windowMs: 60_000, maxRequests: 20, keyPrefix: 'rl:competency' },

  async handler(req, { user }) {
    const url = new URL(req.url)
    const domain = url.searchParams.get('domain') || undefined

    const [competencySummary, weaknesses, recentSessions] = await Promise.all([
      getUserCompetencySummary(user.id, domain),
      getUserWeaknesses(user.id, 10),
      getRecentSummaries(user.id, domain, 10),
    ])

    // Get the competency taxonomy for the domain
    const taxonomy = domain ? getCompetenciesForDomain(domain) : []

    return NextResponse.json({
      competencySummary,
      weaknesses,
      recentSessions,
      taxonomy,
    })
  },
})
