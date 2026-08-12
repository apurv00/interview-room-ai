import { inngest } from '@shared/services/inngest'
import { retryPendingRuntimeRevocationsAcrossWorkspaces } from '../services/engineRevocationService'

export const hireEngineRevocationJob = inngest.createFunction(
  {
    id: 'hire-engine-revocation-retry',
    name: 'Hire: confirm engine revocations',
    retries: 3,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: '* * * * *' }],
  },
  async ({ step }) =>
    step.run('confirm-runtime-revocations', () =>
      retryPendingRuntimeRevocationsAcrossWorkspaces(50),
    ),
)
