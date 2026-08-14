import { isIP } from 'node:net'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { submitHumanInterviewKitScorecard } from '@hire'
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

const DIMENSION_KEYS = [
  'role_capability',
  'problem_solving',
  'communication',
  'collaboration',
] as const

const BodySchema = z
  .object({
    capability: z.string().regex(KIT_CAPABILITY),
    dimensions: z
      .array(
        z.object({
          key: z.enum(DIMENSION_KEYS),
          rating: z.number().int().min(1).max(5),
          evidence: z.string().trim().min(1).max(1200),
        }).strict(),
      )
      .length(DIMENSION_KEYS.length)
      .refine(
        (dimensions) =>
          dimensions.every((dimension, index) => dimension.key === DIMENSION_KEYS[index]),
        'Scorecard dimensions must use the fixed canonical order',
      ),
    recommendation: z.enum(['strong_yes', 'yes', 'no', 'strong_no']),
    overallComment: z.string().trim().min(1).max(2000),
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

async function checkScorecardRateLimits(
  req: NextRequest,
  kitId: string,
): Promise<NextResponse | null> {
  const ipBlocked = await checkRateLimit(requestIp(req), {
    windowMs: 15 * 60_000,
    maxRequests: 8,
    keyPrefix: 'rl:hire-human-kit-scorecard-ip',
    failClosed: true,
  })
  if (ipBlocked) return noStore(ipBlocked)

  const kitBlocked = await checkRateLimit(kitId.toLowerCase(), {
    windowMs: 15 * 60_000,
    maxRequests: 8,
    keyPrefix: 'rl:hire-human-kit-scorecard-kit',
    failClosed: true,
  })
  return kitBlocked ? noStore(kitBlocked) : null
}

/**
 * Submits the one fixed guest scorecard. The core service repeats all
 * application, workspace, expiry, revocation, and candidate-privacy fences
 * atomically, so a stale bootstrap can never submit after a lifecycle change.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ kitId: string }> },
) {
  const { kitId } = await params
  if (!OBJECT_ID.test(kitId)) return inactive()

  let body: z.infer<typeof BodySchema>
  try {
    body = BodySchema.parse(await req.json())
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) return inactive()
    return NextResponse.json(
      { error: 'The scorecard could not be submitted' },
      { status: 500, headers: NO_STORE_HEADERS },
    )
  }
  if (!isCapabilityForKit(body.capability, kitId)) return inactive()

  const blocked = await checkScorecardRateLimits(req, kitId)
  if (blocked) return blocked

  try {
    const submitted = await submitHumanInterviewKitScorecard({ kitId, ...body })
    if (!submitted) return inactive()
    return NextResponse.json({ state: 'submitted' }, { headers: NO_STORE_HEADERS })
  } catch {
    return NextResponse.json(
      { error: 'The scorecard could not be submitted' },
      { status: 500, headers: NO_STORE_HEADERS },
    )
  }
}
