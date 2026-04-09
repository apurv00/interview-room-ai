import { Inngest } from 'inngest'

/**
 * Shared Inngest client for all background jobs.
 *
 * Events emitted to this client:
 * - "analysis/requested"         → multimodal analysis pipeline (modules/interview/jobs/analysisJob)
 *
 * Scheduled functions registered to this client (no event triggers):
 * - "email-digest-daily"         → daily engagement digest (modules/learn/jobs/emailDigestJob)
 * - "regenerate-plans-monthly"   → monthly pathway plan regen (modules/learn/jobs/regeneratePlansJob)
 *
 * In local dev, run the Inngest dev server:
 *   npm run dev:inngest
 * It will auto-discover /api/inngest at http://localhost:3000 and display a
 * dashboard at http://localhost:8288 with event history, step-by-step
 * execution traces, and manual trigger buttons.
 *
 * In production, set INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY. Inngest Cloud
 * auto-syncs the app on the first GET to /api/inngest after deploy.
 */
export const inngest = new Inngest({
  id: 'interview-prep-guru',
  name: 'Interview Prep Guru',
})

/**
 * Strongly-typed event names. Keep in sync with function event triggers.
 */
export type InngestEvents = {
  'analysis/requested': {
    data: {
      sessionId: string
      userId: string
      startTime: number
    }
  }
}
