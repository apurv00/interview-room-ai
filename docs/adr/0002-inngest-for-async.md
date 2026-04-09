# ADR 0002: Inngest for Background Jobs

**Status:** Active  
**Date:** 2026-04-09

## Context

The multimodal analysis pipeline (Groq Whisper + facial aggregation + Claude fusion) ran inline inside a single HTTP request with `maxDuration=60`. Two Vercel crons (email digest, plan regeneration) ran as standalone HTTP routes — one was actually orphaned and never scheduled. There was no retry mechanism, no observability, and no general-purpose job infrastructure.

## Decision

Use Inngest as the background job runner for all async and scheduled work. Functions are registered via a single `/api/inngest` handler route. Event-triggered functions (analysis pipeline) are enqueued via `inngest.send()` from HTTP routes; scheduled functions (email digest, plan regeneration) use Inngest's `cron` trigger.

## Rationale

- **Vercel-native.** Inngest works with the functions-as-handlers model — each step in an Inngest function runs inside a standard Vercel serverless function invocation. No separate worker infrastructure to manage.
- **Step-level retries.** The analysis pipeline's 5 stages (`fetch-session`, `transcribe`, `process-signals`, `fusion`, `persist`) are each independently retryable. A transient Whisper timeout retries only transcription, not the entire pipeline.
- **Observability.** Inngest Cloud dashboard shows event history, step-by-step execution traces, and failure details — replacing the ad-hoc `FailedJob` MongoDB model.
- **Free tier.** Generous enough for our current scale (hundreds of analyses/month).
- **Alternatives considered:** Trigger.dev (similar but smaller ecosystem), Upstash QStash (too thin — no step functions), self-hosted BullMQ (requires Redis worker infrastructure outside Vercel).

## Consequences

- `/api/analysis/start` returns `{ jobId, status: 'pending' }` in <500ms instead of blocking for 10-60s.
- The client (`AnalysisTrigger.tsx`) polls `/api/analysis/[sessionId]` every 3s — this was already in place and required zero changes.
- Production requires `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` environment variables.
- Local dev requires running `npm run dev:inngest` in a second terminal for the Inngest dev server.
- `vercel.json` crons entry is removed; all scheduling is managed by Inngest.
- `FailedJob` model is deleted (Inngest handles retries and dead-lettering natively).
