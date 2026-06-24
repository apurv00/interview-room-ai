import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { aiLogger } from '@shared/logger'
import { getCachedTTS, cacheTTS } from '@shared/services/ttsCache'
import { checkRateLimit } from '@shared/middleware/checkRateLimit'
import { azureSynthesize, isAzureTTSConfigured, AZURE_TTS_MODEL } from '@shared/services/providers/azureTTS'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
// India launch (feedback #4): pin to bom1 (Mumbai) — close to India users AND to the
// Azure centralindia Speech endpoint, so the opt-in Indian-voice TTFB is ~tens of ms
// instead of a cross-continent round-trip. TTS touches no MongoDB (Redis rate-limit +
// R2 cache + Azure/Deepgram only), so it doesn't need the iad1/Atlas proximity the rest
// of the app keeps. Trade-offs to verify post-deploy (INTERVIEW_FLOW.md §8): the Deepgram
// DEFAULT path and the Upstash rate-limit are US-side, so measure real TTFB before relying
// on this — bom1 helps the Indian path but may add latency to the default path.
export const preferredRegion = 'bom1'

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY
const TTS_MODEL = process.env.DEEPGRAM_TTS_MODEL || 'aura-2-luna-en'

/**
 * Sanitize and add punctuation-based pauses for more natural TTS delivery.
 * Deepgram Aura does not support SSML — use punctuation instead.
 */
function sanitizeForTTS(text: string): string {
  let result = text
  // Replace em-dashes and en-dashes with commas — Deepgram reads them
  // as "dash" or creates unnatural pauses
  result = result.replace(/\u2014/g, ',') // em-dash —
  result = result.replace(/\u2013/g, ',') // en-dash –
  // Also handle double-hyphens used as em-dashes
  result = result.replace(/--/g, ',')
  // BUG 3 fix: only add ellipsis pauses to short phrases. On long
  // questions the cumulative pauses cause perceived volume drops and
  // unnatural pacing toward the end of the utterance.
  if (result.length < 200) {
    result = result.replace(/\b(So,|Now,|Alright,|Great,|Okay,|Well,) /g, '$1... ')
  }
  return result
}

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Rate limit — see /api/tts/stream/route.ts for rationale.
    // Same per-user 30/min cap; separate keyPrefix so the two routes'
    // quotas don't interfere with each other's counters.
    const limited = await checkRateLimit(session.user.id, {
      windowMs: 60_000,
      maxRequests: 30,
      keyPrefix: 'rl:tts-buffered',
    })
    if (limited) return limited

    if (!DEEPGRAM_API_KEY) {
      return NextResponse.json({ error: 'TTS not configured' }, { status: 503 })
    }

    const { text } = await req.json()
    if (!text || typeof text !== 'string' || text.length > 5000) {
      return NextResponse.json({ error: 'Invalid text' }, { status: 400 })
    }

    // Indian-voice personality → Azure. Additive: only when ?voice=indian AND
    // Azure is configured; the Deepgram path below is otherwise unchanged.
    const useAzure = req.nextUrl.searchParams.get('voice') === 'indian' && isAzureTTSConfigured()
    const ttsModel = useAzure ? AZURE_TTS_MODEL : TTS_MODEL

    // Check R2 cache first — keyed by ttsModel so Azure/Deepgram never collide.
    const cached = await getCachedTTS(text, 'mp3', ttsModel)
    if (cached) {
      return new NextResponse(new Uint8Array(cached), {
        headers: {
          'Content-Type': 'audio/mpeg',
          'Cache-Control': 'public, max-age=86400',
          'X-TTS-Cache': 'hit',
        },
      })
    }

    const processedText = sanitizeForTTS(text)

    const response = useAzure
      ? await azureSynthesize(processedText)
      : await fetch(
          `https://api.deepgram.com/v1/speak?model=${TTS_MODEL}&encoding=mp3`,
          {
            method: 'POST',
            headers: {
              Authorization: `Token ${DEEPGRAM_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ text: processedText }),
          }
        )

    if (!response.ok) {
      const errorText = await response.text()
      aiLogger.error({ status: response.status, error: errorText, provider: useAzure ? 'azure' : 'deepgram' }, 'TTS failed')
      return NextResponse.json({ error: 'TTS generation failed' }, { status: 502 })
    }

    const audioBuffer = await response.arrayBuffer()
    const audioBytes = Buffer.from(audioBuffer)

    // Cache in R2 (fire-and-forget)
    cacheTTS(text, audioBytes, 'mp3', ttsModel).catch(() => {})

    return new NextResponse(audioBytes, {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-store',
        'X-TTS-Cache': 'miss',
      },
    })
  } catch (err) {
    aiLogger.error({ err }, 'TTS route error')
    return NextResponse.json({ error: 'TTS failed' }, { status: 500 })
  }
}
