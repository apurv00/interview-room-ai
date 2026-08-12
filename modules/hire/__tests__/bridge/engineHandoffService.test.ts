import mongoose from 'mongoose'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  updateMany: vi.fn(),
  create: vi.fn(),
  findOneAndUpdate: vi.fn(),
  workspaceUpdateOne: vi.fn(),
  roundExists: vi.fn(),
  withTransaction: vi.fn(),
  endSession: vi.fn(),
}))

vi.mock('../../services/hireControlBoundary', () => ({
  connectHireControlDB: mocks.connect,
}))
vi.mock('../../models/HireEngineHandoff', () => ({
  HireEngineHandoff: {
    updateMany: mocks.updateMany,
    create: mocks.create,
    findOneAndUpdate: mocks.findOneAndUpdate,
  },
}))
vi.mock('../../models/HireWorkspace', () => ({
  HireWorkspace: { updateOne: mocks.workspaceUpdateOne },
}))
vi.mock('../../models/HireRound', () => ({
  HireRound: { exists: mocks.roundExists },
}))

import {
  exchangeHireEngineHandoff,
  HireEngineHandoffError,
  issueHireEngineHandoff,
} from '../../services/engineHandoffService'

const previousRuntimeUrl = process.env.HIRE_ENGINE_RUNTIME_URL
const startSessionSpy = vi.spyOn(mongoose, 'startSession')
const NOW = new Date('2026-08-10T00:00:00.000Z')
const IDS = {
  workspaceId: 'a'.repeat(24),
  applicationId: 'b'.repeat(24),
  roundId: 'c'.repeat(24),
}

afterEach(() => {
  if (previousRuntimeUrl === undefined) delete process.env.HIRE_ENGINE_RUNTIME_URL
  else process.env.HIRE_ENGINE_RUNTIME_URL = previousRuntimeUrl
})

afterAll(() => {
  startSessionSpy.mockRestore()
})

beforeEach(() => {
  vi.clearAllMocks()
  process.env.HIRE_ENGINE_RUNTIME_URL = 'https://engine.hire.interviewprep.guru'
  mocks.connect.mockResolvedValue(undefined)
  mocks.updateMany.mockResolvedValue({ matchedCount: 0 })
  mocks.create.mockResolvedValue({})
  mocks.workspaceUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.roundExists.mockReturnValue({ session: vi.fn().mockResolvedValue(true) })
  mocks.withTransaction.mockImplementation(async (work: () => Promise<void>) => work())
  mocks.endSession.mockResolvedValue(undefined)
  startSessionSpy.mockResolvedValue({
    withTransaction: mocks.withTransaction,
    endSession: mocks.endSession,
  } as never)
})

describe('Hire control handoff service', () => {
  it('persists no candidate identity and returns the raw code only in the URL/result', async () => {
    const result = await issueHireEngineHandoff({
      ...IDS,
      config: {
        role: 'Backend engineer',
        interviewType: 'behavioral',
        experience: '3-6',
        duration: 20,
        jobDescription: 'Canonical JD',
      },
      consentVersion: 'hire-ai-v1',
      consentAt: new Date('2026-08-09T23:59:00.000Z'),
      inviteExpiresAt: new Date('2026-08-17T00:00:00.000Z'),
      now: NOW,
    })
    expect(result.code).toMatch(new RegExp(`^${IDS.workspaceId}\\.[a-f0-9]{64}$`))
    const url = new URL(result.handoffUrl)
    expect(url.search).toBe('')
    expect(new URLSearchParams(url.hash.slice(1)).get('code')).toBe(result.code)
    const persisted = mocks.create.mock.calls[0][0][0]
    expect(persisted.codeHash).toMatch(/^[a-f0-9]{64}$/)
    expect(persisted.codeHash).not.toBe(result.code)
    expect(persisted).not.toHaveProperty('candidateEmail')
    expect(persisted).not.toHaveProperty('candidateName')
    expect(JSON.stringify(persisted)).not.toContain('@')
    expect(mocks.workspaceUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: IDS.workspaceId }),
      { $inc: { writeFenceVersion: 1 } },
      expect.objectContaining({ session: expect.anything() }),
    )
    expect(mocks.roundExists).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: IDS.roundId,
        workspaceId: IDS.workspaceId,
        applicationId: IDS.applicationId,
      }),
    )
  })

  it('cannot mint a handoff after the workspace tombstone wins', async () => {
    mocks.workspaceUpdateOne.mockResolvedValue({ matchedCount: 0 })
    await expect(
      issueHireEngineHandoff({
        ...IDS,
        config: {
          role: 'Backend engineer',
          interviewType: 'behavioral',
          experience: '3-6',
          duration: 20,
          jobDescription: 'Canonical JD',
        },
        consentVersion: 'hire-ai-v1',
        consentAt: new Date('2026-08-09T23:59:00.000Z'),
        inviteExpiresAt: new Date('2026-08-17T00:00:00.000Z'),
        now: NOW,
      }),
    ).rejects.toMatchObject<HireEngineHandoffError>({ code: 'expired', status: 410 })
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('exchanges only the atomically request-bound code into three-key coordinates', async () => {
    const persistedConfig = {
      role: 'Backend engineer',
      interviewType: 'behavioral',
      experience: '3-6',
      duration: 20,
      jobDescription: 'Canonical JD',
    }
    mocks.findOneAndUpdate.mockResolvedValue({
      codeHash: 'e'.repeat(64),
      workspaceId: { toString: () => IDS.workspaceId },
      applicationId: { toString: () => IDS.applicationId },
      roundId: { toString: () => IDS.roundId },
      expiresAt: new Date('2026-08-10T00:01:00.000Z'),
      inviteExpiresAt: new Date('2026-08-17T00:00:00.000Z'),
      consentVersion: 'hire-ai-v1',
      consentAt: new Date('2026-08-09T23:59:00.000Z'),
      config: {
        ...persistedConfig,
        // Hydrated Mongoose subdocuments expose enumerable document helpers.
        // The bridge must explicitly flatten them before strict wire parsing.
        $isMongooseDocumentPrototype: true,
        toObject: () => persistedConfig,
      },
    })
    const envelope = await exchangeHireEngineHandoff(
      { code: `${IDS.workspaceId}.${'f'.repeat(64)}`, requestId: '1'.repeat(64) },
      NOW,
    )
    expect(envelope).toMatchObject(IDS)
    expect(envelope.config).toEqual(persistedConfig)
    expect(mocks.findOneAndUpdate.mock.calls[0][0]).toMatchObject({
      workspaceId: IDS.workspaceId,
      codeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    const query = mocks.findOneAndUpdate.mock.calls[0][0]
    expect(query.$or).toContainEqual({ requestBindingHash: '1'.repeat(64) })
  })

  it('uses one uniform terminal error for missing, expired, revoked, or consumed codes', async () => {
    mocks.findOneAndUpdate.mockResolvedValue(null)
    await expect(
      exchangeHireEngineHandoff(
        { code: `${IDS.workspaceId}.${'f'.repeat(64)}`, requestId: '1'.repeat(64) },
        NOW,
      ),
    ).rejects.toMatchObject<HireEngineHandoffError>({ code: 'expired', status: 410 })
  })
})
