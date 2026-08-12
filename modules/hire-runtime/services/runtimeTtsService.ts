import { timingSafeEqual } from 'node:crypto'
import {
  isSarvamTTSConfigured,
  sarvamSynthesize,
} from '@shared/services/providers/sarvamTTS'
import { assertHireRuntimeSurface } from './runtimeBoundary'

export type RuntimeTtsEncoding = 'mp3' | 'opus'
export type RuntimeTtsProvider = 'deepgram' | 'sarvam'

function deepgramConfiguration(): { apiKey: string; model: string } | null {
  const apiKey = process.env.DEEPGRAM_API_KEY
  if (!apiKey) return null
  return {
    apiKey,
    model: process.env.DEEPGRAM_TTS_MODEL || 'aura-2-luna-en',
  }
}
export function authorizeRuntimeTtsBoundary(header: string | null): boolean {
  if (process.env.IPG_SURFACE !== 'hire-engine') return false
  const secret = process.env.HIRE_RUNTIME_FENCE_SECRET
  if (!header || !secret || secret.length < 32 || header.length !== secret.length) {
    return false
  }
  return timingSafeEqual(Buffer.from(header), Buffer.from(secret))
}

export function sanitizeRuntimeTts(
  text: string,
  mode: 'buffered' | 'streaming',
): string {
  let result = text
    .replace(/\u2014/g, ',')
    .replace(/\u2013/g, ',')
    .replace(/--/g, ',')
  if (mode === 'streaming' || result.length < 200) {
    result = result.replace(
      /\b(So,|Now,|Alright,|Great,|Okay,|Well,) /g,
      '$1... ',
    )
  }
  return result
}

/**
 * Runtime-only provider boundary. It deliberately has no import from, read
 * of, or write to the shared content-addressed TTS cache.
 */
export async function synthesizeRuntimeTts(input: {
  text: string
  encoding: RuntimeTtsEncoding
  indianVoice: boolean
  mode: 'buffered' | 'streaming'
}): Promise<{ response: Response; provider: RuntimeTtsProvider; encoding: RuntimeTtsEncoding }> {
  assertHireRuntimeSurface()
  const useSarvam = input.indianVoice && isSarvamTTSConfigured()
  const encoding = useSarvam ? 'mp3' : input.encoding
  const processedText = sanitizeRuntimeTts(input.text, input.mode)
  if (useSarvam) {
    return {
      response: await sarvamSynthesize(processedText),
      provider: 'sarvam',
      encoding,
    }
  }

  const deepgram = deepgramConfiguration()
  if (!deepgram) {
    return {
      response: new Response('TTS not configured', { status: 503 }),
      provider: 'deepgram',
      encoding,
    }
  }
  return {
    response: await fetch(
      `https://api.deepgram.com/v1/speak?model=${encodeURIComponent(deepgram.model)}&encoding=${encoding}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Token ${deepgram.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: processedText }),
        cache: 'no-store',
        signal: AbortSignal.timeout(30_000),
      },
    ),
    provider: 'deepgram',
    encoding,
  }
}
