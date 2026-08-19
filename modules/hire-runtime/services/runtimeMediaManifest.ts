import { createHash } from 'node:crypto'
import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import {
  HireEngineResultIngestionSchema,
  type HireEngineResultIngestion,
} from '@shared/contracts/hireEngineBridge'
import { isCanonicalR2Key } from '@shared/storage/r2'

interface RuntimeMediaCandidate {
  kind: 'recording' | 'audio'
  key?: string | null
  sizeBytes?: number | null
  contentType: string
}

type ResolvedRuntimeMediaCandidate = Omit<
  RuntimeMediaCandidate,
  'key' | 'sizeBytes'
> & {
  key: string
  sizeBytes: number
}

function runtimeR2Client(): S3Client {
  const accountId = process.env.R2_ACCOUNT_ID
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error('Runtime R2 credentials are not configured')
  }
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  })
}

function runtimeBucket(): string {
  const value = process.env.R2_BUCKET_NAME
  if (!value) throw new Error('Runtime R2 bucket is not configured')
  return value
}

function assertRuntimeRecordingKey(input: {
  key: string
  principalId: string
  runtimeSessionId: string
}): void {
  if (!isCanonicalR2Key(input.key)) throw new Error('Runtime media key is not canonical')
  const match = /^recordings\/([a-f0-9]{24})\/([a-f0-9]{24})(?:-(?:screen|audio))?-\d{10,16}\.webm$/i
    .exec(input.key)
  if (
    !match ||
    match[1].toLowerCase() !== input.principalId.toLowerCase() ||
    match[2].toLowerCase() !== input.runtimeSessionId.toLowerCase()
  ) {
    throw new Error('Runtime media key crossed its principal/session boundary')
  }
}

function assertRuntimePersonalObjectKey(input: {
  key: string
  principalId: string
  runtimeSessionId?: string
}): void {
  if (!isCanonicalR2Key(input.key)) {
    throw new Error('Runtime personal-data key is not canonical')
  }
  const segments = input.key.split('/')
  if (segments[1] !== input.principalId) {
    throw new Error('Runtime personal-data key crossed its principal boundary')
  }
  if (segments[0] === 'documents') return
  if (!input.runtimeSessionId) {
    throw new Error('Runtime session authority is required for session media')
  }
  if (segments[0] === 'recordings') {
    assertRuntimeRecordingKey(input as Required<typeof input>)
    return
  }
  // New capture attempts use a bounded nonce to make concurrent staging
  // deletion-safe. Keep the exact legacy spelling accepted for cleanup of
  // pre-rollout objects only; ingestion never accepts it as a new artifact.
  const landmarkFile = segments[2]
  const legacyLandmarkFile = `${input.runtimeSessionId}.json`
  const nonceLandmarkFile = new RegExp(
    `^${input.runtimeSessionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[a-f0-9]{32}\\.json$`,
    'i',
  )
  if (
    segments[0] !== 'landmarks' ||
    segments.length !== 3 ||
    (landmarkFile !== legacyLandmarkFile && !nonceLandmarkFile.test(landmarkFile))
  ) {
    throw new Error('Runtime personal-data key crossed its session boundary')
  }
}

async function deleteRuntimeObjects(keys: string[]): Promise<void> {
  const uniqueKeys = Array.from(new Set(keys))
  if (uniqueKeys.length === 0) return
  const client = runtimeR2Client()
  const bucket = runtimeBucket()
  // S3/R2 DeleteObject is idempotent for an absent key. Sequential deletion
  // makes the exact failed key retryable without acknowledging a partial purge.
  for (const key of uniqueKeys) {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
  }
}

async function hashRuntimeObject(candidate: ResolvedRuntimeMediaCandidate): Promise<{
  sha256: string
  sizeBytes: number
}> {
  const response = await runtimeR2Client().send(
    new GetObjectCommand({ Bucket: runtimeBucket(), Key: candidate.key }),
  )
  if (!response.Body) throw new Error('Runtime media object has no body')
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
    hash.update(chunk)
    bytes += chunk.byteLength
  }
  if (bytes !== candidate.sizeBytes) {
    throw new Error('Runtime media size does not match the engine session')
  }
  return { sha256: hash.digest('hex'), sizeBytes: bytes }
}

