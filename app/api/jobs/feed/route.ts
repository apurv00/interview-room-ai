import { createHash } from 'crypto'
import { isIP } from 'net'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { connectDB } from '@shared/db/connection'
import { redis } from '@shared/redis'
import {
  FEED_CURSOR_DIRECTIONS,
  FEED_EXPERIENCE_VALUES,
  FEED_FRESHNESS_VALUES,
  FEED_REMOTE_VALUES,
  FEED_SORT_VALUES,
  InvalidFeedCursorError,
  JOB_DOMAINS,
  getFeed,
  roleToJobsDomain,
  type FeedQuery,
} from '@jobs'

export const dynamic = 'force-dynamic'

const MAX_PERSONALIZED_BODY_BYTES = 8 * 1024
const PRIVATE_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  Pragma: 'no-cache',
} as const
const FEED_RATE_LIMIT = {
  keyPrefix: 'rl:jobs:feed',
  windowMs: 60_000,
  maxRequests: 30,
} as const

const PublicFeedSchema = z.object({
  domain: z.string().max(50).optional(),
  search: z.string().max(80).optional(),
  location: z.string().max(80).optional(),
  remote: z.enum(FEED_REMOTE_VALUES).optional(),
  experience: z.enum(FEED_EXPERIENCE_VALUES).optional(),
  company: z.string().max(100).optional(),
  freshness: z.enum(FEED_FRESHNESS_VALUES).optional(),
  sort: z.enum(FEED_SORT_VALUES).optional(),
  cursor: z.string().max(512).optional(),
  direction: z.enum(FEED_CURSOR_DIRECTIONS).optional(),
  pageSize: z.number().int().min(1).max(50).optional(),
  /** First-page compatibility only; all further navigation is cursor based. */
  page: z.literal(1).optional(),
}).strict()

const PersonalizedFeedSchema = PublicFeedSchema.extend({
  targetRole: z.string().max(80).optional(),
  skills: z.array(z.string().max(40)).max(20).optional(),
}).strict()

type PublicFeedInput = z.infer<typeof PublicFeedSchema>

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

function feedLimitResponse(
  body: unknown,
  status: 429 | 503,
  privateResponse: boolean,
  retryAfterSeconds: number,
) {
  const response = privateResponse
    ? privateJson(body, status)
    : NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
  response.headers.set('Retry-After', String(retryAfterSeconds))
  return response
}

async function checkFeedRateLimit(req: Request, privateResponse: boolean) {
  const firstIp = (header: string | null): string | undefined => {
    const candidate = header?.split(',')[0]?.trim()
    return candidate && isIP(candidate) ? candidate : undefined
  }
  // Use the ingress-owned single-client header. Vercel publishes its own
  // forwarded header; Cloudflare publishes CF-Connecting-IP. The origin must
  // still reject direct traffic so a caller cannot forge proxy headers.
  const address = process.env.VERCEL === '1'
    ? firstIp(req.headers.get('x-vercel-forwarded-for'))
      ?? firstIp(req.headers.get('x-real-ip'))
      ?? firstIp(req.headers.get('x-forwarded-for'))
    : firstIp(req.headers.get('cf-connecting-ip'))
      ?? firstIp(req.headers.get('x-real-ip'))
      ?? firstIp(req.headers.get('x-forwarded-for'))
  // Unknown clients share a deliberately bounded bucket; missing or malformed
  // headers must not turn into an unlimited public aggregation path.
  const clientKey = address ?? 'unknown-client'
  if (process.env.NODE_ENV === 'production' && !process.env.REDIS_URL?.trim()) {
    const body = { error: 'Jobs feed temporarily unavailable', code: 'FEED_RATE_LIMIT_UNAVAILABLE' }
    return feedLimitResponse(body, 503, privateResponse, 30)
  }
  const identifier = `ip:${createHash('sha256').update(clientKey).digest('hex').slice(0, 24)}`
  const key = `${FEED_RATE_LIMIT.keyPrefix}:${identifier}`
  let current: number
  try {
    current = await redis.incr(key)
    if (current === 1) await redis.pexpire(key, FEED_RATE_LIMIT.windowMs)
  } catch {
    const body = { error: 'Jobs feed temporarily unavailable', code: 'FEED_RATE_LIMIT_UNAVAILABLE' }
    return feedLimitResponse(body, 503, privateResponse, 30)
  }
  if (current <= FEED_RATE_LIMIT.maxRequests) return null
  const body = { error: 'Rate limit exceeded. Try again later.' }
  return feedLimitResponse(
    body,
    429,
    privateResponse,
    Math.ceil(FEED_RATE_LIMIT.windowMs / 1_000),
  )
}

