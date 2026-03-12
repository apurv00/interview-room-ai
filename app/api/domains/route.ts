import { NextResponse } from 'next/server'
import { connectDB } from '@/lib/db/connection'
import { InterviewDomain } from '@/lib/db/models'
import { FALLBACK_DOMAINS } from '@/lib/db/seed'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    await connectDB()
    const domains = await InterviewDomain.find({ isActive: true })
      .sort({ sortOrder: 1 })
      .select('slug label shortLabel icon description color category systemPromptContext')
      .lean()

    if (domains.length > 0) {
      return NextResponse.json(domains)
    }
  } catch {
    // DB not available — fall through to fallback
  }

  return NextResponse.json(FALLBACK_DOMAINS)
}
