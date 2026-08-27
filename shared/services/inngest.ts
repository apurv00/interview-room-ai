import { Inngest } from "inngest";

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
export const INNGEST_APP_ID =
  process.env.INNGEST_APP_ID || "interview-prep-guru";

export const inngest = new Inngest({
  id: INNGEST_APP_ID,
  name: "Interview Prep Guru",
});

/**
 * Strongly-typed event names. Keep in sync with function event triggers.
 */
export type InngestEvents = {
  // Hire candidate bulk actions: the worker reloads the durable operation,
  // per-row expected stages, and actor authority from Hire control storage.
  // Candidate identity and the selected id list never enter the event.
  "hire/candidate-bulk-operation.requested": {
    data: {
      workspaceId: string;
      operationId: string;
    };
  };
  // Hire recorded-interview analysis. This event intentionally transports
  // opaque control-plane coordinates only; raw facial data and transcript
  // remain in private Hire storage and are reloaded by the worker.
  "hire/multimodal-analysis.requested": {
    data: {
      workspaceId: string;
      analysisId: string;
    };
  };
  // Hire resume intake (Phase 2): opaque control-plane coordinates only.
  // The worker reloads the select-hidden resume bytes and apply-token hash
  // from the tenant-scoped HireIntakeTask; candidate PII never enters an
  // Inngest event or a B2C identity lookup.
  "hire/intake.requested": {
    data: {
      workspaceId: string;
      taskId: string;
    };
  };
  // Phase 2 screening invitations: durable item coordinates only. Recipient
  // PII and invitation capability remain in Hire's encrypted delivery row.
  "hire/screening-invitation.requested": {
    data: {
      workspaceId: string;
      itemId: string;
    };
  };
  // Phase 3 human interview kits: opaque durable delivery coordinates only.
  // The worker reloads recipient contact data and the encrypted capability
  // envelope from the Hire-control database before egress.
  "hire/human-kit.requested": {
    data: {
      workspaceId: string;
      deliveryId: string;
    };
  };
  // Phase 4 assessment PDF export: only durable control-plane coordinates.
  // The worker reloads the select-hidden safe snapshot and never receives a
  // candidate contact field, résumé, media identifier, or object key here.
  "hire/assessment-export.requested": {
    data: {
      workspaceId: string;
      exportId: string;
    };
  };
  // Phase 5 reports: the export worker re-loads its select-hidden immutable
  // snapshot and private object coordinate. No candidate data or report body
  // enters Inngest.
  "hire/report-export.requested": {
    data: {
      workspaceId: string;
      exportId: string;
    };
  };
  // Phase 5 member digest: recipient and aggregate content stay in the
  // private outbox row. The event is a durable-ID-only wake-up.
  "hire/digest.requested": {
    data: {
      workspaceId: string;
      outboxId: string;
    };
  };
  // Phase 5 onboarding test-drive cleanup: durable coordinates only. The
  // worker reclaims the marker and re-authorizes each graph deletion; no
  // invite capability, candidate contact, or AI payload enters Inngest.
  "hire/onboarding-test-drive.cleanup-requested": {
    data: {
      workspaceId: string;
      testDriveId: string;
    };
  };
  // Feedback enrichment (2026-07-17): full-quality ideal_answers + drills
  // generated off the request path. reason 'post-feedback' = new interview;
  // 'drill-backfill' = historical/partial-coverage session hit from a drill
  // page. Ids only — the job re-reads the session document.
  "feedback/enrich.requested": {
    data: {
      sessionId: string;
      userId: string;
      reason: "post-feedback" | "drill-backfill";
      /** drill-backfill only: the drilled question MUST be in the generated
       *  set even when it ranks outside the weakest-10 cap (Codex P2 #552 —
       *  the 20/30-min case where >10 questions are weak). */
      questionIndex?: number;
    };
  };
  "analysis/requested": {
    data: {
      sessionId: string;
      userId: string;
      startTime: number;
    };
  };
  // Jobs ingestion (Wave 2.1b): ids only — the sync job re-reads config,
  // cursors and targets from Mongo (512KB event limit discipline).
  "jobs/source.sync": {
    data: {
      sourceId: string;
      /** A02 authority epoch: a queued event can never cross a later legal
       *  revoke/restore transition. */
      controlRevision: number;
      /** A08 operational epoch: queued syncs cannot cross pause/settings or
       * enable transitions even when legal authority is unchanged. */
      operationalRevision: number;
      /** Present for audited manual runs; the Inngest event id remains the
       * stable per-run quota identity for scheduled and manual dispatches. */
      operationId?: string;
    };
  };
  "jobs/source.validate": {
    data: {
      sourceId: string;
      controlRevision: number;
      operationalRevision: number;
      operationId: string;
    };
  };
  // Jobs LLM verdict (Wave 2.3, §4.5): ids only, ≤40 per event.
  "jobs/verdict.requested": {
    data: {
      postingIds: string[];
    };
  };
  // Manual sweeper kick (admin route) — the cron sweeper shares the handler.
  "jobs/verdict.sweep": {
    data: {
      limit?: number;
    };
  };
  // Save-gated per-job ATS check (Wave 3.3): the ~35s Sonnet checkATS never
  // runs inline; ids only.
  "jobs/evidence.attribute": {
    data: {
      sessionId: string;
      applicationId: string;
      jobPostingId: string;
    };
  };
  "jobs/email.requested": {
    data: {
      userId: string;
      jobPostingId: string;
      requestedAt: string;
    };
  };
  "jobs/ats.requested": {
    data: {
      userId: string;
      jobPostingId: string;
      /** ISO stamp of the claim this run owns — marker clears are scoped to it. */
      claimedAt: string;
    };
  };
};
