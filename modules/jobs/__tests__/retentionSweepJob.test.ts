import { describe, expect, it, vi } from 'vitest'

const { mockCreateFunction, mockRunSweep } = vi.hoisted(() => ({
  mockCreateFunction: vi.fn((_config: unknown, handler: unknown) => ({ handler })),
  mockRunSweep: vi.fn(),
}))

vi.mock('@shared/services/inngest', () => ({
  inngest: { createFunction: mockCreateFunction },
}))
vi.mock('../services/retentionService', () => ({
  runJobsRetentionSweep: mockRunSweep,
}))

import { runRetentionSweepHandler } from '../jobs/retentionSweepJob'

describe('jobsRetentionSweepJob', () => {
  it('registers one stable daily function', () => {
    expect(mockCreateFunction).toHaveBeenCalledOnce()
    expect(mockCreateFunction.mock.calls[0][0]).toEqual({
      id: 'jobs-retention-sweep',
      name: 'Jobs: daily retention lifecycle sweep',
      retries: 2,
      triggers: [{ cron: '10 2 * * *' }],
    })
  })

  it('uses one idempotent step with a stable run timestamp', async () => {
    const now = new Date('2026-07-21T12:00:00.000Z')
    const report = { dryRun: false, at: now.toISOString() }
    mockRunSweep.mockResolvedValue(report)
    const step = {
      run: vi.fn(async (_name: string, work: () => Promise<unknown>) => work()),
    }

    await expect(runRetentionSweepHandler(step, { now })).resolves.toBe(report)
    expect(step.run).toHaveBeenCalledWith('apply-lifecycle-policy', expect.any(Function))
    expect(mockRunSweep).toHaveBeenCalledWith({ now })
  })
})
