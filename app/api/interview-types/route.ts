import { NextResponse } from 'next/server'
import { connectDB } from '@shared/db/connection'
import { InterviewDepth } from '@shared/db/models'
import { FALLBACK_DEPTHS } from '@shared/db/seed'

export const dynamic = 'force-dynamic'

// Canonical set of active depth slugs — source of truth
const ACTIVE_DEPTH_SLUGS = new Set(FALLBACK_DEPTHS.map(d => d.slug))

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const domain = searchParams.get('domain')

  try {
    await connectDB()
    const query: Record<string, unknown> = { isActive: true }

    const depths = await InterviewDepth.find(query)
      .sort({ sortOrder: 1 })
      .select('slug label icon description scoringDimensions applicableDomains')
      .lean()

    if (depths.length > 0) {
      // Filter out old depths not in the active set, then filter by domain applicability
      let filtered = depths.filter(d => ACTIVE_DEPTH_SLUGS.has(d.slug))
      if (domain) {
        filtered = filtered.filter(d => d.applicableDomains.length === 0 || d.applicableDomains.includes(domain))
      }
      if (filtered.length > 0) {
        return NextResponse.json(filtered, {
          headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=3600' },
        })
      }
    }
  } catch {
    // DB not available — fall through to fallback
  }

  const rawFallback = domain
    ? FALLBACK_DEPTHS.filter(d => d.applicableDomains.length === 0 || d.applicableDomains.includes(domain))
    : FALLBACK_DEPTHS
  // Strip internal prompt fields from fallback data
  const safeFallback = rawFallback.map(({ systemPromptTemplate, questionStrategy, evaluationCriteria, avatarPersona, ...rest }) => rest)
  return NextResponse.json(safeFallback, {
    headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=3600' },
  })
}
