import { inngest } from '@shared/services/inngest'
import { listHireWorkspaceIdsForSweep } from '../../hire/onboardingLifecycleBoundary'
import {
  HIRE_ONBOARDING_TEST_DRIVE_CLEANUP_LIMIT,
  listDueHireOnboardingTestDriveIds,
  purgeHireOnboardingTestDrive,
} from '../services/testDriveLifecycleService'

interface StepRunner {
  run: <T>(name: string, work: () => Promise<T> | T) => Promise<T>
}

type CleanupEvent = { data: { workspaceId: string; testDriveId: string } }

/**
 * The event contains only opaque control coordinates. The cleanup service
 * owns durable claims, runtime acknowledgement, and object deletion, so an
 * event replay can never recreate or expose a practice capability.
 */
export async function runHireOnboardingTestDriveCleanupRequestedHandler(
  event: CleanupEvent,
  step: StepRunner,
) {
  const { workspaceId, testDriveId } = event.data
  const result = await step.run(
    `purge-hire-onboarding-test-drive-${workspaceId}-${testDriveId}`,
    () => purgeHireOnboardingTestDrive({ workspaceId, testDriveId }),
  )
  if (result.failed) throw new Error('Hire onboarding test-drive cleanup failed')
  return result
}

/**
 * Bounded recovery enumerates tenancy roots once, then asks the marker model
 * for a small exact-workspace page. It intentionally sends no candidate,
 * invite, raw capability, or delivery data through Inngest.
 */
export async function runHireOnboardingTestDriveCleanupRecoverySweep(step: StepRunner) {
  const workspaceIds = await step.run(
    'list-hire-workspaces-for-onboarding-test-drive-cleanup',
    () => listHireWorkspaceIdsForSweep(),
  )
  const reports: Array<{
    workspaceId: string
    claimed: number
    purged: number
    failed: number
    mediaObjectsDeleted: number
  }> = []
  let failed = 0

  for (const workspaceId of workspaceIds) {
    const testDriveIds = await step.run(
      `find-due-hire-onboarding-test-drives-${workspaceId}`,
      () => listDueHireOnboardingTestDriveIds({
        workspaceId,
        limit: HIRE_ONBOARDING_TEST_DRIVE_CLEANUP_LIMIT,
      }),
    )
    let claimed = 0
    let purged = 0
    let failedForWorkspace = 0
    let mediaObjectsDeleted = 0
    for (const testDriveId of testDriveIds) {
      // Do not starve later due markers because one poisoned graph needs a
      // retry. The final throw still marks this bounded recovery page failed
      // for Inngest after every exact-coordinate step has had a chance to run.
      try {
        const result = await step.run(
          `purge-hire-onboarding-test-drive-${workspaceId}-${testDriveId}`,
          async () => {
            try {
              return await purgeHireOnboardingTestDrive({ workspaceId, testDriveId })
            } catch {
              // A recovery step must itself settle so a poisoned marker cannot
              // abort/replay the whole page before later IDs are attempted.
              return null
            }
          },
        )
        if (!result || result.failed) {
          failed += 1
          failedForWorkspace += 1
          continue
        }
        if (result.claimed) claimed += 1
        if (result.purged) purged += 1
        mediaObjectsDeleted += result.mediaObjectsDeleted
      } catch {
        // Keep the exact ID in the durable Inngest step name but never copy an
        // arbitrary failure message into job output. The page-level count is
        // enough to trigger retry after every later due marker has run.
        failed += 1
        failedForWorkspace += 1
      }
    }
    reports.push({ workspaceId, claimed, purged, failed: failedForWorkspace, mediaObjectsDeleted })
  }

  if (failed > 0) {
    throw new Error(`Hire onboarding test-drive cleanup failed for ${failed} due test drive(s)`)
  }
  return { workspaces: reports.length, reports }
}

// Registration belongs to the shared Inngest route owned by the parent slice.
// These exports are intentionally standalone until that explicit registry edit.
export const hireOnboardingTestDriveCleanupRequestedJob = inngest.createFunction(
  {
    id: 'hire-onboarding-test-drive-cleanup-requested',
    name: 'Hire: clean one onboarding test drive',
    retries: 3,
    concurrency: [
      { limit: 3 },
      { limit: 1, key: 'event.data.workspaceId' },
    ],
    triggers: [{ event: 'hire/onboarding-test-drive.cleanup-requested' }],
  },
  async ({ event, step }) =>
    runHireOnboardingTestDriveCleanupRequestedHandler(
      event as unknown as CleanupEvent,
      step as StepRunner,
    ),
)

export const hireOnboardingTestDriveCleanupRecoveryJob = inngest.createFunction(
  {
    id: 'hire-onboarding-test-drive-cleanup-recovery',
    name: 'Hire: recover due onboarding test drives',
    retries: 3,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: '19 * * * *' }],
  },
  async ({ step }) => runHireOnboardingTestDriveCleanupRecoverySweep(step as StepRunner),
)