function clean(value: string | undefined): string | undefined {
  return value?.trim() || undefined
}

function toPublicFeedQuery(input: PublicFeedInput): FeedQuery | null {
  if (input.direction && !input.cursor) return null
  return {
    domain: input.domain && JOB_DOMAINS.some((candidate) => candidate.id === input.domain)
      ? input.domain
      : undefined,
    search: clean(input.search),
    location: clean(input.location),
    remote: input.remote,
    experience: input.experience,
    company: clean(input.company),
    freshness: input.freshness,
    sort: input.sort,
    cursor: input.cursor,
    direction: input.direction,
    pageSize: input.pageSize,
  }
}

function publicInputFromUrl(url: URL): Record<string, string | number | undefined> {
  return {
    domain: url.searchParams.get('domain') ?? undefined,
    search: url.searchParams.get('q') ?? undefined,
    location: url.searchParams.get('location') ?? undefined,
    remote: url.searchParams.get('remote') ?? undefined,
    experience: url.searchParams.get('experience') ?? undefined,
    company: url.searchParams.get('company') ?? undefined,
    freshness: url.searchParams.get('freshness') ?? undefined,
    sort: url.searchParams.get('sort') ?? undefined,
    cursor: url.searchParams.get('cursor') ?? undefined,
    direction: url.searchParams.get('direction') ?? undefined,
    pageSize: url.searchParams.has('pageSize')
      ? Number(url.searchParams.get('pageSize'))
      : undefined,
    page: url.searchParams.has('page') ? Number(url.searchParams.get('page')) : undefined,
  }
}

function invalidQuery(privateResponse: boolean, code = 'INVALID_FEED_QUERY') {
  const body = { error: 'Invalid feed filters', code }
  return privateResponse ? privateJson(body, 400) : NextResponse.json(body, { status: 400 })
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
  const legacyPage = url.searchParams.get('page')
  if (legacyPage && legacyPage !== '1') return invalidQuery(false, 'CURSOR_PAGINATION_REQUIRED')
  const parsed = PublicFeedSchema.safeParse(publicInputFromUrl(url))
  if (!parsed.success) return invalidQuery(false)
  const query = toPublicFeedQuery(parsed.data)
  if (!query) return invalidQuery(false)
  try {
    const rateLimitBlock = await checkFeedRateLimit(req, false)
    if (rateLimitBlock) return rateLimitBlock
    await connectDB()
    return NextResponse.json(await getFeed(query))
  } catch (error) {
    if (error instanceof InvalidFeedCursorError) return invalidQuery(false, 'INVALID_FEED_CURSOR')
    return NextResponse.json({ error: 'Unable to load jobs' }, { status: 500 })
  }
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

  const publicQuery = toPublicFeedQuery(parsed.data)
  if (!publicQuery) return invalidQuery(true)
  const domain = publicQuery.domain
  const targetRole = parsed.data.targetRole?.trim() || undefined
  const skills = normalizedSkills(parsed.data.skills)
  const roleDomain = domain ? undefined : roleToJobsDomain(targetRole)

  try {
    const rateLimitBlock = await checkFeedRateLimit(req, true)
    if (rateLimitBlock) return rateLimitBlock
    await connectDB()
    const feed = await getFeed({
      ...publicQuery,
      roleDomain,
      skills: skills.length ? skills : undefined,
      targetRole,
    })
    return privateJson(feed)
  } catch (error) {
    if (error instanceof InvalidFeedCursorError) {
      return privateJson({ error: 'Invalid or expired feed cursor', code: 'INVALID_FEED_CURSOR' }, 400)
    }
    return privateJson({ error: 'Unable to load personalized jobs' }, 500)
  }
}
