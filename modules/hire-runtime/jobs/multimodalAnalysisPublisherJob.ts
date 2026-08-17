import { inngest } from '@shared/services/inngest'
import { publishPendingHireMultimodalAnalyses } from '../services/multimodalAnalysisPublisher'

/** Publishes checksum-addressed Hire landmark artifacts only after the normal
 * immutable result bridge has linked the round in the control plane. */
export const hireRuntimeMultimodalAnalysisPublisherJob = inngest.createFunction(
  {
    id: 'hire-runtime-multimodal-analysis-publisher',
    name: 'Hire runtime: publish recorded-interview analysis inputs',
    retries: 5,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: '* * * * *' }],
  },
  async ({ step }) =>
    step.run('publish-hire-multimodal-analysis-inputs', () =>
      publishPendingHireMultimodalAnalyses(25),
    ),
)
