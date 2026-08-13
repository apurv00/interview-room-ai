import { inngest } from '@shared/services/inngest'
import { listHireWorkspaceIdsForSweep } from '../services/workspaceSweepService'
import {
  cleanupExpiredHireIntakeRawPayloadTasks,
  cleanupStaleHireIntakeNeedsIdentityTasks,
  dispatchHireIntakeTask,
  listDueHireIntakeTaskIds,
  processHireIntakeTask,
} from '../services/intakeQueueService'

interface StepRunner {
  run: <T>(name: string, work: () => Promise<T> | T) => Promise<T>
}

const SWEEP_TASKS_PER_WORKSPACE = 20

/**
 * Event delivery is only a low-latency kick. Task ownership lives in Mongo,
 * so a duplicated/replayed event is harmless: `processHireIntakeTask` uses a
 * workspace-scoped claim lease and returns `skipped` to a losing worker.
 */
export async function runHireIntakeRequestedHandler(
  event: { data: { workspaceId: string; taskId: string } },
  step: StepRunner,
) {
  const { workspaceId, taskId } = event.data
  return step.run(`process-hire-intake-${taskId}`, () =>
    processHireIntakeTask({ workspaceId, taskId }),
  )
}

/**
 * Durable delivery recovery: enumeration is root-scoped, then every child
 * task query and emitted event carries the exact workspace id. A transient
 * `inngest.send()` failure leaves the original task queued for a later sweep.
 */
export async function runHireIntakeRecoverySweep(step: StepRunner) {
  const workspaceIds = await step.run('list-hire-workspaces-for-intake-recovery', () =>
    listHireWorkspaceIdsForSweep(),
  )
  const reports: Array<{
    workspaceId: string
    cancelledExpiredRawPayload: number
    cancelledStaleNeedsIdentity: number
    dispatched: number
  }> = []
  for (const workspaceId of workspaceIds) {
    const { cancelled: cancelledExpiredRawPayload } = await step.run(
      `expire-stale-hire-intake-payload-${workspaceId}`,
      () => cleanupExpiredHireIntakeRawPayloadTasks({ workspaceId, batchSize: SWEEP_TASKS_PER_WORKSPACE }),
    )
    const { cancelled } = await step.run(
      `expire-stale-hire-intake-identity-${workspaceId}`,
      () => cleanupStaleHireIntakeNeedsIdentityTasks({ workspaceId, batchSize: SWEEP_TASKS_PER_WORKSPACE }),
    )
    const taskIds = await step.run(
      `find-due-hire-intake-${workspaceId}`,
      () => listDueHireIntakeTaskIds({ workspaceId, limit: SWEEP_TASKS_PER_WORKSPACE }),
    )
    let dispatched = 0
    for (const taskId of taskIds) {
      await step.run(`dispatch-hire-intake-${workspaceId}-${taskId}`, async () => {
        await dispatchHireIntakeTask({ workspaceId, taskId })
        dispatched += 1
      })
    }
    reports.push({
      workspaceId,
      cancelledExpiredRawPayload,
      cancelledStaleNeedsIdentity: cancelled,
      dispatched,
    })
  }
  return { workspaces: reports.length, reports }
}

export const hireIntakeRequestedJob = inngest.createFunction(
  {
    id: 'hire-resume-intake',
    name: 'Hire: parse and score one queued resume',
    retries: 2,
    concurrency: [
      { limit: 3 },
      { limit: 1, key: 'event.data.workspaceId' },
    ],
    triggers: [{ event: 'hire/intake.requested' }],
  },
  async ({ event, step }) =>
    runHireIntakeRequestedHandler(
      event as unknown as { data: { workspaceId: string; taskId: string } },
      step as StepRunner,
    ),
)

export const hireIntakeRecoveryJob = inngest.createFunction(
  {
    id: 'hire-resume-intake-recovery',
    name: 'Hire: recover queued resume intake',
    retries: 3,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: '* * * * *' }],
  },
  async ({ step }) => runHireIntakeRecoverySweep(step as StepRunner),
)
