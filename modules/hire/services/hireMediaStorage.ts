import { createHash } from 'node:crypto'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { HireMediaKind } from '../models/HireMediaAsset'

const OBJECT_ID = /^[a-f0-9]{24}$/i
const OBJECT_KEY_NONCE = /^[a-f0-9]{64}$/
const LEGACY_HIRE_MEDIA_KEY = /^hire-media\/([a-f0-9]{24})\/([a-f0-9]{24})\/([a-f0-9]{24})\/([a-f0-9]{24})\/([a-f0-9]{24})-(identity-photo|camera-recording|screen-recording|audio-recording|facial-landmarks)\.(jpg|webm|json)$/i
const V2_HIRE_MEDIA_KEY = /^hire-media\/v2\/([a-f0-9]{64})$/
const HIRE_MEDIA_SCOPE_DOMAIN = 'ipg-hire-media-key-scope:v2'
const HIRE_MEDIA_TOMBSTONE_CONTENT_TYPE = 'application/octet-stream'

export const HIRE_MEDIA_DOWNLOAD_TTL_SECONDS = 300
export const HIRE_MEDIA_WRITE_TIMEOUT_MS = 240 * 1000
export const HIRE_MEDIA_LEASE_CLEANUP_MARGIN_MS = 5 * 60 * 1000

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
  | 'screen-recording'
  | 'audio-recording'
  | 'facial-landmarks'

export function hireMediaStorageKindForAsset(
  kind: HireMediaKind,
): HireMediaStorageKind {
  switch (kind) {
    case 'identity_photo':
      return 'identity-photo'
    case 'camera_recording':
      return 'camera-recording'
    case 'screen_recording':
      return 'screen-recording'
    case 'audio_recording':
      return 'audio-recording'
    case 'facial_landmarks':
      return 'facial-landmarks'
    default: {
      const unreachable: never = kind
      throw new Error(`Unsupported Hire media kind: ${String(unreachable)}`)
    }
  }
}

