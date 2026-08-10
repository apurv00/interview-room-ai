import { inngest } from '@shared/services/inngest'
import { recoverMissingRuntimeFeedback } from '../services/feedbackRecoveryService'

export const hireRuntimeFeedbackRecoveryJob = inngest.createFunction(
  {
    id: 'hire-runtime-feedback-recovery',
    name: 'Hire runtime: recover missing base feedback',
    retries: 5,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: '* * * * *' }],
  },
  async ({ step }) =>
    step.run('recover-missing-hire-runtime-feedback', () =>
      recoverMissingRuntimeFeedback(3),
    ),
)
