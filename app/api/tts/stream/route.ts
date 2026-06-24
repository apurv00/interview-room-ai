import { NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { aiLogger } from '@shared/logger'
import { getCachedTTS, cacheTTS } from '@shared/services/ttsCache'
import { checkRateLimit } from '@shared/middleware/checkRateLimit'
import { azureSynthesize, isAzureTTSConfigured, AZURE_TTS_MODEL } from '@shared/services/providers/azureTTS'

export const dynamic = 'force-dynamic'

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY
const TTS_MODEL = process.env.DEEPGRAM_TTS_MODEL || 'aura-2-luna-en'

/**
 * Streaming TTS endpoint — checks R2 cache first, then falls back to
 * Deepgram Aura. On a cache miss the Deepgram response body is tee'd:
 * one branch streams progressively to the client (time-to-first-sound
 * ~300–500ms), the other branch drains in the background and writes
 * the complete audio to R2 so the next identical request hits the
 * cache fast path.
 *
 * HOT PATH — see CLAUDE.md. Do NOT change this to buffer the whole
 * response before returning. That regression broke the interview
 * pipeline in commit 133e44f; see
 * modules/interview/docs/INTERVIEW_FLOW.md §8.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
    }

    // Rate limit to cap Deepgram cost exposure from a compromised or
    // scripted session. Normal interview peak is 2-4 req/min (intro +
    // Q1 + thinking ack) and averages ~1 req/min over a 30-min session;
    // 30/min gives ~10x headroom for retries/prefetches while hard-
    // stopping abuse. Fail-open on redis error so a cache blip doesn't
    // block legitimate interviews. Redis keying on user id — anonymous
    // requests are already blocked by the auth check above.
    const limited = await checkRateLimit(session.user.id, {
      windowMs: 60_000,
      maxRequests: 30,
      keyPrefix: 'rl:tts-stream',
    })
    if (limited) return limited

    if (!DEEPGRAM_API_KEY) {
      return new Response(JSON.stringify({ error: 'TTS not configured' }), { status: 503 })
    }

    const { text } = await req.json()
    if (!text || typeof text !== 'string' || text.length > 5000) {
      return new Response(JSON.stringify({ error: 'Invalid text' }), { status: 400 })
    }

    const encoding = req.nextUrl.searchParams.get('encoding') === 'opus' ? 'opus' : 'mp3'
    // Indian-voice personality → Azure. Purely additive: only when the request
    // carries ?voice=indian AND Azure is configured; the Deepgram path below is
    // otherwise byte-for-byte unchanged. Azure emits MP3, so force mp3 there.
    const useAzure = req.nextUrl.searchParams.get('voice') === 'indian' && isAzureTTSConfigured()
    const enc = useAzure ? 'mp3' : encoding
    const ttsModel = useAzure ? AZURE_TTS_MODEL : TTS_MODEL
    const contentType = enc === 'opus' ? 'audio/opus' : 'audio/mpeg'

    // Check R2 cache first — serves cached audio without a provider call.
    // Keyed by ttsModel so Azure and Deepgram audio never collide.
    const cached = await getCachedTTS(text, enc, ttsModel)
    if (cached) {
      return new Response(new Uint8Array(cached), {
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=86400',
          'X-TTS-Cache': 'hit',
        },
      })
    }

    // Sanitize text for TTS: replace dashes (read as "dash") and add pauses
    let processedText = text
    processedText = processedText.replace(/\u2014/g, ',') // em-dash —
    processedText = processedText.replace(/\u2013/g, ',') // en-dash –
    processedText = processedText.replace(/--/g, ',')     // double-hyphen
    processedText = processedText.replace(/\b(So,|Now,|Alright,|Great,|Okay,|Well,) /g, '$1... ')

    const response = useAzure
      ? await azureSynthesize(processedText)
      : await fetch(
          `https://api.deepgram.com/v1/speak?model=${TTS_MODEL}&encoding=${enc}`,
          {
            method: 'POST',
            headers: {
              Authorization: `Token ${DEEPGRAM_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ text: processedText }),
          }
        )

    if (!response.ok || !response.body) {
      const errorText = await response.text()
      aiLogger.error({ status: response.status, error: errorText, provider: useAzure ? 'azure' : 'deepgram' }, 'TTS stream failed')
      return new Response(JSON.stringify({ error: 'TTS generation failed' }), { status: 502 })
    }

    // Tee the Deepgram stream: one branch streams to the client so the
    // browser starts decoding audio as the first chunk arrives (~300ms
    // time-to-first-sound), the other drains in the background and
    // writes the complete buffer to R2 for next time.
    const [clientStream, cacheStream] = response.body.tee()

    // Fire-and-forget: drain the cache branch and upload to R2. Errors
    // are non-fatal — a missing cache write just means the next identical
    // request will re-hit Deepgram, same as before the cache existed.
    ;(async () => {
      try {
        const reader = cacheStream.getReader()
        const chunks: Uint8Array[] = []
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) chunks.push(value)
        }
        if (chunks.length > 0) {
          await cacheTTS(text, Buffer.concat(chunks), enc, ttsModel)
        }
      } catch (err) {
        aiLogger.warn({ err }, 'TTS cache branch drain failed — non-fatal')
      }
    })()

    return new Response(clientStream, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
        'X-TTS-Cache': 'miss',
      },
    })
  } catch (err) {
    aiLogger.error({ err }, 'TTS stream route error')
    return new Response(JSON.stringify({ error: 'TTS failed' }), { status: 500 })
  }
}
