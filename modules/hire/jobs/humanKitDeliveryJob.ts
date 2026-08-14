import { inngest } from '@shared/services/inngest'
import { listHireWorkspaceIdsForSweep } from '../services/workspaceSweepService'
import {
  dispatchHumanInterviewKitDelivery,
  HIRE_HUMAN_KIT_RECOVERY_LIMIT_PER_WORKSPACE,
  listDueHumanInterviewKitDeliveryIds,
  processHumanInterviewKitDelivery,
} from '../services/humanKitDeliveryService'

interface StepRunner {
  run: <T>(name: string, work: () => Promise<T> | T) => Promise<T>
}

/**
 * The event is only an early wake-up. Durable ownership, lifecycle fences,
 * and the lease that makes a replay harmless all remain in the Hire-control
 * delivery row.
 */
export async function runHireHumanKitDeliveryRequestedHandler(
  event: { data: { workspaceId: string; deliveryId: string } },
  step: StepRunner,
) {
  const { workspaceId, deliveryId } = event.data
  return step.run(`process-hire-human-kit-delivery-${deliveryId}`, () =>
    processHumanInterviewKitDelivery({ workspaceId, deliveryId }),
  )
}

/**
 * Recovery enumerates workspace roots once, then asks the core service for a
 * bounded page scoped to each exact tenant. A successful dispatch emits only
 * the delivery's durable coordinates; no recipient, kit capability, or
 * candidate data is placed in an Inngest event or step payload.
 */
export async function runHireHumanKitDeliveryRecoverySweep(step: StepRunner) {
  const workspaceIds = await step.run('list-hire-workspaces-for-human-kit-recovery', () =>
    listHireWorkspaceIdsForSweep(),
  )
  const reports: Array<{ workspaceId: string; dispatched: number }> = []

  for (const workspaceId of workspaceIds) {
    const deliveryIds = await step.run(
      `find-due-hire-human-kit-deliveries-${workspaceId}`,
      () => listDueHumanInterviewKitDeliveryIds({
        workspaceId,
        limit: HIRE_HUMAN_KIT_RECOVERY_LIMIT_PER_WORKSPACE,
      }),
    )
    let dispatched = 0
    for (const deliveryId of deliveryIds) {
      await step.run(`dispatch-hire-human-kit-delivery-${workspaceId}-${deliveryId}`, async () => {
        await dispatchHumanInterviewKitDelivery({ workspaceId, deliveryId })
        dispatched += 1
      })
    }
    reports.push({ workspaceId, dispatched })
  }

  return { workspaces: reports.length, reports }
}

export const hireHumanKitDeliveryRequestedJob = inngest.createFunction(
  {
    id: 'hire-human-kit-delivery-dispatch',
    name: 'Hire: deliver one human interview kit',
    retries: 2,
    concurrency: [
      { limit: 3 },
      { limit: 1, key: 'event.data.workspaceId' },
    ],
    triggers: [{ event: 'hire/human-kit.requested' }],
  },
  async ({ event, step }) =>
    runHireHumanKitDeliveryRequestedHandler(
      event as unknown as { data: { workspaceId: string; deliveryId: string } },
      step as StepRunner,
    ),
)

export const hireHumanKitDeliveryRecoveryJob = inngest.createFunction(
  {
    id: 'hire-human-kit-delivery-recovery',
    name: 'Hire: recover due human interview kits',
    retries: 3,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: '* * * * *' }],
  },
  async ({ step }) => runHireHumanKitDeliveryRecoverySweep(step as StepRunner),
)
