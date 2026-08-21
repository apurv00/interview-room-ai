import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import mongoose from 'mongoose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HIRE_MEDIA_LEASE_CLEANUP_MARGIN_MS,
  HIRE_MEDIA_WRITE_TIMEOUT_MS,
  hireMediaKey,
} from '../services/hireMediaStorage'

const mocks = vi.hoisted(() => {
  class CandidatePiiTombstoneError extends Error {}
  class Command {
    constructor(readonly input: Record<string, unknown>) {}
  }
  class GetObjectCommand extends Command {}
  class PutObjectCommand extends Command {}
  class DeleteObjectCommand extends Command {}
  return {
    CandidatePiiTombstoneError,
    GetObjectCommand,
    PutObjectCommand,
    DeleteObjectCommand,
    s3Send: vi.fn(),
    connect: vi.fn(),
    workspaceUpdateOne: vi.fn(),
    jobFindOneAndUpdate: vi.fn(),
    mediaFindOne: vi.fn(),
    mediaCreate: vi.fn(),
    mediaUpdateMany: vi.fn(),
    mediaFindOneAndUpdate: vi.fn(),
    mediaUpdateOne: vi.fn(),
    candidateFence: vi.fn(),
  }
})

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    readonly endpoint: string
    constructor(input: { endpoint: string }) {
      this.endpoint = input.endpoint
    }
    send(command: unknown, options?: { abortSignal?: AbortSignal }) {
      return mocks.s3Send(this.endpoint, command, options)
    }
  },
  GetObjectCommand: mocks.GetObjectCommand,
  PutObjectCommand: mocks.PutObjectCommand,
  DeleteObjectCommand: mocks.DeleteObjectCommand,
}))
vi.mock('../services/hireControlBoundary', () => ({
  connectHireControlDB: mocks.connect,
}))
vi.mock('../services/hireCandidatePrivacyWriteFence', () => ({
  claimHireCandidatePiiWriteFence: mocks.candidateFence,
  HireCandidatePiiTombstoneError: mocks.CandidatePiiTombstoneError,
}))
vi.mock('../models/HireWorkspace', () => ({
  HireWorkspace: { updateOne: mocks.workspaceUpdateOne },
}))
vi.mock('../models/HireJob', () => ({
  HireJob: { findOneAndUpdate: mocks.jobFindOneAndUpdate },
}))
vi.mock('../models/HireMediaAsset', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../models/HireMediaAsset')>()
  return {
    ...actual,
    HireMediaAsset: {
      findOne: mocks.mediaFindOne,
      create: mocks.mediaCreate,
      updateMany: mocks.mediaUpdateMany,
      findOneAndUpdate: mocks.mediaFindOneAndUpdate,
      updateOne: mocks.mediaUpdateOne,
    },
  }
})

import {
  __runtimeMediaIngestion,
  activateRuntimeMediaArtifacts,
  HireRuntimeMediaStaleError,
  ingestRuntimeMediaArtifacts,
} from '../services/runtimeMediaIngestionService'

const IDS = {
  workspaceId: '111111111111111111111111',
  applicationId: '222222222222222222222222',
  jobId: '333333333333333333333333',
  candidateId: '444444444444444444444444',
  roundId: '555555555555555555555555',
  attemptId: '666666666666666666666666',
  runtimeSessionId: '777777777777777777777777',
}
const INGESTION = {
  ingestionStream: 'engine_result' as const,
  ingestionAttempt: 2,
  ingestionRevision: 3,
  ingestionEventId: '8'.repeat(64),
  ingestionDigest: '9'.repeat(64),
}
const BODY = Buffer.from('verified-runtime-media')
const SHA256 = createHash('sha256').update(BODY).digest('hex')
const SOURCE_KEY = `recordings/${__runtimeMediaIngestion.runtimePrincipalId(IDS.roundId)}/${IDS.runtimeSessionId}-1723248000000.webm`
const ARTIFACT = {
  kind: 'recording' as const,
  sourceKey: SOURCE_KEY,
  contentType: 'video/webm',
  sizeBytes: BODY.byteLength,
  sha256: SHA256,
}
const INPUT = {
  ...IDS,
  ...INGESTION,
  completedAt: new Date('2026-08-10T12:00:00.000Z'),
  artifacts: [ARTIFACT],
}

