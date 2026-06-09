import { NextResponse } from 'next/server'
import { connectDB } from '@shared/db/connection'
import { Category } from '@shared/db/models'
import { FALLBACK_CATEGORIES } from '@shared/db/seed'

export const dynamic = 'force-dynamic'

const CACHE_HEADERS = { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=3600' }

/**
 * Public taxonomy categories for the setup category step + homepage catalog.
 * DB is the source of truth; falls back to the seed list only when the DB is
 * unavailable/empty so the shape never depends on whether the seed has run.
 *
 * Returns all active categories (including `general`); the UI decides how to
 * render them (e.g. `general` as a search escape, 0-domain categories hidden).
 */
export async function GET() {
  try {
    await connectDB()
    const categories = await Category.find({ isActive: true })
      .sort({ sortOrder: 1 })
      .select('slug label icon description sortOrder parentSlug')
      .lean()
    if (categories.length > 0) {
      return NextResponse.json(categories, { headers: CACHE_HEADERS })
    }
  } catch {
    // DB unavailable — fall through to fallback
  }
  return NextResponse.json(FALLBACK_CATEGORIES, { headers: CACHE_HEADERS })
}
