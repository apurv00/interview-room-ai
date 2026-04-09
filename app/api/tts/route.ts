import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { aiLogger } from '@shared/logger'
import { getCachedTTS, cacheTTS } from '@shared/services/ttsCache'

export const dynamic = 'force-dynamic'

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY
const TTS_MODEL = process.env.DEEPGRAM_TTS_MODEL || 'aura-2-zeus-en'

/**
 * Add punctuation-based pauses for more natural TTS delivery.
 * Deepgram Aura does not support SSML — use punctuation instead.
 */
function addNaturalPauses(text: string): string {
  let result = text
  // Add ellipsis after transitional phrases for a slight pause
  result = result.replace(/\b(So,|Now,|Alright,|Great,|Okay,|Well,) /g, '$1... ')
  return result
}

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    if (!DEEPGRAM_API_KEY) {
      return NextResponse.json({ error: 'TTS not configured' }, { status: 503 })
    }

    const { text } = await req.json()
    if (!text || typeof text !== 'string' || text.length > 5000) {
      return NextResponse.json({ error: 'Invalid text' }, { status: 400 })
    }

    // Check R2 cache first
    const cached = await getCachedTTS(text, 'mp3')
    if (cached) {
      return new NextResponse(new Uint8Array(cached), {
        headers: {
          'Content-Type': 'audio/mpeg',
          'Cache-Control': 'public, max-age=86400',
          'X-TTS-Cache': 'hit',
        },
      })
    }

    const processedText = addNaturalPauses(text)

    const response = await fetch(
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
      aiLogger.error({ status: response.status, error: errorText }, 'Deepgram TTS failed')
      return NextResponse.json({ error: 'TTS generation failed' }, { status: 502 })
    }

    const audioBuffer = await response.arrayBuffer()
    const audioBytes = Buffer.from(audioBuffer)

    // Cache in R2 (fire-and-forget)
    cacheTTS(text, audioBytes, 'mp3').catch(() => {})

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
