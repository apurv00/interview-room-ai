import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { aiLogger } from '@shared/logger'

export const dynamic = 'force-dynamic'

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY
const TTS_MODEL = 'aura-2-zeus-en' // Professional male voice for Alex Chen

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

    const response = await fetch(
      `https://api.deepgram.com/v1/speak?model=${TTS_MODEL}&encoding=mp3`,
      {
        method: 'POST',
        headers: {
          Authorization: `Token ${DEEPGRAM_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text }),
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
