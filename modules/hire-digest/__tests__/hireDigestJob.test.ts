import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createFunction: vi.fn((definition: unknown) => definition),
  dispatch: vi.fn(),
  listDue: vi.fn(),
  listWorkspaces: vi.fn(),
  process: vi.fn(),
  schedule: vi.fn(),
}))

vi.mock('@shared/services/inngest', () => ({
  inngest: { createFunction: mocks.createFunction },
}))
vi.mock('../services/hireDigestService', () => ({
  dispatchHireDailyDigest: mocks.dispatch,
  HIRE_DIGEST_RECOVERY_LIMIT_PER_WORKSPACE: 25,
  listActiveHireDigestWorkspaceIds: mocks.listWorkspaces,
  listDueHireDigestOutboxIds: mocks.listDue,
  processHireDailyDigest: mocks.process,
  scheduleHireDailyDigestsForWorkspace: mocks.schedule,
}))

import {
  hireDailyDigestRecoveryJob,
  hireDailyDigestRequestedJob,
  hireDailyDigestScheduleJob,
  runHireDailyDigestRecoverySweep,
  runHireDailyDigestRequestedHandler,
  runHireDailyDigestScheduleSweep,
} from '../jobs/hireDigestJob'

function step() {
  return { run: vi.fn(async (_name: string, work: () => unknown) => work()) }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listWorkspaces.mockResolvedValue(['workspace-a', 'workspace-b'])
  mocks.listDue.mockResolvedValue([])
  mocks.schedule.mockResolvedValue([])
  mocks.dispatch.mockResolvedValue(undefined)
  mocks.process.mockResolvedValue({ processed: true, outcome: 'sent' })
})

describe('Hire daily-digest Inngest jobs', () => {
  it('uses only the durable requested event coordinates', async () => {
    const runner = step()
    await expect(runHireDailyDigestRequestedHandler({
      data: { workspaceId: 'workspace-a', outboxId: 'outbox-a' },
    }, runner)).resolves.toEqual({ processed: true, outcome: 'sent' })
    expect(mocks.process).toHaveBeenCalledWith({ workspaceId: 'workspace-a', outboxId: 'outbox-a' })
  })

  it('schedules each active workspace through its unique daily outboxes', async () => {
    mocks.schedule
      .mockResolvedValueOnce(['outbox-a'])
      .mockResolvedValueOnce(['outbox-b', 'outbox-c'])
    const report = await runHireDailyDigestScheduleSweep(step())

    expect(mocks.schedule).toHaveBeenNthCalledWith(1, { workspaceId: 'workspace-a' })
    expect(mocks.schedule).toHaveBeenNthCalledWith(2, { workspaceId: 'workspace-b' })
    expect(mocks.dispatch.mock.calls).toEqual([
      [{ workspaceId: 'workspace-a', outboxId: 'outbox-a' }],
      [{ workspaceId: 'workspace-b', outboxId: 'outbox-b' }],
      [{ workspaceId: 'workspace-b', outboxId: 'outbox-c' }],
    ])
    expect(report).toEqual({
      workspaces: 2,
      reports: [
        { workspaceId: 'workspace-a', dispatched: 1 },
        { workspaceId: 'workspace-b', dispatched: 2 },
      ],
    })
  })

  it('recovers bounded due rows one active tenant at a time', async () => {
    mocks.listDue
      .mockResolvedValueOnce(['outbox-a'])
      .mockResolvedValueOnce(['outbox-b', 'outbox-c'])
    const report = await runHireDailyDigestRecoverySweep(step())

    expect(mocks.listDue).toHaveBeenNthCalledWith(1, { workspaceId: 'workspace-a', limit: 25 })
    expect(mocks.listDue).toHaveBeenNthCalledWith(2, { workspaceId: 'workspace-b', limit: 25 })
    expect(mocks.dispatch.mock.calls).toEqual([
      [{ workspaceId: 'workspace-a', outboxId: 'outbox-a' }],
      [{ workspaceId: 'workspace-b', outboxId: 'outbox-b' }],
      [{ workspaceId: 'workspace-b', outboxId: 'outbox-c' }],
    ])
    expect(report).toEqual({
      workspaces: 2,
      reports: [
        { workspaceId: 'workspace-a', dispatched: 1 },
        { workspaceId: 'workspace-b', dispatched: 2 },
      ],
    })
  })

  it('defines a tenant-serialized requested handler, UTC schedule, and recovery sweep', () => {
    expect(hireDailyDigestRequestedJob).toMatchObject({
      id: 'hire-daily-digest-dispatch',
      retries: 2,
      concurrency: [{ limit: 3 }, { limit: 1, key: 'event.data.workspaceId' }],
      triggers: [{ event: 'hire/digest.requested' }],
    })
    expect(hireDailyDigestScheduleJob).toMatchObject({
      id: 'hire-daily-digest-schedule',
      triggers: [{ cron: '0 8 * * *' }],
    })
    expect(hireDailyDigestRecoveryJob).toMatchObject({
      id: 'hire-daily-digest-recovery',
      triggers: [{ cron: '* * * * *' }],
    })
  })
})
