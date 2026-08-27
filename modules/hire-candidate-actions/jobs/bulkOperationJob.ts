import { inngest } from '@shared/services/inngest'
import { listHireWorkspaceIdsForSweep } from '../../hire/services/workspaceSweepService'
import {
  dispatchHireCandidateBulkOperation,
  listDueHireCandidateBulkOperationIds,
  processHireCandidateBulkOperation,
} from '../services/bulkOperationService'

interface StepRunner {
  run: <T>(name: string, work: () => Promise<T> | T) => Promise<T>
}

export async function runHireCandidateBulkOperationRequestedHandler(
  event: { data: { workspaceId: string; operationId: string } },
  step: StepRunner,
) {
  const { workspaceId, operationId } = event.data
  const result = await step.run(`process-hire-candidate-bulk-${operationId}`, () =>
    processHireCandidateBulkOperation({ workspaceId, operationId }),
  )
  if (result.hasRemainingWork) {
    await step.run(`continue-hire-candidate-bulk-${operationId}`, () =>
      dispatchHireCandidateBulkOperation({ workspaceId, operationId }),
    )
  }
  return result
}

/**
 * Recovery is tenant-fair and idempotent. It enumerates tenancy roots first,
 * then re-emits only opaque operation coordinates for due rows in that root.
 */
export async function runHireCandidateBulkOperationRecoverySweep(step: StepRunner) {
  const workspaceIds = await step.run(
    'list-hire-workspaces-for-candidate-bulk-recovery',
    () => listHireWorkspaceIdsForSweep(),
  )
  const reports: Array<{ workspaceId: string; dispatched: number }> = []
  for (const workspaceId of workspaceIds) {
    const operationIds = await step.run(
      `find-due-hire-candidate-bulk-${workspaceId}`,
      () => listDueHireCandidateBulkOperationIds({ workspaceId }),
    )
    let dispatched = 0
    for (const operationId of operationIds) {
      await step.run(
        `dispatch-hire-candidate-bulk-${workspaceId}-${operationId}`,
        async () => {
          await dispatchHireCandidateBulkOperation({ workspaceId, operationId })
          dispatched += 1
        },
      )
    }
    reports.push({ workspaceId, dispatched })
  }
  return { workspaces: reports.length, reports }
}

export const hireCandidateBulkOperationRequestedJob = inngest.createFunction(
  {
    id: 'hire-candidate-bulk-operation',
    name: 'Hire: apply a bounded candidate bulk-action page',
    retries: 2,
    concurrency: [
      { limit: 4 },
      { limit: 1, key: 'event.data.workspaceId' },
    ],
    triggers: [{ event: 'hire/candidate-bulk-operation.requested' }],
  },
  async ({ event, step }) =>
    runHireCandidateBulkOperationRequestedHandler(
      event as unknown as {
        data: { workspaceId: string; operationId: string }
      },
      step as StepRunner,
    ),
)

export const hireCandidateBulkOperationRecoveryJob = inngest.createFunction(
  {
    id: 'hire-candidate-bulk-operation-recovery',
    name: 'Hire: recover candidate bulk actions',
    retries: 3,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: '* * * * *' }],
  },
  async ({ step }) =>
    runHireCandidateBulkOperationRecoverySweep(step as StepRunner),
)
