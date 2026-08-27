import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  deleteItems: vi.fn(),
  deleteOperations: vi.fn(),
}))

vi.mock('../models', () => ({
  HireCandidateBulkOperationItem: { deleteMany: mocks.deleteItems },
  HireCandidateBulkOperation: { deleteMany: mocks.deleteOperations },
}))

import { deleteHireCandidateActionWorkspaceData } from '../purge-boundary'

describe('candidate action workspace purge boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.deleteItems.mockResolvedValue({ deletedCount: 2 })
    mocks.deleteOperations.mockResolvedValue({ deletedCount: 1 })
  })

  it('fails before touching data outside a caller-owned transaction', async () => {
    const session = { inTransaction: () => false }

    await expect(
      deleteHireCandidateActionWorkspaceData({
        workspaceId: 'workspace-1' as never,
        session: session as never,
      }),
    ).rejects.toThrow('inside workspace purge')
    expect(mocks.deleteItems).not.toHaveBeenCalled()
    expect(mocks.deleteOperations).not.toHaveBeenCalled()
  })

  it('deletes row items before operation parents in the same transaction', async () => {
    const session = { inTransaction: () => true }

    await deleteHireCandidateActionWorkspaceData({
      workspaceId: 'workspace-1' as never,
      session: session as never,
    })

    expect(mocks.deleteItems).toHaveBeenCalledWith(
      { workspaceId: 'workspace-1' },
      { session },
    )
    expect(mocks.deleteOperations).toHaveBeenCalledWith(
      { workspaceId: 'workspace-1' },
      { session },
    )
    expect(mocks.deleteItems.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deleteOperations.mock.invocationCallOrder[0],
    )
  })
})
