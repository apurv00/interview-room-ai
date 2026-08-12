import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

const OBJECT_ID = /^[a-f0-9]{24}$/i
const HIRE_MEDIA_KEY = /^hire-media\/([a-f0-9]{24})\/([a-f0-9]{24})\/([a-f0-9]{24})\/([a-f0-9]{24})\/([a-f0-9]{24})-(identity-photo|camera-recording|audio-recording)\.(jpg|webm)$/i

export const HIRE_MEDIA_DOWNLOAD_TTL_SECONDS = 300

export interface HireMediaCoordinate {
  workspaceId: string
  applicationId: string
  roundId: string
  attemptId: string
  assetId: string
}

export type HireMediaStorageKind =
  | 'identity-photo'
  | 'camera-recording'
  | 'audio-recording'

export interface HireMediaStoragePort {
  upload(input: {
    key: string
    body: Buffer | Uint8Array
    contentType: string
  }): Promise<void>
  signDownload(input: { key: string; expiresInSeconds?: number }): Promise<string>
  delete(input: { key: string; coordinate: HireMediaCoordinate }): Promise<void>
}

export class InvalidHireMediaKeyError extends Error {
  constructor() {
    super('Hire media key is outside the authorized scope')
    this.name = 'InvalidHireMediaKeyError'
  }
}

function r2Client(): S3Client {
  const accountId = process.env.R2_ACCOUNT_ID
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error('R2 credentials are not configured')
  }
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  })
}

function bucket(): string {
  const value = process.env.R2_BUCKET_NAME
  if (!value) throw new Error('R2_BUCKET_NAME is not configured')
  return value
}

function assertCoordinate(input: HireMediaCoordinate): void {
  if (Object.values(input).some((value) => !OBJECT_ID.test(value))) {
    throw new InvalidHireMediaKeyError()
  }
}

export function hireMediaKey(
  coordinate: HireMediaCoordinate,
  kind: HireMediaStorageKind,
): string {
  assertCoordinate(coordinate)
  const extension = kind === 'identity-photo' ? 'jpg' : 'webm'
  return [
    'hire-media',
    coordinate.workspaceId,
    coordinate.applicationId,
    coordinate.roundId,
    coordinate.attemptId,
    `${coordinate.assetId}-${kind}.${extension}`,
  ].join('/')
}

export function parseHireMediaKey(key: string):
  | (HireMediaCoordinate & { kind: HireMediaStorageKind })
  | null {
  if (!key || key.length > 1000 || key.includes('%') || key.includes('\\')) return null
  const match = HIRE_MEDIA_KEY.exec(key)
  if (!match) return null
  return {
    workspaceId: match[1],
    applicationId: match[2],
    roundId: match[3],
    attemptId: match[4],
    assetId: match[5],
    kind: match[6] as HireMediaStorageKind,
  }
}

export function assertHireMediaKeyScope(
  key: string,
  coordinate: HireMediaCoordinate,
): void {
  assertCoordinate(coordinate)
  const parsed = parseHireMediaKey(key)
  if (
    !parsed ||
    parsed.workspaceId !== coordinate.workspaceId ||
    parsed.applicationId !== coordinate.applicationId ||
    parsed.roundId !== coordinate.roundId ||
    parsed.attemptId !== coordinate.attemptId ||
    parsed.assetId !== coordinate.assetId
  ) {
    throw new InvalidHireMediaKeyError()
  }
}

export const hireMediaStorage: HireMediaStoragePort = {
  async upload({ key, body, contentType }) {
    if (!parseHireMediaKey(key)) throw new InvalidHireMediaKeyError()
    await r2Client().send(
      new PutObjectCommand({
        Bucket: bucket(),
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: 'private, no-store',
      }),
    )
  },

  async signDownload({ key, expiresInSeconds = HIRE_MEDIA_DOWNLOAD_TTL_SECONDS }) {
    if (!parseHireMediaKey(key)) throw new InvalidHireMediaKeyError()
    if (
      !Number.isInteger(expiresInSeconds) ||
      expiresInSeconds < 30 ||
      expiresInSeconds > HIRE_MEDIA_DOWNLOAD_TTL_SECONDS
    ) {
      throw new Error('Hire media download TTL must be between 30 and 300 seconds')
    }
    return getSignedUrl(
      r2Client(),
      new GetObjectCommand({
        Bucket: bucket(),
        Key: key,
        ResponseCacheControl: 'private, no-store',
      }),
      { expiresIn: expiresInSeconds },
    )
  },

  async delete({ key, coordinate }) {
    assertHireMediaKeyScope(key, coordinate)
    await r2Client().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }))
  },
}

export function isHireMediaStorageConfigured(): boolean {
  return Boolean(
    process.env.R2_ACCOUNT_ID &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY &&
      process.env.R2_BUCKET_NAME,
  )
}
