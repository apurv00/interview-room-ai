import mongoose from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  accountDeleteMany: vi.fn(),
}))

vi.mock('../models', () => ({
  HireCommercialAccount: { deleteMany: mocks.accountDeleteMany },
}))

import { deleteHireCommercialWorkspaceData } from '../purge-boundary'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('Hire commercial workspace purge boundary', () => {
  it('deletes the commercial account on the caller-owned purge transaction', async () => {
    const workspaceId = new mongoose.Types.ObjectId()
    const session = {
      inTransaction: vi.fn(() => true),
    } as unknown as mongoose.ClientSession
    mocks.accountDeleteMany.mockResolvedValue({ deletedCount: 1 })

    await deleteHireCommercialWorkspaceData({ workspaceId, session })

    expect(mocks.accountDeleteMany).toHaveBeenCalledWith(
      { workspaceId },
      { session },
    )
  })

  it('fails closed outside the workspace hard-purge transaction', async () => {
    const session = {
      inTransaction: vi.fn(() => false),
    } as unknown as mongoose.ClientSession

    await expect(
      deleteHireCommercialWorkspaceData({
        workspaceId: new mongoose.Types.ObjectId(),
        session,
      }),
    ).rejects.toThrow('inside workspace purge')
    expect(mocks.accountDeleteMany).not.toHaveBeenCalled()
  })
})
