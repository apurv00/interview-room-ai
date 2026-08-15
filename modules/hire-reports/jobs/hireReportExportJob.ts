import { inngest } from '@shared/services/inngest'
import {
  dispatchHireReportExport,
  HIRE_REPORT_EXPORT_RECOVERY_LIMIT_PER_WORKSPACE,
  listDueHireReportExportIds,
  listHireReportExportWorkspaceIdsForSweep,
  processHireReportExport,
} from '../services/hireReportExportService'
import {
  listDueHireReportExportCleanupIds,
  processHireReportExportCleanup,
} from '../services/hireReportExportCleanupService'
import { HIRE_REPORT_EXPORT_CLEANUP_RECOVERY_LIMIT } from '../models/HireReportExportCleanup'

interface StepRunner {
  run: <T>(name: string, work: () => Promise<T> | T) => Promise<T>
}

/** The requested event is only an early wake-up; durable state and leases own correctness. */
export async function runHireReportExportRequestedHandler(
  event: { data: { workspaceId: string; exportId: string } },
  step: StepRunner,
) {
  const { workspaceId, exportId } = event.data
  return step.run(`process-hire-report-export-${exportId}`, () =>
    processHireReportExport({ workspaceId, exportId }),
  )
}

/**
 * Recovery dispatches opaque IDs one tenant at a time. Cleanup runs first and
 * globally because a hard-purged workspace can leave only a tombstone behind.
 */
export async function runHireReportExportRecoverySweep(step: StepRunner) {
  const cleanupIds = await step.run('find-due-hire-report-export-cleanups', () =>
    listDueHireReportExportCleanupIds({ limit: HIRE_REPORT_EXPORT_CLEANUP_RECOVERY_LIMIT }),
  )
  const cleanupReports: Array<{ cleanupId: string; outcome: string }> = []
  for (const cleanupId of cleanupIds) {
    const outcome = await step.run(
      `clean-hire-report-export-${cleanupId}`,
      () => processHireReportExportCleanup({ cleanupId }),
    )
    cleanupReports.push({ cleanupId, outcome })
  }

  const workspaceIds = await step.run('list-hire-workspaces-for-report-export-recovery', () =>
    listHireReportExportWorkspaceIdsForSweep(),
  )
  const reports: Array<{ workspaceId: string; dispatched: number }> = []
  for (const workspaceId of workspaceIds) {
    const exportIds = await step.run(
      `find-due-hire-report-exports-${workspaceId}`,
      () => listDueHireReportExportIds({
        workspaceId,
        limit: HIRE_REPORT_EXPORT_RECOVERY_LIMIT_PER_WORKSPACE,
      }),
    )
    let dispatched = 0
    for (const exportId of exportIds) {
      await step.run(`dispatch-hire-report-export-${workspaceId}-${exportId}`, async () => {
        await dispatchHireReportExport({ workspaceId, exportId })
        dispatched += 1
      })
    }
    reports.push({ workspaceId, dispatched })
  }
  return { workspaces: reports.length, reports, cleanupReports }
}

/** Not registered yet: app/api/inngest stays untouched until release wiring. */
export const hireReportExportRequestedJob = inngest.createFunction(
  {
    id: 'hire-report-export-dispatch',
    name: 'Hire: generate one private report export',
    retries: 2,
    concurrency: [
      { limit: 2 },
      { limit: 1, key: 'event.data.workspaceId' },
    ],
    triggers: [{ event: 'hire/report-export.requested' }],
  },
  async ({ event, step }) => runHireReportExportRequestedHandler(
    event as unknown as { data: { workspaceId: string; exportId: string } },
    step as StepRunner,
  ),
)

/** Not registered yet: release wiring owns the final Hire-control manifest. */
export const hireReportExportRecoveryJob = inngest.createFunction(
  {
    id: 'hire-report-export-recovery',
    name: 'Hire: recover due report exports',
    retries: 3,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: '* * * * *' }],
  },
  async ({ step }) => runHireReportExportRecoverySweep(step as StepRunner),
)
