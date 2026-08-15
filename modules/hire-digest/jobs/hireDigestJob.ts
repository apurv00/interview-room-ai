import { inngest } from '@shared/services/inngest'
import {
  dispatchHireDailyDigest,
  listActiveHireDigestWorkspaceIds,
  listDueHireDigestOutboxIds,
  processHireDailyDigest,
  scheduleHireDailyDigestsForWorkspace,
} from '../services/hireDigestService'
import { HIRE_DIGEST_RECOVERY_LIMIT_PER_WORKSPACE } from '../types'

interface StepRunner {
  run: <T>(name: string, work: () => Promise<T> | T) => Promise<T>
}

/** The requested event is an early wake-up; the exact outbox claim owns egress. */
export async function runHireDailyDigestRequestedHandler(
  event: { data: { workspaceId: string; outboxId: string } },
  step: StepRunner,
) {
  const { workspaceId, outboxId } = event.data
  return step.run(`process-hire-daily-digest-${outboxId}`, () =>
    processHireDailyDigest({ workspaceId, outboxId }),
  )
}

/**
 * UTC is the explicit product policy until an IANA workspace timezone exists.
 * Each durable row is unique by workspace/member/UTC-day, so a cron replay is
 * harmless and never turns into a second email.
 */
export async function runHireDailyDigestScheduleSweep(step: StepRunner) {
  const workspaceIds = await step.run('list-active-hire-workspaces-for-daily-digest', () =>
    listActiveHireDigestWorkspaceIds(),
  )
  const reports: Array<{ workspaceId: string; dispatched: number }> = []
  for (const workspaceId of workspaceIds) {
    const outboxIds = await step.run(
      `schedule-hire-daily-digest-${workspaceId}`,
      () => scheduleHireDailyDigestsForWorkspace({ workspaceId }),
    )
    let dispatched = 0
    for (const outboxId of outboxIds) {
      await step.run(`dispatch-hire-daily-digest-${workspaceId}-${outboxId}`, async () => {
        await dispatchHireDailyDigest({ workspaceId, outboxId })
        dispatched += 1
      })
    }
    reports.push({ workspaceId, dispatched })
  }
  return { workspaces: reports.length, reports }
}

/** Retry/crash recovery stays tenant-scoped and sends only opaque IDs. */
export async function runHireDailyDigestRecoverySweep(step: StepRunner) {
  const workspaceIds = await step.run('list-active-hire-workspaces-for-digest-recovery', () =>
    listActiveHireDigestWorkspaceIds(),
  )
  const reports: Array<{ workspaceId: string; dispatched: number }> = []
  for (const workspaceId of workspaceIds) {
    const outboxIds = await step.run(
      `find-due-hire-daily-digests-${workspaceId}`,
      () => listDueHireDigestOutboxIds({
        workspaceId,
        limit: HIRE_DIGEST_RECOVERY_LIMIT_PER_WORKSPACE,
      }),
    )
    let dispatched = 0
    for (const outboxId of outboxIds) {
      await step.run(`recover-hire-daily-digest-${workspaceId}-${outboxId}`, async () => {
        await dispatchHireDailyDigest({ workspaceId, outboxId })
        dispatched += 1
      })
    }
    reports.push({ workspaceId, dispatched })
  }
  return { workspaces: reports.length, reports }
}

export const hireDailyDigestRequestedJob = inngest.createFunction(
  {
    id: 'hire-daily-digest-dispatch',
    name: 'Hire: deliver one member daily digest',
    retries: 2,
    concurrency: [
      { limit: 3 },
      { limit: 1, key: 'event.data.workspaceId' },
    ],
    triggers: [{ event: 'hire/digest.requested' }],
  },
  async ({ event, step }) => runHireDailyDigestRequestedHandler(
    event as unknown as { data: { workspaceId: string; outboxId: string } },
    step as StepRunner,
  ),
)

export const hireDailyDigestScheduleJob = inngest.createFunction(
  {
    id: 'hire-daily-digest-schedule',
    name: 'Hire: schedule opted-in daily digests',
    retries: 2,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: '0 8 * * *' }],
  },
  async ({ step }) => runHireDailyDigestScheduleSweep(step as StepRunner),
)

export const hireDailyDigestRecoveryJob = inngest.createFunction(
  {
    id: 'hire-daily-digest-recovery',
    name: 'Hire: recover due member daily digests',
    retries: 3,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: '* * * * *' }],
  },
  async ({ step }) => runHireDailyDigestRecoverySweep(step as StepRunner),
)
