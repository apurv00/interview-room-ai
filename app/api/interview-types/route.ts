import { NextResponse } from 'next/server'
import { connectDB } from '@/lib/db/connection'
import { InterviewDepth } from '@/lib/db/models'
import { FALLBACK_DEPTHS } from '@/lib/db/seed'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const domain = searchParams.get('domain')

  try {
    await connectDB()
    const query: Record<string, unknown> = { isActive: true }

    const depths = await InterviewDepth.find(query)
      .sort({ sortOrder: 1 })
      .select('slug label icon description scoringDimensions applicableDomains systemPromptTemplate questionStrategy evaluationCriteria avatarPersona')
      .lean()

    if (depths.length > 0) {
      // Filter by domain applicability if specified
      const filtered = domain
        ? depths.filter(d => d.applicableDomains.length === 0 || d.applicableDomains.includes(domain))
        : depths
      return NextResponse.json(filtered)
    }
  } catch {
    // DB not available — fall through to fallback
  }

  const fallback = domain
    ? FALLBACK_DEPTHS.filter(d => d.applicableDomains.length === 0 || d.applicableDomains.includes(domain))
    : FALLBACK_DEPTHS
  return NextResponse.json(fallback)
}
