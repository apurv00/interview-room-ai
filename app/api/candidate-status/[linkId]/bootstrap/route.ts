import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { CandidateStatusCapabilitySchema } from '@/modules/hire-status/validators/hireStatus'
import { resolveCandidateStatusLink } from '@/modules/hire-status/services/candidateStatusLinkService'
import { checkRateLimit } from '@shared/middleware/checkRateLimit'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const OBJECT_ID = /^[a-f0-9]{24}$/i
const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store',
  Pragma: 'no-cache',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
}

const BodySchema = z.object({ capability: CandidateStatusCapabilitySchema }).strict()

function noStore(response: NextResponse): NextResponse {
  for (const [name, value] of Object.entries(NO_STORE_HEADERS)) {
    response.headers.set(name, value)
  }
  return response
}

function inactive(): NextResponse {
  return NextResponse.json(
    { error: 'This application status link is no longer active' },
    { status: 410, headers: NO_STORE_HEADERS },
  )
}

function isCapabilityForLink(capability: string, linkId: string): boolean {
  const [, , , , capabilityLinkId] = capability.split('.')
  return capabilityLinkId?.toLowerCase() === linkId.toLowerCase()
}

function capabilityRateLimitKey(capability: string): string {
  // Redis/log keys must never contain a raw capability or a link coordinate.
  // Hashing the complete validated capability also keeps guessed secrets from
  // exhausting a real holder's per-capability bucket.
  return createHash('sha256').update(capability, 'utf8').digest('hex')
}

function requestIp(req: NextRequest): string {
  const firstValidIp = (raw: string | null): string | undefined => {
    const value = raw?.split(',')[0]?.trim()
    return value && isIP(value) ? value : undefined
  }
  return process.env.VERCEL === '1'
    ? (firstValidIp(req.headers.get('x-vercel-forwarded-for')) ??
        firstValidIp(req.headers.get('x-real-ip')) ??
        firstValidIp(req.headers.get('x-forwarded-for')) ??
        'unknown-client')
    : (firstValidIp(req.headers.get('cf-connecting-ip')) ??
        firstValidIp(req.headers.get('x-real-ip')) ??
        firstValidIp(req.headers.get('x-forwarded-for')) ??
        'unknown-client')
}

async function checkBootstrapRateLimits(
  req: NextRequest,
  capability: string,
): Promise<NextResponse | null> {
  const ipBlocked = await checkRateLimit(requestIp(req), {
    windowMs: 15 * 60_000,
    maxRequests: 30,
    keyPrefix: 'rl:hire-candidate-status-bootstrap-ip',
    failClosed: true,
  })
  if (ipBlocked) return noStore(ipBlocked)
  const capabilityBlocked = await checkRateLimit(capabilityRateLimitKey(capability), {
    windowMs: 15 * 60_000,
    maxRequests: 30,
    keyPrefix: 'rl:hire-candidate-status-bootstrap-capability',
    failClosed: true,
  })
  return capabilityBlocked ? noStore(capabilityBlocked) : null
}

/** Sessionless, fragment-capability bootstrap for a neutral application status DTO. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ linkId: string }> }) {
  const { linkId } = await params
  if (!OBJECT_ID.test(linkId)) return inactive()
  let capability: string
  try {
    capability = BodySchema.parse(await req.json()).capability
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) return inactive()
    return NextResponse.json(
      { error: 'The application status could not be loaded' },
      { status: 500, headers: NO_STORE_HEADERS },
    )
  }
  if (!isCapabilityForLink(capability, linkId)) return inactive()
  const blocked = await checkBootstrapRateLimits(req, capability)
  if (blocked) return blocked
  try {
    const status = await resolveCandidateStatusLink({ linkId, capability })
    if (!status) return inactive()
    return NextResponse.json({ state: 'ok', status }, { headers: NO_STORE_HEADERS })
  } catch {
    return NextResponse.json(
      { error: 'The application status could not be loaded' },
      { status: 500, headers: NO_STORE_HEADERS },
    )
  }
}
