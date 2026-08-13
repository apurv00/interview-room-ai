import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createFunction: vi.fn((options: unknown, handler: unknown) => ({ options, handler })),
  process: vi.fn(),
  cleanupExpiredRawPayload: vi.fn(),
  cleanupStaleIdentity: vi.fn(),
  listDue: vi.fn(),
  dispatch: vi.fn(),
  listWorkspaces: vi.fn(),
}))

vi.mock('@shared/services/inngest', () => ({
  inngest: { createFunction: mocks.createFunction },
}))
vi.mock('../services/intakeQueueService', () => ({
  processHireIntakeTask: (...args: unknown[]) => mocks.process(...args),
  cleanupExpiredHireIntakeRawPayloadTasks: (...args: unknown[]) => mocks.cleanupExpiredRawPayload(...args),
  cleanupStaleHireIntakeNeedsIdentityTasks: (...args: unknown[]) => mocks.cleanupStaleIdentity(...args),
  listDueHireIntakeTaskIds: (...args: unknown[]) => mocks.listDue(...args),
  dispatchHireIntakeTask: (...args: unknown[]) => mocks.dispatch(...args),
}))
vi.mock('../services/workspaceSweepService', () => ({
  listHireWorkspaceIdsForSweep: (...args: unknown[]) => mocks.listWorkspaces(...args),
}))

import {
  hireIntakeRecoveryJob,
  hireIntakeRequestedJob,
  runHireIntakeRecoverySweep,
  runHireIntakeRequestedHandler,
} from '../jobs/intakeJob'

function stepRunner() {
  return {
    run: vi.fn(async (_name: string, work: () => Promise<unknown>) => work()),
  }
}

describe('Hire intake Inngest jobs', () => {
  it('registers a tenant-serialized event worker and a durable recovery sweep', () => {
    expect(hireIntakeRequestedJob.options).toMatchObject({
      id: 'hire-resume-intake',
      retries: 2,
      concurrency: [{ limit: 3 }, { limit: 1, key: 'event.data.workspaceId' }],
      triggers: [{ event: 'hire/intake.requested' }],
    })
    expect(hireIntakeRecoveryJob.options).toMatchObject({
      id: 'hire-resume-intake-recovery',
      retries: 3,
      concurrency: [{ limit: 1 }],
      triggers: [{ cron: '* * * * *' }],
    })
  })

  it('passes only durable task coordinates from event to worker', async () => {
    mocks.process.mockResolvedValue({ outcome: 'completed' })
    const step = stepRunner()

    await expect(runHireIntakeRequestedHandler({
      data: { workspaceId: 'a'.repeat(24), taskId: 'b'.repeat(24) },
    }, step)).resolves.toEqual({ outcome: 'completed' })

    expect(mocks.process).toHaveBeenCalledWith({
      workspaceId: 'a'.repeat(24),
      taskId: 'b'.repeat(24),
    })
  })

  it('recovers every due task through its exact workspace-scoped query and dispatch', async () => {
    mocks.listWorkspaces.mockResolvedValue(['a'.repeat(24), 'b'.repeat(24)])
    mocks.listDue
      .mockResolvedValueOnce(['c'.repeat(24), 'd'.repeat(24)])
      .mockResolvedValueOnce([])
    mocks.cleanupStaleIdentity
      .mockResolvedValueOnce({ cancelled: 1 })
      .mockResolvedValueOnce({ cancelled: 0 })
    mocks.cleanupExpiredRawPayload
      .mockResolvedValueOnce({ cancelled: 2 })
      .mockResolvedValueOnce({ cancelled: 0 })
    mocks.dispatch.mockResolvedValue(undefined)
    const step = stepRunner()

    await expect(runHireIntakeRecoverySweep(step)).resolves.toEqual({
      workspaces: 2,
      reports: [
        {
          workspaceId: 'a'.repeat(24),
          cancelledExpiredRawPayload: 2,
          cancelledStaleNeedsIdentity: 1,
          dispatched: 2,
        },
        {
          workspaceId: 'b'.repeat(24),
          cancelledExpiredRawPayload: 0,
          cancelledStaleNeedsIdentity: 0,
          dispatched: 0,
        },
      ],
    })

    expect(mocks.cleanupExpiredRawPayload).toHaveBeenNthCalledWith(1, {
      workspaceId: 'a'.repeat(24),
      batchSize: 20,
    })
    expect(mocks.cleanupExpiredRawPayload).toHaveBeenNthCalledWith(2, {
      workspaceId: 'b'.repeat(24),
      batchSize: 20,
    })

    expect(mocks.cleanupStaleIdentity).toHaveBeenNthCalledWith(1, {
      workspaceId: 'a'.repeat(24),
      batchSize: 20,
    })
    expect(mocks.cleanupStaleIdentity).toHaveBeenNthCalledWith(2, {
      workspaceId: 'b'.repeat(24),
      batchSize: 20,
    })

    expect(mocks.listDue).toHaveBeenNthCalledWith(1, {
      workspaceId: 'a'.repeat(24),
      limit: 20,
    })
    expect(mocks.listDue).toHaveBeenNthCalledWith(2, {
      workspaceId: 'b'.repeat(24),
      limit: 20,
    })
    expect(mocks.dispatch.mock.calls).toEqual([
      [{ workspaceId: 'a'.repeat(24), taskId: 'c'.repeat(24) }],
      [{ workspaceId: 'a'.repeat(24), taskId: 'd'.repeat(24) }],
    ])
  })
})
