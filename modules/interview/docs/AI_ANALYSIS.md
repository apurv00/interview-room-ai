# AI Analysis Flow — Functional & Technical Specification

> HOT PATH. `modules/interview/jobs/analysisJob.ts` is in the HOT PATH
> file list in `CLAUDE.md`. Section 8 (Known Failure Modes) is
> append-only — update it whenever you fix a bug in this flow.

## 1. Overview

After a candidate finishes a live interview, a post-interview pipeline
runs in the background to produce a multimodal "replay" experience. The
pipeline fuses Deepgram / Groq Whisper word-level transcripts, facial
landmark signals from MediaPipe, and prosody measurements into a single
Claude-generated narrative. The output drives an interactive Replay page
that shows synced video + timeline + word-level transcript + coaching
tips.

The pipeline is feature-flagged and quota-gated (Free: 1/month, Pro:
10/month, Enterprise: unlimited). It runs as an Inngest background job,
not inline, so the client finishes the interview quickly and then polls
for results.

## 2. User Journey (Functional)

**Entry:** user lands on `/feedback/[sessionId]` after finishing an interview.

1. **Start.** Client calls `POST /api/analysis/start`. Response is
   `{ jobId, status: 'pending' }` in <500ms.
2. **Pending.** Feedback page shows a progress card ("Analyzing your
   interview — this takes about a minute"). Client polls
   `GET /api/analysis/[sessionId]` every 3s.
3. **Processing.** The background job transcribes audio (Groq Whisper),
   downloads the facial landmarks blob from R2, computes prosody +
   facial signals, and runs a Claude Haiku fusion pass. DB status
   advances `pending → processing → completed`.
4. **Completed.** Client's next poll receives the full analysis. Page
   renders the Replay UI: synced video player, signal timeline,
   word-level transcript with highlightable segments, coaching tips.
5. **Failed.** If Inngest exhausts retries, `onFailure` marks the row
   `failed` and the client shows a fallback explainer plus the option
   to retry.

**Edge cases users see directly:**

- Quota exhausted → block with upsell banner, no job queued.
- Feature flag off → `/analysis/start` returns 403; feedback page
  hides the replay section entirely.
- Long interview (>20 min) → pipeline may take 60-90s; progress card
  stays visible, polling continues.
- R2 download failure → single retry; if still failing, marked
  `failed` with a human-readable error.

## 3. State Machine (Technical)

Analysis status lives in the `InterviewSession.analysisStatus` field.
Values are literal strings:

```
    (session created)
          │
          ▼
    (idle — no analysis requested yet)
          │  POST /api/analysis/start
          ▼
       pending ────▶ processing ────▶ completed ────▶ (terminal)
          │              │                                 ▲
          │              │           retry from client     │
          │              └────────────▶ failed ────────────┘
          │                               ▲
          └───────────────────────────────┘
             (onFailure after Inngest retries exhausted)
```

Triggers:

| From → To | Trigger |
|---|---|
| idle → pending | `POST /api/analysis/start` emits `inngest.send('analysis/requested', ...)` |
| pending → processing | `stepFetchSession` flips status |
| processing → completed | `stepPersistResults` writes analysis + flips status |
| processing → failed | Inngest `onFailure` hook calls `stepMarkFailed` |
| failed → pending | Client calls `POST /api/analysis/[sessionId]/reset` and re-starts |

## 4. Key Components

| Layer | File : line | Responsibility |
|---|---|---|
| Route | `app/api/analysis/start/route.ts` | Quota check + `inngest.send('analysis/requested', ...)`. Returns `{ jobId, status: 'pending' }` in <500ms. |
| Route | `app/api/analysis/[sessionId]/route.ts` | Polling endpoint. Reads `InterviewSession.analysisStatus` and the completed analysis payload. |
| Route | `app/api/analysis/[sessionId]/reset/route.ts` | Resets a failed row to idle so the client can retry. |
| Route | `app/api/analysis/quota/route.ts` | Free/Pro/Enterprise quota check. |
| Job | `modules/interview/jobs/analysisJob.ts:46` | `runAnalysisJobHandler` — pure handler invoked by Inngest wrapper. Runs 5 `step.run(...)` stages. |
| Pipeline | `modules/interview/services/analysis/multimodalPipeline.ts` | Pure-function stages: `stepFetchSession`, `stepTranscribeAndDownload`, `stepProcessSignals`, `stepRunFusion`, `stepPersistResults`, `stepMarkFailed`. |
| Storage | `shared/storage/r2.ts` | R2 client. Stores video recording, facial landmarks blob, audio track. |
| AI | `shared/services/modelRouter.ts` | Claude Haiku fusion call routed via `completion()`. |
| Client | `modules/interview/components/replay/AnalysisTrigger.tsx` | Fire-and-poll harness. 3s polling interval, progressive progress bar. |
| Client | `modules/interview/components/replay/ReplayPage.tsx` | Renders the completed analysis: synced video, timeline, transcript. |
| Model | `shared/db/models/InterviewSession.ts` | `analysisStatus`, `analysisResult`, `liveTranscriptWords`, R2 keys. |

## 5. API Contracts

### `POST /api/analysis/start`

**Latency budget:** ≤500ms (quota check + Inngest enqueue only).

```ts
// Request
{ sessionId: string }
// Response (success)
{ jobId: string, status: 'pending' }
// Response (quota exhausted)
{ error: 'quota_exhausted', limit: number, plan: string } // 429
// Response (flag off)
{ error: 'feature_disabled' } // 403
```

### `GET /api/analysis/[sessionId]`

**Latency budget:** ≤200ms.

```ts
// Response (pending | processing)
{ status: 'pending' | 'processing' }
// Response (completed)
{
  status: 'completed',
  analysis: {
    fusionSummary: string,
    segments: AnalysisSegment[],
    prosody: ProsodySignals,
    facial: FacialSignals,
  }
}
// Response (failed)
{ status: 'failed', error: string }
```

### `POST /api/analysis/[sessionId]/reset`

Resets a failed row. Idempotent. Body is empty.

## 6. Functional ↔ Technical Mapping

| User experience | State | Implementation |
|---|---|---|
| "Analyzing your interview…" card appears | `pending` | `AnalysisTrigger.tsx` posts to `/api/analysis/start` |
| Progress bar advances to 40% | `processing` | `stepTranscribeAndDownload` completes in `analysisJob.ts:56` |
| Progress bar advances to 75% | `processing` | `stepProcessSignals` + `stepRunFusion` complete |
| Replay UI fades in | `completed` | Poll response includes `analysis` payload; `ReplayPage.tsx` renders |
| "Analysis failed — retry" banner | `failed` | Inngest `onFailure` → `stepMarkFailed` → next poll surfaces error |
| "You've reached your monthly limit" | blocked | Quota check at `/api/analysis/start` |

## 7. Invariants (Must Not Break)

1. **`/api/analysis/start` returns in <500ms.** Enforced by moving all
   heavy work into Inngest steps. Do not add synchronous work to this
   route. Verify: DevTools → Timing tab on Start click.

2. **Each Inngest step is independently retried.** Enforced by wrapping
   every significant unit of work in `step.run(...)` in
   `analysisJob.ts:46-`. If you add a new stage, give it its own
   `step.run` — do not chain work inside an existing step.

3. **Pipeline stages are pure functions.** Enforced by keeping IO
   isolated in `multimodalPipeline.ts` stepXxx functions that receive
   all inputs as arguments and return structured outputs. No mutable
   module state. Verify: `analysisJob.test.ts` mocks `step.run` with
   a plain object.

4. **Failed jobs are recoverable.** Enforced by `onFailure` +
   `stepMarkFailed` + `/api/analysis/[sessionId]/reset`. A `failed`
   row can always be re-queued without manual DB surgery.

5. **Live transcripts are reused.** If the interview captured
   word-level transcripts via Deepgram
   (`InterviewSession.liveTranscriptWords`), the pipeline uses them
   instead of re-transcribing with Whisper. Enforced in
   `stepTranscribeAndDownload`. Saves ~25s + the 25MB Groq upload
   limit.

## 8. Known Failure Modes (Append-Only Log)

_No analysis-specific incidents logged yet. When a bug breaks this flow,
add an entry with the template from `INTERVIEW_FLOW.md` Section 8 —
date, commit hash, symptom, root cause, fix, why tests missed it,
prevention._
