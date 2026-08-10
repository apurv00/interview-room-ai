import { inngest } from '@shared/services/inngest'
import {
  purgeDueHireMedia,
  reconcileClosedJobMediaRetention,
} from '../services/mediaLifecycleService'
import { listHireWorkspaceIdsForSweep } from '../services/workspaceSweepService'

export const hireMediaRetentionJob = inngest.createFunction(
  {
    id: 'hire-media-retention',
    name: 'Hire: media retention and verified deletion',
    retries: 5,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: '17 * * * *' }],
  },
  async ({ step }) => {
    const workspaceIds = await step.run(
      'list-hire-workspaces-for-media-retention',
      () => listHireWorkspaceIdsForSweep(),
    )
    const reports = []
    for (const workspaceId of workspaceIds) {
      reports.push(await step.run(
        `purge-due-hire-media-${workspaceId}`,
        async () => {
          const reconciled = await reconcileClosedJobMediaRetention({
            workspaceId,
            batchSize: 100,
          })
          const report = await purgeDueHireMedia({ workspaceId, batchSize: 100 })
          if (report.failed > 0) {
            throw new Error(`Hire media purge failed for ${workspaceId}`)
          }
          return { ...report, reconciled }
        },
      ))
    }
    return { workspaces: reports.length, reports }
  },
)
