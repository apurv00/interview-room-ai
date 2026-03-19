import { NextResponse } from 'next/server'
import { connectDB } from '@shared/db/connection'
import { InterviewDomain } from '@shared/db/models'
import { FALLBACK_DOMAINS } from '@shared/db/seed'

export const dynamic = 'force-dynamic'

// Canonical set of active domain slugs — source of truth
const ACTIVE_DOMAIN_SLUGS = new Set(FALLBACK_DOMAINS.map(d => d.slug))

export async function GET() {
  try {
    await connectDB()
    const domains = await InterviewDomain.find({ isActive: true })
      .sort({ sortOrder: 1 })
      .select('slug label shortLabel icon description color category')
      .lean()

    if (domains.length > 0) {
      // Filter to only current slugs
      const filtered = domains.filter(d => ACTIVE_DOMAIN_SLUGS.has(d.slug))
      // Only use DB data if it covers ALL expected domains (otherwise it's stale)
      const dbSlugs = new Set(filtered.map(d => d.slug))
      const hasAll = Array.from(ACTIVE_DOMAIN_SLUGS).every(s => dbSlugs.has(s))
      if (hasAll) {
        return NextResponse.json(filtered, {
          headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=3600' },
        })
      }
    }
  } catch {
    // DB not available — fall through to fallback
  }

  // Strip internal prompt fields from fallback data
  const safeFallback = FALLBACK_DOMAINS.map(({ systemPromptContext, ...rest }) => rest)
  return NextResponse.json(safeFallback, {
    headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=3600' },
  })
}
