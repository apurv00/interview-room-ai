import { NextResponse } from 'next/server'
import { connectDB } from '@shared/db/connection'
import { InterviewDomain } from '@shared/db/models'
import { FALLBACK_DOMAINS } from '@shared/db/seed'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    await connectDB()
    const domains = await InterviewDomain.find({ isActive: true })
      .sort({ sortOrder: 1 })
      .select('slug label shortLabel icon description color category')
      .lean()

    if (domains.length > 0) {
      return NextResponse.json(domains, {
        headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=3600' },
      })
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
