import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listWorkspaces: vi.fn(),
  listDue: vi.fn(),
  purge: vi.fn(),
  createFunction: vi.fn(),
}))

vi.mock('@shared/services/inngest', () => ({
  inngest: {
    createFunction: (...args: unknown[]) => mocks.createFunction(...args),
  },
}))
vi.mock('../../hire/onboardingLifecycleBoundary', () => ({
  listHireWorkspaceIdsForSweep: (...args: unknown[]) => mocks.listWorkspaces(...args),
}))
vi.mock('../services/testDriveLifecycleService', () => ({
  HIRE_ONBOARDING_TEST_DRIVE_CLEANUP_LIMIT: 20,
  listDueHireOnboardingTestDriveIds: (...args: unknown[]) => mocks.listDue(...args),
  purgeHireOnboardingTestDrive: (...args: unknown[]) => mocks.purge(...args),
}))

import {
  runHireOnboardingTestDriveCleanupRecoverySweep,
  runHireOnboardingTestDriveCleanupRequestedHandler,
} from '../jobs/testDriveCleanupJob'

const WORKSPACE_ID = '111111111111111111111111'
const TEST_DRIVE_ID = '222222222222222222222222'

function step() {
  return {
    run: vi.fn(async (_name: string, work: () => Promise<unknown>) => work()),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.createFunction.mockReturnValue({})
  mocks.listWorkspaces.mockResolvedValue([WORKSPACE_ID])
  mocks.listDue.mockResolvedValue([TEST_DRIVE_ID])
  mocks.purge.mockResolvedValue({
    claimed: true,
    purged: true,
    failed: false,
    skipped: false,
    mediaObjectsDeleted: 0,
  })
})

describe('Hire onboarding test-drive cleanup jobs', () => {
  it('uses ID-only requested-event coordinates and fails the retry when cleanup reports a durable failure', async () => {
    const runner = step()
    await expect(
      runHireOnboardingTestDriveCleanupRequestedHandler(
        { data: { workspaceId: WORKSPACE_ID, testDriveId: TEST_DRIVE_ID } },
        runner,
      ),
    ).resolves.toMatchObject({ purged: true })
    expect(mocks.purge).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID, testDriveId: TEST_DRIVE_ID })

    mocks.purge.mockResolvedValueOnce({
      claimed: true,
      purged: false,
      failed: true,
      skipped: false,
      mediaObjectsDeleted: 0,
    })
    await expect(
      runHireOnboardingTestDriveCleanupRequestedHandler(
        { data: { workspaceId: WORKSPACE_ID, testDriveId: TEST_DRIVE_ID } },
        step(),
      ),
    ).rejects.toThrow('Hire onboarding test-drive cleanup failed')
  })

  it('recovers a bounded exact-workspace page without putting contact or capability data into job payloads', async () => {
    const result = await runHireOnboardingTestDriveCleanupRecoverySweep(step())

    expect(mocks.listDue).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID, limit: 20 })
    expect(mocks.purge).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID, testDriveId: TEST_DRIVE_ID })
    expect(result).toEqual({
      workspaces: 1,
      reports: [{ workspaceId: WORKSPACE_ID, claimed: 1, purged: 1, failed: 0, mediaObjectsDeleted: 0 }],
    })
    expect(JSON.stringify(mocks.purge.mock.calls)).not.toMatch(
      /candidateEmail|inviteUrl|rawToken|capability/i,
    )
  })

  it('processes later due IDs when one poisoned marker fails, then fails the bounded page with its count', async () => {
    const secondTestDriveId = '333333333333333333333333'
    mocks.listDue.mockResolvedValue([TEST_DRIVE_ID, secondTestDriveId])
    mocks.purge
      .mockResolvedValueOnce({
        claimed: true,
        purged: false,
        failed: true,
        skipped: false,
        mediaObjectsDeleted: 0,
      })
      .mockResolvedValueOnce({
        claimed: true,
        purged: true,
        failed: false,
        skipped: false,
        mediaObjectsDeleted: 0,
      })

    await expect(
      runHireOnboardingTestDriveCleanupRecoverySweep(step()),
    ).rejects.toThrow('failed for 1 due test drive')
    expect(mocks.purge).toHaveBeenNthCalledWith(1, {
      workspaceId: WORKSPACE_ID,
      testDriveId: TEST_DRIVE_ID,
    })
    expect(mocks.purge).toHaveBeenNthCalledWith(2, {
      workspaceId: WORKSPACE_ID,
      testDriveId: secondTestDriveId,
    })
  })

  it('continues after an unexpected one-marker rejection and reports the bounded failure count', async () => {
    const secondTestDriveId = '333333333333333333333333'
    mocks.listDue.mockResolvedValue([TEST_DRIVE_ID, secondTestDriveId])
    mocks.purge
      .mockRejectedValueOnce(new Error('poisoned marker'))
      .mockResolvedValueOnce({
        claimed: true,
        purged: true,
        failed: false,
        skipped: false,
        mediaObjectsDeleted: 0,
      })

    await expect(
      runHireOnboardingTestDriveCleanupRecoverySweep(step()),
    ).rejects.toThrow('failed for 1 due test drive')
    expect(mocks.purge).toHaveBeenNthCalledWith(1, {
      workspaceId: WORKSPACE_ID,
      testDriveId: TEST_DRIVE_ID,
    })
    expect(mocks.purge).toHaveBeenNthCalledWith(2, {
      workspaceId: WORKSPACE_ID,
      testDriveId: secondTestDriveId,
    })
  })
})
