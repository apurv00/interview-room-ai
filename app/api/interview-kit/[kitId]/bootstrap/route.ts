import { isIP } from 'node:net'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { bootstrapHumanInterviewKit } from '@hire'
import { checkRateLimit } from '@shared/middleware/checkRateLimit'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const OBJECT_ID = /^[a-f0-9]{24}$/i
const KIT_CAPABILITY = /^[a-f0-9]{24}\.[a-f0-9]{24}\.[a-f0-9]{64}$/i
const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store',
  'Pragma': 'no-cache',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
}

const BodySchema = z
  .object({
    capability: z.string().regex(KIT_CAPABILITY),
  })
  .strict()

function noStore(response: NextResponse): NextResponse {
  for (const [name, value] of Object.entries(NO_STORE_HEADERS)) {
    response.headers.set(name, value)
  }
  return response
}

function inactive(): NextResponse {
  return NextResponse.json(
    { error: 'This interview kit link is no longer active' },
    { status: 410, headers: NO_STORE_HEADERS },
  )
}

function isCapabilityForKit(capability: string, kitId: string): boolean {
  const [, capabilityKitId] = capability.split('.')
  return capabilityKitId?.toLowerCase() === kitId.toLowerCase()
}

function requestIp(req: NextRequest): string {
  const firstValidIp = (raw: string | null): string | undefined => {
    const value = raw?.split(',')[0]?.trim()
    return value && isIP(value) ? value : undefined
  }
  return process.env.VERCEL === '1'
    ? firstValidIp(req.headers.get('x-vercel-forwarded-for'))
        ?? firstValidIp(req.headers.get('x-real-ip'))
        ?? firstValidIp(req.headers.get('x-forwarded-for'))
        ?? 'unknown-client'
    : firstValidIp(req.headers.get('cf-connecting-ip'))
        ?? firstValidIp(req.headers.get('x-real-ip'))
        ?? firstValidIp(req.headers.get('x-forwarded-for'))
        ?? 'unknown-client'
}

async function checkBootstrapRateLimits(
  req: NextRequest,
  kitId: string,
): Promise<NextResponse | null> {
  const ipBlocked = await checkRateLimit(requestIp(req), {
    windowMs: 15 * 60_000,
    maxRequests: 30,
    keyPrefix: 'rl:hire-human-kit-bootstrap-ip',
    failClosed: true,
  })
  if (ipBlocked) return noStore(ipBlocked)

  const kitBlocked = await checkRateLimit(kitId.toLowerCase(), {
    windowMs: 15 * 60_000,
    maxRequests: 30,
    keyPrefix: 'rl:hire-human-kit-bootstrap-kit',
    failClosed: true,
  })
  return kitBlocked ? noStore(kitBlocked) : null
}

/**
 * Fixed public entry point for a guest interviewer. It accepts only a
 * fragment-supplied possession capability, never a NextAuth/session cookie.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ kitId: string }> },
) {
  const { kitId } = await params
  if (!OBJECT_ID.test(kitId)) return inactive()

  let capability: string
  try {
    capability = BodySchema.parse(await req.json()).capability
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) return inactive()
    return NextResponse.json(
      { error: 'The interview kit could not be loaded' },
      { status: 500, headers: NO_STORE_HEADERS },
    )
  }
  if (!isCapabilityForKit(capability, kitId)) return inactive()

  const blocked = await checkBootstrapRateLimits(req, kitId)
  if (blocked) return blocked

  try {
    const view = await bootstrapHumanInterviewKit({ kitId, capability })
    if (!view) return inactive()
    return NextResponse.json(
      { ...view, state: 'ok' },
      { headers: NO_STORE_HEADERS },
    )
  } catch {
    return NextResponse.json(
      { error: 'The interview kit could not be loaded' },
      { status: 500, headers: NO_STORE_HEADERS },
    )
  }
}
