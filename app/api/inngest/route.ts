import { serve } from 'inngest/next'
import { inngest } from '@interview/services/inngestClient'
import { multimodalAnalysis } from '@interview/services/inngestFunctions'

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [multimodalAnalysis],
})
