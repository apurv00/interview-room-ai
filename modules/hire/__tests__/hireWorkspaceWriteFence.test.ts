import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  startSession: vi.fn(),
  memberUpdate: vi.fn(),
  workspaceUpdate: vi.fn(),
}))

vi.mock('mongoose', () => ({
  default: { startSession: mocks.startSession },
}))

vi.mock('../services/hireControlBoundary', () => ({
  connectHireControlDB: mocks.connect,
}))

vi.mock('../models', () => ({
  HireWorkspaceMember: { updateOne: mocks.memberUpdate },
  HireWorkspace: { updateOne: mocks.workspaceUpdate },
}))

vi.mock('../services/hireWorkspaceLifecycleFilter', () => ({
  activeHireWorkspaceLifecycleFilter: () => ({
    $or: [{ lifecycleState: 'active' }, { lifecycleState: { $exists: false } }],
  }),
}))

import { withActiveHireWorkspaceWriteTransaction } from '../services/hireWorkspaceWriteFence'

const session = {
  withTransaction: vi.fn(async (work: () => Promise<void>) => work()),
  endSession: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connect.mockResolvedValue(undefined)
  mocks.startSession.mockResolvedValue(session)
  mocks.memberUpdate.mockResolvedValue({ matchedCount: 1 })
  mocks.workspaceUpdate.mockResolvedValue({ matchedCount: 1 })
})

describe('withActiveHireWorkspaceWriteTransaction', () => {
  it('claims the active workspace and member in the same transaction as the write', async () => {
    const work = vi.fn().mockResolvedValue('committed')

    await expect(
      withActiveHireWorkspaceWriteTransaction('ws-1' as never, 'member-1' as never, work),
    ).resolves.toBe('committed')

    expect(mocks.connect).toHaveBeenCalledOnce()
    expect(mocks.memberUpdate).toHaveBeenCalledWith(
      {
        _id: 'member-1',
        workspaceId: 'ws-1',
        authState: 'active',
      },
      { $inc: { workspaceWriteFenceVersion: 1 } },
      { session },
    )
    expect(mocks.workspaceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'ws-1' }),
      { $inc: { writeFenceVersion: 1 } },
      { session },
    )
    expect(mocks.workspaceUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.memberUpdate.mock.invocationCallOrder[0],
    )
    expect(mocks.memberUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      work.mock.invocationCallOrder[0],
    )
    expect(work).toHaveBeenCalledWith(session)
    expect(session.endSession).toHaveBeenCalledOnce()
  })

  it('fails before the write when the Hire member was removed', async () => {
    mocks.memberUpdate.mockResolvedValue({ matchedCount: 0 })
    const work = vi.fn()

    await expect(
      withActiveHireWorkspaceWriteTransaction('ws-1' as never, 'member-1' as never, work),
    ).rejects.toMatchObject({ code: 'MEMBER_REMOVED' })
    expect(mocks.workspaceUpdate).toHaveBeenCalledOnce()
    expect(work).not.toHaveBeenCalled()
    expect(session.endSession).toHaveBeenCalledOnce()
  })

  it('fails before the write when workspace deletion committed first', async () => {
    mocks.workspaceUpdate.mockResolvedValue({ matchedCount: 0 })
    const work = vi.fn()

    await expect(
      withActiveHireWorkspaceWriteTransaction('ws-1' as never, 'member-1' as never, work),
    ).rejects.toMatchObject({ code: 'WORKSPACE_DELETION_PENDING' })
    expect(work).not.toHaveBeenCalled()
  })

  it('supports a transaction callback whose valid result is undefined', async () => {
    await expect(
      withActiveHireWorkspaceWriteTransaction(
        'ws-1' as never,
        'member-1' as never,
        async () => undefined,
      ),
    ).resolves.toBeUndefined()
  })
})
