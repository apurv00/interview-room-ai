import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import {
  assertHireAssessmentExportObjectKeyScope,
  parseHireAssessmentExportObjectKey,
  type HireAssessmentExportCoordinate,
} from '../models/HireAssessmentExport'
import { HIRE_ASSESSMENT_EXPORT_R2_REQUEST_TIMEOUT_MS } from '../models/HireAssessmentExportCleanup'

export const HIRE_ASSESSMENT_EXPORT_CONTENT_TYPE = 'application/pdf'
export const HIRE_ASSESSMENT_EXPORT_MAX_BYTES = 50 * 1024 * 1024

export interface HireAssessmentExportStoragePort {
  upload(input: {
    key: string
    coordinate: HireAssessmentExportCoordinate
    body: Buffer | Uint8Array
    /** Absolute worker-claim deadline; a paused worker may never start after it. */
    leaseExpiresAt: Date
  }): Promise<void>
  download(input: {
    key: string
    coordinate: HireAssessmentExportCoordinate
  }): Promise<Buffer>
  delete(input: {
    key: string
    coordinate: HireAssessmentExportCoordinate
  }): Promise<void>
}

/**
 * This intentionally does not call shared/storage/r2. Assessment exports are
 * private Hire-control artifacts with a narrow key grammar and no presigned
 * URL surface; keeping this client local prevents accidental B2C key reuse.
 */
function r2Client(): S3Client {
  const accountId = process.env.R2_ACCOUNT_ID?.trim()
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim()
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim()
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error('Hire assessment export R2 credentials are not configured')
  }
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    requestHandler: new NodeHttpHandler({
      connectionTimeout: HIRE_ASSESSMENT_EXPORT_R2_REQUEST_TIMEOUT_MS,
      socketTimeout: HIRE_ASSESSMENT_EXPORT_R2_REQUEST_TIMEOUT_MS,
    }),
  })
}

function bucket(): string {
  const value = process.env.R2_BUCKET_NAME?.trim()
  if (!value) throw new Error('Hire assessment export R2 bucket is not configured')
  return value
}

function assertBody(body: Buffer | Uint8Array): void {
  if (body.byteLength < 1 || body.byteLength > HIRE_ASSESSMENT_EXPORT_MAX_BYTES) {
    throw new Error('Hire assessment export PDF is outside the permitted size')
  }
}

function assertStorageScope(key: string, coordinate: HireAssessmentExportCoordinate): void {
  if (!parseHireAssessmentExportObjectKey(key)) {
    throw new Error('Hire assessment export key is invalid')
  }
  assertHireAssessmentExportObjectKeyScope(key, coordinate)
}

async function responseBuffer(body: unknown): Promise<Buffer> {
  const reader = body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined
  if (!reader?.transformToByteArray) {
    throw new Error('Hire assessment export object was unreadable')
  }
  const bytes = await reader.transformToByteArray()
  assertBody(bytes)
  return Buffer.from(bytes)
}

function boundedTimeoutMs(deadlineAt?: Date): number {
  if (!deadlineAt) return HIRE_ASSESSMENT_EXPORT_R2_REQUEST_TIMEOUT_MS
  const remainingMs = deadlineAt.getTime() - Date.now()
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    throw new Error('Hire assessment export worker lease expired before R2 upload')
  }
  return Math.min(HIRE_ASSESSMENT_EXPORT_R2_REQUEST_TIMEOUT_MS, remainingMs)
}

/**
 * Both upload and delete have an abortable, socket-bounded external call.
 * Upload additionally receives an absolute claim deadline, so pausing a
 * worker after final authorization cannot create a new PutObject later.
 */
async function sendBounded<T>(
  command: PutObjectCommand | DeleteObjectCommand | GetObjectCommand,
  deadlineAt?: Date,
): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), boundedTimeoutMs(deadlineAt))
  try {
    return await r2Client().send(command, { abortSignal: controller.signal }) as T
  } finally {
    clearTimeout(timeout)
  }
}

export const hireAssessmentExportStorage: HireAssessmentExportStoragePort = {
  async upload({ key, coordinate, body, leaseExpiresAt }) {
    assertStorageScope(key, coordinate)
    assertBody(body)
    await sendBounded(
      new PutObjectCommand({
        Bucket: bucket(),
        Key: key,
        Body: body,
        ContentType: HIRE_ASSESSMENT_EXPORT_CONTENT_TYPE,
        CacheControl: 'private, no-store',
      }),
      leaseExpiresAt,
    )
  },

  async download({ key, coordinate }) {
    assertStorageScope(key, coordinate)
    const response = await sendBounded<{
      Body?: unknown
    }>(
      new GetObjectCommand({
        Bucket: bucket(),
        Key: key,
        ResponseCacheControl: 'private, no-store',
      }),
    )
    return responseBuffer(response.Body)
  },

  async delete({ key, coordinate }) {
    assertStorageScope(key, coordinate)
    // R2's delete operation is idempotent. It is intentionally the only
    // cleanup primitive exported by this private storage boundary.
    await sendBounded(new DeleteObjectCommand({ Bucket: bucket(), Key: key }))
  },
}

export function isHireAssessmentExportStorageConfigured(): boolean {
  return Boolean(
    process.env.R2_ACCOUNT_ID?.trim() &&
      process.env.R2_ACCESS_KEY_ID?.trim() &&
      process.env.R2_SECRET_ACCESS_KEY?.trim() &&
      process.env.R2_BUCKET_NAME?.trim(),
  )
}
