import { NextResponse } from 'next/server'
import { connectDB } from '@shared/db/connection'
import { InterviewDomain } from '@shared/db/models'
import { FALLBACK_DOMAINS, categorySlugFor } from '@shared/db/seed'

export const dynamic = 'force-dynamic'

const CACHE_HEADERS = { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=3600' }

export async function GET() {
  try {
    await connectDB()
    const domains = await InterviewDomain.find({ isActive: true })
      .sort({ sortOrder: 1 })
      .select('slug label shortLabel icon description color category categorySlug')
      .lean()

    if (domains.length > 0) {
      // Taxonomy Phase 1 — the DB is the source of truth: return ALL active
      // domains, including CMS-added roles that aren't in the seed. The old
      // ACTIVE_DOMAIN_SLUGS whitelist + hasAll gate silently dropped any
      // non-seed slug, so CMS-created roles never reached users (adding a role
      // required editing seed.ts + redeploying). Derive a categorySlug for any
      // doc that predates the seed backfill so the shape stays seed-independent.
      const withCategory = domains.map(d => ({
        ...d,
        categorySlug: d.categorySlug ?? categorySlugFor(d.slug),
      }))
      return NextResponse.json(withCategory, { headers: CACHE_HEADERS })
    }
  } catch {
    // DB not available — fall through to fallback
  }

  // DB unavailable or empty — strip internal prompt fields from fallback data
  const safeFallback = FALLBACK_DOMAINS.map(({ systemPromptContext, ...rest }) => rest)
  return NextResponse.json(safeFallback, { headers: CACHE_HEADERS })
}
