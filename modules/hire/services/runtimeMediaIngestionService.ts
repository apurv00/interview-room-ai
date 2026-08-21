import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import mongoose from 'mongoose'
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import type { HireEngineResultIngestion } from '@shared/contracts/hireEngineBridge'
import { HireJob } from '../models/HireJob'
import {
  createHireMediaIngestionLease,
  HIRE_MEDIA_INGESTION_LEASE_MS,
  HireMediaAsset,
  type HireMediaIngestionLease,
  type IHireMediaAsset,
} from '../models/HireMediaAsset'
import { HireWorkspace } from '../models/HireWorkspace'
import { addCalendarMonths } from './mediaLifecycleService'
import {
  HIRE_MEDIA_LEASE_CLEANUP_MARGIN_MS,
  HIRE_MEDIA_WRITE_TIMEOUT_MS,
  assertHireMediaV2KeyScope,
  hireMediaKey,
  hireMediaStorage,
  hireMediaStorageKindForAsset,
  type HireMediaCoordinate,
  type HireMediaStorageKind,
} from './hireMediaStorage'
import { connectHireControlDB } from './hireControlBoundary'
import { activeHireWorkspaceLifecycleFilter } from './hireWorkspaceLifecycleFilter'
import {
  claimHireCandidatePiiWriteFence,
  HireCandidatePiiTombstoneError,
} from './hireCandidatePrivacyWriteFence'

type MediaArtifact = HireEngineResultIngestion['media'][number] & {
  /** Temporary scope authority carried only by runtime landmark v2. */
  objectKeyNonce?: string
}
type RuntimeMediaIngestionStream = 'engine_result' | 'multimodal_analysis'

interface RuntimeMediaIngestionIdentity {
  workspaceId: string
  applicationId: string
  roundId: string
  runtimeSessionId: string
  ingestionStream: RuntimeMediaIngestionStream
  ingestionAttempt: number
  ingestionRevision: number
  ingestionEventId: string
  ingestionDigest: string
}

export class HireRuntimeMediaStaleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HireRuntimeMediaStaleError'
  }
}

function runtimeMediaCheckpointKey(
  input: RuntimeMediaIngestionIdentity & { artifactIndex: number },
): string {
  return createHash('sha256')
    .update(
      [
        'ipg-hire-runtime-media-checkpoint:v2',
        input.ingestionStream,
        input.workspaceId,
        input.applicationId,
        input.roundId,
        input.runtimeSessionId,
        input.ingestionAttempt.toString(),
        input.ingestionRevision.toString(),
        input.ingestionEventId,
        input.ingestionDigest,
        input.artifactIndex.toString(),
      ].join('\0'),
    )
    .digest('hex')
}

if (
  HIRE_MEDIA_WRITE_TIMEOUT_MS + HIRE_MEDIA_LEASE_CLEANUP_MARGIN_MS >=
  HIRE_MEDIA_INGESTION_LEASE_MS
) {
  throw new Error('Hire media write deadline must leave cleanup time on its lease')
}

