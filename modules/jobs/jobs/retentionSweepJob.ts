import { inngest } from '@shared/services/inngest'
import {
  runJobsRetentionSweep,
  type JobsRetentionSweepOptions,
  type JobsRetentionSweepReport,
} from '../services/retentionService'

interface StepRunner {
  run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T>
}

export async function runRetentionSweepHandler(
  step: StepRunner,
  options: JobsRetentionSweepOptions = {},
): Promise<JobsRetentionSweepReport> {
  const now = options.now ?? new Date()
  return step.run('apply-lifecycle-policy', () => runJobsRetentionSweep({
    ...options,
    now,
  }))
}

export const jobsRetentionSweepJob = inngest.createFunction(
  {
    id: 'jobs-retention-sweep',
    name: 'Jobs: daily retention lifecycle sweep',
    retries: 2,
    triggers: [{ cron: '10 2 * * *' }],
  },
  async ({ step }) => runRetentionSweepHandler(step as StepRunner),
)
