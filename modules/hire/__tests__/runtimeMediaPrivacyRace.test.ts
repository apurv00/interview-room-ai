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
    jobFindOne: vi.fn(),
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
    send(command: unknown) {
      return mocks.s3Send(command)
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
  HireJob: { findOne: mocks.jobFindOne },
}))
vi.mock('../models/HireMediaAsset', () => ({
  HireMediaAsset: {
    findOne: mocks.mediaFindOne,
    create: mocks.mediaCreate,
    updateMany: mocks.mediaUpdateMany,
    findOneAndUpdate: mocks.mediaFindOneAndUpdate,
    updateOne: mocks.mediaUpdateOne,
  },
}))

import {
  __runtimeMediaIngestion,
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
const BODY = Buffer.from('verified-runtime-media')
const SHA256 = createHash('sha256').update(BODY).digest('hex')
const SOURCE_KEY = `recordings/${__runtimeMediaIngestion.runtimePrincipalId(IDS.roundId)}/${IDS.runtimeSessionId}-1723248000000.webm`
const dbSession = {
  withTransaction: vi.fn(async (work: () => Promise<void>) => work()),
  endSession: vi.fn().mockResolvedValue(undefined),
}

function lean(value: unknown) {
  return { select: () => ({ lean: async () => value }) }
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
  mocks.jobFindOne.mockReturnValue(lean({ status: 'open' }))
  mocks.mediaFindOne.mockResolvedValue(null)
  mocks.mediaCreate.mockImplementation(
    async (input: Record<string, unknown>) => input,
  )
  mocks.mediaUpdateMany.mockResolvedValue({ modifiedCount: 0 })
  mocks.mediaFindOneAndUpdate.mockResolvedValue(null)
  mocks.mediaUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.candidateFence.mockRejectedValue(
    new mocks.CandidatePiiTombstoneError('verified deletion won'),
  )
  mocks.s3Send.mockImplementation(
    async (command: InstanceType<typeof mocks.GetObjectCommand>) => {
      if (command instanceof mocks.GetObjectCommand)
        return { Body: Readable.from([BODY]) }
      if (command instanceof mocks.PutObjectCommand) {
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
  it('never activates a copied object when deletion wins the candidate fence', async () => {
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

    expect(mocks.candidateFence).toHaveBeenCalledWith({
      workspaceId: IDS.workspaceId,
      candidateId: IDS.candidateId,
      session: dbSession,
    })
    expect(mocks.mediaFindOneAndUpdate).not.toHaveBeenCalled()
    expect(mocks.mediaUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: IDS.workspaceId,
        applicationId: IDS.applicationId,
        jobId: IDS.jobId,
        candidateId: IDS.candidateId,
        roundId: IDS.roundId,
        attemptId: IDS.attemptId,
        state: 'staging',
      }),
      {
        $set: {
          purgeEligibleAt: expect.any(Date),
          purgeReason: 'privacy_request',
        },
        $unset: { active: 1 },
      },
    )
    expect(dbSession.endSession).toHaveBeenCalledOnce()
  })
})