let checkpoint: Record<string, any> | null
let active: Record<string, any> | null
let destinationBody: Buffer | undefined
let destinationContentType: string | undefined

function query(value: unknown) {
  const promise = Promise.resolve(value)
  const chain = {
    sort: vi.fn(),
    select: vi.fn(),
    session: vi.fn(),
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
  }
  chain.sort.mockReturnValue(chain)
  chain.select.mockReturnValue(chain)
  chain.session.mockReturnValue(chain)
  return chain
}

function objectId(value: string) {
  return new mongoose.Types.ObjectId(value)
}

function isTombstone(
  command: InstanceType<typeof mocks.PutObjectCommand>,
): boolean {
  return Boolean(
    command.input.Metadata &&
      (command.input.Metadata as Record<string, string>)[
        'hire-media-tombstone'
      ] === 'v2',
  )
}

const dbSession = {
  withTransaction: vi.fn(async (work: () => Promise<void>) => work()),
  endSession: vi.fn().mockResolvedValue(undefined),
}

function installDatabaseState(): void {
  mocks.mediaFindOne.mockImplementation((filter: Record<string, unknown>) => {
    if ('ingestionCheckpointKey' in filter) {
      return query(
        checkpoint?.ingestionCheckpointKey === filter.ingestionCheckpointKey
          ? checkpoint
          : null,
      )
    }
    if (filter.active === true) {
      return query(
        active?.kind === filter.kind &&
          active?.contentType === filter.contentType &&
          active?.bytes === filter.bytes &&
          active?.sha256 === filter.sha256
          ? active
          : null,
      )
    }
    return query(null)
  })
  mocks.mediaCreate.mockImplementation(async (documents: Record<string, any>[]) => {
    checkpoint = {
      ...documents[0],
      workspaceId: objectId(String(documents[0].workspaceId)),
      applicationId: objectId(String(documents[0].applicationId)),
      jobId: objectId(String(documents[0].jobId)),
      candidateId: objectId(String(documents[0].candidateId)),
      roundId: objectId(String(documents[0].roundId)),
      attemptId: objectId(String(documents[0].attemptId)),
    }
    return [checkpoint]
  })
  mocks.mediaUpdateOne.mockImplementation(
    async (filter: Record<string, any>, update: Record<string, any>) => {
      if (checkpoint && filter.state === checkpoint.state) {
        checkpoint = { ...checkpoint, ...(update.$set ?? {}) }
      }
      return { matchedCount: 1, modifiedCount: 1 }
    },
  )
  mocks.mediaFindOneAndUpdate.mockImplementation(
    async (filter: Record<string, any>, update: Record<string, any>) => {
      if (filter.state !== 'staging' || checkpoint?.state !== 'staging') {
        return null
      }
      checkpoint = { ...checkpoint, ...(update.$set ?? {}) }
      if (update.$set?.state === 'ready') active = checkpoint
      return checkpoint
    },
  )
}

