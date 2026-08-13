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
vi.mock('../services/screeningInvitationService', () => ({
  processHireScreeningInvitationItem: (...args: unknown[]) => mocks.process(...args),
  listDueHireScreeningInvitationItemIds: (...args: unknown[]) => mocks.listDue(...args),
  dispatchHireScreeningInvitationItem: (...args: unknown[]) => mocks.dispatch(...args),
  HIRE_SCREENING_INVITATION_RECOVERY_LIMIT_PER_WORKSPACE: 10,
}))
vi.mock('../services/workspaceSweepService', () => ({
  listHireWorkspaceIdsForSweep: (...args: unknown[]) => mocks.listWorkspaces(...args),
}))

import {
  hireScreeningInvitationRecoveryJob,
  hireScreeningInvitationRequestedJob,
  runHireScreeningInvitationRecoverySweep,
  runHireScreeningInvitationRequestedHandler,
} from '../jobs/screeningInvitationJob'

function stepRunner() {
  return {
    run: vi.fn(async (_name: string, work: () => Promise<unknown>) => work()),
  }
}

describe('Hire screening invitation Inngest jobs', () => {
  it('registers only a tenant-serialized event dispatcher and a durable minute recovery sweep', () => {
    expect(hireScreeningInvitationRequestedJob.options).toMatchObject({
      id: 'hire-screening-invitation-dispatch',
      retries: 2,
      concurrency: [{ limit: 3 }, { limit: 1, key: 'event.data.workspaceId' }],
      triggers: [{ event: 'hire/screening-invitation.requested' }],
    })
    expect(hireScreeningInvitationRecoveryJob.options).toMatchObject({
      id: 'hire-screening-invitation-recovery',
      retries: 3,
      concurrency: [{ limit: 1 }],
      triggers: [{ cron: '* * * * *' }],
    })
  })

  it('passes only immutable worker coordinates from the event to one item claim', async () => {
    mocks.process.mockResolvedValue({ outcome: 'sent' })
    const step = stepRunner()

    await expect(
      runHireScreeningInvitationRequestedHandler({
        data: { workspaceId: 'a'.repeat(24), itemId: 'b'.repeat(24) },
      }, step),
    ).resolves.toEqual({ outcome: 'sent' })

    expect(mocks.process).toHaveBeenCalledWith({
      workspaceId: 'a'.repeat(24),
      itemId: 'b'.repeat(24),
    })
  })

  it('recovers each workspace fairly through its bounded tenant-scoped due query', async () => {
    mocks.listWorkspaces.mockResolvedValue(['a'.repeat(24), 'b'.repeat(24)])
    mocks.listDue
      .mockResolvedValueOnce(['c'.repeat(24), 'd'.repeat(24)])
      .mockResolvedValueOnce([])
    mocks.dispatch.mockResolvedValue(undefined)
    const step = stepRunner()

    await expect(runHireScreeningInvitationRecoverySweep(step)).resolves.toEqual({
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
      [{ workspaceId: 'a'.repeat(24), itemId: 'c'.repeat(24) }],
      [{ workspaceId: 'a'.repeat(24), itemId: 'd'.repeat(24) }],
    ])
  })
})
