import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { resolveApplyToken } from '@hire/services/applyPageService'
import { checkRateLimit } from '@shared/middleware/checkRateLimit'

export const dynamic = 'force-dynamic'

const BodySchema = z
  .object({
    capability: z.string().regex(/^[a-f0-9]{24}\.[a-f0-9]{64}$/i),
  })
  .strict()

export async function POST(req: NextRequest) {
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  const blocked = await checkRateLimit(ip, {
    windowMs: 15 * 60_000,
    maxRequests: 30,
    keyPrefix: 'rl:hire-apply-resolve',
  })
  if (blocked) return blocked

  try {
    const { capability } = BodySchema.parse(await req.json())
    const view = await resolveApplyToken(capability)
    if (!view) {
      return NextResponse.json(
        { error: 'This application link is no longer active' },
        { status: 404, headers: { 'Cache-Control': 'private, no-store' } },
      )
    }
    return NextResponse.json(
      {
        jobTitle: view.job.title,
        workspaceName: view.workspaceName,
        companyDescription: view.companyDescription,
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return NextResponse.json(
        { error: 'This application link is no longer active' },
        { status: 404, headers: { 'Cache-Control': 'private, no-store' } },
      )
    }
    return NextResponse.json(
      { error: 'The application page could not be loaded' },
      { status: 500, headers: { 'Cache-Control': 'private, no-store' } },
    )
  }
}
