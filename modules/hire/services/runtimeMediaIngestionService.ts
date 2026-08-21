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

type MediaArtifact = HireEngineResultIngestion['media'][number]

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

function assertRuntimeArtifactScope(input: {
  artifact: MediaArtifact
  roundId: string
  runtimeSessionId: string
}): void {
  const expectedOwner = runtimePrincipalId(input.roundId)
  const match = input.artifact.kind === 'landmarks'
    ? /^landmarks\/([a-f0-9]{24})\/([a-f0-9]{24})-([a-f0-9]{32})\.json$/i.exec(input.artifact.sourceKey)
    : /^recordings\/([a-f0-9]{24})\/([a-f0-9]{24})(?:-(?:audio|screen))?-\d{10,16}\.webm$/i.exec(
        input.artifact.sourceKey,
      )
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
    throw new Error('Runtime media checksum verification failed')
  }
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
    throw new Error('Hire workspace is unavailable during media ingestion')
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
  if (!job) throw new Error('Hire job is missing during media ingestion')
  return job.status === 'closed' && job.closedAt
    ? {
        purgeEligibleAt: addCalendarMonths(job.closedAt, 6),
        purgeReason: 'job_closed',
      }
    : undefined
}

async function reserveRuntimeMediaIngestion(input: {
  assetId: mongoose.Types.ObjectId
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
}): Promise<void> {
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
    return
  }
  if (!claimed) return

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
    return
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
}

type RuntimeMediaIngestionInput = {
  workspaceId: string
  applicationId: string
  jobId: string
  candidateId: string
  roundId: string
  attemptId: string
  runtimeSessionId: string
  completedAt: Date
  artifacts: HireEngineResultIngestion['media']
}

async function ingestRuntimeMediaArtifactsWithinDeadline(
  input: RuntimeMediaIngestionInput,
  writeSignal: AbortSignal,
): Promise<IHireMediaAsset[]> {
  await connectHireControlDB()
  const supported = input.artifacts.filter(
    (artifact) =>
      artifact.kind === 'recording' ||
      artifact.kind === 'screen' ||
      artifact.kind === 'audio' ||
      artifact.kind === 'landmarks',
  )
  if (supported.length === 0) return []

  const output: IHireMediaAsset[] = []
  for (const artifact of supported) {
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
    const existing = await HireMediaAsset.findOne({
      workspaceId: input.workspaceId,
      applicationId: input.applicationId,
      roundId: input.roundId,
      attemptId: input.attemptId,
      kind,
      sha256: artifact.sha256,
      state: 'ready',
    })
    if (existing) {
      output.push(existing)
      continue
    }

    const assetId = new mongoose.Types.ObjectId()
    const objectKeyNonce = randomBytes(32).toString('hex')
    const coordinate = {
      workspaceId: input.workspaceId,
      applicationId: input.applicationId,
      roundId: input.roundId,
      attemptId: input.attemptId,
      assetId: assetId.toString(),
    }
    const storageKind = hireMediaStorageKindForAsset(kind)
    const objectKey = hireMediaKey(coordinate, storageKind, objectKeyNonce)
    const { staged, lease } = await reserveRuntimeMediaIngestion({
      assetId,
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
    try {
      await copyAndVerify({
        sourceKey: artifact.sourceKey,
        destinationKey: objectKey,
        coordinate,
        storageKind,
        objectKeyNonce,
        contentType: artifact.contentType,
        expectedBytes: artifact.sizeBytes,
        expectedSha256: artifact.sha256,
        signal: writeSignal,
      })
      const dbSession = await mongoose.startSession()
      let ready: IHireMediaAsset | null = null
      try {
        await dbSession.withTransaction(async () => {
          ready = null
          await claimActiveWorkspaceForMedia(input.workspaceId, dbSession)
          await claimHireCandidatePiiWriteFence({
            workspaceId: input.workspaceId,
            candidateId: input.candidateId,
            session: dbSession,
          })
          const retention = await claimHireJobMediaRetention(input, dbSession)
          await HireMediaAsset.updateMany(
            {
              workspaceId: input.workspaceId,
              applicationId: input.applicationId,
              jobId: input.jobId,
              candidateId: input.candidateId,
              roundId: input.roundId,
              attemptId: input.attemptId,
              kind,
              active: true,
              _id: { $ne: assetId },
            },
            {
              $set: { purgeEligibleAt: new Date(), purgeReason: 'replaced' },
              $unset: { active: 1 },
            },
            { session: dbSession },
          )
          ready = await HireMediaAsset.findOneAndUpdate(
            {
              _id: assetId,
              workspaceId: input.workspaceId,
              applicationId: input.applicationId,
              jobId: input.jobId,
              candidateId: input.candidateId,
              roundId: input.roundId,
              attemptId: input.attemptId,
              state: 'staging',
              ingestionLeaseId: lease.ingestionLeaseId,
              ingestionLeaseExpiresAt: { $gt: new Date() },
              purgeReason: { $ne: 'privacy_request' },
            },
            {
              $set: { state: 'ready', active: true, ...retention },
              $unset: {
                ingestionLeaseId: 1,
                ingestionLeaseExpiresAt: 1,
                purgeFailureCode: 1,
                ...(!retention
                  ? { purgeEligibleAt: 1, purgeReason: 1 }
                  : {}),
              },
            },
            { new: true, session: dbSession },
          )
          if (!ready)
            throw new Error('Runtime media asset changed during ingestion')
        })
      } finally {
        await dbSession.endSession()
      }
      if (!ready)
        throw new Error('Runtime media asset changed during ingestion')
      output.push(ready)
    } catch (error) {
      const privacyWon = error instanceof HireCandidatePiiTombstoneError
      await quarantineAndDeleteFailedCopy({
        assetId: staged._id,
        workspaceId: input.workspaceId,
        applicationId: input.applicationId,
        jobId: input.jobId,
        candidateId: input.candidateId,
        roundId: input.roundId,
        attemptId: input.attemptId,
        objectKey,
        objectKeyNonce,
        storageKind,
        ingestionLeaseId: lease.ingestionLeaseId,
        privacyWon,
      })
      throw error
    }
  }
  return output
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
}
