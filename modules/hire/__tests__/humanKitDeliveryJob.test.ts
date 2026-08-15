import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createFunction: vi.fn((options: unknown, handler: unknown) => ({ options, handler })),
  process: vi.fn(),
  listDue: vi.fn(),
  dispatch: vi.fn(),
  listWorkspaces: vi.fn(),
}))

vi.mock('@shared/services/inngest', () => ({
  inngest: { createFunction: mocks.createFunction },
}))
vi.mock('../services/humanKitDeliveryService', () => ({
  processHumanInterviewKitDelivery: (...args: unknown[]) => mocks.process(...args),
  listDueHumanInterviewKitDeliveryIds: (...args: unknown[]) => mocks.listDue(...args),
  dispatchHumanInterviewKitDelivery: (...args: unknown[]) => mocks.dispatch(...args),
  HIRE_HUMAN_KIT_RECOVERY_LIMIT_PER_WORKSPACE: 10,
}))
vi.mock('../services/workspaceSweepService', () => ({
  listHireWorkspaceIdsForSweep: (...args: unknown[]) => mocks.listWorkspaces(...args),
}))

import {
  hireHumanKitDeliveryRecoveryJob,
  hireHumanKitDeliveryRequestedJob,
  runHireHumanKitDeliveryRecoverySweep,
  runHireHumanKitDeliveryRequestedHandler,
} from '../jobs/humanKitDeliveryJob'

function stepRunner() {
  return {
    run: vi.fn(async (_name: string, work: () => Promise<unknown>) => work()),
  }
}

describe('Hire human interview-kit Inngest jobs', () => {
  it('registers tenant-serialized delivery and a durable minute recovery sweep', () => {
    expect(hireHumanKitDeliveryRequestedJob.options).toMatchObject({
      id: 'hire-human-kit-delivery-dispatch',
      retries: 2,
      concurrency: [{ limit: 3 }, { limit: 1, key: 'event.data.workspaceId' }],
      triggers: [{ event: 'hire/human-kit.requested' }],
    })
    expect(hireHumanKitDeliveryRecoveryJob.options).toMatchObject({
      id: 'hire-human-kit-delivery-recovery',
      retries: 3,
      concurrency: [{ limit: 1 }],
      triggers: [{ cron: '* * * * *' }],
    })
  })

  it('passes only exact durable coordinates from the event to one claim', async () => {
    mocks.process.mockResolvedValue('sent')
    const step = stepRunner()

    await expect(runHireHumanKitDeliveryRequestedHandler({
      data: { workspaceId: 'a'.repeat(24), deliveryId: 'b'.repeat(24) },
    }, step)).resolves.toBe('sent')

    expect(mocks.process).toHaveBeenCalledWith({
      workspaceId: 'a'.repeat(24),
      deliveryId: 'b'.repeat(24),
    })
  })

  it('recovers every workspace through a bounded exact-workspace due query', async () => {
    mocks.listWorkspaces.mockResolvedValue(['a'.repeat(24), 'b'.repeat(24)])
    mocks.listDue
      .mockResolvedValueOnce(['c'.repeat(24), 'd'.repeat(24)])
      .mockResolvedValueOnce([])
    mocks.dispatch.mockResolvedValue(undefined)
    const step = stepRunner()

    await expect(runHireHumanKitDeliveryRecoverySweep(step)).resolves.toEqual({
      workspaces: 2,
      reports: [
        { workspaceId: 'a'.repeat(24), dispatched: 2 },
        { workspaceId: 'b'.repeat(24), dispatched: 0 },
      ],
    })

    expect(mocks.listDue).toHaveBeenNthCalledWith(1, {
      workspaceId: 'a'.repeat(24),
      limit: 10,
    })
    expect(mocks.listDue).toHaveBeenNthCalledWith(2, {
      workspaceId: 'b'.repeat(24),
      limit: 10,
    })
    expect(mocks.dispatch.mock.calls).toEqual([
      [{ workspaceId: 'a'.repeat(24), deliveryId: 'c'.repeat(24) }],
      [{ workspaceId: 'a'.repeat(24), deliveryId: 'd'.repeat(24) }],
    ])
  })
})
