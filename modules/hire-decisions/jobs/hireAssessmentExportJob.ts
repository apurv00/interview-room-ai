import { inngest } from '@shared/services/inngest'
import {
  dispatchHireAssessmentExport,
  HIRE_ASSESSMENT_EXPORT_RECOVERY_LIMIT_PER_WORKSPACE,
  listDueHireAssessmentExportIds,
  listHireAssessmentExportWorkspaceIdsForSweep,
  processHireAssessmentExport,
} from '../services/hireAssessmentExportService'
import {
  listDueHireAssessmentExportCleanupIds,
  processHireAssessmentExportCleanup,
} from '../services/hireAssessmentExportCleanupService'
import { HIRE_ASSESSMENT_EXPORT_CLEANUP_RECOVERY_LIMIT } from '../models/HireAssessmentExportCleanup'

interface StepRunner {
  run: <T>(name: string, work: () => Promise<T> | T) => Promise<T>
}

/** The requested event is an early wake-up; durable state and leases own correctness. */
export async function runHireAssessmentExportRequestedHandler(
  event: { data: { workspaceId: string; exportId: string } },
  step: StepRunner,
) {
  const { workspaceId, exportId } = event.data
  return step.run(`process-hire-assessment-export-${exportId}`, () =>
    processHireAssessmentExport({ workspaceId, exportId }),
  )
}

/**
 * Recover by one active Hire tenant at a time. Every follow-up event contains
 * only durable IDs; the worker reauthorizes the snapshot and R2 operation.
 */
export async function runHireAssessmentExportRecoverySweep(step: StepRunner) {
  // This scan cannot be scoped to active roots: a hard-purged workspace leaves
  // only an immutable deletion tombstone behind. The cleanup worker has no
  // report-read capability and derives one exact private object key itself.
  const cleanupIds = await step.run('find-due-hire-assessment-export-cleanups', () =>
    listDueHireAssessmentExportCleanupIds({
      limit: HIRE_ASSESSMENT_EXPORT_CLEANUP_RECOVERY_LIMIT,
    }),
  )
  const cleanupReports: Array<{ cleanupId: string; outcome: string }> = []
  for (const cleanupId of cleanupIds) {
    const outcome = await step.run(
      `clean-hire-assessment-export-${cleanupId}`,
      () => processHireAssessmentExportCleanup({ cleanupId }),
    )
    cleanupReports.push({ cleanupId, outcome })
  }

  const workspaceIds = await step.run('list-hire-workspaces-for-assessment-export-recovery', () =>
    listHireAssessmentExportWorkspaceIdsForSweep(),
  )
  const reports: Array<{ workspaceId: string; dispatched: number }> = []

  for (const workspaceId of workspaceIds) {
    const exportIds = await step.run(
      `find-due-hire-assessment-exports-${workspaceId}`,
      () => listDueHireAssessmentExportIds({
        workspaceId,
        limit: HIRE_ASSESSMENT_EXPORT_RECOVERY_LIMIT_PER_WORKSPACE,
      }),
    )
    let dispatched = 0
    for (const exportId of exportIds) {
      await step.run(`dispatch-hire-assessment-export-${workspaceId}-${exportId}`, async () => {
        await dispatchHireAssessmentExport({ workspaceId, exportId })
        dispatched += 1
      })
    }
    reports.push({ workspaceId, dispatched })
  }
  return { workspaces: reports.length, reports, cleanupReports }
}

export const hireAssessmentExportRequestedJob = inngest.createFunction(
  {
    id: 'hire-assessment-export-dispatch',
    name: 'Hire: generate one private assessment export',
    retries: 2,
    concurrency: [
      { limit: 2 },
      { limit: 1, key: 'event.data.workspaceId' },
    ],
    triggers: [{ event: 'hire/assessment-export.requested' }],
  },
  async ({ event, step }) => runHireAssessmentExportRequestedHandler(
    event as unknown as { data: { workspaceId: string; exportId: string } },
    step as StepRunner,
  ),
)

export const hireAssessmentExportRecoveryJob = inngest.createFunction(
  {
    id: 'hire-assessment-export-recovery',
    name: 'Hire: recover due assessment exports',
    retries: 3,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: '* * * * *' }],
  },
  async ({ step }) => runHireAssessmentExportRecoverySweep(step as StepRunner),
)
