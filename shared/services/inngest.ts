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
 * - "recording-retention-cleanup"→ daily replay-video retention cleanup
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
// The id IS the app identity in Inngest Cloud: a sync (PUT /api/inngest) from
// any URL repoints whichever registered app shares this id. Non-prod deploys
// must therefore set INNGEST_APP_ID (e.g. interview-prep-guru-staging) or
// their sync hijacks production's registration — this happened for ~6 minutes
// on 2026-07-17 during the Oracle migration's staging bring-up.
// `||` not `??`: an empty-string env value (easy to produce in the Coolify UI)
// must mean "unset", never an app registered under the id "".
export const INNGEST_APP_ID = process.env.INNGEST_APP_ID || 'interview-prep-guru'

export const inngest = new Inngest({
  id: INNGEST_APP_ID,
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
  // Jobs ingestion (Wave 2.1b): ids only — the sync job re-reads config,
  // cursors and targets from Mongo (512KB event limit discipline).
  'jobs/source.sync': {
    data: {
      sourceId: string
    }
  }
  // Jobs LLM verdict (Wave 2.3, §4.5): ids only, ≤40 per event.
  'jobs/verdict.requested': {
    data: {
      postingIds: string[]
    }
  }
  // Manual sweeper kick (admin route) — the cron sweeper shares the handler.
  'jobs/verdict.sweep': {
    data: {
      limit?: number
    }
  }
  // Save-gated per-job ATS check (Wave 3.3): the ~35s Sonnet checkATS never
  // runs inline; ids only.
  'jobs/evidence.attribute': {
    data: {
      sessionId: string
      applicationId: string
      jobPostingId: string
    }
  }
  'jobs/email.requested': {
    data: {
      userId: string
      jobPostingId: string
      requestedAt: string
    }
  }
  'jobs/ats.requested': {
    data: {
      userId: string
      jobPostingId: string
      /** ISO stamp of the claim this run owns — marker clears are scoped to it. */
      claimedAt: string
    }
  }
}
