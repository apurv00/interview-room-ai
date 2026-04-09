import { createHash } from 'crypto'
import { aiLogger } from '@shared/logger'

// ─── TTS Cache via R2 ──────────────────────────────────────────────────────
// Caches TTS audio in R2 keyed by SHA-256 of the exact text.
// Static phrases (intro, wrap-up, thinking acks) get permanent cache.
// Dynamic questions get 30-day TTL (checked via metadata).

const TTS_CACHE_PREFIX = 'tts-cache/'
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

/** Generate a deterministic cache key for a TTS text. */
export function ttsCacheKey(text: string, encoding: string = 'mp3'): string {
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 16)
  return `${TTS_CACHE_PREFIX}${hash}.${encoding}`
}

/** Try to get cached TTS audio from R2. Returns null on miss or error. */
export async function getCachedTTS(text: string, encoding: string = 'mp3'): Promise<Buffer | null> {
  try {
    const { isR2Configured } = await import('@shared/storage/r2')
    if (!isR2Configured()) return null

    const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3')
    const client = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
    })

    const key = ttsCacheKey(text, encoding)
    const response = await client.send(new GetObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME!,
      Key: key,
    }))

    if (!response.Body) return null

    // Check TTL via metadata
    const cachedAt = response.Metadata?.['cached-at']
    if (cachedAt && Date.now() - parseInt(cachedAt) > CACHE_TTL_MS) {
      return null // Expired
    }

    const chunks: Uint8Array[] = []
    const stream = response.Body as AsyncIterable<Uint8Array>
    for await (const chunk of stream) {
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  } catch {
    // Cache miss or R2 error — fall through to Deepgram
    return null
  }
}

/** Store TTS audio in R2 cache. Fire-and-forget — errors are logged but not thrown. */
export async function cacheTTS(text: string, audio: Buffer | Uint8Array, encoding: string = 'mp3'): Promise<void> {
  try {
    const { isR2Configured } = await import('@shared/storage/r2')
    if (!isR2Configured()) return

    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3')
    const client = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
    })

    const key = ttsCacheKey(text, encoding)
    const contentType = encoding === 'opus' ? 'audio/opus' : 'audio/mpeg'

    await client.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME!,
      Key: key,
      Body: audio instanceof Buffer ? audio : Buffer.from(audio),
      ContentType: contentType,
      Metadata: { 'cached-at': String(Date.now()) },
    }))
  } catch (err) {
    aiLogger.warn({ err }, 'TTS cache write failed — non-critical')
  }
}
