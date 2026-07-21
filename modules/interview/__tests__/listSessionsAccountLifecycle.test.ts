import { beforeEach, describe, expect, it, vi } from 'vitest'
import mongoose from 'mongoose'

const mocks = vi.hoisted(() => ({
  connectDB: vi.fn(),
  aggregate: vi.fn(),
  countDocuments: vi.fn(),
  distinctActiveUsers: vi.fn(),
}))

vi.mock('@shared/db/connection', () => ({ connectDB: mocks.connectDB }))
vi.mock('@shared/db/models', () => ({
  InterviewSession: {
    aggregate: (...args: unknown[]) => mocks.aggregate(...args),
    countDocuments: (...args: unknown[]) => mocks.countDocuments(...args),
  },
  User: {
    distinct: (...args: unknown[]) => mocks.distinctActiveUsers(...args),
  },
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
const ACTIVE_OWNER_ID = new mongoose.Types.ObjectId()
const LEGACY_ACTIVE_OWNER_ID = new mongoose.Types.ObjectId()
const ORGANIZATION_ID = new mongoose.Types.ObjectId().toString()

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connectDB.mockResolvedValue(undefined)
  mocks.distinctActiveUsers.mockResolvedValue([ACTIVE_OWNER_ID, LEGACY_ACTIVE_OWNER_ID])
  mocks.aggregate.mockResolvedValue([
    { _id: 'active-session', userId: ACTIVE_OWNER_ID },
    { _id: 'legacy-active-session', userId: LEGACY_ACTIVE_OWNER_ID },
  ])
  mocks.countDocuments.mockResolvedValue(2)
})

describe('listSessions organization account lifecycle', () => {
  it('filters deleting/missing owners before skip, limit, and count while keeping legacy-active owners', async () => {
    const result = await listSessions({
      userId: REQUESTER_ID,
      organizationId: ORGANIZATION_ID,
      role: 'recruiter',
      page: 2,
      limit: 10,
      status: 'completed',
    })

    expect(mocks.distinctActiveUsers).toHaveBeenNthCalledWith(1, '_id', {
      organizationId: expect.any(mongoose.Types.ObjectId),
      $or: [{ accountState: 'active' }, { accountState: { $exists: false } }],
    })
    const pipeline = mocks.aggregate.mock.calls[0][0]
    expect(pipeline.slice(0, 4)).toEqual([
      {
        $match: {
          organizationId: expect.any(mongoose.Types.ObjectId),
          userId: { $in: [ACTIVE_OWNER_ID, LEGACY_ACTIVE_OWNER_ID] },
          status: 'completed',
        },
      },
      { $sort: { createdAt: -1 } },
      { $skip: 10 },
      { $limit: 10 },
    ])
    expect(mocks.countDocuments).toHaveBeenCalledWith({
      organizationId: expect.any(mongoose.Types.ObjectId),
      userId: { $in: [ACTIVE_OWNER_ID, LEGACY_ACTIVE_OWNER_ID] },
      status: 'completed',
    })
    expect(result.pagination).toEqual({ page: 2, limit: 10, total: 2, totalPages: 1 })
  })

  it('returns an empty, correctly paginated page when no organization owner is active', async () => {
    mocks.distinctActiveUsers.mockResolvedValue([])
    mocks.aggregate.mockResolvedValue([])
    mocks.countDocuments.mockResolvedValue(0)

    const result = await listSessions({
      userId: REQUESTER_ID,
      organizationId: ORGANIZATION_ID,
      role: 'org_admin',
      page: 1,
      limit: 20,
    })

    const match = mocks.aggregate.mock.calls[0][0][0].$match
    expect(match.userId).toEqual({ $in: [] })
    expect(result).toEqual({
      sessions: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    })
  })

  it('keeps candidate history owner-scoped without an organization-wide User query', async () => {
    await listSessions({
      userId: REQUESTER_ID,
      organizationId: ORGANIZATION_ID,
      role: 'candidate',
      page: 1,
      limit: 20,
    })

    expect(mocks.distinctActiveUsers).not.toHaveBeenCalled()
    expect(mocks.countDocuments).toHaveBeenCalledWith({
      userId: new mongoose.Types.ObjectId(REQUESTER_ID),
    })
  })
})
