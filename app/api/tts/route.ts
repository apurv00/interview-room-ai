import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { aiLogger } from '@shared/logger'

export const dynamic = 'force-dynamic'

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY
const TTS_MODEL = process.env.DEEPGRAM_TTS_MODEL || 'aura-2-zeus-en'

/**
 * Add lightweight SSML prosody hints for more natural delivery.
 * Inserts pauses after question marks and transitional phrases.
 */
function addProsodyHints(text: string): string {
  let result = text
  // Add brief pause after question marks for natural cadence
  result = result.replace(/\?\s+/g, '? <break time="250ms"/> ')
  // Add pause after transitional phrases
  result = result.replace(/\b(So,|Now,|Alright,|Great,|Okay,|Well,)\s/g, '$1 <break time="200ms"/> ')
  // Add slight pause before "and" in lists for clarity
  result = result.replace(/,\s+and\s/g, ', <break time="150ms"/> and ')
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

    const processedText = addProsodyHints(text)

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

    return new NextResponse(audioBuffer, {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    aiLogger.error({ err }, 'TTS route error')
    return NextResponse.json({ error: 'TTS failed' }, { status: 500 })
  }
}
