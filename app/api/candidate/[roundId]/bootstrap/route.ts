import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { verifyRoundToken } from '@hire/services/aiRoundService'
import { HireJob } from '@hire/models/HireJob'
import { HireWorkspace } from '@hire/models/HireWorkspace'
import { checkRateLimit } from '@shared/middleware/checkRateLimit'
import { obfuscateHireEmail } from '@hire/services/privacyService'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const BodySchema = z
  .object({
    capability: z.string().regex(/^[a-f0-9]{24}\.[a-f0-9]{64}$/i),
  })
  .strict()

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ roundId: string }> },
) {
  const { roundId } = await params
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  const blocked = await checkRateLimit(`${ip}:${roundId}`, {
    windowMs: 15 * 60_000,
    maxRequests: 20,
    keyPrefix: 'rl:hire-candidate-bootstrap',
  })
  if (blocked) return blocked

  try {
    const body = BodySchema.parse(await req.json())
    const verified = await verifyRoundToken(roundId, body.capability)
    if (!verified) {
      return NextResponse.json(
        { error: 'This interview link is no longer valid' },
        { status: 410, headers: { 'Cache-Control': 'private, no-store' } },
      )
    }

    const { round } = verified
    if (verified.state !== 'ok') {
      return NextResponse.json(
        {
          state: verified.state,
          privacyAvailable: true,
        },
        { headers: { 'Cache-Control': 'private, no-store' } },
      )
    }

    const [job, workspace] = await Promise.all([
      HireJob.findOne({
        _id: round.jobId,
        workspaceId: round.workspaceId,
      })
        .select('title')
        .lean(),
      HireWorkspace.findOne({
        _id: round.workspaceId,
        $or: [
          { lifecycleState: 'active' },
          { lifecycleState: { $exists: false } },
        ],
      })
        .select('name')
        .lean(),
    ])
    if (!job || !workspace) {
      return NextResponse.json(
        { error: 'This interview link is no longer valid' },
        { status: 410, headers: { 'Cache-Control': 'private, no-store' } },
      )
    }

    return NextResponse.json(
      {
        state: 'ok',
        privacyAvailable: true,
        workspaceName: workspace.name,
        jobTitle: job.title,
        duration: round.config.duration,
        authMode: round.authMode === 'otp' ? 'otp' : 'magic_link',
        consentAlreadyGiven: Boolean(round.consentAt),
        emailHint: obfuscateHireEmail(round.candidateEmail),
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return NextResponse.json(
        { error: 'This interview link is no longer valid' },
        { status: 410, headers: { 'Cache-Control': 'private, no-store' } },
      )
    }
    return NextResponse.json(
      { error: 'The interview could not be loaded' },
      { status: 500, headers: { 'Cache-Control': 'private, no-store' } },
    )
  }
}
