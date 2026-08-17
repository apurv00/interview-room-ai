import { inngest } from '@shared/services/inngest'
import { publishPendingHireMultimodalObservations } from '../services/multimodalObservationPublisher'

export const hireRuntimeMultimodalObservationPublisherJob = inngest.createFunction(
  {
    id: 'hire-runtime-multimodal-observation-publisher',
    name: 'Hire runtime: publish supplemental interview observations',
    retries: 5,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: '* * * * *' }],
  },
  async ({ step }) =>
    step.run('publish-hire-multimodal-observations', () =>
      publishPendingHireMultimodalObservations(25),
    ),
)
