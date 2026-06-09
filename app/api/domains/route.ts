import { NextResponse } from 'next/server'
import { connectDB } from '@shared/db/connection'
import { InterviewDomain, Category } from '@shared/db/models'
import { FALLBACK_DOMAINS, FALLBACK_CATEGORIES, resolveCategorySlug } from '@shared/db/seed'

export const dynamic = 'force-dynamic'

const CACHE_HEADERS = { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=3600' }

export async function GET() {
  try {
    await connectDB()
    const [domains, categoryDocs] = await Promise.all([
      InterviewDomain.find({ isActive: true })
        .sort({ sortOrder: 1 })
        .select('slug label shortLabel icon description color category categorySlug')
        .lean(),
      Category.find({ isActive: true }).select('slug').lean<{ slug: string }[]>(),
    ])

    if (domains.length > 0) {
      // Taxonomy Phase 1 — the DB is the source of truth: return ALL active
      // domains, including CMS-added roles that aren't in the seed. The old
      // ACTIVE_DOMAIN_SLUGS whitelist + hasAll gate silently dropped any
      // non-seed slug, so CMS-created roles never reached users (adding a role
      // required editing seed.ts + redeploying).
      //
      // Validate each domain's categorySlug against the LIVE Category set (not a
      // hardcoded list) so admin-created custom categories are honored; derive a
      // valid slug for any doc that predates the seed backfill.
      const knownSlugs = new Set(
        (categoryDocs.length ? categoryDocs : FALLBACK_CATEGORIES).map(c => c.slug),
      )
      const withCategory = domains.map(d => ({
        ...d,
        categorySlug: resolveCategorySlug(d, knownSlugs),
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
