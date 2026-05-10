import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  type CompletedPart,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME

function getR2Client(): S3Client {
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    throw new Error('R2 credentials not configured — set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY')
  }

  return new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  })
}

function getBucket(): string {
  if (!R2_BUCKET_NAME) {
    throw new Error('R2_BUCKET_NAME not configured')
  }
  return R2_BUCKET_NAME
}

/** Build a namespaced R2 key: recordings/{userId}/{sessionId}-{ts}.webm */
export function recordingKey(userId: string, sessionId: string): string {
  return `recordings/${userId}/${sessionId}-${Date.now()}.webm`
}

/** Build a namespaced R2 key for the screen-share track of a coding/system-design interview */
export function screenRecordingKey(userId: string, sessionId: string): string {
  return `recordings/${userId}/${sessionId}-screen-${Date.now()}.webm`
}

/** Build a namespaced R2 key for the audio-only recording used by Whisper transcription.
 * Recorded in parallel with the camera webm so Whisper isn't handed a large
 * video file that would exceed Groq's 25MB upload limit. */
export function audioRecordingKey(userId: string, sessionId: string): string {
  return `recordings/${userId}/${sessionId}-audio-${Date.now()}.webm`
}

/** Build a namespaced R2 key: documents/{userId}/{docType}/{filename} */
export function documentKey(userId: string, docType: string, filename: string): string {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_')
  return `documents/${userId}/${docType}/${Date.now()}-${safe}`
}

/** Upload a buffer directly to R2 */
export async function uploadToR2(
  key: string,
  body: Buffer | Uint8Array,
  contentType: string
): Promise<string> {
  const client = getR2Client()
  await client.send(
    new PutObjectCommand({
      Bucket: getBucket(),
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  )
  return key
}

/** Generate a presigned URL for uploading to R2 (PUT) */
export async function getUploadPresignedUrl(
  key: string,
  contentType: string,
  expiresIn = 3600
): Promise<string> {
  const client = getR2Client()
  return getSignedUrl(
    client,
    new PutObjectCommand({
      Bucket: getBucket(),
      Key: key,
      ContentType: contentType,
    }),
    { expiresIn }
  )
}

/** Start a multipart upload for large browser-originated recordings. */
export async function createMultipartUpload(
  key: string,
  contentType: string
): Promise<{ key: string; uploadId: string }> {
  const client = getR2Client()
  const result = await client.send(
    new CreateMultipartUploadCommand({
      Bucket: getBucket(),
      Key: key,
      ContentType: contentType,
    })
  )
  if (!result.UploadId) {
    throw new Error('R2 did not return a multipart upload ID')
  }
  return { key, uploadId: result.UploadId }
}

/** Generate a presigned URL for one multipart upload part. */
export async function getMultipartPartPresignedUrl(
  key: string,
  uploadId: string,
  partNumber: number,
  expiresIn = 3600
): Promise<string> {
  const client = getR2Client()
  return getSignedUrl(
    client,
    new UploadPartCommand({
      Bucket: getBucket(),
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
    }),
    { expiresIn }
  )
}

/** Complete a multipart upload after every part has reached R2. */
export async function completeMultipartUpload(
  key: string,
  uploadId: string,
  parts: CompletedPart[]
): Promise<void> {
  const client = getR2Client()
  await client.send(
    new CompleteMultipartUploadCommand({
      Bucket: getBucket(),
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: parts.slice().sort((a, b) => (a.PartNumber ?? 0) - (b.PartNumber ?? 0)),
      },
    })
  )
}

/** Abort a multipart upload and discard already-uploaded parts. */
export async function abortMultipartUpload(
  key: string,
  uploadId: string
): Promise<void> {
  const client = getR2Client()
  await client.send(
    new AbortMultipartUploadCommand({
      Bucket: getBucket(),
      Key: key,
      UploadId: uploadId,
    })
  )
}

/** Generate a presigned URL for downloading from R2 (GET) */
export async function getDownloadPresignedUrl(
  key: string,
  expiresIn = 900 // 15 minutes — shorter TTL limits URL sharing window
): Promise<string> {
  const client = getR2Client()
  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: getBucket(),
      Key: key,
    }),
    { expiresIn }
  )
}

/** Check whether an object exists at `key`. Returns false on 404; rethrows on other errors. */
export async function objectExists(key: string): Promise<boolean> {
  const client = getR2Client()
  try {
    await client.send(
      new HeadObjectCommand({
        Bucket: getBucket(),
        Key: key,
      })
    )
    return true
  } catch (err) {
    if (err && typeof err === 'object') {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } }
      if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return false
    }
    throw err
  }
}

/** Delete an object from R2 */
export async function deleteFromR2(key: string): Promise<void> {
  const client = getR2Client()
  await client.send(
    new DeleteObjectCommand({
      Bucket: getBucket(),
      Key: key,
    })
  )
}

/** Check if R2 is configured */
export function isR2Configured(): boolean {
  return !!(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET_NAME)
}
