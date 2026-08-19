import { inngest } from '@shared/services/inngest'
import { listHireWorkspaceIdsForSweep } from '@hire'
import {
  markHireMultimodalAnalysisFailed,
  processHireMultimodalAnalysis,
  recoverPendingHireMultimodalAnalyses,
} from '../services/analysisProcessingService'

export interface HireMultimodalAnalysisJobEvent {
  workspaceId: string
  analysisId: string
}

export async function runHireMultimodalAnalysisJob(input: {
  event: { data: HireMultimodalAnalysisJobEvent }
  step: { run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T> }
}): Promise<{ outcome: string }> {
  const { workspaceId, analysisId } = input.event.data
  const outcome = await input.step.run('process-hire-multimodal-analysis', () =>
    processHireMultimodalAnalysis({ workspaceId, analysisId }),
  )
  return { outcome }
}

export const hireMultimodalAnalysisJob = inngest.createFunction(
  {
    id: 'hire-multimodal-analysis',
    name: 'Hire: generate recorded-interview analysis report',
    retries: 3,
    concurrency: [{ limit: 2 }],
    triggers: [{ event: 'hire/multimodal-analysis.requested' }],
    onFailure: async ({ event, error }) => {
      const original = (event.data as {
        event?: { data?: HireMultimodalAnalysisJobEvent }
      }).event?.data
      if (!original) return
      await markHireMultimodalAnalysisFailed({
        workspaceId: original.workspaceId,
        analysisId: original.analysisId,
        errorCode: error instanceof Error ? error.name : undefined,
      })
    },
  },
  async ({ event, step }) => runHireMultimodalAnalysisJob({
    event: event as unknown as { data: HireMultimodalAnalysisJobEvent },
    step: step as { run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T> },
  }),
)

/** Handles a lost Inngest wake-up or a worker lease that expired mid-run. */
export const hireMultimodalAnalysisRecoveryJob = inngest.createFunction(
  {
    id: 'hire-multimodal-analysis-recovery',
    name: 'Hire: recover pending recorded-interview analysis',
    retries: 3,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: '11 * * * *' }],
  },
  async ({ step }) => {
    const workspaceIds = await step.run('list-hire-workspaces-for-analysis-recovery', () =>
      listHireWorkspaceIdsForSweep(),
    )
    const reports = []
    for (const workspaceId of workspaceIds) {
      reports.push(await step.run(
        `recover-hire-multimodal-analysis-${workspaceId}`,
        () => recoverPendingHireMultimodalAnalyses({ workspaceId, batchSize: 25 }),
      ))
    }
    return { workspaces: reports.length, reports }
  },
)