export interface HireMediaStoragePort {
  upload(input: {
    key: string
    coordinate: HireMediaCoordinate
    kind: HireMediaStorageKind
    objectKeyNonce: string
    body: Buffer | Uint8Array
    contentType: string
    signal?: AbortSignal
  }): Promise<void>
  signDownload(input: {
    key: string
    coordinate: HireMediaCoordinate
    kind: HireMediaStorageKind
    objectKeyNonce: string | undefined
    expiresInSeconds?: number
  }): Promise<string>
  delete(input: {
    key: string
    coordinate: HireMediaCoordinate
    kind: HireMediaStorageKind
    objectKeyNonce: string | undefined
  }): Promise<void>
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

function extensionFor(kind: HireMediaStorageKind): 'jpg' | 'webm' | 'json' {
  return kind === 'identity-photo'
    ? 'jpg'
    : kind === 'facial-landmarks'
      ? 'json'
      : 'webm'
}

function scopeDigest(
  coordinate: HireMediaCoordinate,
  kind: HireMediaStorageKind,
  objectKeyNonce: string,
): string {
  if (!OBJECT_KEY_NONCE.test(objectKeyNonce)) {
    throw new InvalidHireMediaKeyError()
  }
  const canonicalScope = [
    HIRE_MEDIA_SCOPE_DOMAIN,
    coordinate.workspaceId,
    coordinate.applicationId,
    coordinate.roundId,
    coordinate.attemptId,
    coordinate.assetId,
    kind,
  ]
    .map((value) => value.toLowerCase())
    .join('\0')
  return createHash('sha256')
    .update(canonicalScope)
    .update('\0')
    .update(objectKeyNonce)
    .digest('hex')
}

export function hireMediaKey(
  coordinate: HireMediaCoordinate,
  kind: HireMediaStorageKind,
  objectKeyNonce: string,
): string {
  assertCoordinate(coordinate)
  return `hire-media/v2/${scopeDigest(coordinate, kind, objectKeyNonce)}`
}

export function parseHireMediaKey(key: string):
  | (HireMediaCoordinate & { kind: HireMediaStorageKind })
  | { digest: string }
  | null {
  if (!key || key.length > 1000 || key.includes('%') || key.includes('\\')) return null
  const v2 = V2_HIRE_MEDIA_KEY.exec(key)
  if (v2) {
    return { digest: v2[1] }
  }
  const legacy = LEGACY_HIRE_MEDIA_KEY.exec(key)
  if (!legacy) return null
  const kind = legacy[6] as HireMediaStorageKind
  if (legacy[7].toLowerCase() !== extensionFor(kind)) return null
  return {
    workspaceId: legacy[1],
    applicationId: legacy[2],
    roundId: legacy[3],
    attemptId: legacy[4],
    assetId: legacy[5],
    kind,
  }
}

export function assertHireMediaKeyScope(
  key: string,
  coordinate: HireMediaCoordinate,
  kind: HireMediaStorageKind,
  objectKeyNonce: string | undefined,
): void {
  assertCoordinate(coordinate)
  const parsed = parseHireMediaKey(key)
  if (!parsed) throw new InvalidHireMediaKeyError()
  const matches = 'digest' in parsed
    ? Boolean(
        kind &&
          objectKeyNonce &&
          parsed.digest === scopeDigest(coordinate, kind, objectKeyNonce),
      )
    : parsed.workspaceId === coordinate.workspaceId &&
      parsed.applicationId === coordinate.applicationId &&
      parsed.roundId === coordinate.roundId &&
      parsed.attemptId === coordinate.attemptId &&
      parsed.assetId === coordinate.assetId &&
      parsed.kind === kind
  if (!matches) {
    throw new InvalidHireMediaKeyError()
  }
}

export function assertHireMediaV2KeyScope(
  key: string,
  coordinate: HireMediaCoordinate,
  kind: HireMediaStorageKind,
  objectKeyNonce: string,
): void {
  assertHireMediaKeyScope(key, coordinate, kind, objectKeyNonce)
  const parsed = parseHireMediaKey(key)
  if (!parsed || !('digest' in parsed)) throw new InvalidHireMediaKeyError()
}

export const hireMediaStorage: HireMediaStoragePort = {
  async upload({
    key,
    coordinate,
    kind,
    objectKeyNonce,
    body,
    contentType,
    signal,
  }) {
    assertHireMediaV2KeyScope(key, coordinate, kind, objectKeyNonce)
    await r2Client().send(
      new PutObjectCommand({
        Bucket: bucket(),
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: 'private, no-store',
        IfNoneMatch: '*',
      }),
      { abortSignal: signal },
    )
  },

  async signDownload({
    key,
    coordinate,
    kind,
    objectKeyNonce,
    expiresInSeconds = HIRE_MEDIA_DOWNLOAD_TTL_SECONDS,
  }) {
    assertHireMediaKeyScope(key, coordinate, kind, objectKeyNonce)
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

  async delete({ key, coordinate, kind, objectKeyNonce }) {
    assertHireMediaKeyScope(key, coordinate, kind, objectKeyNonce)
    const parsed = parseHireMediaKey(key)
    if (!parsed) throw new InvalidHireMediaKeyError()
    if (!('digest' in parsed)) {
      await r2Client().send(
        new DeleteObjectCommand({ Bucket: bucket(), Key: key }),
      )
      return
    }
    // Logical deletion is a permanent, non-PII seal at the same key. Because
    // every media write is conditional, a late PutObject can never resurrect
    // bytes after this acknowledged tombstone wins the object-key race.
    await r2Client().send(
      new PutObjectCommand({
        Bucket: bucket(),
        Key: key,
        Body: new Uint8Array(0),
        ContentLength: 0,
        ContentType: HIRE_MEDIA_TOMBSTONE_CONTENT_TYPE,
        CacheControl: 'private, no-store',
        Metadata: { 'hire-media-tombstone': 'v2' },
      }),
    )
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
