import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import {
  assertHireReportExportObjectKeyScope,
  parseHireReportExportObjectKey,
  type HireReportExportCoordinate,
} from '../models/HireReportExport'
import { HIRE_REPORT_EXPORT_STORAGE_REQUEST_TIMEOUT_MS } from '../models/HireReportExportCleanup'
import type { HireReportFormat } from '../types'

export const HIRE_REPORT_EXPORT_CONTENT_TYPES: Record<HireReportFormat, string> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}
export const HIRE_REPORT_EXPORT_MAX_BYTES = 50 * 1024 * 1024

export interface HireReportExportStoragePort {
  upload(input: {
    key: string
    coordinate: HireReportExportCoordinate
    body: Buffer | Uint8Array
    /** Absolute worker-claim deadline; an old worker cannot begin a new upload. */
    leaseExpiresAt: Date
  }): Promise<void>
  download(input: {
    key: string
    coordinate: HireReportExportCoordinate
  }): Promise<Buffer>
  delete(input: {
    key: string
    coordinate: HireReportExportCoordinate
  }): Promise<void>
}

/**
 * Report artifacts deliberately do not use a generic shared-storage helper:
 * their narrow deterministic grammar, private cache policy, and no-signed-URL
 * contract must not be accidentally widened by a B2C artifact caller.
 */
function r2Client(): S3Client {
  const accountId = process.env.R2_ACCOUNT_ID?.trim()
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim()
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim()
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error('Hire report export R2 credentials are not configured')
  }
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    requestHandler: new NodeHttpHandler({
      connectionTimeout: HIRE_REPORT_EXPORT_STORAGE_REQUEST_TIMEOUT_MS,
      socketTimeout: HIRE_REPORT_EXPORT_STORAGE_REQUEST_TIMEOUT_MS,
    }),
  })
}

function bucket(): string {
  const value = process.env.R2_BUCKET_NAME?.trim()
  if (!value) throw new Error('Hire report export R2 bucket is not configured')
  return value
}

function assertBody(body: Buffer | Uint8Array): void {
  if (body.byteLength < 1 || body.byteLength > HIRE_REPORT_EXPORT_MAX_BYTES) {
    throw new Error('Hire report export artifact is outside the permitted size')
  }
}

function assertStorageScope(key: string, coordinate: HireReportExportCoordinate): void {
  if (!parseHireReportExportObjectKey(key)) {
    throw new Error('Hire report export key is invalid')
  }
  assertHireReportExportObjectKeyScope(key, coordinate)
}

async function responseBuffer(body: unknown): Promise<Buffer> {
  const reader = body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined
  if (!reader?.transformToByteArray) {
    throw new Error('Hire report export object was unreadable')
  }
  const bytes = await reader.transformToByteArray()
  assertBody(bytes)
  return Buffer.from(bytes)
}

function boundedTimeoutMs(deadlineAt?: Date): number {
  if (!deadlineAt) return HIRE_REPORT_EXPORT_STORAGE_REQUEST_TIMEOUT_MS
  const remainingMs = deadlineAt.getTime() - Date.now()
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    throw new Error('Hire report export worker lease expired before R2 upload')
  }
  return Math.min(HIRE_REPORT_EXPORT_STORAGE_REQUEST_TIMEOUT_MS, remainingMs)
}

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

export const hireReportExportStorage: HireReportExportStoragePort = {
  async upload({ key, coordinate, body, leaseExpiresAt }) {
    assertStorageScope(key, coordinate)
    assertBody(body)
    await sendBounded(
      new PutObjectCommand({
        Bucket: bucket(),
        Key: key,
        Body: body,
        ContentType: HIRE_REPORT_EXPORT_CONTENT_TYPES[coordinate.format],
        CacheControl: 'private, no-store',
      }),
      leaseExpiresAt,
    )
  },

  async download({ key, coordinate }) {
    assertStorageScope(key, coordinate)
    const response = await sendBounded<{ Body?: unknown }>(
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
    // R2 delete is idempotent. This is the only cleanup primitive exposed.
    await sendBounded(new DeleteObjectCommand({ Bucket: bucket(), Key: key }))
  },
}

export function isHireReportExportStorageConfigured(): boolean {
  return Boolean(
    process.env.R2_ACCOUNT_ID?.trim() &&
      process.env.R2_ACCESS_KEY_ID?.trim() &&
      process.env.R2_SECRET_ACCESS_KEY?.trim() &&
      process.env.R2_BUCKET_NAME?.trim(),
  )
}

export const __hireReportExportStorage = {
  assertBody,
  boundedTimeoutMs,
}
