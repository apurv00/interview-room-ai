import { NextResponse } from 'next/server'
import { connectDB } from '@shared/db/connection'
import { InterviewDepth, InterviewDomain } from '@shared/db/models'
import { FALLBACK_DEPTHS, FALLBACK_DOMAINS, resolveCategorySlug } from '@shared/db/seed'

export const dynamic = 'force-dynamic'

const CACHE_HEADERS = { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=3600' }

// Canonical set of active depth slugs — source of truth
const ACTIVE_DEPTH_SLUGS = new Set(FALLBACK_DEPTHS.map(d => d.slug))

// A depth applies to a domain when BOTH lists are empty (=all), or the domain
// slug is whitelisted, or the domain's category is whitelisted. Categories let
// e.g. all Programming roles inherit coding/system-design without per-slug lists.
interface DepthApplicability { applicableDomains?: string[]; applicableCategories?: string[] }
function depthApplies(d: DepthApplicability, domain: string, domainCategory?: string): boolean {
  const domains = d.applicableDomains ?? []
  const cats = d.applicableCategories ?? []
  if (domains.length === 0 && cats.length === 0) return true
  if (domains.includes(domain)) return true
  return !!domainCategory && cats.includes(domainCategory)
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const domain = searchParams.get('domain')

  try {
    await connectDB()
    const [depths, domainDoc] = await Promise.all([
      InterviewDepth.find({ isActive: true })
        .sort({ sortOrder: 1 })
        .select('slug label icon description scoringDimensions applicableDomains applicableCategories')
        .lean(),
      domain
        ? InterviewDomain.findOne({ slug: domain }).select('slug category categorySlug').lean<{ slug: string; category?: string; categorySlug?: string }>()
        : Promise.resolve(null),
    ])

    if (depths.length > 0) {
      // Only use DB data if it covers ALL expected depths (otherwise it's stale)
      const filtered = depths.filter(d => ACTIVE_DEPTH_SLUGS.has(d.slug))
      const dbSlugs = new Set(filtered.map(d => d.slug))
      const hasAll = Array.from(ACTIVE_DEPTH_SLUGS).every(s => dbSlugs.has(s))
      if (hasAll) {
        const domainCategory = domainDoc ? resolveCategorySlug(domainDoc) : undefined
        const result = domain ? filtered.filter(d => depthApplies(d, domain, domainCategory)) : filtered
        return NextResponse.json(result, { headers: CACHE_HEADERS })
      }
    }
  } catch {
    // DB not available — fall through to fallback
  }

  // Fallback (DB down/empty): resolve the domain's category from the seed list.
  const domainCategory = domain
    ? (FALLBACK_DOMAINS.find(d => d.slug === domain)?.categorySlug ?? resolveCategorySlug({ slug: domain }))
    : undefined
  const rawFallback = domain
    ? FALLBACK_DEPTHS.filter(d => depthApplies(d, domain, domainCategory))
    : FALLBACK_DEPTHS
  // Strip internal prompt fields from fallback data
  const safeFallback = rawFallback.map(({ systemPromptTemplate, questionStrategy, evaluationCriteria, avatarPersona, ...rest }) => rest)
  return NextResponse.json(safeFallback, { headers: CACHE_HEADERS })
}
