import { inngest } from '@shared/services/inngest'
import {
  runTrackerStatusSweep,
  type TrackerStatusSweepOptions,
  type TrackerStatusSweepReport,
} from '../services/trackerStatusSweepService'

interface StepRunner {
  run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T>
}

export async function runTrackerStatusSweepHandler(
  step: StepRunner,
  options: TrackerStatusSweepOptions = {},
): Promise<TrackerStatusSweepReport> {
  const now = options.now ?? new Date()
  return step.run('infer-confirmed-application-outcomes', () =>
    runTrackerStatusSweep({ ...options, now }),
  )
}

export const jobsTrackerStatusSweepJob = inngest.createFunction(
  {
    id: 'jobs-tracker-status-sweep',
    name: 'Jobs: daily confirmed-application inference sweep',
    retries: 2,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: '30 2 * * *' }],
  },
  async ({ step }) => runTrackerStatusSweepHandler(step as StepRunner),
)
