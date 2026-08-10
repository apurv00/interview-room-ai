import { describe, expect, it, vi } from 'vitest'

const { createFunction, purgeMedia, reconcileMedia, listWorkspaces } = vi.hoisted(() => ({
  createFunction: vi.fn((options: unknown, handler: unknown) => ({ options, handler })),
  purgeMedia: vi.fn().mockResolvedValue({ purged: 1, failed: 0 }),
  reconcileMedia: vi.fn().mockResolvedValue({ closedJobs: 1, scheduled: 2 }),
  listWorkspaces: vi.fn().mockResolvedValue([
    '111111111111111111111111',
    '222222222222222222222222',
  ]),
}))

vi.mock('@shared/services/inngest', () => ({ inngest: { createFunction } }))
vi.mock('../services/mediaLifecycleService', () => ({
  purgeDueHireMedia: (...args: unknown[]) => purgeMedia(...args),
  reconcileClosedJobMediaRetention: (...args: unknown[]) => reconcileMedia(...args),
}))
vi.mock('../services/workspaceSweepService', () => ({
  listHireWorkspaceIdsForSweep: (...args: unknown[]) => listWorkspaces(...args),
}))

import { hireMediaRetentionJob } from '../jobs/mediaRetentionJob'

describe('Hire media retention Inngest job', () => {
  it('enumerates tenancy roots and invokes only workspace-scoped child sweeps', async () => {
    const step = {
      run: vi.fn(async (_name: string, work: () => Promise<unknown>) => work()),
    }
    await hireMediaRetentionJob.handler({ step })

    expect(step.run).toHaveBeenNthCalledWith(
      1,
      'list-hire-workspaces-for-media-retention',
      expect.any(Function),
    )
    expect(purgeMedia.mock.calls).toEqual([
      [{ workspaceId: '111111111111111111111111', batchSize: 100 }],
      [{ workspaceId: '222222222222222222222222', batchSize: 100 }],
    ])
    expect(reconcileMedia.mock.calls).toEqual([
      [{ workspaceId: '111111111111111111111111', batchSize: 100 }],
      [{ workspaceId: '222222222222222222222222', batchSize: 100 }],
    ])
    expect(reconcileMedia.mock.invocationCallOrder[0]).toBeLessThan(
      purgeMedia.mock.invocationCallOrder[0],
    )
  })

  it('throws when deletion fails so Inngest retries the scoped lease', async () => {
    purgeMedia.mockResolvedValueOnce({ purged: 0, failed: 1 })
    const step = {
      run: vi.fn(async (_name: string, work: () => Promise<unknown>) => work()),
    }

    await expect(hireMediaRetentionJob.handler({ step })).rejects.toThrow(
      /media purge failed/i,
    )
  })
})
