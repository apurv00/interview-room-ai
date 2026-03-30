import { inngest } from './inngestClient'
import { runMultimodalPipeline } from './multimodalPipeline'

/**
 * Inngest function: Multimodal Interview Analysis
 *
 * Triggered by 'interview/analysis.requested' event.
 * Runs the full pipeline in multi-step fashion so each step
 * gets its own timeout and retry.
 */
export const multimodalAnalysis = inngest.createFunction(
  {
    id: 'multimodal-analysis',
    retries: 2,
    concurrency: [{ limit: 5 }],
    triggers: [{ event: 'interview/analysis.requested' }],
  },
  async ({ event, step }) => {
    const { sessionId, userId } = event.data as { sessionId: string; userId: string }

    await step.run('run-pipeline', async () => {
      await runMultimodalPipeline(sessionId, userId)
    })

    return { sessionId, status: 'completed' }
  }
)
