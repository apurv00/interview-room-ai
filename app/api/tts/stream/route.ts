import { NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { aiLogger } from '@shared/logger'

export const dynamic = 'force-dynamic'

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY
const TTS_MODEL = process.env.DEEPGRAM_TTS_MODEL || 'aura-2-zeus-en'

/**
 * Streaming TTS endpoint — pipes Deepgram's audio response directly
 * to the client without buffering. This reduces time-to-first-sound
 * from ~1-3s (buffered) to ~300-500ms (streaming).
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

    // Add punctuation-based pauses (Deepgram Aura does not support SSML)
    let processedText = text
    processedText = processedText.replace(/\b(So,|Now,|Alright,|Great,|Okay,|Well,) /g, '$1... ')

    // Determine encoding — prefer opus if client requests it
    const encoding = req.nextUrl.searchParams.get('encoding') === 'opus' ? 'opus' : 'mp3'
    const contentType = encoding === 'opus' ? 'audio/opus' : 'audio/mpeg'

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

    // Pass through Deepgram's response body as a stream — no buffering
    return new Response(response.body, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
        'Transfer-Encoding': 'chunked',
      },
    })
  } catch (err) {
    aiLogger.error({ err }, 'TTS stream route error')
    return new Response(JSON.stringify({ error: 'TTS failed' }), { status: 500 })
  }
}
