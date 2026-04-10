import { NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { aiLogger } from '@shared/logger'
import { getCachedTTS, cacheTTS } from '@shared/services/ttsCache'

export const dynamic = 'force-dynamic'

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY
const TTS_MODEL = process.env.DEEPGRAM_TTS_MODEL || 'aura-2-zeus-en'

/**
 * Streaming TTS endpoint — checks R2 cache first, then falls back to
 * Deepgram Aura. Caches the result for future hits.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
    }

    if (!DEEPGRAM_API_KEY) {
      return new Response(JSON.stringify({ error: 'TTS not configured' }), { status: 503 })
    }

    const { text } = await req.json()
    if (!text || typeof text !== 'string' || text.length > 5000) {
      return new Response(JSON.stringify({ error: 'Invalid text' }), { status: 400 })
    }

    const encoding = req.nextUrl.searchParams.get('encoding') === 'opus' ? 'opus' : 'mp3'
    const contentType = encoding === 'opus' ? 'audio/opus' : 'audio/mpeg'

    // Check R2 cache first — serves cached audio without Deepgram call
    const cached = await getCachedTTS(text, encoding)
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

    const response = await fetch(
      `https://api.deepgram.com/v1/speak?model=${TTS_MODEL}&encoding=${encoding}`,
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
      aiLogger.error({ status: response.status, error: errorText }, 'Deepgram TTS stream failed')
      return new Response(JSON.stringify({ error: 'TTS generation failed' }), { status: 502 })
    }

    // Buffer the response so we can both return it AND cache it
    const audioBuffer = await response.arrayBuffer()
    const audioBytes = Buffer.from(audioBuffer)

    // Cache in R2 (fire-and-forget)
    cacheTTS(text, audioBytes, encoding).catch(() => {})

    return new Response(audioBytes, {
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
