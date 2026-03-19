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
    const depths = await InterviewDepth.find({ isActive: true })
      .sort({ sortOrder: 1 })
      .select('slug label icon description scoringDimensions applicableDomains')
      .lean()

    if (depths.length > 0) {
      // Filter to only current slugs
      const filtered = depths.filter(d => ACTIVE_DEPTH_SLUGS.has(d.slug))
      // Only use DB data if it covers ALL expected depths (otherwise it's stale)
      const dbSlugs = new Set(filtered.map(d => d.slug))
      const hasAll = Array.from(ACTIVE_DEPTH_SLUGS).every(s => dbSlugs.has(s))
      if (hasAll) {
        const result = domain
          ? filtered.filter(d => d.applicableDomains.length === 0 || d.applicableDomains.includes(domain))
          : filtered
        return NextResponse.json(result, {
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
