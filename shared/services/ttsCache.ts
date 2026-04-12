import { createHash } from 'crypto'
import { aiLogger } from '@shared/logger'

// ─── TTS Cache via R2 ──────────────────────────────────────────────────────
// Caches TTS audio in R2 keyed by SHA-256 of the exact text.
// Static phrases (intro, wrap-up, thinking acks) get permanent cache.
// Dynamic questions get 30-day TTL (checked via metadata).

const TTS_CACHE_PREFIX = 'tts-cache/'
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

// Module-scoped S3Client — reused across requests to avoid cold-start
// overhead of re-creating the client on every TTS cache lookup (Issue #1).
// Lazy-initialized on first use so missing env vars don't crash at import time.
let _s3Client: import('@aws-sdk/client-s3').S3Client | null = null
async function getS3Client(): Promise<import('@aws-sdk/client-s3').S3Client | null> {
  if (_s3Client) return _s3Client
  const accountId = process.env.R2_ACCOUNT_ID
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
  if (!accountId || !accessKeyId || !secretAccessKey) return null
  const { S3Client } = await import('@aws-sdk/client-s3')
  _s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  })
  return _s3Client
}

/** Generate a deterministic cache key for a TTS text.
 *  Includes the model name so a voice change doesn't serve stale audio
 *  from the previous voice's cache. */
export function ttsCacheKey(text: string, encoding: string = 'mp3', model?: string): string {
  const modelSuffix = model ? `-${model.replace(/[^a-z0-9-]/gi, '')}` : ''
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 16)
  return `${TTS_CACHE_PREFIX}${hash}${modelSuffix}.${encoding}`
}

/** Try to get cached TTS audio from R2. Returns null on miss or error. */
export async function getCachedTTS(text: string, encoding: string = 'mp3', model?: string): Promise<Buffer | null> {
  try {
    const { isR2Configured } = await import('@shared/storage/r2')
    if (!isR2Configured()) return null

    const client = await getS3Client()
    if (!client) return null

    const { GetObjectCommand } = await import('@aws-sdk/client-s3')
    const key = ttsCacheKey(text, encoding, model)
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
export async function cacheTTS(text: string, audio: Buffer | Uint8Array, encoding: string = 'mp3', model?: string): Promise<void> {
  try {
    const { isR2Configured } = await import('@shared/storage/r2')
    if (!isR2Configured()) return

    const client = await getS3Client()
    if (!client) return

    const { PutObjectCommand } = await import('@aws-sdk/client-s3')
    const key = ttsCacheKey(text, encoding, model)
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