function s3Client(input: {
  accountId?: string
  accessKeyId?: string
  secretAccessKey?: string
  label: string
}): S3Client {
  if (!input.accountId || !input.accessKeyId || !input.secretAccessKey) {
    throw new Error(`${input.label} R2 credentials are not configured`)
  }
  return new S3Client({
    region: 'auto',
    endpoint: `https://${input.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: input.accessKeyId,
      secretAccessKey: input.secretAccessKey,
    },
  })
}

function sourceStorage(): { client: S3Client; bucket: string } {
  const bucket = process.env.HIRE_RUNTIME_R2_BUCKET_NAME
  if (!bucket)
    throw new Error('Hire runtime R2 source bucket is not configured')
  return {
    bucket,
    client: s3Client({
      accountId: process.env.HIRE_RUNTIME_R2_ACCOUNT_ID,
      accessKeyId: process.env.HIRE_RUNTIME_R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.HIRE_RUNTIME_R2_SECRET_ACCESS_KEY,
      label: 'Hire runtime source',
    }),
  }
}

function destinationStorage(): { client: S3Client; bucket: string } {
  const bucket = process.env.R2_BUCKET_NAME
  if (!bucket) throw new Error('Hire control R2 bucket is not configured')
  return {
    bucket,
    client: s3Client({
      accountId: process.env.R2_ACCOUNT_ID,
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      label: 'Hire control',
    }),
  }
}

function runtimePrincipalId(roundId: string): string {
  return createHash('sha256')
    .update(`ipg-hire-runtime-principal:v1:${roundId.toLowerCase()}`)
    .digest('hex')
    .slice(0, 24)
}

function runtimeLandmarkV2ScopeDigest(input: {
  principalId: string
  runtimeSessionId: string
  objectKeyNonce: string
}): string {
  return createHash('sha256')
    .update('interview-room-ai:hire-runtime-landmark:v2\0')
    .update(input.principalId.toLowerCase())
    .update('\0')
    .update(input.runtimeSessionId.toLowerCase())
    .update('\0')
    .update(input.objectKeyNonce.toLowerCase())
    .digest('hex')
}

function assertRuntimeArtifactScope(input: {
  artifact: MediaArtifact
  roundId: string
  runtimeSessionId: string
}): void {
  const expectedOwner = runtimePrincipalId(input.roundId)
  if (input.artifact.kind === 'landmarks') {
    const legacy =
      /^landmarks\/([a-f0-9]{24})\/([a-f0-9]{24})-([a-f0-9]{32})\.json$/i
        .exec(input.artifact.sourceKey)
    const v2 = /^landmarks\/v2\/([a-f0-9]{64})$/
      .exec(input.artifact.sourceKey)
    const legacyMatches = Boolean(
      legacy &&
      !input.artifact.objectKeyNonce &&
      legacy[1].toLowerCase() === expectedOwner &&
      legacy[2].toLowerCase() === input.runtimeSessionId.toLowerCase(),
    )
    const v2Matches = Boolean(
      v2 &&
      /^[a-f0-9]{64}$/.test(input.artifact.objectKeyNonce ?? '') &&
      v2[1] === runtimeLandmarkV2ScopeDigest({
        principalId: expectedOwner,
        runtimeSessionId: input.runtimeSessionId,
        objectKeyNonce: input.artifact.objectKeyNonce as string,
      }),
    )
    if (legacyMatches || v2Matches) return
    throw new Error('Runtime media artifact crossed its round/session boundary')
  }
  const match =
    /^recordings\/([a-f0-9]{24})\/([a-f0-9]{24})(?:-(?:audio|screen))?-\d{10,16}\.webm$/i
      .exec(input.artifact.sourceKey)
  if (
    !match ||
    match[1].toLowerCase() !== expectedOwner ||
    match[2].toLowerCase() !== input.runtimeSessionId.toLowerCase()
  ) {
    throw new Error('Runtime media artifact crossed its round/session boundary')
  }
}

async function copyAndVerify(input: {
  sourceKey: string
  destinationKey: string
  coordinate: HireMediaCoordinate
  storageKind: HireMediaStorageKind
  objectKeyNonce: string
  contentType: string
  expectedBytes: number
  expectedSha256: string
  signal: AbortSignal
}): Promise<void> {
  assertHireMediaV2KeyScope(
    input.destinationKey,
    input.coordinate,
    input.storageKind,
    input.objectKeyNonce,
  )
  const source = sourceStorage()
  const destination = destinationStorage()
  const object = await source.client.send(
    new GetObjectCommand({ Bucket: source.bucket, Key: input.sourceKey }),
    { abortSignal: input.signal },
  )
  if (!object.Body) throw new Error('Runtime media source has no body')

  const hash = createHash('sha256')
  let bytes = 0
  const verifier = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength
      hash.update(chunk)
      callback(null, chunk)
    },
  })
  const body = Readable.from(object.Body as AsyncIterable<Uint8Array>).pipe(
    verifier,
  )
  await destination.client.send(
    new PutObjectCommand({
      Bucket: destination.bucket,
      Key: input.destinationKey,
      Body: body,
      ContentLength: input.expectedBytes,
      ContentType: input.contentType,
      CacheControl: 'private, no-store',
      IfNoneMatch: '*',
    }),
    { abortSignal: input.signal },
  )
  const actualSha256 = hash.digest('hex')
  if (
    bytes !== input.expectedBytes ||
    actualSha256 !== input.expectedSha256
  ) {
    throw new RuntimeMediaChecksumError()
  }
}

function storageStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const metadata = (error as { $metadata?: { httpStatusCode?: unknown } })
    .$metadata
  return typeof metadata?.httpStatusCode === 'number'
    ? metadata.httpStatusCode
    : undefined
}

function isMissingObject(error: unknown): boolean {
  const name =
    typeof error === 'object' && error !== null
      ? (error as { name?: unknown }).name
      : undefined
  return (
    storageStatus(error) === 404 ||
    name === 'NoSuchKey' ||
    name === 'NotFound'
  )
}

function isPreconditionFailure(error: unknown): boolean {
  const name =
    typeof error === 'object' && error !== null
      ? (error as { name?: unknown }).name
      : undefined
  return storageStatus(error) === 412 || name === 'PreconditionFailed'
}

async function verifyExistingDestination(input: {
  destinationKey: string
  expectedBytes: number
  expectedSha256: string
  expectedContentType: string
  signal: AbortSignal
}): Promise<'verified' | 'missing' | 'mismatch'> {
  const destination = destinationStorage()
  let object: unknown
  try {
    object = await destination.client.send(
      new GetObjectCommand({
        Bucket: destination.bucket,
        Key: input.destinationKey,
      }),
      { abortSignal: input.signal },
    )
  } catch (error) {
    if (isMissingObject(error)) return 'missing'
    throw error
  }
  if (typeof object !== 'object' || object === null) return 'mismatch'
  const stored = object as {
    Body?: AsyncIterable<Uint8Array>
    ContentType?: string
  }
  if (!stored.Body) return 'mismatch'
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of stored.Body) {
    bytes += chunk.byteLength
    if (bytes > input.expectedBytes) return 'mismatch'
    hash.update(chunk)
  }
  const contentType =
    typeof stored.ContentType === 'string'
      ? stored.ContentType
      : undefined
  return bytes === input.expectedBytes &&
    hash.digest('hex') === input.expectedSha256 &&
    contentType === input.expectedContentType
    ? 'verified'
    : 'mismatch'
}

const FAILED_COPY_CLEANUP_CODE = 'RUNTIME_MEDIA_TOMBSTONE_FAILED'

async function claimActiveWorkspaceForMedia(
  workspaceId: string,
  session: mongoose.ClientSession,
): Promise<void> {
  const claim = await HireWorkspace.updateOne(
    { _id: workspaceId, ...activeHireWorkspaceLifecycleFilter() },
    { $inc: { writeFenceVersion: 1 } },
    { session },
  )
  if (claim.matchedCount !== 1) {
    throw new HireRuntimeMediaStaleError(
      'Hire workspace is unavailable during media ingestion',
    )
  }
}

async function claimHireJobMediaRetention(
  input: { workspaceId: string; jobId: string },
  session: mongoose.ClientSession,
): Promise<{ purgeEligibleAt: Date; purgeReason: 'job_closed' } | undefined> {
  const job = await HireJob.findOneAndUpdate(
    { _id: input.jobId, workspaceId: input.workspaceId },
    { $inc: { intakeWriteVersion: 1 } },
    {
      new: true,
      session,
      projection: { status: 1, closedAt: 1 },
    },
  )
  if (!job) {
    throw new HireRuntimeMediaStaleError(
      'Hire job is missing during media ingestion',
    )
  }
  const retention = job.status === 'closed' && job.closedAt
    ? {
        purgeEligibleAt: addCalendarMonths(job.closedAt, 6),
        purgeReason: 'job_closed' as const,
      }
    : undefined
  if (retention && retention.purgeEligibleAt <= new Date()) {
    throw new HireRuntimeMediaStaleError(
      'Hire media retention expired during ingestion',
    )
  }
  return retention
}

async function reserveRuntimeMediaIngestion(input: {
  assetId: mongoose.Types.ObjectId
  checkpointKey: string
  checkpointGeneration: number
  existing?: IHireMediaAsset
  workspaceId: string
  applicationId: string
  jobId: string
  candidateId: string
  roundId: string
  attemptId: string
  kind: IHireMediaAsset['kind']
  objectKey: string
  objectKeyNonce: string
  artifact: MediaArtifact
  completedAt: Date
}): Promise<{ staged: IHireMediaAsset; lease: HireMediaIngestionLease }> {
  const lease = createHireMediaIngestionLease()
  const session = await mongoose.startSession()
  let staged: IHireMediaAsset | undefined
  try {
    await session.withTransaction(async () => {
      // Keep the workspace-root-first lock order used by workspace deletion.
      await claimActiveWorkspaceForMedia(input.workspaceId, session)
      await claimHireCandidatePiiWriteFence({
        workspaceId: input.workspaceId,
        candidateId: input.candidateId,
        session,
      })
      const retention = await claimHireJobMediaRetention(input, session)
      if (input.existing) {
        const reclaimed = await HireMediaAsset.updateOne(
          {
            _id: input.existing._id,
            workspaceId: input.workspaceId,
            applicationId: input.applicationId,
            jobId: input.jobId,
            candidateId: input.candidateId,
            roundId: input.roundId,
            attemptId: input.attemptId,
            kind: input.kind,
            state: 'staging',
            ingestionCheckpointKey: input.checkpointKey,
            ingestionCheckpointGeneration: input.checkpointGeneration,
            objectKey: input.objectKey,
            contentType: input.artifact.contentType,
            bytes: input.artifact.sizeBytes,
            sha256: input.artifact.sha256,
            purgeReason: { $ne: 'privacy_request' },
          },
          {
            $set: { ...lease, ...retention },
            $unset: {
              active: 1,
              purgeFailureCode: 1,
              purgeClaimId: 1,
              purgeClaimedAt: 1,
              purgedAt: 1,
              ...(!retention
                ? { purgeEligibleAt: 1, purgeReason: 1 }
                : {}),
            },
          },
          { session },
        )
        if (reclaimed.matchedCount !== 1) {
          throw new Error('Runtime media checkpoint changed before reclaim')
        }
        staged = input.existing
        // The reclaimed document was read before this transaction replaced
        // its lease. Keep the returned in-memory token aligned with the
        // durable row so terminal activation can fence the exact owner.
        staged.ingestionLeaseId = lease.ingestionLeaseId
        staged.ingestionLeaseExpiresAt = lease.ingestionLeaseExpiresAt
        return
      }
      const created = await HireMediaAsset.create(
        [
          {
            _id: input.assetId,
            workspaceId: input.workspaceId,
            applicationId: input.applicationId,
            jobId: input.jobId,
            candidateId: input.candidateId,
            roundId: input.roundId,
            attemptId: input.attemptId,
            kind: input.kind,
            state: 'staging',
            ingestionCheckpointKey: input.checkpointKey,
            ingestionCheckpointGeneration: input.checkpointGeneration,
            ...lease,
            objectKey: input.objectKey,
            objectKeyNonce: input.objectKeyNonce,
            contentType: input.artifact.contentType,
            bytes: input.artifact.sizeBytes,
            sha256: input.artifact.sha256,
            capturedAt: input.completedAt,
            ...retention,
          },
        ],
        { session },
      )
      staged = created[0]
    })
  } finally {
    await session.endSession()
  }
  if (!staged) throw new Error('Runtime media staging transaction did not complete')
  return { staged, lease }
}

async function quarantineAndDeleteFailedCopy(input: {
  assetId: mongoose.Types.ObjectId
  workspaceId: string
  applicationId: string
  jobId: string
  candidateId: string
  roundId: string
  attemptId: string
  objectKey: string
  objectKeyNonce: string
  storageKind: HireMediaStorageKind
  ingestionLeaseId: string
  privacyWon: boolean
}): Promise<'purged' | 'purge_failed' | 'unchanged'> {
  const now = new Date()
  const purgeClaimId = randomUUID()
  const stagingScope = {
    _id: input.assetId,
    workspaceId: input.workspaceId,
    applicationId: input.applicationId,
    jobId: input.jobId,
    candidateId: input.candidateId,
    roundId: input.roundId,
    attemptId: input.attemptId,
    objectKey: input.objectKey,
    state: 'staging' as const,
    ingestionLeaseId: input.ingestionLeaseId,
  }

  // Claim cleanup authority before touching R2. An unknown successful commit
  // may already have activated this row and cleared the lease; in that case the
  // CAS misses and the valid active object must remain untouched. A claim error
  // leaves leased staging for ordinary expiry recovery.
  let claimed: IHireMediaAsset | null = null
  try {
    claimed = await HireMediaAsset.findOneAndUpdate(
      stagingScope,
      {
        $set: {
          state: 'purge_claimed',
          purgeClaimId,
          purgeClaimedAt: now,
          purgeEligibleAt: now,
          purgeReason: input.privacyWon ? 'privacy_request' : 'stale_staging',
          purgeFailureCode: FAILED_COPY_CLEANUP_CODE,
        },
        $unset: {
          active: 1,
          ingestionLeaseId: 1,
          ingestionLeaseExpiresAt: 1,
          purgedAt: 1,
        },
      },
      { new: true },
    )
  } catch {
    return 'unchanged'
  }
  if (!claimed) return 'unchanged'

  const claimScope = {
    _id: input.assetId,
    workspaceId: input.workspaceId,
    applicationId: input.applicationId,
    jobId: input.jobId,
    candidateId: input.candidateId,
    roundId: input.roundId,
    attemptId: input.attemptId,
    objectKey: input.objectKey,
    state: 'purge_claimed' as const,
    purgeClaimId,
  }

  try {
    await hireMediaStorage.delete({
      key: input.objectKey,
      coordinate: {
        workspaceId: input.workspaceId,
        applicationId: input.applicationId,
        roundId: input.roundId,
        attemptId: input.attemptId,
        assetId: input.assetId.toString(),
      },
      kind: input.storageKind,
      objectKeyNonce: input.objectKeyNonce,
    })
  } catch {
    await HireMediaAsset.updateOne(
      claimScope,
      {
        $set: {
          state: 'purge_failed',
          purgeEligibleAt: now,
          purgeReason: input.privacyWon ? 'privacy_request' : 'stale_staging',
          purgeFailureCode: FAILED_COPY_CLEANUP_CODE,
        },
        $unset: {
          active: 1,
          purgeClaimId: 1,
          purgeClaimedAt: 1,
          purgedAt: 1,
        },
      },
    ).catch(() => undefined)
    return 'purge_failed'
  }

  // Only the exact cleanup claim can terminal the row after a tombstone ACK.
  await HireMediaAsset.updateOne(
    claimScope,
    {
      $set: { state: 'purged', purgedAt: new Date() },
      $unset: {
        active: 1,
        ingestionLeaseId: 1,
        ingestionLeaseExpiresAt: 1,
        purgeClaimId: 1,
        purgeClaimedAt: 1,
        purgeFailureCode: 1,
      },
    },
  ).catch(() => undefined)
  return 'purged'
}

type RuntimeMediaIngestionInput = {
  workspaceId: string
  applicationId: string
  jobId: string
  candidateId: string
  roundId: string
  attemptId: string
  runtimeSessionId: string
  ingestionStream: RuntimeMediaIngestionStream
  ingestionAttempt: number
  ingestionRevision: number
  ingestionEventId: string
  ingestionDigest: string
  completedAt: Date
  artifacts: MediaArtifact[]
}

class RuntimeMediaChecksumError extends Error {
  constructor() {
    super('Runtime media checksum verification failed')
    this.name = 'RuntimeMediaChecksumError'
  }
}

interface RuntimeMediaArtifactContext {
  artifact: MediaArtifact
  artifactIndex: number
  kind: IHireMediaAsset['kind']
  storageKind: HireMediaStorageKind
  checkpointKey: string
}

function activeUnexpiredFilter(now: Date) {
  return {
    active: true,
    state: 'ready' as const,
    purgeReason: { $ne: 'privacy_request' },
    $or: [
      { purgeEligibleAt: { $exists: false } },
      { purgeEligibleAt: { $gt: now } },
    ],
  }
}

async function findReusableRuntimeMedia(input: {
  identity: RuntimeMediaIngestionInput
  context: RuntimeMediaArtifactContext
}): Promise<IHireMediaAsset | null> {
  const session = await mongoose.startSession()
  let reusable: IHireMediaAsset | null = null
  try {
    await session.withTransaction(async () => {
      await claimActiveWorkspaceForMedia(input.identity.workspaceId, session)
      await claimHireCandidatePiiWriteFence({
        workspaceId: input.identity.workspaceId,
        candidateId: input.identity.candidateId,
        session,
      })
      await claimHireJobMediaRetention(input.identity, session)
      const reusableScope = {
        workspaceId: input.identity.workspaceId,
        applicationId: input.identity.applicationId,
        jobId: input.identity.jobId,
        candidateId: input.identity.candidateId,
        roundId: input.identity.roundId,
        attemptId: input.identity.attemptId,
        kind: input.context.kind,
        contentType: input.context.artifact.contentType,
        bytes: input.context.artifact.sizeBytes,
        sha256: input.context.artifact.sha256,
        ...activeUnexpiredFilter(new Date()),
      }
      const candidate = await HireMediaAsset.findOne(reusableScope).session(
        session,
      )
      if (!candidate) return
      // This is deliberately read-only with respect to the asset. The caller
      // revalidates it and applies the fresh retention policy inside the same
      // terminal transaction as the result/event. A later lifecycle loss can
      // therefore never leave a pre-terminal asset mutation behind.
      reusable = candidate
    })
  } finally {
    await session.endSession()
  }
  return reusable
}

async function latestRuntimeMediaCheckpoint(
  checkpointKey: string,
): Promise<IHireMediaAsset | null> {
  return HireMediaAsset.findOne({ ingestionCheckpointKey: checkpointKey })
    .sort({ ingestionCheckpointGeneration: -1 })
    .select('+objectKeyNonce')
}

function sameObjectId(value: unknown, expected: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'toString' in value &&
    typeof value.toString === 'function' &&
    value.toString() === expected
  )
}

function assertCheckpointMatches(input: {
  checkpoint: IHireMediaAsset
  identity: RuntimeMediaIngestionInput
  context: RuntimeMediaArtifactContext
}): void {
  const { checkpoint, identity, context } = input
  if (
    !sameObjectId(checkpoint.workspaceId, identity.workspaceId) ||
    !sameObjectId(checkpoint.applicationId, identity.applicationId) ||
    !sameObjectId(checkpoint.jobId, identity.jobId) ||
    !sameObjectId(checkpoint.candidateId, identity.candidateId) ||
    !sameObjectId(checkpoint.roundId, identity.roundId) ||
    !sameObjectId(checkpoint.attemptId, identity.attemptId) ||
    checkpoint.kind !== context.kind ||
    checkpoint.contentType !== context.artifact.contentType ||
    checkpoint.bytes !== context.artifact.sizeBytes ||
    checkpoint.sha256 !== context.artifact.sha256
  ) {
    throw new Error('Runtime media checkpoint identity does not match its event')
  }
  if (!checkpoint.objectKeyNonce) {
    throw new Error('Runtime media checkpoint is missing its opaque key nonce')
  }
  assertHireMediaV2KeyScope(
    checkpoint.objectKey,
    {
      workspaceId: identity.workspaceId,
      applicationId: identity.applicationId,
      roundId: identity.roundId,
      attemptId: identity.attemptId,
      assetId: checkpoint._id.toString(),
    },
    context.storageKind,
    checkpoint.objectKeyNonce,
  )
}

/**
 * Activates an entire verified media batch inside the caller's terminal
 * transaction. Until this succeeds every newly copied object remains an
 * inactive staging checkpoint, so a crash or later-artifact failure cannot
 * replace recruiter-visible media.
 */
export async function activateRuntimeMediaArtifacts(input: {
  assets: IHireMediaAsset[]
  workspaceId: string
  applicationId: string
  jobId: string
  candidateId: string
  roundId: string
  attemptId: string
  session: mongoose.ClientSession
}): Promise<void> {
  await claimActiveWorkspaceForMedia(input.workspaceId, input.session)
  await claimHireCandidatePiiWriteFence({
    workspaceId: input.workspaceId,
    candidateId: input.candidateId,
    session: input.session,
  })
  const retention = await claimHireJobMediaRetention(input, input.session)
  if (input.assets.length === 0) return

  const now = new Date()
  const kinds = new Set<IHireMediaAsset['kind']>()
  for (const asset of input.assets) {
    if (
      !sameObjectId(asset.workspaceId, input.workspaceId) ||
      !sameObjectId(asset.applicationId, input.applicationId) ||
      !sameObjectId(asset.jobId, input.jobId) ||
      !sameObjectId(asset.candidateId, input.candidateId) ||
      !sameObjectId(asset.roundId, input.roundId) ||
      !sameObjectId(asset.attemptId, input.attemptId)
    ) {
      throw new Error('Runtime media activation crossed its Hire coordinate')
    }
    if (kinds.has(asset.kind)) {
      throw new Error('Runtime media activation contains a duplicate kind')
    }
    kinds.add(asset.kind)

    if (asset.state === 'ready') {
      const retained = await HireMediaAsset.updateOne(
        {
          _id: asset._id,
          workspaceId: input.workspaceId,
          applicationId: input.applicationId,
          jobId: input.jobId,
          candidateId: input.candidateId,
          roundId: input.roundId,
          attemptId: input.attemptId,
          kind: asset.kind,
          ...activeUnexpiredFilter(now),
        },
        retention
          ? { $set: retention }
          : { $unset: { purgeEligibleAt: 1, purgeReason: 1 } },
        { session: input.session },
      )
      if (retained.matchedCount !== 1) {
        throw new HireRuntimeMediaStaleError(
          'Reusable runtime media changed before terminal activation',
        )
      }
      continue
    }
    if (
      asset.state !== 'staging' ||
      !asset.ingestionLeaseId ||
      !asset.ingestionLeaseExpiresAt ||
      asset.ingestionLeaseExpiresAt <= now
    ) {
      throw new Error('Runtime media staging lease is unavailable at terminal activation')
    }

    await HireMediaAsset.updateMany(
      {
        workspaceId: input.workspaceId,
        applicationId: input.applicationId,
        jobId: input.jobId,
        candidateId: input.candidateId,
        roundId: input.roundId,
        attemptId: input.attemptId,
        kind: asset.kind,
        active: true,
        _id: { $ne: asset._id },
      },
      {
        $set: { purgeEligibleAt: now, purgeReason: 'replaced' },
        $unset: { active: 1 },
      },
      { session: input.session },
    )
    const activated = await HireMediaAsset.updateOne(
      {
        _id: asset._id,
        workspaceId: input.workspaceId,
        applicationId: input.applicationId,
        jobId: input.jobId,
        candidateId: input.candidateId,
        roundId: input.roundId,
        attemptId: input.attemptId,
        kind: asset.kind,
        state: 'staging',
        objectKey: asset.objectKey,
        contentType: asset.contentType,
        bytes: asset.bytes,
        sha256: asset.sha256,
        ingestionLeaseId: asset.ingestionLeaseId,
        ingestionLeaseExpiresAt: { $gt: now },
        purgeReason: { $ne: 'privacy_request' },
      },
      {
        $set: { state: 'ready', active: true, ...retention },
        $unset: {
          ingestionLeaseId: 1,
          ingestionLeaseExpiresAt: 1,
          purgeFailureCode: 1,
          purgeClaimId: 1,
          purgeClaimedAt: 1,
          purgedAt: 1,
          ...(!retention
            ? { purgeEligibleAt: 1, purgeReason: 1 }
            : {}),
        },
      },
      { session: input.session },
    )
    if (activated.matchedCount !== 1) {
      throw new Error('Runtime media asset changed during terminal activation')
    }
  }
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 11000
  )
}

/**
 * Removes copied artifacts from the active set in the caller's terminal
 * transaction. Lifecycle deletion intentionally happens after commit.
 */
export async function quarantineRuntimeMediaAssets(input: {
  assets: IHireMediaAsset[]
  workspaceId: string
  applicationId: string
  jobId: string
  candidateId: string
  roundId: string
  attemptId: string
  reason: 'privacy_request' | 'stale_staging'
  session: mongoose.ClientSession
}): Promise<void> {
  if (input.assets.length === 0) return
  const scope = {
    _id: { $in: input.assets.map((asset) => asset._id) },
    workspaceId: input.workspaceId,
    applicationId: input.applicationId,
    jobId: input.jobId,
    candidateId: input.candidateId,
    roundId: input.roundId,
    attemptId: input.attemptId,
    ...(input.reason === 'stale_staging'
      ? { purgeReason: { $ne: 'privacy_request' } }
      : {}),
  }
  const now = new Date()
  await HireMediaAsset.updateMany(
      { ...scope, state: 'staging' },
      {
        $set: {
          state: 'purge_failed',
          purgeEligibleAt: now,
          purgeReason: input.reason,
          purgeFailureCode: 'TERMINAL_INGESTION_QUARANTINE',
        },
        $unset: {
          active: 1,
          ingestionLeaseId: 1,
          ingestionLeaseExpiresAt: 1,
          purgeClaimId: 1,
          purgeClaimedAt: 1,
        },
      },
      { session: input.session },
    )
  if (input.reason === 'privacy_request') {
    await HireMediaAsset.updateMany(
      { ...scope, state: 'ready' },
      {
        $set: { purgeEligibleAt: now, purgeReason: input.reason },
        $unset: { active: 1 },
      },
      { session: input.session },
    )
  }
}

async function ingestRuntimeMediaArtifactsBatch(
  input: RuntimeMediaIngestionInput,
  writeSignal: AbortSignal,
): Promise<IHireMediaAsset[]> {
  await connectHireControlDB()
  const supported = input.artifacts
    .map((artifact, artifactIndex) => ({ artifact, artifactIndex }))
    .filter(
      ({ artifact }) =>
        artifact.kind === 'recording' ||
        artifact.kind === 'screen' ||
        artifact.kind === 'audio' ||
        artifact.kind === 'landmarks',
    )
  if (supported.length === 0) return []

  const output: IHireMediaAsset[] = []
  for (const { artifact, artifactIndex } of supported) {
    assertRuntimeArtifactScope({
      artifact,
      roundId: input.roundId,
      runtimeSessionId: input.runtimeSessionId,
    })
    if (artifact.kind === 'landmarks' && artifact.contentType !== 'application/json') {
      throw new Error('Runtime landmark artifact has an invalid content type')
    }
    const kind = artifact.kind === 'recording'
      ? 'camera_recording'
      : artifact.kind === 'screen'
        ? 'screen_recording'
      : artifact.kind === 'audio'
        ? 'audio_recording'
        : 'facial_landmarks'
    const context: RuntimeMediaArtifactContext = {
      artifact,
      artifactIndex,
      kind,
      storageKind: hireMediaStorageKindForAsset(kind),
      checkpointKey: runtimeMediaCheckpointKey({
        ...input,
        artifactIndex,
      }),
    }
    let observedCheckpoint = await latestRuntimeMediaCheckpoint(
      context.checkpointKey,
    )
    if (observedCheckpoint?.state !== 'staging') {
      const reusable = await findReusableRuntimeMedia({
        identity: input,
        context,
      })
      if (reusable) {
        output.push(reusable)
        continue
      }
    }

    let produced = false
    for (
      let generationAttempt = 0;
      generationAttempt <= 100;
      generationAttempt += 1
    ) {
      const latest =
        observedCheckpoint ??
        (await latestRuntimeMediaCheckpoint(context.checkpointKey))
      observedCheckpoint = null
      let checkpointGeneration: number
      let assetId: mongoose.Types.ObjectId
      let objectKeyNonce: string
      let objectKey: string
      let existing: IHireMediaAsset | undefined

      if (latest?.state === 'staging') {
        assertCheckpointMatches({ checkpoint: latest, identity: input, context })
        checkpointGeneration = latest.ingestionCheckpointGeneration ?? 0
        assetId = latest._id
        objectKeyNonce = latest.objectKeyNonce as string
        objectKey = latest.objectKey
        existing = latest
      } else {
        checkpointGeneration = latest
          ? (latest.ingestionCheckpointGeneration ?? -1) + 1
          : 0
        if (checkpointGeneration > 100) {
          throw new Error('Runtime media checkpoint exhausted its generations')
        }
        assetId = new mongoose.Types.ObjectId()
        objectKeyNonce = randomBytes(32).toString('hex')
        const coordinate = {
          workspaceId: input.workspaceId,
          applicationId: input.applicationId,
          roundId: input.roundId,
          attemptId: input.attemptId,
          assetId: assetId.toString(),
        }
        objectKey = hireMediaKey(
          coordinate,
          context.storageKind,
          objectKeyNonce,
        )
      }

      let reserved: Awaited<ReturnType<typeof reserveRuntimeMediaIngestion>>
      try {
        reserved = await reserveRuntimeMediaIngestion({
          assetId,
          checkpointKey: context.checkpointKey,
          checkpointGeneration,
          existing,
          workspaceId: input.workspaceId,
          applicationId: input.applicationId,
          roundId: input.roundId,
          attemptId: input.attemptId,
          jobId: input.jobId,
          candidateId: input.candidateId,
          kind,
          objectKey,
          objectKeyNonce,
          artifact,
          completedAt: input.completedAt,
        })
      } catch (error) {
        if (isDuplicateKeyError(error)) continue
        if (
          existing?.ingestionLeaseId &&
          (error instanceof HireRuntimeMediaStaleError ||
            error instanceof HireCandidatePiiTombstoneError)
        ) {
          await quarantineAndDeleteFailedCopy({
            assetId: existing._id,
            workspaceId: input.workspaceId,
            applicationId: input.applicationId,
            jobId: input.jobId,
            candidateId: input.candidateId,
            roundId: input.roundId,
            attemptId: input.attemptId,
            objectKey,
            objectKeyNonce,
            storageKind: context.storageKind,
            ingestionLeaseId: existing.ingestionLeaseId,
            privacyWon: error instanceof HireCandidatePiiTombstoneError,
          })
        }
        throw error
      }
      const { staged, lease } = reserved
      const coordinate = {
        workspaceId: input.workspaceId,
        applicationId: input.applicationId,
        roundId: input.roundId,
        attemptId: input.attemptId,
        assetId: staged._id.toString(),
      }
      assertHireMediaV2KeyScope(
        objectKey,
        coordinate,
        context.storageKind,
        objectKeyNonce,
      )
      const quarantine = (privacyWon: boolean) =>
        quarantineAndDeleteFailedCopy({
          assetId: staged._id,
          workspaceId: input.workspaceId,
          applicationId: input.applicationId,
          jobId: input.jobId,
          candidateId: input.candidateId,
          roundId: input.roundId,
          attemptId: input.attemptId,
          objectKey,
          objectKeyNonce,
          storageKind: context.storageKind,
          ingestionLeaseId: lease.ingestionLeaseId,
          privacyWon,
        })

      let destinationState: 'verified' | 'missing' | 'mismatch'
      destinationState = await verifyExistingDestination({
        destinationKey: objectKey,
        expectedBytes: artifact.sizeBytes,
        expectedSha256: artifact.sha256,
        expectedContentType: artifact.contentType,
        signal: writeSignal,
      })
      if (destinationState === 'mismatch') {
        const cleanup = await quarantine(false)
        if (cleanup === 'unchanged') {
          throw new Error('Runtime media checkpoint changed before sealing')
        }
        observedCheckpoint = await latestRuntimeMediaCheckpoint(
          context.checkpointKey,
        )
        continue
      }
      if (destinationState === 'missing') {
        try {
          await copyAndVerify({
            sourceKey: artifact.sourceKey,
            destinationKey: objectKey,
            coordinate,
            storageKind: context.storageKind,
            objectKeyNonce,
            contentType: artifact.contentType,
            expectedBytes: artifact.sizeBytes,
            expectedSha256: artifact.sha256,
            signal: writeSignal,
          })
        } catch (error) {
          if (isPreconditionFailure(error)) {
            destinationState = await verifyExistingDestination({
              destinationKey: objectKey,
              expectedBytes: artifact.sizeBytes,
              expectedSha256: artifact.sha256,
              expectedContentType: artifact.contentType,
              signal: writeSignal,
            })
            if (destinationState !== 'verified') {
              const cleanup = await quarantine(false)
              if (cleanup === 'unchanged') {
                throw new Error(
                  'Runtime media checkpoint changed after a conditional Put',
                )
              }
              observedCheckpoint = await latestRuntimeMediaCheckpoint(
                context.checkpointKey,
              )
              continue
            }
          } else if (error instanceof RuntimeMediaChecksumError) {
            await quarantine(false)
            throw error
          } else {
            // Transport failures have an unknown Put outcome. Retain the
            // checkpoint so the next exact retry can GET and adopt it.
            throw error
          }
        }
      }

      // Copy verification is durable, but recruiter-visible activation is
      // deferred to the caller's event/result terminal transaction.
      output.push(staged)
      produced = true
      break
    }
    if (!produced) {
      throw new Error('Runtime media checkpoint did not produce an asset')
    }
  }
  return output
}

async function quarantineRuntimeMediaCheckpoints(input: {
  identity: RuntimeMediaIngestionInput
  reason: 'privacy_request' | 'stale_staging'
}): Promise<void> {
  const checkpointKeys = input.identity.artifacts
    .map((artifact, artifactIndex) => ({ artifact, artifactIndex }))
    .filter(({ artifact }) =>
      ['recording', 'screen', 'audio', 'landmarks'].includes(artifact.kind),
    )
    .map(({ artifactIndex }) =>
      runtimeMediaCheckpointKey({ ...input.identity, artifactIndex }),
    )
  if (checkpointKeys.length === 0) return

  const session = await mongoose.startSession()
  try {
    await session.withTransaction(async () => {
      const scope = {
        workspaceId: input.identity.workspaceId,
        applicationId: input.identity.applicationId,
        jobId: input.identity.jobId,
        candidateId: input.identity.candidateId,
        roundId: input.identity.roundId,
        attemptId: input.identity.attemptId,
        ingestionCheckpointKey: { $in: checkpointKeys },
        ...(input.reason === 'stale_staging'
          ? { purgeReason: { $ne: 'privacy_request' } }
          : {}),
      }
      const now = new Date()
      await HireMediaAsset.updateMany(
        { ...scope, state: 'staging' },
        {
          $set: {
            state: 'purge_failed',
            purgeEligibleAt: now,
            purgeReason: input.reason,
            purgeFailureCode: 'TERMINAL_INGESTION_QUARANTINE',
          },
          $unset: {
            active: 1,
            ingestionLeaseId: 1,
            ingestionLeaseExpiresAt: 1,
            purgeClaimId: 1,
            purgeClaimedAt: 1,
          },
        },
        { session },
      )
      if (input.reason === 'privacy_request') {
        await HireMediaAsset.updateMany(
          { ...scope, state: 'ready' },
          {
            $set: { purgeEligibleAt: now, purgeReason: input.reason },
            $unset: { active: 1 },
          },
          { session },
        )
      }
    })
  } finally {
    await session.endSession()
  }
}

async function ingestRuntimeMediaArtifactsWithinDeadline(
  input: RuntimeMediaIngestionInput,
  writeSignal: AbortSignal,
): Promise<IHireMediaAsset[]> {
  try {
    return await ingestRuntimeMediaArtifactsBatch(input, writeSignal)
  } catch (error) {
    if (
      error instanceof HireRuntimeMediaStaleError ||
      error instanceof HireCandidatePiiTombstoneError
    ) {
      // A result can carry several artifacts. If a later artifact loses a
      // lifecycle fence, quarantine every copied checkpoint for this exact
      // event; checksum-reused assets from an older event remain untouched.
      await quarantineRuntimeMediaCheckpoints({
        identity: input,
        reason:
          error instanceof HireCandidatePiiTombstoneError
            ? 'privacy_request'
            : 'stale_staging',
      })
    }
    throw error
  }
}

export async function ingestRuntimeMediaArtifacts(
  input: RuntimeMediaIngestionInput,
): Promise<IHireMediaAsset[]> {
  const writeController = new AbortController()
  const writeDeadline = setTimeout(() => {
    writeController.abort(new Error('Hire runtime media copy timed out'))
  }, HIRE_MEDIA_WRITE_TIMEOUT_MS)
  try {
    return await ingestRuntimeMediaArtifactsWithinDeadline(
      input,
      writeController.signal,
    )
  } finally {
    clearTimeout(writeDeadline)
  }
}

export const __runtimeMediaIngestion = {
  runtimePrincipalId,
  assertRuntimeArtifactScope,
  runtimeMediaCheckpointKey,
  activeUnexpiredFilter,
}
