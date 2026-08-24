import { beforeEach, describe, expect, it, vi } from 'vitest'
import mongoose from 'mongoose'

const mocks = vi.hoisted(() => ({
  connectDB: vi.fn(),
  aggregate: vi.fn(),
  countDocuments: vi.fn(),
}))

vi.mock('@shared/db/connection', () => ({ connectDB: mocks.connectDB }))
vi.mock('@shared/db/models', () => ({
  InterviewSession: {
    aggregate: (...args: unknown[]) => mocks.aggregate(...args),
    countDocuments: (...args: unknown[]) => mocks.countDocuments(...args),
  },
  User: {},
}))
vi.mock('@shared/db/models/InterviewDepth', () => ({ InterviewDepth: {} }))
vi.mock('@shared/services/jobsAccountFence', () => ({
  activeJobsAccountFilter: (userId: string) => ({
    _id: userId,
    $or: [{ accountState: 'active' }, { accountState: { $exists: false } }],
  }),
  JobsAccountInactiveError: class JobsAccountInactiveError extends Error {},
  withActiveJobsAccountWrite: vi.fn(),
}))
vi.mock('@shared/auth/permissions', () => ({
  canEditSession: vi.fn(),
  canViewSession: vi.fn(),
}))
vi.mock('@shared/db/seed', () => ({ FALLBACK_DEPTHS: [] }))
vi.mock('@shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@interview/services/persona/jdParserService', () => ({
  parseJobDescription: vi.fn(),
  buildParsedJDContext: vi.fn(),
}))
vi.mock('@interview/services/persona/resumeContextService', () => ({
  parseAndCacheResume: vi.fn(),
  buildParsedResumeContext: vi.fn(),
}))
vi.mock('@interview/services/persona/documentContextCache', () => ({
  setCachedJDContext: vi.fn(),
  setCachedResumeContext: vi.fn(),
}))
vi.mock('@interview/services/core/sessionConfigCache', () => ({
  warmSessionConfigCache: vi.fn(),
}))

import { listSessions } from '@interview/services/core/interviewService'

const REQUESTER_ID = new mongoose.Types.ObjectId().toString()

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connectDB.mockResolvedValue(undefined)
  mocks.aggregate.mockResolvedValue([{ _id: 'owner-session', userId: REQUESTER_ID }])
  mocks.countDocuments.mockResolvedValue(2)
})

describe('listSessions owner-only history contract', () => {
  it('queries only the requester and retains pagination/status behavior', async () => {
    const result = await listSessions({
      userId: REQUESTER_ID,
      page: 2,
      limit: 10,
      status: 'completed',
    })

    const ownerFilter = {
      userId: new mongoose.Types.ObjectId(REQUESTER_ID),
      status: 'completed',
    }
    const pipeline = mocks.aggregate.mock.calls[0][0]
    expect(pipeline.slice(0, 4)).toEqual([
      { $match: ownerFilter },
      { $sort: { createdAt: -1 } },
      { $skip: 10 },
      { $limit: 10 },
    ])
    expect(mocks.countDocuments).toHaveBeenCalledWith(ownerFilter)
    expect(result.pagination).toEqual({ page: 2, limit: 10, total: 2, totalPages: 1 })
  })

  it('has no role or organization input that can widen history to foreign sessions', async () => {
    await listSessions({ userId: REQUESTER_ID, page: 1, limit: 20 })

    const match = mocks.aggregate.mock.calls[0][0][0].$match
    expect(match).toEqual({
      userId: new mongoose.Types.ObjectId(REQUESTER_ID),
    })
    expect(match).not.toHaveProperty('organizationId')
    expect(match.userId).not.toHaveProperty('$in')
  })
})
