import { inngest } from '@shared/services/inngest'
import { listHireWorkspaceIdsForSweep } from '../services/workspaceSweepService'
import {
  dispatchHireScreeningInvitationItem,
  HIRE_SCREENING_INVITATION_RECOVERY_LIMIT_PER_WORKSPACE,
  listDueHireScreeningInvitationItemIds,
  processHireScreeningInvitationItem,
} from '../services/screeningInvitationService'

interface StepRunner {
  run: <T>(name: string, work: () => Promise<T> | T) => Promise<T>
}

/**
 * The event only reduces latency. Item ownership stays in Mongo behind a
 * workspace-scoped lease, so duplicate/replayed events cannot send twice.
 */
export async function runHireScreeningInvitationRequestedHandler(
  event: { data: { workspaceId: string; itemId: string } },
  step: StepRunner,
) {
  const { workspaceId, itemId } = event.data
  return step.run(`dispatch-hire-screening-invitation-${itemId}`, () =>
    processHireScreeningInvitationItem({ workspaceId, itemId }),
  )
}

/**
 * Tenant-fair recovery: enumerate roots once, then discover and dispatch a
 * small due page inside each exact workspace coordinate. A failed event send
 * leaves the durable row pending for the next minute.
 */
export async function runHireScreeningInvitationRecoverySweep(step: StepRunner) {
  const workspaceIds = await step.run('list-hire-workspaces-for-screening-invitation-recovery', () =>
    listHireWorkspaceIdsForSweep(),
  )
  const reports: Array<{ workspaceId: string; dispatched: number }> = []
  for (const workspaceId of workspaceIds) {
    const itemIds = await step.run(
      `find-due-hire-screening-invitations-${workspaceId}`,
      () => listDueHireScreeningInvitationItemIds({
        workspaceId,
        limit: HIRE_SCREENING_INVITATION_RECOVERY_LIMIT_PER_WORKSPACE,
      }),
    )
    let dispatched = 0
    for (const itemId of itemIds) {
      await step.run(`dispatch-hire-screening-invitation-${workspaceId}-${itemId}`, async () => {
        await dispatchHireScreeningInvitationItem({ workspaceId, itemId })
        dispatched += 1
      })
    }
    reports.push({ workspaceId, dispatched })
  }
  return { workspaces: reports.length, reports }
}

export const hireScreeningInvitationRequestedJob = inngest.createFunction(
  {
    id: 'hire-screening-invitation-dispatch',
    name: 'Hire: dispatch one confirmed screening invitation',
    retries: 2,
    concurrency: [
      { limit: 3 },
      { limit: 1, key: 'event.data.workspaceId' },
    ],
    triggers: [{ event: 'hire/screening-invitation.requested' }],
  },
  async ({ event, step }) =>
    runHireScreeningInvitationRequestedHandler(
      event as unknown as { data: { workspaceId: string; itemId: string } },
      step as StepRunner,
    ),
)

export const hireScreeningInvitationRecoveryJob = inngest.createFunction(
  {
    id: 'hire-screening-invitation-recovery',
    name: 'Hire: recover due screening invitations',
    retries: 3,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: '* * * * *' }],
  },
  async ({ step }) => runHireScreeningInvitationRecoverySweep(step as StepRunner),
)
