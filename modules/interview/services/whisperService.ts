import OpenAI from 'openai'
import { getDownloadPresignedUrl } from '@shared/storage/r2'
import { aiLogger } from '@shared/logger'
import type { WhisperSegment, WhisperWord } from '@shared/types/multimodal'

function getGroqClient(): OpenAI {
  return new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1',
  })
}

// Groq Whisper cost: $0.004 per minute of audio
const WHISPER_COST_PER_MINUTE = 0.004

interface WhisperResult {
  segments: WhisperSegment[]
  durationSeconds: number
  costUsd: number
}

/**
 * Download a recording from R2 and transcribe it with OpenAI Whisper.
 * Returns word-level and segment-level timestamps.
 */
export async function transcribeRecording(r2Key: string): Promise<WhisperResult> {
  const startTime = Date.now()

  // 1. Download the recording from R2
  const presignedUrl = await getDownloadPresignedUrl(r2Key, 300)
  const response = await fetch(presignedUrl)

  if (!response.ok) {
    throw new Error(`Failed to download recording from R2: ${response.status}`)
  }

  const arrayBuffer = await response.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)

  aiLogger.info(
    { r2Key, sizeBytes: buffer.length },
    'Downloaded recording for Whisper transcription'
  )

  // 2. Send to Whisper API
  // Create a File object from the buffer for the API
  const file = new File([buffer], 'recording.webm', { type: 'video/webm' })

  const transcription = await getGroqClient().audio.transcriptions.create({
    model: 'whisper-large-v3-turbo',
    file,
    response_format: 'verbose_json',
    timestamp_granularities: ['word', 'segment'],
  })

  // 3. Parse the response into our types
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawSegments = (transcription as any).segments as Array<{
    id: number
    start: number
    end: number
    text: string
  }> | undefined

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawWords = (transcription as any).words as Array<{
    word: string
    start: number
    end: number
  }> | undefined

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const durationSeconds = (transcription as any).duration as number || 0

  // Build segments with their corresponding words
  const segments: WhisperSegment[] = (rawSegments || []).map((seg) => {
    const segWords: WhisperWord[] = (rawWords || [])
      .filter((w) => w.start >= seg.start && w.end <= seg.end + 0.1)
      .map((w) => ({
        word: w.word.trim(),
        start: w.start,
        end: w.end,
        confidence: 1, // Whisper API doesn't return per-word confidence in verbose_json
      }))

    return {
      id: seg.id,
      start: seg.start,
      end: seg.end,
      text: seg.text.trim(),
      words: segWords,
    }
  })

  const durationMinutes = durationSeconds / 60
  const costUsd = parseFloat((durationMinutes * WHISPER_COST_PER_MINUTE).toFixed(4))

  const elapsedMs = Date.now() - startTime
  aiLogger.info(
    { r2Key, segments: segments.length, words: rawWords?.length || 0, durationSeconds, costUsd, elapsedMs },
    'Whisper transcription complete'
  )

  return { segments, durationSeconds, costUsd }
}