export async function buildRuntimeMediaManifest(input: {
  principalId: string
  runtimeSessionId: string
  recordingR2Key?: string | null
  recordingSizeBytes?: number | null
  audioRecordingR2Key?: string | null
  audioRecordingSizeBytes?: number | null
}): Promise<HireEngineResultIngestion['media']> {
  const candidates: RuntimeMediaCandidate[] = [
    {
      kind: 'recording',
      key: input.recordingR2Key,
      sizeBytes: input.recordingSizeBytes,
      contentType: 'video/webm',
    },
    {
      kind: 'audio',
      key: input.audioRecordingR2Key,
      sizeBytes: input.audioRecordingSizeBytes,
      contentType: 'audio/webm',
    },
  ]
  const manifest: HireEngineResultIngestion['media'] = []
  for (const candidate of candidates) {
    if (!candidate.key || !candidate.sizeBytes || candidate.sizeBytes <= 0) continue
    const resolved: ResolvedRuntimeMediaCandidate = {
      ...candidate,
      key: candidate.key,
      sizeBytes: candidate.sizeBytes,
    }
    assertRuntimeRecordingKey({
      key: resolved.key,
      principalId: input.principalId,
      runtimeSessionId: input.runtimeSessionId,
    })
    const hashed = await hashRuntimeObject(resolved)
    manifest.push({
      kind: resolved.kind,
      sourceKey: resolved.key,
      contentType: resolved.contentType,
      sizeBytes: hashed.sizeBytes,
      sha256: hashed.sha256,
    })
  }
  return manifest
}

/** Delete only the source objects that were hashed into an acknowledged result. */
export async function deleteRuntimeMediaManifest(input: {
  principalId: string
  runtimeSessionId: string
  media: HireEngineResultIngestion['media']
}): Promise<void> {
  const media = HireEngineResultIngestionSchema.shape.media.parse(input.media)
  for (const artifact of media) {
    if (artifact.kind !== 'recording' && artifact.kind !== 'audio') {
      throw new Error('Runtime result contains an unsupported staged-media kind')
    }
    assertRuntimeRecordingKey({
      key: artifact.sourceKey,
      principalId: input.principalId,
      runtimeSessionId: input.runtimeSessionId,
    })
  }
  await deleteRuntimeObjects(media.map((artifact) => artifact.sourceKey))
}

/**
 * Delete every isolated-runtime object referenced by a principal/session.
 * Callers must supply the owning session for recording and landmark keys;
 * document keys are scoped to the same pseudonymous principal namespace.
 */
export async function deleteRuntimePersonalObjects(input: {
  principalId: string
  objects: Array<{ key: string; runtimeSessionId?: string }>
}): Promise<void> {
  for (const object of input.objects) {
    assertRuntimePersonalObjectKey({
      key: object.key,
      principalId: input.principalId,
      runtimeSessionId: object.runtimeSessionId,
    })
  }
  await deleteRuntimeObjects(input.objects.map((object) => object.key))
}

/** Abort inventoried multipart uploads; an already absent upload is success. */
export async function abortRuntimeMultipartUploads(input: {
  principalId: string
  uploads: Array<{
    key: string
    runtimeSessionId: string
    uploadId: string
  }>
}): Promise<void> {
  if (input.uploads.length === 0) return
  for (const upload of input.uploads) {
    assertRuntimeRecordingKey({
      key: upload.key,
      principalId: input.principalId,
      runtimeSessionId: upload.runtimeSessionId,
    })
  }
  const client = runtimeR2Client()
  const bucket = runtimeBucket()
  for (const upload of input.uploads) {
    try {
      await client.send(
        new AbortMultipartUploadCommand({
          Bucket: bucket,
          Key: upload.key,
          UploadId: upload.uploadId,
        }),
      )
    } catch (error) {
      const code = error && typeof error === 'object'
        ? (error as { name?: unknown; Code?: unknown }).name ??
          (error as { Code?: unknown }).Code
        : undefined
      if (code !== 'NoSuchUpload') throw error
    }
  }
}

export const __runtimeMediaManifest = {
  assertRuntimeRecordingKey,
  assertRuntimePersonalObjectKey,
}
