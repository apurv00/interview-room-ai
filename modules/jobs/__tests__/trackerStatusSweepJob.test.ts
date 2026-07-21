import { describe, expect, it, vi } from 'vitest'

const { mockCreateFunction, mockRunSweep } = vi.hoisted(() => ({
  mockCreateFunction: vi.fn((_config: unknown, handler: unknown) => ({ handler })),
  mockRunSweep: vi.fn(),
}))

vi.mock('@shared/services/inngest', () => ({
  inngest: { createFunction: mockCreateFunction },
}))
vi.mock('../services/trackerStatusSweepService', () => ({
  runTrackerStatusSweep: mockRunSweep,
}))

import { runTrackerStatusSweepHandler } from '../jobs/trackerStatusSweepJob'

describe('jobsTrackerStatusSweepJob', () => {
  it('registers one stable serialized daily function', () => {
    expect(mockCreateFunction).toHaveBeenCalledOnce()
    expect(mockCreateFunction.mock.calls[0][0]).toEqual({
      id: 'jobs-tracker-status-sweep',
      name: 'Jobs: daily confirmed-application inference sweep',
      retries: 2,
      concurrency: [{ limit: 1 }],
      triggers: [{ cron: '30 2 * * *' }],
    })
  })

  it('uses one idempotent step with a stable run timestamp', async () => {
    const now = new Date('2026-07-21T12:00:00.000Z')
    const report = { at: now.toISOString(), ghosted: 1 }
    mockRunSweep.mockResolvedValue(report)
    const step = {
      run: vi.fn(async (_name: string, work: () => Promise<unknown>) => work()),
    }

    await expect(runTrackerStatusSweepHandler(step, { now, limit: 20 })).resolves.toBe(report)
    expect(step.run).toHaveBeenCalledWith(
      'infer-confirmed-application-outcomes',
      expect.any(Function),
    )
    expect(mockRunSweep).toHaveBeenCalledWith({ now, limit: 20 })
  })
})
