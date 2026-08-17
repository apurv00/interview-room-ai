import { createHash } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import mongoose from 'mongoose'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import type { HireEngineResultIngestion } from '@shared/contracts/hireEngineBridge'
import { HireJob } from '../models/HireJob'
import { HireMediaAsset, type IHireMediaAsset } from '../models/HireMediaAsset'
import { addCalendarMonths } from './mediaLifecycleService'
import { hireMediaKey } from './hireMediaStorage'
import { connectHireControlDB } from './hireControlBoundary'
import {
  claimHireCandidatePiiWriteFence,
  HireCandidatePiiTombstoneError,
} from './hireCandidatePrivacyWriteFence'

type MediaArtifact = HireEngineResultIngestion['media'][number]

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
  contentType: string
  expectedBytes: number
  expectedSha256: string
}): Promise<void> {
  const source = sourceStorage()
  const destination = destinationStorage()
  const object = await source.client.send(
    new GetObjectCommand({ Bucket: source.bucket, Key: input.sourceKey }),
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
  try {
    await destination.client.send(
      new PutObjectCommand({
        Bucket: destination.bucket,
        Key: input.destinationKey,
        Body: body,
        ContentLength: input.expectedBytes,
        ContentType: input.contentType,
        CacheControl: 'private, no-store',
      }),
    )
    const actualSha256 = hash.digest('hex')
    if (
      bytes !== input.expectedBytes ||
      actualSha256 !== input.expectedSha256
    ) {
      throw new Error('Runtime media checksum verification failed')
    }
  } catch (error) {
    await destination.client
      .send(
        new DeleteObjectCommand({
          Bucket: destination.bucket,
          Key: input.destinationKey,
        }),
      )
      .catch(() => undefined)
    throw error
  }
}

export async function ingestRuntimeMediaArtifacts(input: {
  workspaceId: string
  applicationId: string
  jobId: string
  candidateId: string
  roundId: string
  attemptId: string
  runtimeSessionId: string
  completedAt: Date
  artifacts: HireEngineResultIngestion['media']
}): Promise<IHireMediaAsset[]> {
  await connectHireControlDB()
  const supported = input.artifacts.filter(
    (artifact) =>
      artifact.kind === 'recording' ||
      artifact.kind === 'audio' ||
      artifact.kind === 'landmarks',
  )
  if (supported.length === 0) return []
  const job = await HireJob.findOne({
    _id: input.jobId,
    workspaceId: input.workspaceId,
  })
    .select('status closedAt')
    .lean()
  if (!job) throw new Error('Hire job is missing during media ingestion')

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
    const coordinate = {
      workspaceId: input.workspaceId,
      applicationId: input.applicationId,
      roundId: input.roundId,
      attemptId: input.attemptId,
      assetId: assetId.toString(),
    }
    const storageKind = artifact.kind === 'recording'
      ? 'camera-recording'
      : artifact.kind === 'audio'
        ? 'audio-recording'
        : 'facial-landmarks'
    const objectKey = hireMediaKey(coordinate, storageKind)
    const purgeEligibleAt =
      job.status === 'closed' && job.closedAt
        ? addCalendarMonths(job.closedAt, 6)
        : undefined
    const staged = await HireMediaAsset.create({
      _id: assetId,
      ...coordinate,
      jobId: input.jobId,
      candidateId: input.candidateId,
      kind,
      state: 'staging',
      objectKey,
      contentType: artifact.contentType,
      bytes: artifact.sizeBytes,
      sha256: artifact.sha256,
      capturedAt: input.completedAt,
      ...(purgeEligibleAt
        ? { purgeEligibleAt, purgeReason: 'job_closed' }
        : {}),
    })
    try {
      await copyAndVerify({
        sourceKey: artifact.sourceKey,
        destinationKey: objectKey,
        contentType: artifact.contentType,
        expectedBytes: artifact.sizeBytes,
        expectedSha256: artifact.sha256,
      })
      const dbSession = await mongoose.startSession()
      let ready: IHireMediaAsset | null = null
      try {
        await dbSession.withTransaction(async () => {
          ready = null
          await claimHireCandidatePiiWriteFence({
            workspaceId: input.workspaceId,
            candidateId: input.candidateId,
            session: dbSession,
          })
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
              purgeReason: { $ne: 'privacy_request' },
            },
            { $set: { state: 'ready', active: true } },
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
      await HireMediaAsset.updateOne(
        {
          _id: staged._id,
          workspaceId: input.workspaceId,
          applicationId: input.applicationId,
          jobId: input.jobId,
          candidateId: input.candidateId,
          roundId: input.roundId,
          attemptId: input.attemptId,
          state: 'staging',
        },
        {
          $set: {
            purgeEligibleAt: new Date(),
            purgeReason: privacyWon ? 'privacy_request' : 'stale_staging',
            ...(privacyWon
              ? {}
              : { purgeFailureCode: 'RUNTIME_MEDIA_INGEST_FAILED' }),
          },
          $unset: { active: 1 },
        },
      )
      throw error
    }
  }
  return output
}

export const __runtimeMediaIngestion = {
  runtimePrincipalId,
  assertRuntimeArtifactScope,
}
