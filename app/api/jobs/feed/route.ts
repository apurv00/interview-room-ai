import { NextResponse } from 'next/server'
import { connectDB } from '@shared/db/connection'
import { getFeed } from '@jobs'
import { JOB_DOMAINS } from '@jobs'

export const dynamic = 'force-dynamic'

/**
 * GET /api/jobs/feed — PUBLIC (P-2: feed is the anon surface; detail is the
 * gate). Tier-A deterministic rank only; the response never contains JD
 * bodies or apply URLs — those live behind the authed detail route. Query
 * inputs are clamped server-side; the candidate pool is bounded, so an
 * anonymous scan cannot turn this into an unbounded read.
 */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const domainParam = url.searchParams.get('domain') ?? undefined
  const domain = domainParam && JOB_DOMAINS.some((d) => d.id === domainParam) ? domainParam : undefined
  const city = (url.searchParams.get('city') ?? '').slice(0, 80) || undefined
  const page = Number(url.searchParams.get('page') ?? 1)
  // Tier-B inputs come from the CLIENT's sessionStorage (stateless — a
  // stranger's resume structure never persists server-side). Clamped hard:
  // 20 skills × 40 chars, role 80 chars.
  const skills = (url.searchParams.get('skills') ?? '')
    .split(',')
    .map((s) => s.trim().slice(0, 40))
    .filter(Boolean)
    .slice(0, 20)
  const targetRole = (url.searchParams.get('targetRole') ?? '').slice(0, 80) || undefined
  await connectDB()
  const feed = await getFeed({
    domain,
    city,
    page: Number.isFinite(page) ? page : 1,
    skills: skills.length ? skills : undefined,
    targetRole,
  })
  return NextResponse.json(feed)
}
