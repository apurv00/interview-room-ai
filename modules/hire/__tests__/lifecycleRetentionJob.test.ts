import { describe, expect, it, vi } from 'vitest'

const { createFunction, anonymize, purge, listWorkspaces } = vi.hoisted(() => ({
  createFunction: vi.fn((options: unknown, handler: unknown) => ({ options, handler })),
  anonymize: vi.fn().mockResolvedValue({ anonymized: 2, failed: 0 }),
  purge: vi.fn().mockResolvedValue({ purged: 1, failed: 0 }),
  listWorkspaces: vi.fn().mockResolvedValue(['111111111111111111111111']),
}))

vi.mock('@shared/services/inngest', () => ({
  inngest: { createFunction },
}))
vi.mock('../services/candidateRetentionService', () => ({
  anonymizeDueHireCandidates: (...args: unknown[]) => anonymize(...args),
}))
vi.mock('../services/workspacePurgeService', () => ({
  purgeDueHireWorkspaces: (...args: unknown[]) => purge(...args),
}))
vi.mock('../services/workspaceSweepService', () => ({
  listHireWorkspaceIdsForSweep: (...args: unknown[]) => listWorkspaces(...args),
}))

import { hireLifecycleRetentionJob } from '../jobs/lifecycleRetentionJob'

describe('Hire lifecycle retention Inngest job', () => {
  it('is a single-concurrency retried daily control sweep with durable service steps', async () => {
    expect(createFunction).toHaveBeenCalledOnce()
    expect(hireLifecycleRetentionJob.options).toMatchObject({
      id: 'hire-lifecycle-retention',
      retries: 5,
      concurrency: [{ limit: 1 }],
      triggers: [{ cron: '43 2 * * *' }],
    })
    const step = {
      run: vi.fn(async (_name: string, work: () => Promise<unknown>) => work()),
    }
    await hireLifecycleRetentionJob.handler({ step })
    expect(step.run).toHaveBeenNthCalledWith(
      1,
      'list-hire-workspaces-for-lifecycle-retention',
      expect.any(Function),
    )
    expect(step.run).toHaveBeenNthCalledWith(
      2,
      'anonymize-due-hire-candidates-111111111111111111111111',
      expect.any(Function),
    )
    expect(step.run).toHaveBeenNthCalledWith(
      3,
      'purge-due-hire-workspace-111111111111111111111111',
      expect.any(Function),
    )
    expect(anonymize).toHaveBeenCalledWith({
      workspaceId: '111111111111111111111111',
      batchSize: 100,
    })
    expect(purge).toHaveBeenCalledWith({
      workspaceId: '111111111111111111111111',
    })
  })

  it('throws a scoped step failure so Inngest retries a durable claim', async () => {
    anonymize.mockResolvedValueOnce({ anonymized: 0, failed: 1 })
    const step = {
      run: vi.fn(async (_name: string, work: () => Promise<unknown>) => work()),
    }

    await expect(hireLifecycleRetentionJob.handler({ step })).rejects.toThrow(
      /candidate anonymization failed/i,
    )
  })
})
