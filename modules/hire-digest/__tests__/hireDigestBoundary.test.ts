import mongoose from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  workspaceUpdateOne: vi.fn(),
  memberUpdateOne: vi.fn(),
  session: {
    withTransaction: vi.fn(),
    endSession: vi.fn(),
  },
}))

vi.mock('@hire-digest-boundary', () => ({
  connectHireControlDB: mocks.connect,
  activeHireWorkspaceLifecycleFilter: () => ({
    $or: [{ lifecycleState: 'active' }, { lifecycleState: { $exists: false } }],
  }),
  HireWorkspace: { updateOne: mocks.workspaceUpdateOne },
  HireWorkspaceMember: { updateOne: mocks.memberUpdateOne },
}))

import { authorizeHireDigestEgress } from '../services/hireDigestBoundary'

const WORKSPACE_ID = new mongoose.Types.ObjectId('111111111111111111111111')
const MEMBER_ID = new mongoose.Types.ObjectId('222222222222222222222222')

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connect.mockResolvedValue(undefined)
  mocks.workspaceUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.memberUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.session.withTransaction.mockImplementation(async (work: () => Promise<unknown>) => work())
  mocks.session.endSession.mockResolvedValue(undefined)
  vi.spyOn(mongoose, 'startSession').mockResolvedValue(mocks.session as unknown as mongoose.ClientSession)
})

describe('Hire digest exact egress authorization', () => {
  it('atomically matches the captured privacy aggregate epoch with active workspace authority', async () => {
    const work = vi.fn().mockResolvedValue('authorized')

    await expect(
      authorizeHireDigestEgress({
        workspaceId: WORKSPACE_ID,
        memberId: MEMBER_ID,
        privacyAggregateFenceVersion: 7,
        work,
      }),
    ).resolves.toBe('authorized')

    expect(mocks.workspaceUpdateOne).toHaveBeenCalledWith(
      {
        $and: [
          { _id: WORKSPACE_ID },
          { $or: [{ lifecycleState: 'active' }, { lifecycleState: { $exists: false } }] },
          { privacyAggregateFenceVersion: 7 },
        ],
      },
      { $inc: { writeFenceVersion: 1 } },
      { session: mocks.session },
    )
    expect(work).toHaveBeenCalledWith(mocks.session)
  })

  it('treats a missing legacy workspace field as epoch zero without weakening the active-workspace check', async () => {
    await authorizeHireDigestEgress({
      workspaceId: WORKSPACE_ID,
      memberId: MEMBER_ID,
      privacyAggregateFenceVersion: 0,
      work: async () => 'authorized',
    })

    expect(mocks.workspaceUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        $and: expect.arrayContaining([
          { $or: [{ lifecycleState: 'active' }, { lifecycleState: { $exists: false } }] },
          {
            $or: [
              { privacyAggregateFenceVersion: 0 },
              { privacyAggregateFenceVersion: { $exists: false } },
            ],
          },
        ]),
      }),
      expect.anything(),
      expect.anything(),
    )
  })
})
