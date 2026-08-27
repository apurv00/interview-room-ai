import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createFunction: vi.fn((config) => config),
  listWorkspaces: vi.fn(),
  listDue: vi.fn(),
  process: vi.fn(),
  dispatch: vi.fn(),
}))

vi.mock('@shared/services/inngest', () => ({
  inngest: { createFunction: mocks.createFunction },
}))
vi.mock('../../hire/services/workspaceSweepService', () => ({
  listHireWorkspaceIdsForSweep: mocks.listWorkspaces,
}))
vi.mock('../services/bulkOperationService', () => ({
  listDueHireCandidateBulkOperationIds: mocks.listDue,
  processHireCandidateBulkOperation: mocks.process,
  dispatchHireCandidateBulkOperation: mocks.dispatch,
}))

import {
  runHireCandidateBulkOperationRecoverySweep,
  runHireCandidateBulkOperationRequestedHandler,
} from '../jobs/bulkOperationJob'

const step = {
  run: vi.fn(async (_name: string, work: () => unknown) => work()),
}

describe('candidate bulk operation Inngest handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    step.run.mockImplementation(async (_name: string, work: () => unknown) => work())
    mocks.dispatch.mockResolvedValue(undefined)
  })

  it('continues a bounded operation page using opaque coordinates only', async () => {
    mocks.process.mockResolvedValue({
      outcome: 'processing',
      processed: 10,
      hasRemainingWork: true,
    })
    const result = await runHireCandidateBulkOperationRequestedHandler(
      { data: { workspaceId: 'workspace-1', operationId: 'operation-1' } },
      step,
    )

    expect(mocks.process).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      operationId: 'operation-1',
    })
    expect(mocks.dispatch).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      operationId: 'operation-1',
    })
    expect(result.processed).toBe(10)
  })

  it('does not emit another event after a terminal page', async () => {
    mocks.process.mockResolvedValue({
      outcome: 'completed',
      processed: 4,
      hasRemainingWork: false,
    })
    await runHireCandidateBulkOperationRequestedHandler(
      { data: { workspaceId: 'workspace-1', operationId: 'operation-1' } },
      step,
    )
    expect(mocks.dispatch).not.toHaveBeenCalled()
  })

  it('enumerates workspace roots before tenant-scoped recovery dispatch', async () => {
    mocks.listWorkspaces.mockResolvedValue(['workspace-a', 'workspace-b'])
    mocks.listDue
      .mockResolvedValueOnce(['operation-a', 'operation-b'])
      .mockResolvedValueOnce([])

    await expect(runHireCandidateBulkOperationRecoverySweep(step)).resolves.toEqual({
      workspaces: 2,
      reports: [
        { workspaceId: 'workspace-a', dispatched: 2 },
        { workspaceId: 'workspace-b', dispatched: 0 },
      ],
    })
    expect(mocks.listDue).toHaveBeenNthCalledWith(1, {
      workspaceId: 'workspace-a',
    })
    expect(mocks.listDue).toHaveBeenNthCalledWith(2, {
      workspaceId: 'workspace-b',
    })
  })
})
