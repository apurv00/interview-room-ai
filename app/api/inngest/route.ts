import { serve } from 'inngest/next'
import { inngest } from '@shared/services/inngest'
import { analysisJob } from '@interview/jobs/analysisJob'
import { emailDigestJob } from '@learn/jobs/emailDigestJob'
import { regeneratePlansJob } from '@learn/jobs/regeneratePlansJob'

/**
 * Inngest handler route — entry point for all background jobs.
 *
 * - Event-triggered: analysisJob (reacts to 'analysis/requested')
 * - Scheduled:       emailDigestJob, regeneratePlansJob
 *
 * Inngest's serve() handler responds to:
 *   GET   — health check + function introspection for Inngest Cloud sync
 *   POST  — receives event deliveries for event-triggered functions
 *   PUT   — function execution (step-by-step)
 *
 * maxDuration is raised from the default so that individual step executions
 * (especially the Whisper + fusion steps in analysisJob) have headroom. Inngest
 * splits between steps, so each step runs inside its own function invocation
 * — 300s is generous for our longest single step.
 */
export const maxDuration = 300
export const dynamic = 'force-dynamic'

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [analysisJob, emailDigestJob, regeneratePlansJob],
})
