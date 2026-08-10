import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../services/hireControlBoundary', () => ({
  connectHireControlDB: vi.fn().mockResolvedValue(undefined),
}))

const { jobAggregate, mediaUpdateMany } = vi.hoisted(() => ({
  jobAggregate: vi.fn(),
  mediaUpdateMany: vi.fn(),
}))

vi.mock('../models/HireJob', () => ({
  HireJob: { aggregate: jobAggregate },
}))
vi.mock('../models/HireMediaAsset', () => ({
  HireMediaAsset: {
    collection: { name: 'hiremediaassets' },
    updateMany: mediaUpdateMany,
  },
}))
vi.mock('../models/HirePrivacyRequest', () => ({ HirePrivacyRequest: {} }))
vi.mock('../models/HireRound', () => ({ HireRound: {} }))

import { reconcileClosedJobMediaRetention } from '../services/mediaLifecycleService'

const WORKSPACE_A = '111111111111111111111111'
const WORKSPACE_B = '222222222222222222222222'
const JOB_A = 'aaaaaaaaaaaaaaaaaaaaaaaa'

describe('closed-job media retention crash reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mediaUpdateMany.mockResolvedValue({ modifiedCount: 2 })
  })

  it('repairs the post-commit crash window at calendar +6 months and is idempotent', async () => {
    jobAggregate
      .mockResolvedValueOnce([{
        _id: JOB_A,
        closedAt: new Date('2026-08-31T12:30:00.000Z'),
      }])
      .mockResolvedValueOnce([])

    await expect(reconcileClosedJobMediaRetention({ workspaceId: WORKSPACE_A }))
      .resolves.toEqual({ closedJobs: 1, scheduled: 2 })
    await expect(reconcileClosedJobMediaRetention({ workspaceId: WORKSPACE_A }))
      .resolves.toEqual({ closedJobs: 0, scheduled: 0 })

    expect(mediaUpdateMany).toHaveBeenCalledTimes(1)
    expect(mediaUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: expect.objectContaining({ toString: expect.any(Function) }),
        jobId: JOB_A,
        purgeEligibleAt: { $exists: false },
      }),
      {
        $set: {
          purgeEligibleAt: new Date('2027-02-28T12:30:00.000Z'),
          purgeReason: 'job_closed',
        },
      },
    )
  })

  it('scopes both the closed-job root and joined media child to one workspace', async () => {
    jobAggregate.mockResolvedValue([])
    await reconcileClosedJobMediaRetention({ workspaceId: WORKSPACE_B, batchSize: 25 })

    const pipeline = jobAggregate.mock.calls[0][0]
    expect(pipeline[0]).toEqual({
      $match: {
        workspaceId: expect.objectContaining({ toString: expect.any(Function) }),
        status: 'closed',
        closedAt: { $type: 'date' },
      },
    })
    expect(pipeline[0].$match.workspaceId.toString()).toBe(WORKSPACE_B)
    expect(pipeline[1].$lookup.pipeline[0].$match.$expr).toEqual({
      $and: [
        { $eq: ['$jobId', '$$jobId'] },
        { $eq: ['$workspaceId', '$$workspaceId'] },
      ],
    })
    expect(pipeline).toContainEqual({ $limit: 25 })
    expect(mediaUpdateMany).not.toHaveBeenCalled()
  })
})
