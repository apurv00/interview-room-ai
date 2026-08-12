import { inngest } from '@shared/services/inngest'
import { publishCompletedRuntimeResults } from '../services/resultPublisher'

export const hireRuntimeResultPublisherJob = inngest.createFunction(
  {
    id: 'hire-runtime-result-publisher',
    name: 'Hire runtime: publish completed interview results',
    retries: 5,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: '* * * * *' }],
  },
  async ({ step }) =>
    step.run('publish-completed-hire-runtime-results', () =>
      publishCompletedRuntimeResults(25),
    ),
)
