import { inngest } from '@shared/services/inngest'
import { processDueHireEmailsAcrossWorkspaces } from '../services/emailOutboxService'

const MAX_PER_RUN = 20

/** Register this function in app/api/inngest/route.ts at integration time. */
export const hireEmailOutboxJob = inngest.createFunction(
  {
    id: 'hire-email-outbox',
    name: 'Hire: transactional email outbox',
    retries: 1,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: '* * * * *' }],
  },
  async ({ step }) =>
    step.run('deliver-tenant-scoped-email-batch', () =>
      processDueHireEmailsAcrossWorkspaces(MAX_PER_RUN),
    ),
)