function installStorage(): void {
  mocks.s3Send.mockImplementation(
    async (
      endpoint: string,
      command:
        | InstanceType<typeof mocks.GetObjectCommand>
        | InstanceType<typeof mocks.PutObjectCommand>,
    ) => {
      const runtime = endpoint.includes('runtime-account')
      if (command instanceof mocks.GetObjectCommand) {
        if (runtime) return { Body: Readable.from([BODY]) }
        if (!destinationBody) {
          throw Object.assign(new Error('missing'), {
            name: 'NoSuchKey',
            $metadata: { httpStatusCode: 404 },
          })
        }
        return {
          Body: Readable.from([destinationBody]),
          ContentType: destinationContentType,
        }
      }
      if (command instanceof mocks.PutObjectCommand) {
        const chunks: Buffer[] = []
        for await (const chunk of command.input.Body as AsyncIterable<Uint8Array>) {
          chunks.push(Buffer.from(chunk))
        }
        destinationBody = Buffer.concat(chunks)
        destinationContentType = String(command.input.ContentType)
        return {}
      }
      return {}
    },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  checkpoint = null
  active = null
  destinationBody = undefined
  destinationContentType = undefined
  vi.stubEnv('R2_ACCOUNT_ID', 'control-account')
  vi.stubEnv('R2_ACCESS_KEY_ID', 'control-key')
  vi.stubEnv('R2_SECRET_ACCESS_KEY', 'control-secret')
  vi.stubEnv('R2_BUCKET_NAME', 'control-bucket')
  vi.stubEnv('HIRE_RUNTIME_R2_ACCOUNT_ID', 'runtime-account')
  vi.stubEnv('HIRE_RUNTIME_R2_ACCESS_KEY_ID', 'runtime-key')
  vi.stubEnv('HIRE_RUNTIME_R2_SECRET_ACCESS_KEY', 'runtime-secret')
  vi.stubEnv('HIRE_RUNTIME_R2_BUCKET_NAME', 'runtime-bucket')
  vi.spyOn(mongoose, 'startSession').mockResolvedValue(
    dbSession as unknown as mongoose.ClientSession,
  )
  dbSession.withTransaction.mockImplementation(
    async (work: () => Promise<void>) => work(),
  )
  mocks.connect.mockResolvedValue(undefined)
  mocks.workspaceUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.jobFindOneAndUpdate.mockResolvedValue({ status: 'open' })
  mocks.candidateFence.mockResolvedValue(undefined)
  mocks.mediaUpdateMany.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 })
  installDatabaseState()
  installStorage()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('runtime media durable checkpoint protocol', () => {
  it('keeps the object-write deadline strictly below the ingestion lease', async () => {
    const actualModel = await vi.importActual<
      typeof import('../models/HireMediaAsset')
    >('../models/HireMediaAsset')

    expect(
      HIRE_MEDIA_WRITE_TIMEOUT_MS + HIRE_MEDIA_LEASE_CLEANUP_MARGIN_MS,
    ).toBeLessThan(actualModel.HIRE_MEDIA_INGESTION_LEASE_MS)
  })

  it('uses one AbortSignal for destination verification, source GET, and conditional Put', async () => {
    const writeSignals: AbortSignal[] = []
    const storage = mocks.s3Send.getMockImplementation()!
    mocks.s3Send.mockImplementation(async (...args: unknown[]) => {
      const options = args[2] as { abortSignal?: AbortSignal } | undefined
      if (options?.abortSignal) writeSignals.push(options.abortSignal)
      return storage(
        ...(args as [string, unknown, { abortSignal?: AbortSignal }?]),
      )
    })

    await expect(ingestRuntimeMediaArtifacts(INPUT)).resolves.toHaveLength(1)

    expect(writeSignals).toHaveLength(3)
    expect(new Set(writeSignals).size).toBe(1)
    expect(writeSignals[0]?.aborted).toBe(false)
  })

  it('keeps the exact lease while Put is held and final privacy blocks activation', async () => {
    let notifyPutStarted!: () => void
    let releasePut!: () => void
    const putStarted = new Promise<void>((resolve) => {
      notifyPutStarted = resolve
    })
    const putRelease = new Promise<void>((resolve) => {
      releasePut = resolve
    })
    const storage = mocks.s3Send.getMockImplementation()!
    mocks.s3Send.mockImplementation(async (...args: unknown[]) => {
      const command = args[1]
      if (
        command instanceof mocks.PutObjectCommand &&
        command.input.IfNoneMatch === '*'
      ) {
        notifyPutStarted()
        await putRelease
      }
      return storage(
        ...(args as [string, unknown, { abortSignal?: AbortSignal }?]),
      )
    })

    const ingestion = ingestRuntimeMediaArtifacts(INPUT)
    await putStarted

    expect(checkpoint).toMatchObject({
      state: 'staging',
      ingestionLeaseId: expect.any(String),
      ingestionLeaseExpiresAt: expect.any(Date),
    })

    releasePut()
    const assets = await ingestion
    mocks.mediaUpdateOne.mockClear()
    mocks.candidateFence.mockRejectedValueOnce(
      new mocks.CandidatePiiTombstoneError('verified deletion won'),
    )

    await expect(
      activateRuntimeMediaArtifacts({
        assets,
        workspaceId: IDS.workspaceId,
        applicationId: IDS.applicationId,
        jobId: IDS.jobId,
        candidateId: IDS.candidateId,
        roundId: IDS.roundId,
        attemptId: IDS.attemptId,
        session: dbSession as unknown as mongoose.ClientSession,
      }),
    ).rejects.toBeInstanceOf(mocks.CandidatePiiTombstoneError)
    expect(mocks.mediaUpdateOne).not.toHaveBeenCalled()
    expect(checkpoint?.state).toBe('staging')
  })

  it('activates only through the exact unexpired lease after the final fences', async () => {
    const assets = await ingestRuntimeMediaArtifacts(INPUT)
    const leaseId = assets[0]?.ingestionLeaseId
    mocks.mediaUpdateOne.mockClear()

    await activateRuntimeMediaArtifacts({
      assets,
      workspaceId: IDS.workspaceId,
      applicationId: IDS.applicationId,
      jobId: IDS.jobId,
      candidateId: IDS.candidateId,
      roundId: IDS.roundId,
      attemptId: IDS.attemptId,
      session: dbSession as unknown as mongoose.ClientSession,
    })

    expect(mocks.mediaUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: assets[0]?._id,
        state: 'staging',
        ingestionLeaseId: leaseId,
        ingestionLeaseExpiresAt: { $gt: expect.any(Date) },
      }),
      expect.objectContaining({
        $set: expect.objectContaining({ state: 'ready', active: true }),
      }),
      { session: dbSession },
    )
    expect(checkpoint).toMatchObject({ state: 'ready', active: true })
  })

  it('does not stage or touch storage when the privacy fence has already won', async () => {
    mocks.candidateFence.mockRejectedValueOnce(
      new mocks.CandidatePiiTombstoneError('verified deletion won'),
    )

    await expect(ingestRuntimeMediaArtifacts(INPUT)).rejects.toBeInstanceOf(
      mocks.CandidatePiiTombstoneError,
    )

    expect(mocks.mediaCreate).not.toHaveBeenCalled()
    expect(mocks.s3Send).not.toHaveBeenCalled()
  })

  it('adopts the exact staged object after an unknown successful Put response', async () => {
    let loseFirstPutResponse = true
    const storage = mocks.s3Send.getMockImplementation()!
    mocks.s3Send.mockImplementation(async (...args: unknown[]) => {
      const result = await storage(...(args as [string, unknown]))
      if (
        args[1] instanceof mocks.PutObjectCommand &&
        (args[1] as InstanceType<typeof mocks.PutObjectCommand>).input
          .IfNoneMatch === '*' &&
        loseFirstPutResponse
      ) {
        loseFirstPutResponse = false
        throw new Error('connection reset after remote commit')
      }
      return result
    })

    await expect(ingestRuntimeMediaArtifacts(INPUT)).rejects.toThrow(
      'connection reset after remote commit',
    )
    expect(checkpoint?.state).toBe('staging')
    const stagedId = checkpoint?._id.toString()
    const stagedKey = checkpoint?.objectKey

    await expect(ingestRuntimeMediaArtifacts(INPUT)).resolves.toEqual([
      expect.objectContaining({ state: 'staging' }),
    ])

    expect(checkpoint?._id.toString()).toBe(stagedId)
    expect(checkpoint?.objectKey).toBe(stagedKey)
    expect(stagedKey).toMatch(/^hire-media\/v2\/[a-f0-9]{64}$/)
    const conditionalPuts = mocks.s3Send.mock.calls.filter(
      ([, command]) =>
        command instanceof mocks.PutObjectCommand &&
        command.input.IfNoneMatch === '*',
    )
    expect(conditionalPuts).toHaveLength(1)
  })

  it('adopts an already verified staging checkpoint without another Put', async () => {
    const checkpointKey = __runtimeMediaIngestion.runtimeMediaCheckpointKey({
      ...INPUT,
      artifactIndex: 0,
    })
    const assetId = new mongoose.Types.ObjectId()
    const objectKeyNonce = 'a'.repeat(64)
    const objectKey = hireMediaKey(
      {
        workspaceId: IDS.workspaceId,
        applicationId: IDS.applicationId,
        roundId: IDS.roundId,
        attemptId: IDS.attemptId,
        assetId: assetId.toString(),
      },
      'camera-recording',
      objectKeyNonce,
    )
    checkpoint = {
      _id: assetId,
      workspaceId: objectId(IDS.workspaceId),
      applicationId: objectId(IDS.applicationId),
      jobId: objectId(IDS.jobId),
      candidateId: objectId(IDS.candidateId),
      roundId: objectId(IDS.roundId),
      attemptId: objectId(IDS.attemptId),
      kind: 'camera_recording',
      state: 'staging',
      ingestionCheckpointKey: checkpointKey,
      ingestionCheckpointGeneration: 0,
      objectKey,
      objectKeyNonce,
      contentType: ARTIFACT.contentType,
      bytes: ARTIFACT.sizeBytes,
      sha256: ARTIFACT.sha256,
    }
    destinationBody = BODY
    destinationContentType = ARTIFACT.contentType

    await expect(ingestRuntimeMediaArtifacts(INPUT)).resolves.toEqual([
      expect.objectContaining({ _id: assetId, state: 'staging' }),
    ])
    expect(
      mocks.s3Send.mock.calls.some(
        ([, command]) =>
          command instanceof mocks.PutObjectCommand &&
          command.input.IfNoneMatch === '*',
      ),
    ).toBe(false)
  })

  it('rejects a staged object whose opaque key is bound to another asset', async () => {
    const checkpointKey = __runtimeMediaIngestion.runtimeMediaCheckpointKey({
      ...INPUT,
      artifactIndex: 0,
    })
    const assetId = new mongoose.Types.ObjectId()
    const objectKeyNonce = 'c'.repeat(64)
    checkpoint = {
      _id: assetId,
      workspaceId: objectId(IDS.workspaceId),
      applicationId: objectId(IDS.applicationId),
      jobId: objectId(IDS.jobId),
      candidateId: objectId(IDS.candidateId),
      roundId: objectId(IDS.roundId),
      attemptId: objectId(IDS.attemptId),
      kind: 'camera_recording',
      state: 'staging',
      ingestionCheckpointKey: checkpointKey,
      ingestionCheckpointGeneration: 0,
      objectKey: hireMediaKey(
        {
          workspaceId: IDS.workspaceId,
          applicationId: IDS.applicationId,
          roundId: IDS.roundId,
          attemptId: IDS.attemptId,
          assetId: new mongoose.Types.ObjectId().toString(),
        },
        'camera-recording',
        objectKeyNonce,
      ),
      objectKeyNonce,
      contentType: ARTIFACT.contentType,
      bytes: ARTIFACT.sizeBytes,
      sha256: ARTIFACT.sha256,
    }
    destinationBody = BODY
    destinationContentType = ARTIFACT.contentType

    await expect(ingestRuntimeMediaArtifacts(INPUT)).rejects.toThrow(
      'Hire media key is outside the authorized scope',
    )
    expect(mocks.mediaUpdateOne).not.toHaveBeenCalled()
    expect(mocks.s3Send).not.toHaveBeenCalled()
  })

  it.each(['purged', 'purge_failed'] as const)(
    'allocates a fresh nonce after a %s checkpoint generation',
    async (terminalState) => {
    const checkpointKey = __runtimeMediaIngestion.runtimeMediaCheckpointKey({
      ...INPUT,
      artifactIndex: 0,
    })
    const oldAssetId = new mongoose.Types.ObjectId()
    const oldNonce = 'b'.repeat(64)
    const oldKey = hireMediaKey(
      {
        workspaceId: IDS.workspaceId,
        applicationId: IDS.applicationId,
        roundId: IDS.roundId,
        attemptId: IDS.attemptId,
        assetId: oldAssetId.toString(),
      },
      'camera-recording',
      oldNonce,
    )
    checkpoint = {
      _id: oldAssetId,
      state: terminalState,
      ingestionCheckpointKey: checkpointKey,
      ingestionCheckpointGeneration: 0,
      objectKey: oldKey,
      objectKeyNonce: oldNonce,
    }

    await expect(ingestRuntimeMediaArtifacts(INPUT)).resolves.toHaveLength(1)

    expect(checkpoint?.ingestionCheckpointGeneration).toBe(1)
    expect(checkpoint?._id.toString()).not.toBe(oldAssetId.toString())
    expect(checkpoint?.objectKey).not.toBe(oldKey)
    expect(checkpoint?.objectKeyNonce).not.toBe(oldNonce)
    },
  )

  it('seals a copied staging checkpoint when retention expires before retry', async () => {
    const checkpointKey = __runtimeMediaIngestion.runtimeMediaCheckpointKey({
      ...INPUT,
      artifactIndex: 0,
    })
    const assetId = new mongoose.Types.ObjectId()
    const objectKeyNonce = 'c'.repeat(64)
    const objectKey = hireMediaKey(
      {
        workspaceId: IDS.workspaceId,
        applicationId: IDS.applicationId,
        roundId: IDS.roundId,
        attemptId: IDS.attemptId,
        assetId: assetId.toString(),
      },
      'camera-recording',
      objectKeyNonce,
    )
    checkpoint = {
      _id: assetId,
      workspaceId: objectId(IDS.workspaceId),
      applicationId: objectId(IDS.applicationId),
      jobId: objectId(IDS.jobId),
      candidateId: objectId(IDS.candidateId),
      roundId: objectId(IDS.roundId),
      attemptId: objectId(IDS.attemptId),
      kind: 'camera_recording',
      state: 'staging',
      ingestionLeaseId: 'crashed-owner',
      ingestionCheckpointKey: checkpointKey,
      ingestionCheckpointGeneration: 0,
      objectKey,
      objectKeyNonce,
      contentType: ARTIFACT.contentType,
      bytes: ARTIFACT.sizeBytes,
      sha256: ARTIFACT.sha256,
    }
    destinationBody = BODY
    destinationContentType = ARTIFACT.contentType
    mocks.jobFindOneAndUpdate.mockResolvedValue({
      status: 'closed',
      closedAt: new Date('2025-01-01T00:00:00.000Z'),
    })

    await expect(ingestRuntimeMediaArtifacts(INPUT)).rejects.toBeInstanceOf(
      HireRuntimeMediaStaleError,
    )

    expect(mocks.mediaFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: assetId,
        state: 'staging',
        ingestionLeaseId: 'crashed-owner',
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          state: 'purge_claimed',
          purgeReason: 'stale_staging',
        }),
      }),
      { new: true },
    )
    expect(
      mocks.s3Send.mock.calls.some(
        ([, command]) =>
          command instanceof mocks.PutObjectCommand &&
          command.input.Key === objectKey &&
          command.input.ContentLength === 0,
      ),
    ).toBe(true)
  })

  it('retains the exact cleanup claim when the tombstone ACK fails', async () => {
    const checkpointKey = __runtimeMediaIngestion.runtimeMediaCheckpointKey({
      ...INPUT,
      artifactIndex: 0,
    })
    const assetId = new mongoose.Types.ObjectId()
    const objectKeyNonce = 'd'.repeat(64)
    const objectKey = hireMediaKey(
      {
        workspaceId: IDS.workspaceId,
        applicationId: IDS.applicationId,
        roundId: IDS.roundId,
        attemptId: IDS.attemptId,
        assetId: assetId.toString(),
      },
      'camera-recording',
      objectKeyNonce,
    )
    checkpoint = {
      _id: assetId,
      workspaceId: objectId(IDS.workspaceId),
      applicationId: objectId(IDS.applicationId),
      jobId: objectId(IDS.jobId),
      candidateId: objectId(IDS.candidateId),
      roundId: objectId(IDS.roundId),
      attemptId: objectId(IDS.attemptId),
      kind: 'camera_recording',
      state: 'staging',
      ingestionLeaseId: 'crashed-owner',
      ingestionCheckpointKey: checkpointKey,
      ingestionCheckpointGeneration: 0,
      objectKey,
      objectKeyNonce,
      contentType: ARTIFACT.contentType,
      bytes: ARTIFACT.sizeBytes,
      sha256: ARTIFACT.sha256,
    }
    destinationBody = BODY
    destinationContentType = ARTIFACT.contentType
    mocks.jobFindOneAndUpdate.mockResolvedValue({
      status: 'closed',
      closedAt: new Date('2025-01-01T00:00:00.000Z'),
    })
    const storage = mocks.s3Send.getMockImplementation()!
    mocks.s3Send.mockImplementation(async (...args: unknown[]) => {
      const command = args[1]
      if (command instanceof mocks.PutObjectCommand && isTombstone(command)) {
        throw new Error('tombstone acknowledgement lost')
      }
      return storage(
        ...(args as [string, unknown, { abortSignal?: AbortSignal }?]),
      )
    })

    await expect(ingestRuntimeMediaArtifacts(INPUT)).rejects.toBeInstanceOf(
      HireRuntimeMediaStaleError,
    )

    expect(mocks.mediaUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: assetId,
        state: 'purge_claimed',
        purgeClaimId: expect.any(String),
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          state: 'purge_failed',
          purgeFailureCode: 'RUNTIME_MEDIA_TOMBSTONE_FAILED',
        }),
      }),
    )
    expect(checkpoint?.state).toBe('purge_failed')
  })

  it('never activates a partial multi-artifact batch when a later artifact turns stale', async () => {
    const audioArtifact = {
      ...ARTIFACT,
      kind: 'audio' as const,
      sourceKey: `recordings/${__runtimeMediaIngestion.runtimePrincipalId(IDS.roundId)}/${IDS.runtimeSessionId}-audio-1723248000001.webm`,
    }
    mocks.jobFindOneAndUpdate
      .mockResolvedValueOnce({ status: 'open' })
      .mockResolvedValueOnce({ status: 'open' })
      .mockResolvedValueOnce({ status: 'open' })
      .mockResolvedValueOnce({
        status: 'closed',
        closedAt: new Date('2025-01-01T00:00:00.000Z'),
      })

    await expect(
      ingestRuntimeMediaArtifacts({
        ...INPUT,
        artifacts: [ARTIFACT, audioArtifact],
      }),
    ).rejects.toBeInstanceOf(HireRuntimeMediaStaleError)

    const checkpointKeys = [0, 1].map((artifactIndex) =>
      __runtimeMediaIngestion.runtimeMediaCheckpointKey({
        ...INPUT,
        artifacts: [ARTIFACT, audioArtifact],
        artifactIndex,
      }),
    )
    expect(mocks.mediaUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        ingestionCheckpointKey: { $in: checkpointKeys },
        state: 'staging',
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          state: 'purge_failed',
          purgeReason: 'stale_staging',
        }),
        $unset: expect.objectContaining({ active: 1 }),
      }),
      { session: dbSession },
    )
    expect(mocks.mediaUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ state: 'ready' }),
      expect.anything(),
      expect.anything(),
    )
    expect(active).toBeNull()
    expect(
      mocks.mediaUpdateOne.mock.calls.some(
        ([, update]) => update.$set?.state === 'ready' || update.$set?.active === true,
      ),
    ).toBe(false)
  })

  it('keeps an accepted reusable asset active when a later artifact is stale', async () => {
    const acceptedAssetId = new mongoose.Types.ObjectId()
    active = {
      _id: acceptedAssetId,
      workspaceId: objectId(IDS.workspaceId),
      applicationId: objectId(IDS.applicationId),
      jobId: objectId(IDS.jobId),
      candidateId: objectId(IDS.candidateId),
      roundId: objectId(IDS.roundId),
      attemptId: objectId(IDS.attemptId),
      kind: 'camera_recording',
      state: 'ready',
      active: true,
      contentType: ARTIFACT.contentType,
      bytes: ARTIFACT.sizeBytes,
      sha256: ARTIFACT.sha256,
    }
    const audioArtifact = {
      ...ARTIFACT,
      kind: 'audio' as const,
      sourceKey: `recordings/${__runtimeMediaIngestion.runtimePrincipalId(IDS.roundId)}/${IDS.runtimeSessionId}-audio-1723248000001.webm`,
    }
    mocks.jobFindOneAndUpdate
      .mockResolvedValueOnce({ status: 'open' })
      .mockResolvedValueOnce({ status: 'open' })
      .mockResolvedValueOnce({
        status: 'closed',
        closedAt: new Date('2025-01-01T00:00:00.000Z'),
      })

    await expect(
      ingestRuntimeMediaArtifacts({
        ...INPUT,
        artifacts: [ARTIFACT, audioArtifact],
      }),
    ).rejects.toBeInstanceOf(HireRuntimeMediaStaleError)

    expect(active).toMatchObject({
      _id: acceptedAssetId,
      state: 'ready',
      active: true,
    })
    expect(mocks.mediaUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ state: 'ready' }),
      expect.anything(),
      expect.anything(),
    )
  })
})
