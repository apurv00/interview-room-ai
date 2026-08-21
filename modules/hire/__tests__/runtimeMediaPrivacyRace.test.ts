import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import mongoose from 'mongoose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
    jobFindOneAndUpdate: vi.fn(),
    mediaFindOne: vi.fn(),
    mediaCreate: vi.fn(),
    mediaUpdateMany: vi.fn(),
    mediaFindOneAndUpdate: vi.fn(),
    mediaUpdateOne: vi.fn(),
    workspaceUpdateOne: vi.fn(),
    candidateFence: vi.fn(),
    createLease: vi.fn(),
  }
})

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send(command: unknown, options?: { abortSignal?: AbortSignal }) {
      return mocks.s3Send(command, options)
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
vi.mock('../models/HireJob', () => ({
  HireJob: { findOneAndUpdate: mocks.jobFindOneAndUpdate },
}))
vi.mock('../models/HireMediaAsset', () => ({
  HIRE_MEDIA_INGESTION_LEASE_MS: 60 * 60 * 1000,
  createHireMediaIngestionLease: mocks.createLease,
  HireMediaAsset: {
    findOne: mocks.mediaFindOne,
    create: mocks.mediaCreate,
    updateMany: mocks.mediaUpdateMany,
    findOneAndUpdate: mocks.mediaFindOneAndUpdate,
    updateOne: mocks.mediaUpdateOne,
  },
}))
vi.mock('../models/HireWorkspace', () => ({
  HireWorkspace: { updateOne: mocks.workspaceUpdateOne },
}))

import {
  __runtimeMediaIngestion,
  ingestRuntimeMediaArtifacts,
} from '../services/runtimeMediaIngestionService'
import {
  HIRE_MEDIA_LEASE_CLEANUP_MARGIN_MS,
  HIRE_MEDIA_WRITE_TIMEOUT_MS,
} from '../services/hireMediaStorage'

const IDS = {
  workspaceId: '111111111111111111111111',
  applicationId: '222222222222222222222222',
  jobId: '333333333333333333333333',
  candidateId: '444444444444444444444444',
  roundId: '555555555555555555555555',
  attemptId: '666666666666666666666666',
  runtimeSessionId: '777777777777777777777777',
}
const BODY = Buffer.from('verified-runtime-media')
const SHA256 = createHash('sha256').update(BODY).digest('hex')
const SOURCE_KEY = `recordings/${__runtimeMediaIngestion.runtimePrincipalId(IDS.roundId)}/${IDS.runtimeSessionId}-1723248000000.webm`
const SCREEN_SOURCE_KEY = `recordings/${__runtimeMediaIngestion.runtimePrincipalId(IDS.roundId)}/${IDS.runtimeSessionId}-screen-1723248000001.webm`
const INGESTION_LEASE_ID = '11111111-2222-4333-8444-555555555555'
const dbSession = {
  withTransaction: vi.fn(async (work: () => Promise<void>) => work()),
  endSession: vi.fn().mockResolvedValue(undefined),
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

beforeEach(() => {
  vi.clearAllMocks()
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
  dbSession.endSession.mockResolvedValue(undefined)
  mocks.connect.mockResolvedValue(undefined)
  mocks.jobFindOneAndUpdate.mockResolvedValue({ status: 'open' })
  mocks.mediaFindOne.mockResolvedValue(null)
  mocks.mediaCreate.mockImplementation(
    async (input: Array<Record<string, unknown>>) => input,
  )
  mocks.mediaUpdateMany.mockResolvedValue({ modifiedCount: 0 })
  mocks.mediaFindOneAndUpdate.mockResolvedValue({ state: 'purge_claimed' })
  mocks.mediaUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.workspaceUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.createLease.mockReturnValue({
    ingestionLeaseId: INGESTION_LEASE_ID,
    ingestionLeaseExpiresAt: new Date('2099-08-10T13:00:00.000Z'),
  })
  mocks.candidateFence
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(
      new mocks.CandidatePiiTombstoneError('verified deletion won'),
    )
  mocks.s3Send.mockImplementation(
    async (command: InstanceType<typeof mocks.GetObjectCommand>) => {
      if (command instanceof mocks.GetObjectCommand)
        return { Body: Readable.from([BODY]) }
      if (command instanceof mocks.PutObjectCommand) {
        if (isTombstone(command)) return {}
        for await (const _chunk of command.input
          .Body as AsyncIterable<Uint8Array>) {
          // Consume the upload so the production checksum transform is exercised.
        }
        return {}
      }
      return {}
    },
  )
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('runtime media versus verified deletion', () => {
  it('keeps the object-write deadline strictly below the ingestion lease', async () => {
    const actualModel = await vi.importActual<
      typeof import('../models/HireMediaAsset')
    >('../models/HireMediaAsset')

    expect(
      HIRE_MEDIA_WRITE_TIMEOUT_MS + HIRE_MEDIA_LEASE_CLEANUP_MARGIN_MS,
    ).toBeLessThan(
      actualModel.HIRE_MEDIA_INGESTION_LEASE_MS,
    )
  })

  it('uses one write deadline signal across every artifact in the invocation', async () => {
    const writeSignals: AbortSignal[] = []
    mocks.candidateFence.mockReset()
    mocks.candidateFence.mockResolvedValue(undefined)
    mocks.mediaFindOneAndUpdate.mockResolvedValue({
      _id: new mongoose.Types.ObjectId(),
      state: 'ready',
      active: true,
    })
    mocks.s3Send.mockImplementation(
      async (
        command: InstanceType<typeof mocks.GetObjectCommand>,
        options?: { abortSignal?: AbortSignal },
      ) => {
        if (options?.abortSignal) writeSignals.push(options.abortSignal)
        if (command instanceof mocks.GetObjectCommand)
          return { Body: Readable.from([BODY]) }
        if (command instanceof mocks.PutObjectCommand) {
          if (isTombstone(command)) return {}
          for await (const _chunk of command.input
            .Body as AsyncIterable<Uint8Array>) {
            // Consume both uploads so checksum verification completes.
          }
        }
        return {}
      },
    )

    await expect(
      ingestRuntimeMediaArtifacts({
        ...IDS,
        completedAt: new Date('2026-08-10T12:00:00.000Z'),
        artifacts: [
          {
            kind: 'recording',
            sourceKey: SOURCE_KEY,
            contentType: 'video/webm',
            sizeBytes: BODY.byteLength,
            sha256: SHA256,
          },
          {
            kind: 'screen',
            sourceKey: SCREEN_SOURCE_KEY,
            contentType: 'video/webm',
            sizeBytes: BODY.byteLength,
            sha256: SHA256,
          },
        ],
      }),
    ).resolves.toHaveLength(2)

    expect(writeSignals).toHaveLength(4)
    expect(new Set(writeSignals).size).toBe(1)
    expect(writeSignals[0].aborted).toBe(false)
    const mediaPuts = mocks.s3Send.mock.calls
      .map(([command]) => command)
      .filter(
        (command) =>
          command instanceof mocks.PutObjectCommand && !isTombstone(command),
      ) as Array<InstanceType<typeof mocks.PutObjectCommand>>
    expect(mediaPuts).toHaveLength(2)
    expect(mediaPuts.every((command) => command.input.IfNoneMatch === '*')).toBe(
      true,
    )
  })

  it('claims workspace and candidate fences transactionally before staging or Put', async () => {
    mocks.candidateFence.mockReset()
    mocks.candidateFence.mockRejectedValueOnce(
      new mocks.CandidatePiiTombstoneError('deletion already live'),
    )

    await expect(
      ingestRuntimeMediaArtifacts({
        ...IDS,
        completedAt: new Date('2026-08-10T12:00:00.000Z'),
        artifacts: [
          {
            kind: 'recording',
            sourceKey: SOURCE_KEY,
            contentType: 'video/webm',
            sizeBytes: BODY.byteLength,
            sha256: SHA256,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(mocks.CandidatePiiTombstoneError)

    expect(mocks.workspaceUpdateOne).toHaveBeenCalledWith(
      {
        _id: IDS.workspaceId,
        $or: [
          { lifecycleState: 'active' },
          { lifecycleState: { $exists: false } },
        ],
      },
      { $inc: { writeFenceVersion: 1 } },
      { session: dbSession },
    )
    expect(mocks.candidateFence).toHaveBeenCalledWith({
      workspaceId: IDS.workspaceId,
      candidateId: IDS.candidateId,
      session: dbSession,
    })
    expect(
      mocks.workspaceUpdateOne.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.candidateFence.mock.invocationCallOrder[0])
    expect(mocks.mediaCreate).not.toHaveBeenCalled()
    expect(mocks.s3Send).not.toHaveBeenCalled()
  })

  it('holds an ingestion lease through a deferred Put and seals only after privacy wins', async () => {
    let notifyPutStarted!: () => void
    let releasePut!: () => void
    const putStarted = new Promise<void>((resolve) => {
      notifyPutStarted = resolve
    })
    const putMayFinish = new Promise<void>((resolve) => {
      releasePut = resolve
    })
    const commandOrder: string[] = []
    mocks.s3Send.mockImplementation(
      async (command: InstanceType<typeof mocks.GetObjectCommand>) => {
        if (command instanceof mocks.GetObjectCommand)
          return { Body: Readable.from([BODY]) }
        if (command instanceof mocks.PutObjectCommand) {
          if (isTombstone(command)) {
            commandOrder.push('seal')
            return {}
          }
          commandOrder.push('put-started')
          notifyPutStarted()
          for await (const _chunk of command.input
            .Body as AsyncIterable<Uint8Array>) {
            // Consume the upload before allowing its response to settle.
          }
          await putMayFinish
          commandOrder.push('put-finished')
          return {}
        }
        return {}
      },
    )

    const ingestion = ingestRuntimeMediaArtifacts({
      ...IDS,
      completedAt: new Date('2026-08-10T12:00:00.000Z'),
      artifacts: [
        {
          kind: 'recording',
          sourceKey: SOURCE_KEY,
          contentType: 'video/webm',
          sizeBytes: BODY.byteLength,
          sha256: SHA256,
        },
      ],
    })

    await putStarted
    expect(commandOrder).toEqual(['put-started'])
    expect(mocks.mediaCreate).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          state: 'staging',
          ingestionLeaseId: INGESTION_LEASE_ID,
          ingestionLeaseExpiresAt: expect.any(Date),
        }),
      ],
      { session: dbSession },
    )
    expect(
      mocks.candidateFence.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.mediaCreate.mock.invocationCallOrder[0])

    releasePut()
    await expect(ingestion).rejects.toBeInstanceOf(
      mocks.CandidatePiiTombstoneError,
    )

    expect(commandOrder).toEqual(['put-started', 'put-finished', 'seal'])
    expect(mocks.candidateFence).toHaveBeenNthCalledWith(1, {
      workspaceId: IDS.workspaceId,
      candidateId: IDS.candidateId,
      session: dbSession,
    })
    expect(mocks.candidateFence).toHaveBeenNthCalledWith(2, {
      workspaceId: IDS.workspaceId,
      candidateId: IDS.candidateId,
      session: dbSession,
    })
    expect(mocks.mediaFindOneAndUpdate).toHaveBeenCalledOnce()
    expect(mocks.mediaFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: IDS.workspaceId,
        applicationId: IDS.applicationId,
        jobId: IDS.jobId,
        candidateId: IDS.candidateId,
        roundId: IDS.roundId,
        attemptId: IDS.attemptId,
        state: 'staging',
        ingestionLeaseId: INGESTION_LEASE_ID,
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          state: 'purge_claimed',
          purgeClaimId: expect.any(String),
          purgeClaimedAt: expect.any(Date),
          purgeReason: 'privacy_request',
        }),
        $unset: expect.objectContaining({
          ingestionLeaseId: 1,
          ingestionLeaseExpiresAt: 1,
        }),
      }),
      { new: true },
    )
    const purgeClaimId = (
      mocks.mediaFindOneAndUpdate.mock.calls[0][1] as {
        $set: { purgeClaimId: string }
      }
    ).$set.purgeClaimId
    expect(mocks.mediaUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: IDS.workspaceId,
        applicationId: IDS.applicationId,
        jobId: IDS.jobId,
        candidateId: IDS.candidateId,
        roundId: IDS.roundId,
        attemptId: IDS.attemptId,
        state: 'purge_claimed',
        purgeClaimId,
      }),
      {
        $set: { state: 'purged', purgedAt: expect.any(Date) },
        $unset: {
          active: 1,
          ingestionLeaseId: 1,
          ingestionLeaseExpiresAt: 1,
          purgeClaimId: 1,
          purgeClaimedAt: 1,
          purgeFailureCode: 1,
        },
      },
    )
    const sealCall = mocks.s3Send.mock.calls.findIndex(
      ([command]) =>
        command instanceof mocks.PutObjectCommand && isTombstone(command),
    )
    expect(
      mocks.mediaFindOneAndUpdate.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.s3Send.mock.invocationCallOrder[sealCall])
    expect(dbSession.endSession).toHaveBeenCalledTimes(2)
  })

  it('releases the exact lease to purge_failed when the tombstone ACK fails', async () => {
    mocks.s3Send.mockImplementation(
      async (command: InstanceType<typeof mocks.GetObjectCommand>) => {
        if (command instanceof mocks.GetObjectCommand)
          return { Body: Readable.from([BODY]) }
        if (command instanceof mocks.PutObjectCommand) {
          if (isTombstone(command)) {
            throw new Error('simulated R2 tombstone acknowledgement loss')
          }
          for await (const _chunk of command.input
            .Body as AsyncIterable<Uint8Array>) {
            // Consume the upload so checksum verification completes.
          }
          return {}
        }
        return {}
      },
    )

    await expect(
      ingestRuntimeMediaArtifacts({
        ...IDS,
        completedAt: new Date('2026-08-10T12:00:00.000Z'),
        artifacts: [
          {
            kind: 'recording',
            sourceKey: SOURCE_KEY,
            contentType: 'video/webm',
            sizeBytes: BODY.byteLength,
            sha256: SHA256,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(mocks.CandidatePiiTombstoneError)

    const purgeClaimId = (
      mocks.mediaFindOneAndUpdate.mock.calls[0][1] as {
        $set: { purgeClaimId: string }
      }
    ).$set.purgeClaimId
    expect(mocks.mediaUpdateOne).toHaveBeenCalledOnce()
    expect(mocks.mediaUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: IDS.workspaceId,
        applicationId: IDS.applicationId,
        jobId: IDS.jobId,
        candidateId: IDS.candidateId,
        roundId: IDS.roundId,
        attemptId: IDS.attemptId,
        state: 'purge_claimed',
        purgeClaimId,
      }),
      {
        $set: {
          state: 'purge_failed',
          purgeEligibleAt: expect.any(Date),
          purgeReason: 'privacy_request',
          purgeFailureCode: 'RUNTIME_MEDIA_TOMBSTONE_FAILED',
        },
        $unset: {
          active: 1,
          purgeClaimId: 1,
          purgeClaimedAt: 1,
          purgedAt: 1,
        },
      },
    )
  })

  it('preserves ready media when attachment committed with an unknown result', async () => {
    const unknownCommit = new Error('unknown transaction commit result')
    const ready = {
      _id: new mongoose.Types.ObjectId(),
      kind: 'camera_recording',
      state: 'ready',
      active: true,
    }
    mocks.candidateFence.mockReset()
    mocks.candidateFence.mockResolvedValue(undefined)
    mocks.mediaFindOne
      .mockReset()
      .mockResolvedValueOnce(null)
    mocks.mediaFindOneAndUpdate
      .mockReset()
      .mockResolvedValueOnce(ready)
      .mockResolvedValueOnce(null)
    dbSession.withTransaction
      .mockImplementationOnce(async (work: () => Promise<void>) => work())
      .mockImplementationOnce(async (work: () => Promise<void>) => {
        await work()
        throw unknownCommit
      })

    await expect(
      ingestRuntimeMediaArtifacts({
        ...IDS,
        completedAt: new Date('2026-08-10T12:00:00.000Z'),
        artifacts: [
          {
            kind: 'recording',
            sourceKey: SOURCE_KEY,
            contentType: 'video/webm',
            sizeBytes: BODY.byteLength,
            sha256: SHA256,
          },
        ],
      }),
    ).rejects.toBe(unknownCommit)

    expect(mocks.mediaFindOneAndUpdate).toHaveBeenCalledTimes(2)
    expect(mocks.mediaFindOneAndUpdate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        state: 'staging',
        ingestionLeaseId: INGESTION_LEASE_ID,
      }),
      expect.objectContaining({
        $set: expect.objectContaining({ state: 'purge_claimed' }),
      }),
      { new: true },
    )
    expect(mocks.mediaFindOne).toHaveBeenCalledOnce()
    expect(
      mocks.s3Send.mock.calls.some(
        ([command]) =>
          command instanceof mocks.PutObjectCommand && isTombstone(command),
      ),
    ).toBe(false)
    expect(mocks.mediaUpdateOne).not.toHaveBeenCalled()
  })

  it('seals an ambiguous timed-out Put before terminaling the database row', async () => {
    vi.useFakeTimers()
    const writeStartedAt = new Date('2026-08-21T10:00:00.000Z')
    vi.setSystemTime(writeStartedAt)
    let notifyPutStarted!: () => void
    const putStarted = new Promise<void>((resolve) => {
      notifyPutStarted = resolve
    })
    let writeSignal: AbortSignal | undefined
    mocks.candidateFence.mockReset()
    mocks.candidateFence.mockResolvedValue(undefined)
    mocks.s3Send.mockImplementation(
      async (
        command: InstanceType<typeof mocks.GetObjectCommand>,
        options?: { abortSignal?: AbortSignal },
      ) => {
        if (command instanceof mocks.GetObjectCommand)
          return { Body: Readable.from([BODY]) }
        if (command instanceof mocks.PutObjectCommand) {
          if (isTombstone(command)) return {}
          writeSignal = options?.abortSignal
          notifyPutStarted()
          return new Promise((_resolve, reject) => {
            writeSignal?.addEventListener(
              'abort',
              () => reject(writeSignal?.reason),
              { once: true },
            )
          })
        }
        return {}
      },
    )

    try {
      const ingestion = ingestRuntimeMediaArtifacts({
        ...IDS,
        completedAt: new Date('2026-08-10T12:00:00.000Z'),
        artifacts: [
          {
            kind: 'recording',
            sourceKey: SOURCE_KEY,
            contentType: 'video/webm',
            sizeBytes: BODY.byteLength,
            sha256: SHA256,
          },
        ],
      })
      await putStarted
      expect(writeSignal?.aborted).toBe(false)

      const rejected = expect(ingestion).rejects.toThrow(
        'Hire runtime media copy timed out',
      )
      await vi.advanceTimersByTimeAsync(HIRE_MEDIA_WRITE_TIMEOUT_MS)
      await rejected

      expect(writeSignal?.aborted).toBe(true)
      expect(mocks.mediaFindOneAndUpdate).toHaveBeenCalledOnce()
      expect(
        mocks.s3Send.mock.calls.some(
          ([command]) =>
            command instanceof mocks.PutObjectCommand && isTombstone(command),
        ),
      ).toBe(true)
      expect(mocks.mediaUpdateOne).toHaveBeenCalledOnce()
      expect(mocks.mediaUpdateOne).toHaveBeenCalledWith(
        expect.objectContaining({
          state: 'purge_claimed',
          purgeClaimId: expect.any(String),
        }),
        expect.objectContaining({
          $set: { state: 'purged', purgedAt: expect.any(Date) },
        }),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('activates media only through the exact unexpired ingestion lease CAS', async () => {
    mocks.candidateFence.mockReset()
    mocks.candidateFence.mockResolvedValue(undefined)
    mocks.mediaFindOneAndUpdate.mockResolvedValue({
      _id: new mongoose.Types.ObjectId(),
      kind: 'camera_recording',
      state: 'ready',
      active: true,
    })

    await expect(
      ingestRuntimeMediaArtifacts({
        ...IDS,
        completedAt: new Date('2026-08-10T12:00:00.000Z'),
        artifacts: [
          {
            kind: 'recording',
            sourceKey: SOURCE_KEY,
            contentType: 'video/webm',
            sizeBytes: BODY.byteLength,
            sha256: SHA256,
          },
        ],
      }),
    ).resolves.toHaveLength(1)

    expect(mocks.mediaFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: IDS.workspaceId,
        applicationId: IDS.applicationId,
        jobId: IDS.jobId,
        candidateId: IDS.candidateId,
        roundId: IDS.roundId,
        attemptId: IDS.attemptId,
        state: 'staging',
        ingestionLeaseId: INGESTION_LEASE_ID,
        ingestionLeaseExpiresAt: { $gt: expect.any(Date) },
      }),
      {
        $set: { state: 'ready', active: true },
        $unset: {
          ingestionLeaseId: 1,
          ingestionLeaseExpiresAt: 1,
          purgeFailureCode: 1,
          purgeEligibleAt: 1,
          purgeReason: 1,
        },
      },
      { new: true, session: dbSession },
    )
    expect(
      mocks.s3Send.mock.calls.some(
        ([command]) => command instanceof mocks.DeleteObjectCommand,
      ),
    ).toBe(false)
    expect(mocks.jobFindOneAndUpdate).toHaveBeenCalledTimes(2)
    expect(mocks.jobFindOneAndUpdate).toHaveBeenNthCalledWith(
      1,
      { _id: IDS.jobId, workspaceId: IDS.workspaceId },
      { $inc: { intakeWriteVersion: 1 } },
      {
        new: true,
        session: dbSession,
        projection: { status: 1, closedAt: 1 },
      },
    )
    expect(mocks.jobFindOneAndUpdate).toHaveBeenNthCalledWith(
      2,
      { _id: IDS.jobId, workspaceId: IDS.workspaceId },
      { $inc: { intakeWriteVersion: 1 } },
      {
        new: true,
        session: dbSession,
        projection: { status: 1, closedAt: 1 },
      },
    )
    const staged = mocks.mediaCreate.mock.calls[0][0][0] as Record<
      string,
      unknown
    >
    expect(staged).not.toHaveProperty('purgeEligibleAt')
    expect(staged).not.toHaveProperty('purgeReason')
  })

  it('clears a staged close deadline when the job reopens before activation', async () => {
    const closedAt = new Date('2026-01-31T12:00:00.000Z')
    const expectedPurgeAt = new Date('2026-07-31T12:00:00.000Z')
    mocks.candidateFence.mockReset()
    mocks.candidateFence.mockResolvedValue(undefined)
    mocks.jobFindOneAndUpdate
      .mockResolvedValueOnce({ status: 'closed', closedAt })
      .mockResolvedValueOnce({ status: 'open' })
    mocks.mediaFindOneAndUpdate.mockResolvedValue({
      _id: new mongoose.Types.ObjectId(),
      kind: 'camera_recording',
      state: 'ready',
      active: true,
    })

    await expect(
      ingestRuntimeMediaArtifacts({
        ...IDS,
        completedAt: new Date('2026-02-01T12:00:00.000Z'),
        artifacts: [
          {
            kind: 'recording',
            sourceKey: SOURCE_KEY,
            contentType: 'video/webm',
            sizeBytes: BODY.byteLength,
            sha256: SHA256,
          },
        ],
      }),
    ).resolves.toHaveLength(1)

    expect(mocks.mediaCreate).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          purgeEligibleAt: expectedPurgeAt,
          purgeReason: 'job_closed',
        }),
      ],
      { session: dbSession },
    )
    expect(mocks.mediaFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'staging' }),
      expect.objectContaining({
        $set: expect.not.objectContaining({
          purgeEligibleAt: expect.anything(),
          purgeReason: expect.anything(),
        }),
        $unset: expect.objectContaining({
          purgeEligibleAt: 1,
          purgeReason: 1,
        }),
      }),
      { new: true, session: dbSession },
    )
  })

  it('stages a shared-display object as screen media under the same privacy fence', async () => {
    await expect(
      ingestRuntimeMediaArtifacts({
        ...IDS,
        completedAt: new Date('2026-08-10T12:00:00.000Z'),
        artifacts: [
          {
            kind: 'screen',
            sourceKey: SCREEN_SOURCE_KEY,
            contentType: 'video/webm',
            sizeBytes: BODY.byteLength,
            sha256: SHA256,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(mocks.CandidatePiiTombstoneError)

    expect(mocks.mediaCreate).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          workspaceId: IDS.workspaceId,
          applicationId: IDS.applicationId,
          roundId: IDS.roundId,
          attemptId: IDS.attemptId,
          kind: 'screen_recording',
          state: 'staging',
          contentType: 'video/webm',
          ingestionLeaseId: INGESTION_LEASE_ID,
        }),
      ],
      { session: dbSession },
    )
    expect(
      (mocks.mediaCreate.mock.calls[0][0][0] as { objectKey: string }).objectKey,
    ).toMatch(/^hire-media\/v2\/[a-f0-9]{64}$/)
    expect(
      (mocks.mediaCreate.mock.calls[0][0][0] as {
        objectKeyNonce: string
      }).objectKeyNonce,
    ).toMatch(/^[a-f0-9]{64}$/)
  })
})
