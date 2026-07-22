import { NextResponse } from 'next/server'
import { z } from 'zod'
import { connectDB } from '@shared/db/connection'
import { getFeed } from '@jobs'
import { JOB_DOMAINS, roleToJobsDomain } from '@jobs'

export const dynamic = 'force-dynamic'

const MAX_PERSONALIZED_BODY_BYTES = 8 * 1024
const PRIVATE_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  Pragma: 'no-cache',
} as const

const PersonalizedFeedSchema = z.object({
  domain: z.string().max(50).optional(),
  page: z.number().int().min(1).max(10_000).optional(),
  targetRole: z.string().max(80).optional(),
  skills: z.array(z.string().max(40)).max(20).optional(),
}).strict()

function normalizedSkills(skills: string[] | undefined): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of skills ?? []) {
    const skill = value.trim()
    const key = skill.toLowerCase()
    if (!skill || seen.has(key)) continue
    seen.add(key)
    result.push(skill)
  }
  return result
}

function privateJson(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: PRIVATE_NO_STORE_HEADERS })
}

/**
 * GET /api/jobs/feed — PUBLIC Tier-A discovery. Only non-sensitive navigation
 * inputs belong in this URL. Resume-derived skills and target role use POST
 * below so they never enter access logs, browser tooling, or copied URLs.
 */
export async function GET(req: Request) {
  const url = new URL(req.url)
  if (url.searchParams.has('skills') || url.searchParams.has('targetRole')) {
    return privateJson(
      {
        error: 'Personalized feed preferences must be sent in the request body',
        code: 'PERSONALIZATION_REQUIRES_POST',
      },
      400,
    )
  }
  const domainParam = url.searchParams.get('domain') ?? undefined
  const domain = domainParam && JOB_DOMAINS.some((d) => d.id === domainParam) ? domainParam : undefined
  const page = Number(url.searchParams.get('page') ?? 1)
  await connectDB()
  const feed = await getFeed({
    domain,
    page: Number.isFinite(page) ? page : 1,
  })
  return NextResponse.json(feed)
}

/**
 * POST /api/jobs/feed — public, stateless Tier-B ranking. The body is tightly
 * bounded and never persisted; the response is private/non-cacheable because
 * matchedSkills reveals which resume-derived signals affected the ranking.
 */
export async function POST(req: Request) {
  const declaredLength = Number(req.headers.get('content-length') ?? 0)
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PERSONALIZED_BODY_BYTES) {
    return privateJson({ error: 'Request too large' }, 413)
  }

  let raw: unknown
  try {
    const text = await req.text()
    if (new TextEncoder().encode(text).byteLength > MAX_PERSONALIZED_BODY_BYTES) {
      return privateJson({ error: 'Request too large' }, 413)
    }
    raw = JSON.parse(text)
  } catch {
    return privateJson({ error: 'Invalid JSON' }, 400)
  }

  const parsed = PersonalizedFeedSchema.safeParse(raw)
  if (!parsed.success) {
    return privateJson({ error: 'Invalid feed preferences' }, 400)
  }

  const domain = parsed.data.domain && JOB_DOMAINS.some((d) => d.id === parsed.data.domain)
    ? parsed.data.domain
    : undefined
  const targetRole = parsed.data.targetRole?.trim() || undefined
  const skills = normalizedSkills(parsed.data.skills)
  const roleDomain = domain ? undefined : roleToJobsDomain(targetRole)

  try {
    await connectDB()
    const feed = await getFeed({
      domain,
      roleDomain,
      page: parsed.data.page ?? 1,
      skills: skills.length ? skills : undefined,
      targetRole,
    })
    return privateJson(feed)
  } catch {
    return privateJson({ error: 'Unable to load personalized jobs' }, 500)
  }
}
