import { getServerSession } from 'next-auth'
import { NextRequest, NextResponse } from 'next/server'
import { authOptions } from '@shared/auth/authOptions'
import { aiLogger } from '@shared/logger'
import { checkRateLimit } from '@shared/middleware/checkRateLimit'
import {
  authorizeRuntimeTtsBoundary,
  synthesizeRuntimeTts,
} from '@modules/hire-runtime/services/runtimeTtsService'
import { requireRuntimeWorkspaceId } from '@modules/hire-runtime/services/runtimeTenantScope'

export const dynamic = 'force-dynamic'

const BYPASS_HEADER = 'x-ipg-hire-runtime-fence-bypass'

export async function POST(req: NextRequest): Promise<Response> {
  if (!authorizeRuntimeTtsBoundary(req.headers.get(BYPASS_HEADER))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  const session = await getServerSession(authOptions)
  if (!session?.user?.id || !session.user.organizationId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const workspaceId = requireRuntimeWorkspaceId(session.user.organizationId)
    const limited = await checkRateLimit(
      `${workspaceId}:${session.user.id}`,
      { windowMs: 60_000, maxRequests: 30, keyPrefix: 'rl:hire-runtime-tts-stream' },
    )
    if (limited) return limited

    const body = await req.json() as { text?: unknown }
    if (typeof body.text !== 'string' || body.text.length === 0 || body.text.length > 5_000) {
      return NextResponse.json({ error: 'Invalid text' }, { status: 400 })
    }
    const synthesized = await synthesizeRuntimeTts({
      text: body.text,
      encoding: req.nextUrl.searchParams.get('encoding') === 'opus' ? 'opus' : 'mp3',
      indianVoice: req.nextUrl.searchParams.get('voice') === 'indian',
      mode: 'streaming',
    })
    if (!synthesized.response.ok || !synthesized.response.body) {
      await synthesized.response.body?.cancel().catch(() => undefined)
      return NextResponse.json(
        { error: synthesized.response.status === 503 ? 'TTS not configured' : 'TTS generation failed' },
        { status: synthesized.response.status === 503 ? 503 : 502 },
      )
    }
    return new Response(synthesized.response.body, {
      headers: {
        'Content-Type': synthesized.encoding === 'opus' ? 'audio/opus' : 'audio/mpeg',
        'Cache-Control': 'private, no-store',
        'X-TTS-Cache': 'disabled',
        'X-TTS-Provider': synthesized.provider,
      },
    })
  } catch (error) {
    aiLogger.error({ error }, 'Hire runtime streaming TTS failed')
    return NextResponse.json({ error: 'TTS failed' }, { status: 500 })
  }
}
