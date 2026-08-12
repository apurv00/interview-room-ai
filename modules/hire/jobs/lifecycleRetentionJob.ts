import { inngest } from '@shared/services/inngest'
import { anonymizeDueHireCandidates } from '../services/candidateRetentionService'
import { purgeDueHireWorkspaces } from '../services/workspacePurgeService'
import { listHireWorkspaceIdsForSweep } from '../services/workspaceSweepService'

/**
 * One control-surface lifecycle sweep. Each service owns durable database
 * claims, so an Inngest retry or overlapping delivery remains idempotent.
 */
export const hireLifecycleRetentionJob = inngest.createFunction(
  {
    id: 'hire-lifecycle-retention',
    name: 'Hire: candidate anonymization and workspace hard purge',
    retries: 5,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: '43 2 * * *' }],
  },
  async ({ step }) => {
    const workspaceIds = await step.run(
      'list-hire-workspaces-for-lifecycle-retention',
      () => listHireWorkspaceIdsForSweep(),
    )
    const candidateRetention = []
    const workspacePurge = []
    for (const workspaceId of workspaceIds) {
      candidateRetention.push(await step.run(
        `anonymize-due-hire-candidates-${workspaceId}`,
        async () => {
          const report = await anonymizeDueHireCandidates({ workspaceId, batchSize: 100 })
          if (report.failed > 0) {
            throw new Error(`Hire candidate anonymization failed for ${workspaceId}`)
          }
          return report
        },
      ))
      workspacePurge.push(await step.run(
        `purge-due-hire-workspace-${workspaceId}`,
        async () => {
          const report = await purgeDueHireWorkspaces({ workspaceId })
          if (report.failed > 0) {
            throw new Error(`Hire workspace purge failed for ${workspaceId}`)
          }
          return report
        },
      ))
    }
    return { candidateRetention, workspacePurge }
  },
)
