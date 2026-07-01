# Interview Flow — Functional & Technical Specification

> HOT PATH. Read this before touching any file in the Key Components table.
> See `CLAUDE.md` → "HOT PATH — DO NOT BREAK" for the rules of engagement.
> Section 8 (Known Failure Modes) is append-only — update it whenever you
> fix a bug in this flow.

## 1. Overview

The live interview pipeline is the core of Interview Prep Guru. A
candidate enters a lobby, configures a mock interview (domain, depth,
duration), and converses in real time with an AI interviewer named Alex
Chen. The AI asks questions, listens to the candidate's spoken answer via
streaming speech-to-text, scores each answer across five dimensions, and
moves on to the next topic. A short wrap-up and a feedback page close the
loop.

The flow is orchestrated entirely inside `modules/interview/hooks/useInterview.ts`
via a 1600-line async generator loop driven by a state machine. The loop
is pure client code — every network call (TTS, STT token, question
generation, answer evaluation) is a request to a Next.js App Router
endpoint under `app/api/`.

## 2. User Journey (Functional)

**Entry:** `/lobby` — candidate picks domain + depth + duration, clicks **Start**.

1. **Calibration (≤5s).** Microphone permission prompt. Camera preview
   starts if multimodal is enabled. Deepgram WebSocket is pre-warmed.
2. **Introduction.** Avatar greets the candidate ("Hi, I'm Alex…"). Text
   appears immediately; voice follows within ~500 ms.
3. **Ask question.** Avatar asks Q1. Text and voice are synchronized —
   candidate sees the question written AND hears it spoken.
4. **Listen.** Candidate answers. Live transcript streams into the
   TranscriptPanel. Deepgram finalizes the utterance on a pause.
5. **Process.** Avatar shows a thinking face while the backend scores
   the answer. Every ~3 turns the avatar plays a short "Got it" / "Okay"
   filler so the silence isn't awkward.
6. **Coach.** A short tip appears ("Try adding a metric to the result.").
   Auto-dismisses.
7. **Next question.** Loop back to step 3 until time runs out or the
   question budget is exhausted.
8. **Wrap-up.** Avatar asks a closing question. Candidate answers.
9. **Feedback.** Navigate to `/feedback/[sessionId]`. AI-generated report
   shows per-dimension scores, strengths, improvements, and a full
   transcript. Async AI analysis kicks off in the background (see
   `AI_ANALYSIS.md`).

**Edge cases users see directly:**

- Mic permission denied → inline error, can retry.
- Network drop mid-question → Deepgram reconnects with exponential backoff.
- Usage limit reached → interview halts with upsell banner.
- "End Interview" button (top right) → flow short-circuits to step 9.
- Candidate interrupts with ≥3 words during TTS → AI cuts off and listens.

## 3. State Machine (Technical)

States are typed as `InterviewState` in `shared/types.ts:40-55`. Literal
string names match exactly:

```
LOBBY ─┐
       │  config persisted to localStorage
       ▼
CALIBRATION ─┐  mic perms + Deepgram WS warmup
             ▼
INTERVIEW_START ─┐  intro greeting + optional self-intro Q
                 ▼
       ┌─▶ ASK_QUESTION ──▶ LISTENING ──▶ PROCESSING ──▶ COACHING ─┐
       │                                                            │
       │                                                            │
       │   (qIdx < maxQuestions && timeRemaining > 15s)              │
       └────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
                                WRAP_UP ──▶ SCORING ──▶ FEEDBACK ──▶ ENDED
```

Additional specialised branches:

- **Coding interviews** (`config.interviewType === 'coding'`): ASK_QUESTION
  → `CODE_EDITING` → PROCESSING → COACHING.
- **System design**: ASK_QUESTION → `DESIGN_CANVAS` → PROCESSING → COACHING.
- **Follow-up probing**: PROCESSING → `FOLLOW_UP` → LISTENING loop (up to 2
  probes per topic).

Triggers:

| From → To | Trigger |
|---|---|
| `LOBBY → CALIBRATION` | user clicks Start in lobby |
| `CALIBRATION → INTERVIEW_START` | mic + Deepgram token both resolved |
| `INTERVIEW_START → ASK_QUESTION` | intro TTS playback finished |
| `ASK_QUESTION → LISTENING` | `listenForAnswer(...)` resolves its `onListenStart` callback |
| `LISTENING → PROCESSING` | Deepgram final transcript + grace timer expires |
| `PROCESSING → COACHING` | `evaluateAnswer` RPC returns |
| `COACHING → ASK_QUESTION` | tip dismiss + question-budget check passes |
| `* → WRAP_UP` | qIdx hits max OR `timeRemaining < 15s` after an answer |
| `WRAP_UP → SCORING` | wrap-up answer captured |
| `SCORING → FEEDBACK` | `persistSession` settled OR 10s timeout |
| `* → ENDED` | user clicks End, or usage limit hit |

Any state → ENDED is synchronous via
`finishInterview` (`useInterview.ts:576`), which aborts all in-flight
work before transitioning. BUG-1 established this ordering — do not
re-introduce the race.

## 4. Key Components

| Layer | File : line | Responsibility |
|---|---|---|
| Page | `app/(interview)/interview/page.tsx` | Client shell; mounts `useInterview`, renders `InterviewRoom`. |
| Hook | `modules/interview/hooks/useInterview.ts:834` | Main loop (`runInterviewLoop`). State machine, question generation, answer capture, scoring. |
| Hook | `modules/interview/hooks/useInterview.ts:533` | `evaluateAndCoach` — scores answer, schedules thinking ack, computes performance signal. |
| Hook | `modules/interview/hooks/useInterview.ts:576` | `finishInterview` — aborts work, persists to DB, transitions to SCORING. |
| Hook | `modules/interview/hooks/useAvatarSpeech.ts:162` | `avatarSpeak` — main TTS channel. Tries pre-fetched blob → streaming → buffered → browser fallback. |
| Hook | `modules/interview/hooks/useAvatarSpeech.ts:253` | `cancelTTS` — aborts in-flight fetches, stops `<audio>`, cancels MediaSource, cancels speechSynthesis. |
| Hook | `modules/interview/hooks/useStreamingAudio.ts:45` | `streamAndPlay` — progressive chunk playback via MediaSource API. First chunk fires `onPlaybackStarted`. |
| Hook | `modules/interview/hooks/useDeepgramRecognition.ts:251` | WebSocket message handler. Fires `onInterrupt` when speech arrives without an active listen session. |
| Route | `app/api/tts/stream/route.ts` | Streaming TTS via Deepgram Aura. Tees the Deepgram response: one branch streams to the client, one branch drains into R2 cache. |
| Route | `app/api/tts/route.ts` | Buffered TTS for prefetch + thinking acks. Same Deepgram + R2 cache as streaming, but returns complete bytes. |
| Route | `app/api/generate-question/route.ts` | Claude Haiku call for next question. Uses domain + depth + performance signal. |
| Route | `app/api/evaluate-answer/route.ts` | Claude Haiku call for scoring. Returns 5 dimensions + tip. |
| Route | `app/api/transcribe/token/route.ts` | Ephemeral Deepgram WebSocket token. |
| Component | `modules/interview/components/interview/TranscriptPanel.tsx:94` | Renders chat transcript. Shows "Preparing next question…" placeholder when `currentQuestion` is empty during ASK_QUESTION. |
| Audio | `modules/interview/audio/voiceMixer.ts:61` | `tapAudioElement` — routes any `<audio>` element into the MediaRecorder mixer so recordings capture both candidate and interviewer voice. |

## 5. API Contracts

### `POST /api/tts/stream` — HOT PATH

**Latency budget:** cold cache ≤600ms TTFB, warm cache (R2 hit) ≤150ms TTFB.

```ts
// Request
{ text: string }  // max 5000 chars

// Response (miss): streaming audio
// Content-Type: audio/mpeg | audio/opus
// X-TTS-Cache: miss
// Body: chunked Deepgram Aura stream (tee'd; one branch cached in R2)

// Response (hit): buffered audio from R2
// X-TTS-Cache: hit
// Cache-Control: public, max-age=86400
```

Errors: 401 unauthorized · 503 no API key · 400 invalid text · 502 Deepgram failed · 500 internal.

### `POST /api/tts` — HOT PATH

Same contract, but always returns a complete buffer (no streaming). Used
for prefetch cache warmup and for `playAck` thinking acknowledgments —
both of which prefer low variance over low TTFB.

### `POST /api/generate-question` — HOT PATH

```ts
// Request
{ config, previousAnswers, currentQIndex, performanceSignal }
// Response
{ question: string }
```

Latency budget: ≤1500ms p95 (Claude Haiku).

### `POST /api/evaluate-answer` — HOT PATH

```ts
// Request
{ question, answer, config, probeDepth }
// Response
{ relevance, structure, specificity, ownership, jdAlignment, tip, followUpSuggestion? }
```

Latency budget: ≤1500ms p95 (Claude Haiku).

### `POST /api/transcribe/token`

Returns an ephemeral Deepgram WebSocket token. Short-lived. The candidate
never sees this endpoint; it's called during warmup and after reconnects.

## 6. Functional ↔ Technical Mapping

Lets you answer "if I change X, what does the user see?" and the inverse.

| User experience | State | Implementation |
|---|---|---|
| Clicks Start in lobby | `LOBBY → CALIBRATION` | `LobbyForm.tsx` → router.push(`/interview`) |
| Mic permission prompt | `CALIBRATION` | `useDeepgramRecognition.warmUp()` at `useDeepgramRecognition.ts:79` |
| Hears "Hi, I'm Alex…" | `INTERVIEW_START` | `avatarSpeak(intro)` at `useInterview.ts:1608` area |
| "Alex asks Q1" (text + voice synced) | `ASK_QUESTION` | `useInterview.ts:849-890` — `setCurrentQuestion` + `addToTranscript` eager, then `await avatarSpeak(...)` |
| "Listening…" label | `LISTENING` | `transitionTo('LISTENING')` inside `listenForAnswer`'s `onListenStart` (`useInterview.ts:908`) |
| Live transcript scrolling | `LISTENING` | Deepgram interim results, surfaced via `setLiveAnswer` |
| "Got it / Okay" filler during evaluation | `PROCESSING` | `evaluateAndCoach` timer at `useInterview.ts:547-555`, calls `playAck(...)` from `useAvatarSpeech` |
| Coaching tip card appears | `COACHING` | `showCoachingTip(evaluation)` at `useInterview.ts:491` |
| "Alex cuts off and listens" (candidate interrupt) | `ASK_QUESTION → LISTENING` | Deepgram `onInterrupt` at `useDeepgramRecognition.ts:260`, which calls the callback registered at `useInterview.ts:117-128` (runs `cancelTTS`) |
| End Interview button stops everything | `* → SCORING` | `finishInterview` at `useInterview.ts:576` — `interviewAbortRef.abort()` → `cancelTTS()` → `stopListening()` |
| "Preparing next question…" placeholder | (transient) | `TranscriptPanel.tsx:94` when `currentQuestion === ''`. Should not be visible for more than one frame — see invariant #2. |

## 7. Invariants (Must Not Break)

1. **Intro text visible ≤500 ms after Start click.** Enforced by eager
   `setCurrentQuestion` before `avatarSpeak` at `useInterview.ts:860`.
   Verify: DevTools → click Start → watch TranscriptPanel for intro text.

2. **"Preparing next question…" placeholder visible for ≤1 animation
   frame.** Enforced by the same eager call — the placeholder only exists
   while `currentQuestion === ''` during the microsecond between question
   fetch and state set. Verify: slow-motion screen record, no frame should
   show the placeholder with a visible page around it.

3. **First audio byte on `/api/tts/stream` ≤600 ms (cold cache).**
   Enforced by `response.body.tee()` in `app/api/tts/stream/route.ts` —
   the client branch streams Deepgram bytes progressively. Verify:
   DevTools Network → filter `/api/tts/stream` → TTFB column.

4. **Candidate interrupt requires ≥3 words.** Enforced by word-count
   threshold at `useDeepgramRecognition.ts:261`. Verify: breathe / tap
   desk during TTS → AI must continue. Say "wait can I clarify" → AI
   must cut off.

5. **End Interview stops all audio within 100 ms.** Enforced by
   `cancelTTS` at `useAvatarSpeech.ts:253` aborting fetches + stopping
   `<audio>` + cancelling MediaSource + clearing ack audio ref. Verify:
   click End during a long TTS utterance.

6. **Thinking acks fire on ~1 in 3 evaluations.** Enforced by the
   `ackCountRef.current % 3 === 0` gate at `useInterview.ts:547` plus
   the decoupled `playAck` helper (ack audio element is tracked
   separately so a subsequent `avatarSpeak` does not cancel it).
   Verify: 3 long answers in a row; at least one should emit an
   audible "Got it" / "Okay".

## 8. Known Failure Modes (Append-Only Log)

### 2026-04-11 · Q1 slow, Q2 cut off, Q3 lag, acks silent · PR #228

**Commits in scope:** `133e44f`, `95cf5f2`, `f8735f1` (PR #227 merged as `eb9d8a5`)

**Symptoms reported by Rakshit:**
1. First question takes 7-8s to start speaking (was 2-3s).
2. Q2 cut off mid-sentence without candidate speaking.
3. Q3 voice lagged behind text.
4. "Got it" / "Okay" fillers no longer audible.

**Root causes:**

- **A (#1, #3).** `app/api/tts/stream/route.ts:73` called
  `await response.arrayBuffer()`, buffering the entire Deepgram response
  before returning it. TTFB regressed from ~400ms to ~2000ms. The
  buffering was accidentally introduced in `133e44f` ("TTS R2 cache")
  to enable writing the full body to R2 — but the author did not use
  `tee()` to preserve the streaming path.

- **B (amplifies #1, #3).** `f8735f1` (BUG-7) deferred
  `setCurrentQuestion` and `addToTranscript` into an `onAudioStart`
  callback in `useInterview.ts:885-890`, trying to "sync" text with
  audio. This papered over root cause A by making the blank screen
  match the slow audio instead of fixing the slow audio. Users saw
  "Preparing next question…" for 1-3s every question.

- **C (#2).** `useDeepgramRecognition.ts:261` had no word-count
  threshold on interrupt detection. A single noise word ("uh", "mm",
  mic pop) fired the interrupt. Before `95cf5f2` (BUG-1) the interrupt
  only cancelled the MediaSource stream — buffered / cached audio kept
  playing, so false positives were invisible. BUG-1 extended
  `cancelTTS` to also abort in-flight fetches and pause buffered
  `<audio>` — legitimate for End Interview, but now a false-positive
  interrupt cut the AI off mid-sentence.

- **D (#4).** Thinking acks in `useInterview.ts:547-555` were fire-
  and-forget through `avatarSpeak(ack, 'friendly')`. Two problems:
  (i) the 1500ms timer frequently lost the race against a ~1.2s
  Haiku eval, setting `ackCancelled = true`; (ii) even when they did
  fire, the next question's `avatarSpeak` called `cancelStream()` at
  `useAvatarSpeech.ts:166`, killing the in-flight ack.

**Fixes (this commit):**

- Fix 1 — `app/api/tts/stream/route.ts:72-85`: replaced `arrayBuffer()`
  with `response.body.tee()`. Client branch streams progressively; cache
  branch drains in background and writes to R2.
- Fix 2 — `useInterview.ts:860-890`: restored eager `setCurrentQuestion`
  and `addToTranscript` before `await avatarSpeak`. Dropped the
  `onAudioStart` callback (parameter stays in signatures as a no-op).
- Fix 3 — `useDeepgramRecognition.ts:261`: require
  `transcript.trim().split(/\s+/).filter(Boolean).length >= 3`.
- Fix 4 — new `playAck(text)` in `useAvatarSpeech.ts`. Fetches `/api/tts`
  (buffered, R2-cached for static phrases), plays via a dedicated
  `<audio>` element tracked in `currentAckAudioRef` (NOT `currentAudioRef`),
  so `cancelStream()` from the next `avatarSpeak` does not touch it.
  `cancelTTS` extended to also clear the ack ref so End Interview still
  stops it within 100ms. Ack timer lowered from 1500ms → 800ms.

**Why existing tests didn't catch it:** The `test:run` suite and
`ci.yml` are unit-level and never exercise the real shape of the
`/api/tts/stream` response body. The Playwright e2e suite is
`workflow_dispatch`-only. There was no written TTFB budget, no invariant
covering "text must be eager", and no interrupt-threshold contract.

**Prevention added in this commit:**

- `CLAUDE.md` — new "HOT PATH — DO NOT BREAK" section listing the 10
  hot-path files + 6 rules of engagement. Rule #1 ("measure before
  theorizing") and Rule #4 ("do not treat symptoms") are the exact
  rules that would have blocked BUG-7.
- This flow document — invariants #1-#6 in Section 7 are the contracts
  that were silently broken.
- A unit test for the interrupt threshold in
  `modules/interview/__tests__/deepgramRecognition.test.ts` —
  mechanical guard against regressing rule-of-3 filter.
- A streaming contract test for `/api/tts/stream` at
  `modules/interview/__tests__/ttsStreamRoute.test.ts`. Mocks
  `fetch` to return a ReadableStream whose second chunk is gated
  behind a test-controlled promise; asserts the POST handler returns
  and the client's first read resolves BEFORE the gate is released.
  If someone re-introduces `await response.arrayBuffer()`, the
  POST handler hangs on the gate and the test times out with the
  message "POST did not return within 500ms — route is buffering
  the response". Proven to detect the regression: running the test
  against the original commit-`133e44f` buffered version produces
  exactly that failure.
- A local TTFB measurement script at `scripts/measure-tts-ttfb.mjs`.
  Not run in CI (requires external `api.deepgram.com` access), but
  runs the real tee-vs-arrayBuffer comparison against live Deepgram
  Aura and prints the TTFB delta. Useful for anyone who wants the
  empirical number behind the contract test before shipping.

_Follow-up considerations (not fixed in this commit):_ making
`test:pipeline` PR-blocking in CI; nightly scripted interview against
real APIs; co-locating `app/api/tts/stream/route.ts` logic into a
`modules/interview/api/` shim so the ESLint hot-path rules apply to
its imports.

---

### Follow-up: 2026-04-11 — Codex review findings on PR #228

Two bugs in the original fix pair above, caught by Codex automated
review and shipped as a follow-up PR immediately after the merge of
#228.

**P1 — interrupt word count was per-packet, not accumulated (user-visible):**

Fix 3 from the original commit counted `transcript.trim().split(...).length`
on each individual Deepgram `is_final` packet. Deepgram can split a
single utterance into multiple finals (e.g. `"wait can"` then
`"I clarify"`). Each packet is <3 words alone, so the genuine
4-word interrupt was dropped — the candidate could speak a multi-word
interruption and the AI would keep talking right over them,
reproducing the BUG-1-class symptom the original fix was meant to
rule out. Confirmed by reading the existing in-session final-packet
handler at `useDeepgramRecognition.ts:283-285`, which already
acknowledges multi-packet utterances by accumulating into
`finalTextRef` — but only while a listening session is active, not
during interrupt detection.

Fixed at `modules/interview/hooks/useDeepgramRecognition.ts:66-79,
273-311`:

- New `interruptAccumRef` + `interruptAccumTimerRef` track the
  running transcript across final packets while the avatar is
  speaking.
- Each packet appends to the accumulator; the ≥3-word threshold
  now applies to the accumulated text, not the single packet.
- 2s inactivity timer resets the accumulator so isolated noise
  bursts cannot combine over time to spuriously cross the
  threshold.
- `startListening` also resets the accumulator so stale fragments
  from a prior interrupt window don't leak into the next
  candidate turn.
- Tests added at
  `modules/interview/__tests__/deepgramRecognition.test.ts`:
  - `interrupt fires when 3 words arrive split across two final packets`
  - `interrupt accumulator resets after 2s inactivity`
- Existing `1-2 word false positives` test rewritten to advance
  fake timers between events (matches realistic sparse noise
  spacing; previously it implicitly tested per-packet behavior).

**P2 — pending `playAck` could leak past evaluation (audibly-broken):**

Fix 4 from the original commit guarded the ack timer with an
`ackCancelled` flag that was only checked INSIDE the setTimeout
callback. Once the 800ms timer fired and launched `playAck()`,
the fetch was in flight on the isolated ack channel with nothing
left to cancel it. If evaluation returned right after the timer
fired, the flow was:

1. Timer fires at t=800ms → `playAck("Got it.")` → `/api/tts`
   fetch starts
2. Evaluation returns at t=900ms → `ackCancelled = true;
   clearTimeout(ackTimer)` (both no-ops at this point — timer
   already fired)
3. Main loop runs `avatarSpeak(nextQuestion)` → calls
   `cancelStream()` which deliberately does NOT touch the ack
   channel (invariant #4 — acks must survive the next speak to
   fire during PROCESSING without getting cut off)
4. `/api/tts` fetch resolves at t=1200ms (~300ms cache-miss) →
   "Got it." starts playing OVER the next question's audio

The ack channel did the right thing protecting acks from
`cancelStream()`, but it needed an escape hatch for
"eval finished — abandon the ack". The original fix had no way
to trigger that cleanup from outside the hook.

Fixed at `modules/interview/hooks/useAvatarSpeech.ts:278-297,
362-371` and `modules/interview/hooks/useInterview.ts:103,
566-583`:

- Extracted the ack-clearing block in `cancelTTS` into a
  `clearAckChannel` helper (abort fetch + tear down audio
  element + revoke URL).
- New `cancelAck` public method on `UseAvatarSpeechReturn` that
  delegates to `clearAckChannel`. Isolated from the main
  channel — calling it does NOT touch `currentAudioRef`,
  `currentFetchAbortRef`, or `cancelStream()`.
- `cancelTTS` now calls `clearAckChannel()` instead of
  inlining the same code twice — one source of truth.
- `useInterview.ts:evaluateAndCoach` destructures `cancelAck`
  and calls it immediately after `clearTimeout(ackTimer)` so
  both the pre-fire and post-fire race windows are closed.
  No-op in the healthy case (ack already finished or never
  started).

No new test added for P2 — the race is purely a timing concern
between real `fetch` resolution and `cancelStream`; unit-testing
it would require mocking `fetch` + `Audio` + the interview loop's
full state machine, which is more brittle than useful. The fix
is simple enough to read and reason about directly, and the
manual verification in the PR test plan exercises it end-to-end.

**Why existing tests didn't catch either:**

Neither regression was caught by the 900-test suite. P1 needed a
test that sends multiple final packets — the existing interrupt
tests used a single packet. P2 is a race condition that only
manifests in real-time with a slow `/api/tts` fetch; unit tests
use resolved promises and can't reproduce it. Automated review
(Codex) caught both by reasoning about the code paths directly,
which suggests the test suite needs: (a) multi-packet interrupt
tests (added), and (b) probably an integration-style test for
the ack channel lifecycle (deferred — too brittle for the
benefit, manual verification covers it).

---

### 2026-04-12 · Feedback scores corrupted / last answer missing from feedback

**Symptoms:**

1. Feedback page occasionally shows `NaN` for dimension averages or
   impossible score values (e.g. `undefined` rendered as 0).
2. Feedback page sometimes omits the last answered question's evaluation,
   producing feedback for N-1 questions instead of N.

**Root causes:**

- **A (corrupted evaluations).** `useInterviewAPI.ts:evaluateAnswer`
  called `res.json()` without checking `res.ok`. When `/api/evaluate-answer`
  returned a non-2xx status (429 rate limit, 500 server error), the error
  body `{ error: "..." }` was parsed as an `AnswerEvaluation` and pushed
  into `evaluationsRef`. All score fields (`relevance`, `structure`, etc.)
  were `undefined`, producing `NaN` in downstream average computations
  (`finishInterview` lines 776-780) and corrupting the persisted session
  feedback. Every other fetch in the same file (`callTurnRouter` line 195)
  already checked `res.ok` — this was the only gap.

- **B (race condition — last eval missing).** `evaluateMainAnswer` fires
  the full evaluation as fire-and-forget (`void evaluateAnswer(...)`) at
  line 689. The `.then()` handler updates `evaluationsRef` asynchronously
  (~1-3s). If the interview ends (timer or user click) before the eval
  settles, `finishInterview` reads `evaluationsRef.current` at lines
  741/761/773/815 with the last evaluation missing. No synchronization
  mechanism existed to ensure the background eval had resolved.

**Fixes:**

- Fix A — `useInterviewAPI.ts:133`: added `if (!res.ok)` guard before
  `res.json()`, returning fallback scores (60/55/55/60) matching the
  existing catch block pattern. Prevents error responses from corrupting
  `evaluationsRef`.

- Fix B — `useInterview.ts`: three surgical changes:
  1. New `pendingEvalRef = useRef<Promise<void> | null>(null)` (line 168)
     to track the in-flight background eval promise.
  2. `evaluateMainAnswer` line 691: replaced `void evaluateAnswer(...)` with
     `pendingEvalRef.current = evaluateAnswer(...)` to capture the promise.
     The `.then()` / `.catch()` handlers are unchanged.
  3. `finishInterview` line 742: await `pendingEvalRef.current` with a 3s
     timeout before reading `evaluationsRef`. The abort signal fired at
     line 731 causes in-flight fetches to fail fast (catch returns fallback
     scores), so the await resolves almost immediately in practice. The 3s
     cap is a safety net for edge cases.

---

### 2026-04-12 · Candidate cut off mid-answer after ~15-20 seconds

**Symptom:** Candidate actively speaking for 15-20 seconds, then AI says
"Got it" and moves to next question. Not a silence issue — user was
mid-sentence.

**Root cause:** `listenForAnswer` (useInterview.ts:491-506) had a 30-second
**absolute** `setTimeout` that called `stopListening()` unconditionally.
The timer started when `listenForAnswer()` was called (before Deepgram
connected and before the user started speaking). Effective speaking time
was 30s minus connection setup (2-5s) minus user think time (2-5s) ≈
15-20s. The comment said "silence timeout" but the implementation was a
hard wall clock cutoff.

**Fix:** Replaced the absolute timeout with a **speech-aware inactivity
timeout**. The timer still fires after `timeoutMs` (30s), but now checks
if `liveAnswerRef.current` has grown since the last check. If the user is
still speaking, it reschedules itself. Only fires `stopListening()` when
no new speech has arrived for the full `timeoutMs` window.

Also increased `MAX_ANSWER_MS` from 120s to 180s to give candidates more
room for long-form answers (case study, system design).

**Why gitnexus flagged HIGH risk:** `listenForAnswer` is called from
`useInterview.start` (the main interview loop) at 10+ call sites covering
main answers, probe answers, wrap-up, retry, and pivot flows. All share
the same `timeoutMs=30000` default. The fix is internal to `listenForAnswer`
and does not change its signature or return contract, so all callers
benefit without modification.

---

### 2026-04-16 · Tab-backgrounded answer truncation (E-3.7)

**Symptom:** Candidate backgrounded the browser tab mid-answer (checked
email, notifications, another app) and returned to find the answer cut off,
the interview advanced, and a fallback 60/55/55/60 evaluation recorded for
the truncated text. Reported by EDGE_CASES.md Group 3 #7.

**Root cause:** Two independent timers terminated the answer while the tab
was hidden:

1. **Deepgram grace timer.** Browsers suspend `AudioContext` when a tab is
   backgrounded. The `ScriptProcessorNode` stops delivering audio frames,
   Deepgram sees silence on the WebSocket, and fires `UtteranceEnd` after
   its configured `utterance_end_ms=2500`. `attachMessageHandler` then
   scheduled a 3500-4000 ms grace timer that called `finishRecognition()`,
   closing the WS and resolving the answer with whatever partial text was
   captured before the tab hid. An earlier half-fix in
   `setupAudioProcessing` (per-session) installed a `visibilitychange`
   listener that only tried to resume the AudioContext when the tab
   returned — by which point `finishRecognition` had already run.

2. **useInterview inactivity timer.** `listenForAnswer` at line 582
   scheduled a `setTimeout(timeoutMs=30000)` that called `stopListening()`
   when `liveAnswerRef.current` hadn't grown. While hidden, no audio was
   flowing, so the ref never grew — the 30s timer fired (browser throttling
   defers but doesn't cancel) and terminated the answer independently of
   the Deepgram fix.

**Fixes (this commit):**

- `useDeepgramRecognition.ts` — replaced the per-session visibility
  listener with a hook-level `useEffect` that tracks `isPageHiddenRef`.
  UtteranceEnd handler now skips grace-timer scheduling while hidden
  (`finalTextRef.current.trim().length > 0 && !isPageHiddenRef.current`).
  Grace timer callback adds a defensive early-return when the ref is true
  on fire (covers the case where the browser fires a scheduled timer
  mid-throttle rather than deferring it). The hook-level visibility handler
  cancels any in-flight grace timer on the visible event and resumes the
  AudioContext if the browser suspended it.
- `useInterview.ts` — `scheduleInactivityTimeout` adds a `document.hidden`
  check: when hidden, the timer reschedules itself instead of calling
  `stopListening`. Mirrors the Deepgram-layer fix so neither layer can
  independently truncate the answer.

**Tests added:**

- `modules/interview/__tests__/deepgramRecognition.test.ts`:
  - `does NOT schedule grace timer when UtteranceEnd arrives with page hidden`
  - `cancels an in-flight grace timer when the tab becomes visible`

The tests simulate `document.hidden` + `visibilitychange` events against
the real hook and assert `onComplete` is not called prematurely.

**Why existing tests didn't catch it:** The catalog (EDGE_CASES.md) named
this issue explicitly but no test exercised the visibility lifecycle
against the real hook. E-3.7 was documented but never instrumented.
Adding the two tests closes that gap.

_Follow-up considerations (not fixed in this commit):_ some browsers
suspend `AudioContext` aggressively even for brief backgrounding; the
fix assumes the WebSocket stays alive, which Chrome/Firefox honor but
Safari may not. If Safari users report issues, we may need a reconnect
flow tied to the visible event.

---

### 2026-04-16 · Closing-question AI cut mid-sentence when timer expires (E-5.2)

**Symptom:** On the final seconds of an interview, if the timer hit 0
while the AI was mid-question (`ASK_QUESTION` phase), the AI audio was
truncated ~5 seconds in — typically mid-word for longer questions. The
interview ended abruptly with the candidate never hearing the full final
question. Reported by EDGE_CASES.md Group 5 #2.

**Root cause:** `useInterview.ts` timer tick at line 410 gave `ASK_QUESTION`
/ `PROCESSING` / `COACHING` phases a blanket 5-second grace when the
timer hit 0. That covers most eval settles (~1-3s) and coaching-tip
displays (2-6s), but TTS questions vary widely: short greetings take
2-3s, typical behavioral prompts run 4-8s, and multi-clause framing
("Walk me through a situation where… particularly when…") can hit
10-12s. A 5s grace cut the last ~50% of the audio off on long
questions. The candidate had no chance to answer because the interview
ended before the question finished, and the feedback page showed a
question with no corresponding candidate answer for the final slot.

**Fix:** Split the `ASK_QUESTION` branch out of the combined 5s path:

- `ASK_QUESTION` now gets **10 seconds** to let the AI finish speaking.
  Covers ~99% of question lengths. Still bounded (no unbounded waits).
- **Phase-transition detection within the grace window.** If the AI
  finishes speaking and `useInterview`'s loop transitions the phase to
  `LISTENING` (candidate started answering) before the 10s elapses, the
  grace timer re-dispatches to the existing `LISTENING` handling:
  raises the "Time is up, please finish your current thought" coaching
  tip, sets `timerTruncatedCurrentAnswerRef` (G.12 — so the last eval
  isn't penalized for incompleteness), and gives an additional 15s for
  the candidate to wrap their answer. Worst-case total grace: 25s for
  the edge case where a long question + a candidate answering just as
  time expires align.
- `PROCESSING` / `COACHING` keep the original 5s — they don't have the
  same variability as TTS playback.
- All other phases (INTERVIEW_START, CALIBRATION, WRAP_UP, etc.)
  continue to hard-cut as before.

Total code change: 17 lines in `useInterview.ts`'s 1s-tick callback.
No signature changes, no new timers introduced at hook level.

**Tests added:** None. The grace-timer code path is not reachable from
the hook's public surface without driving the full interview loop
(TTS mocks + phase transitions + `avatarSpeak` promise resolution).
Existing regression tests (3 integration-style files under
`__tests__/`) exercise the timer callback and will flag any structural
regression. Manual verification: start a short interview (duration=1
minute), let the timer run down during a long-framed question, confirm
AI finishes its sentence AND you can answer afterward if you start
speaking within 10s.

**Why catalogued but not fixed until now:** EDGE_CASES.md Group 5
correctly identified the issue, but the original 5s vs. 15s
(ASK vs. LISTENING) asymmetry already looked like an intentional
design decision — so prior eyes read the catalog and moved on. This
audit surfaced it by walking TTS latency numbers (typical 4-8s) and
noting they exceed the 5s grace regularly. Fix was 17 lines; cost of
not fixing was a damaging UX bug on the closing seconds of every
interview where the final question happened to be long.

---

### 2026-04-16 · TTS routes unrated — Deepgram cost exposure (N1)

**Symptom (latent, not yet exploited):** `POST /api/tts/stream` and
`POST /api/tts` were gated only by NextAuth — no per-user rate limit.
A compromised session cookie or a scripted client could replay TTS
calls against the Deepgram Aura backend faster than any human could
trigger legitimately. Cost exposure: ~$0.015 per 1K chars × spam rate.
Even with R2 caching, abuse would pick unique texts to force cache
misses, driving sustained Deepgram-priced calls.

**Root cause:** The two TTS routes were written as raw `POST(req)`
handlers that called `fetch('https://api.deepgram.com/...')` directly.
They never wired into `composeApiRoute` (which includes a rate-limit
block) and no one added standalone `checkRateLimit` calls. Every other
AI route in this repo (generate-question, evaluate-answer, turn-router,
etc.) has a rate limit; the TTS pair was an oversight.

**Fix:** Added a `checkRateLimit(session.user.id, {windowMs: 60_000,
maxRequests: 30, keyPrefix: 'rl:tts-stream' | 'rl:tts-buffered'})` call
immediately after the auth check on both routes. 30 requests/minute
per user is ~10x peak legitimate usage (measured: intro + Q1 + thinking
ack → 2-4 req/min burst at interview start, averaging <1 req/min over
30 min) but hard-stops abuse at 1800 req/hour → $30-60/hour cost ceiling
per compromised account instead of unbounded. Separate key prefixes so
the streaming and buffered routes don't share a quota counter.

`checkRateLimit` fails open on Redis errors (the catch inside
`checkRateLimit.ts` logs and returns `null`) — a cache blip will not
take TTS offline for legitimate users.

**Tests added** at `modules/interview/__tests__/ttsStreamRoute.test.ts`:

- `returns 429 when the per-user rate limit is exceeded` — mocks
  `redis.incr` to return 31 (one over the cap); asserts 429 + the
  `Retry-After: 60` header.
- `keys rate limit per user (id is embedded in the redis key)` —
  asserts the Redis key includes the user id (`rl:tts-stream:test-user-1`)
  so the quota scopes per-user, not globally.
- `redis failure fails open (request still served)` — mocks
  `redis.incr` to reject; asserts 200 + body streams normally, so a
  Redis outage doesn't take TTS offline.

Plus a redis mock added to the test suite setup — makes the existing
streaming-contract tests deterministic (no more dependency on a real
Redis for the 4 legacy tests in the file).

**Why existing tests didn't catch it:** None of the 1900+ existing
tests exercised the TTS routes through `checkRateLimit` — the function
didn't exist in those routes. This was a missing-feature bug, not a
regression, so there was no prior failure mode to reference.

_Follow-up considerations (not fixed in this commit):_ add similar
rate limits to `/api/transcribe/token` if abuse patterns shift;
consider a daily cap in addition to per-minute (30/min × 60 min ×
24h = 43,200 req/day per user today, which is still uncomfortably
high for a single actor — a `rl:tts-stream-daily:{userId}` key with
maxRequests=2000 would add a ~$30/day ceiling).

### E-6.4 — Deferred topic bridge not interrupt-aware (2026-04-16)

**Symptom:** When the AI speaks a deferred-topic bridge ("Earlier you
mentioned…"), the candidate can interrupt, but the code ignores the
`interrupted` return from `avatarSpeak`. `listenForAnswer` then runs
with the interrupt prefix, and the captured speech gets evaluated
against the bridge question — a question the candidate never heard in
full. Semantic mismatch: the eval scores an answer about topic X
against a question about topic Y.

**Root cause:** Both deferred-topic `avatarSpeak` calls (mid-interview
bridge at ~line 1592 and wrap-up loop at ~line 1622) discarded the
`{ interrupted }` return value, falling through to `listenForAnswer`
and `evaluateAndCoach` unconditionally.

**Fix (useInterview.ts):**
1. Mid-interview bridge: capture `{ interrupted: bridgeInterrupted }`.
   If interrupted, `unshift` the topic back into `deferredTopicsRef`
   and skip `listenForAnswer` + `evaluateAndCoach` + `qIdx++`.
2. Wrap-up loop: capture `{ interrupted: wrapUpInterrupted }`. If
   interrupted, `break` out of the remaining-topics loop — the
   candidate clearly wants to move on.

**Why existing tests didn't catch it:** No tests exercise the deferred
topic bridge path with simulated interrupts. The `useInterview` test
suite mocks `avatarSpeak` as a no-op and doesn't trigger the interrupt
callback mid-speech.

### E-3.4 — WS disconnect with partial text no longer truncates answers (2026-04-16)

**Symptom:** Network blip mid-answer → Deepgram WebSocket closes →
`maybeReconnectOrFinish` saw `finalTextRef.current.trim().length > 0`
and immediately called `finishRecognition()`. Result: candidate's
answer was truncated to whatever they'd said before the blip, even
though they were mid-sentence and the network recovered 200ms later.
For a 30-minute interview this is a surprisingly common failure mode
on flaky home Wi-Fi.

**Root cause:** The early-bail check was a safety measure to avoid
"losing" text on reconnect, but it predated the current
`finalTextRef`-accumulating message handler. `finalTextRef` is only
cleared at `startListening` entry — it persists across reconnects.
So the shortcut was actively harmful: it discarded the *future* of
the answer to "preserve" the past.

**Fix (useDeepgramRecognition.ts):**
1. `maybeReconnectOrFinish`: removed the partial-text→finish early
   return. Now always reconnects up to `maxReconnectAttempts (2)`
   before finishing, regardless of whether `finalTextRef` has content.
2. Before scheduling the reconnect, tear down the stale audio
   processor + source + AudioContext bound to the dead ws.
   `setupAudioProcessing` on the next `onopen` creates fresh ones.
   (Previously only `finishRecognition` tore these down, so
   reconnects would have leaked — a latent bug exposed by the more
   aggressive reconnect policy.)
3. `connectWebSocket.onopen`: reset `reconnectAttemptsRef.current = 0`
   on successful open so a second blip 20 minutes later doesn't fail
   from a stale incremented counter. `startListening` also resets this
   at session start; the onopen reset covers mid-session reconnects.

**Tests added (deepgramRecognition.test.ts):**
- `reconnects on WS close when partial text exists; preserves partial
  text` — verifies a new WebSocket is created (not finished) and the
  combined transcript after reconnect contains both halves.
- `finishes once maxReconnectAttempts is exhausted even with partial
  text` — three back-to-back closes (no successful onopen between)
  eventually trigger `finishRecognition` with the captured partial.

**Scope limit:** The `warmUp` fast path has its own
`onclose` handler that only flips `isWarmedUpRef`; that path doesn't
go through `maybeReconnectOrFinish`. Reconnect behavior on the warm
WS is a separate existing-behavior limitation, untouched by this fix.

**Why existing tests didn't catch it:** No existing test exercised
the reconnect path at all. The `deepgramRecognition.test.ts` suite
had 10 tests before E-3.7; all covered happy-path listening or
interrupt accumulation. The reconnect code was deployed and never
verified end-to-end.

### F-4 — Redis fail-open no longer doubles Claude bill (2026-04-16)

_Lives in the feedback scoring flow (`app/api/generate-feedback/route.ts`)
— logged here because §8 is the repo's institutional "what has broken
and why" registry, and no dedicated FEEDBACK_SCORING.md exists yet._

**Symptom:** When Redis was unreachable the idempotency lock (G.6)
failed open (`acquireFeedbackLock` returns `{ acquired: false }` on a
caught error, see `shared/services/feedbackLock.ts:83-87`). Both the
`finishInterview` pre-gen fire-and-forget AND the feedback page's
8-second-poll-miss fallback then ran the full Claude pipeline in
parallel: 2× the LLM bill, racing `findByIdAndUpdate` on
`InterviewSession.feedback`, and double-firing every post-feedback
side effect (competency / pathway / summary / weakness clusters /
XP). End-users could also flash-see one `overall_score` before the
later write landed and replaced it.

**Root cause:** The lock was the only duplicate-work guard in the
pipeline. With the lock effectively absent, nothing else checked
whether another caller was already mid-flight.

**Fix (`app/api/generate-feedback/route.ts`):** Added a pre-flight
DB read right after the short-form guard, before any context
assembly or Claude call. If `InterviewSession.feedback` is already
populated, return that as the response and skip the rest of the
pipeline entirely. Runs regardless of the Redis lock state, so it
also catches two related edge cases the lock missed:
(a) lock TTL expiry mid-generation, (b) a race between
`acquireFeedbackLock` returning and the winner's DB write landing.

The pre-flight read is wrapped in try/catch — a transient Mongo
blip logs a warn and falls through to the original pipeline rather
than blocking legitimate feedback generation. One ~50 ms DB read
to save a ~10–20 s Claude call + five side-effect writes.

**Security: owner-scoped lookup.** `sessionId` is client-supplied
and only format-validated as a string. The pre-flight query MUST
filter on `{ _id: body.sessionId, userId: user.id }` (not a bare
`findById`) — otherwise this endpoint becomes a cross-account
feedback oracle: any authenticated user who learns another user's
sessionId could fetch that user's overall_score, dimensions,
red_flags, and top_3_improvements. The owner filter ensures a
mismatched caller gets `null` back (same as "no cached feedback"),
falling through to the normal generation path. Caught during the
Codex review of PR #273 before merge; regression test
`F-4: pre-flight lookup is owner-scoped (no cross-account feedback
leak)` asserts the filter shape includes `userId`.

**Tests added (`generateFeedbackIdempotency.test.ts`):**
- `F-4: returns cached feedback when session.feedback already
  populated (fail-open race)` — asserts no completion call, cached
  feedback in response.
- `F-4: proceeds with generation when session.feedback is null
  (normal first run)` — asserts the check is non-intrusive on cold.
- `F-4: pre-flight DB read failure is non-fatal (falls through to
  normal pipeline)` — asserts Mongo outage still allows generation.

**Scope limit:** This fix defends against duplicate Claude calls +
duplicate side effects. It does NOT make the final DB write atomic
— two callers can still race `findByIdAndUpdate` if both pass the
pre-flight check (e.g., both queries land before either writes).
The last-writer-wins race is harmless for the `feedback` field
(the overall_score converges on identical values from the same
input) and acceptable for side effects (rare; logged). A proper
`findOneAndUpdate({ _id, feedback: null })` conditional write is
tracked as future hardening but unnecessary for the 99%+ scenario
handled by the pre-flight read.

### F-3 — Aggregate side-effect summary log (2026-04-16)

_Also in `app/api/generate-feedback/route.ts`, post-feedback block._

**Symptom:** The five fire-and-forget side effects that fan out after
a feedback is generated (practiceStats / competency / sessionSummary
/ weaknessClusters / pathwayPlan) each had their own `.catch(err ⇒
aiLogger.warn(...))` with no `sessionId` in the context. If three of
five silently failed on a given interview, there was no way to see
it: the per-call warns had no correlation key, and there was no
"how many of the N calls succeeded?" line at all. Users could land
on a feedback page with a score but no XP update, no learning plan,
no weakness signals — undetectable without combing server logs.

**Root cause:** Observability gap. The calls were structurally
correct but their outcomes weren't aggregated.

**Fix:** Each side effect is now registered via a local
`fireAndTrack(name, promise, errLabel)` helper that:
1. Pushes the raw promise into a `sideEffects: Array<{ name, promise }>`
   so `Promise.allSettled` can observe it (individual `.catch`
   handlers are attached after pushing, keeping the raw promise's
   rejection state intact for the aggregate).
2. Emits the existing per-call warn WITH `sessionId`, `userId`, and a
   `sideEffect: <name>` tag for correlation.

After all side effects are registered, `Promise.allSettled(sideEffects
.map(s => s.promise))` runs (non-blocking; the response has already
returned). Its `.then` emits one `aiLogger.info` line with
`totalSideEffects`, `succeeded`, `failedCount`, and — if failures
exist — a `failed: [{ name, reason }]` array. One glance now tells
ops "4/5 succeeded for session X, failed: [pathwayPlan]".

The `evaluateSession → generatePathwayPlan` chain is registered as a
single `pathwayPlan` side effect — a failure in either stage
attributes to the same name, which is how users experience it
(either they got a new learning plan or they didn't).

**Tests added (`generateFeedbackIdempotency.test.ts`):**
- `F-3: emits aggregate summary log with succeeded count when all
  side effects pass` — asserts the info line includes
  `totalSideEffects`, `succeeded`, `failedCount: 0`, and no `failed`
  key when everything succeeds.
- `F-3: aggregate summary lists failed side effects by name` —
  overrides `updateCompetencyState` and `generatePathwayPlan` to
  reject, asserts the aggregate log names both failures with their
  reason strings.

### 2026-04-20 · Mic capture moved from ScriptProcessorNode → AudioWorkletNode (A-1)

**Symptom:** A live interview on 2026-04-20 showed mid-answer Deepgram
WebSocket reconnects (`[Deepgram] WebSocket connected` appeared 3× in
the client console during a 6-question session), duplicate
`finishRecognition` fires for the same Q4 text, and `ScriptProcessorNode
is deprecated` warnings repeated 6× — once per question, matching the
per-question `setupAudioProcessing` recreation. Earlier entries E-3.4
(2026-04-16, WS drop mid-answer → truncation) and E-3.7 (2026-04-16,
tab-backgrounded answer truncation) had already documented the same
root cause from different triggers; the fix for each was a bandaid
(reconnect-not-truncate, KeepAlive-during-listening, visibility
handler).

**Root cause:** `ScriptProcessorNode.onaudioprocess` runs on the main
thread. Anything heavy on the main thread — MediaPipe face-landmark
inference (`vision_wasm_internal.js` running concurrently during
interviews), React reconciler, Deepgram message parsing, coaching-
nudge timers, WebGL avatar animations, V8 GC pauses — can throttle or
drop those callbacks. Missed callbacks = no PCM bytes sent to Deepgram
= server sees silence = server fires UtteranceEnd or closes the
socket with 1011 idle-timeout = the observed reconnect/duplicate
behavior. The 9 bandaid commits spanning 2026-03 through 2026-04
(`528e1f5`, `44fe05f`, `53c9f38`, `aaf4993`, `0b056e1`, `03e8671`,
`57d0a27`, `43d7989`, `859f924`) were each addressing one downstream
symptom of this single upstream cause.

**Fix (commit in this PR):** Replace the main-thread
`createScriptProcessor(4096, 1, 1)` with an `AudioWorkletNode` whose
processor lives in `public/pcm-processor.js` and runs on the audio
rendering thread. The audio thread is unaffected by main-thread work
— Chrome/Firefox/Safari all guarantee `AudioWorkletProcessor.process()`
is called on the audio thread at a deterministic 128-frame render
quantum. Internal buffering inside the worklet (32 render quanta =
4096 samples = 256ms) preserves the exact packet cadence Deepgram's
server-side VAD was calibrated against, so `utterance_end_ms=2500` and
all client-side grace timers (`GRACE_MS_BY_INTENT`) continue to work
without retuning. Bytes on the WebSocket wire are bit-identical to the
ScriptProcessor implementation (linear16 Int16 PCM, 4096 samples per
frame, 16kHz), verified by the same Float32→Int16 clamp + scale
formula running in the worklet instead of the main thread.

**Why a single migration instead of continuing to patch symptoms:**
Per-symptom bandaids had already introduced significant hook
complexity (the KeepAlive / close-trigger-tagging / reconnect-scoping
plumbing). Each new symptom surfaced a new bandaid. Removing the
root cause removes the need for future bandaids of this family.

**Tests added (`deepgramRecognition.test.ts` mock surface):** Replaced
`createScriptProcessor` mock on `MockAudioContext` with
`audioWorklet.addModule` (resolves immediately) plus a global
`MockAudioWorkletNode` stub that exposes `port.onmessage` (so tests
that need to simulate inbound PCM chunks can assign + call the
handler directly). All 63 existing Deepgram tests continue to pass
without logic changes — the mock swap is the only test-side diff.

**Deliberately kept as-is (not rolled back):** KeepAlive pings, close-
trigger tagging (`aaf49937`), visibility resume listener, and the
reconnect-not-truncate path. Those are defensive, cheap, and still
protect against legitimate network blips (router renegotiation, ISP
brown-outs, Safari aggressive AudioContext suspension). Worklet fixes
the main-thread-throttle failure mode; network-level failures still
need their own handling.

**Backlog (intentionally deferred to a separate PR):** Tune the
worklet's internal buffer size from 32 render quanta to 8 or 16 for
potentially faster interim-transcript updates. Requires measuring
p95 time-from-last-word-to-final-transcript at each setting and
cross-checking Deepgram server-side VAD behavior. Tracked in
CLAUDE.md Known Issues.

**What will change in the client footprint:**
- `.next/static/chunks/app/interview/page-*.js` loses
  `createScriptProcessor` / `ScriptProcessorNode` references
- New static asset served at `/pcm-processor.js` (~3.7 KB, one-time
  fetch cached by the browser)
- First-answer startup cost: +1 fetch for `pcm-processor.js` if the
  browser cache is cold (single-digit ms on HTTP/2 + gzip); subsequent
  questions / interviews are free (cache hit)

**What to verify manually post-deploy** (cannot unit-test these):
1. Chrome desktop DevTools console: no `ScriptProcessorNode is
   deprecated` warning during a full interview.
2. Background the tab mid-answer for ≥10s, return: answer should NOT
   be truncated (E-3.7 remains fixed).
3. Network panel filter `ws`: Deepgram frame sizes should be 8192 B
   at ~256ms cadence — exactly as they were before the migration.
4. Safari 17 (if available): complete one full interview. AudioWorklet
   is supported since Safari 14.1 but has had quirks; confirm audio
   flows end-to-end.

### 2026-06-02 · Wrap-up labels, stuck wrap-up, and Safe Q&A · PR #431

**Symptoms reported:** Production screenshots/HAR logs showed internal
probe turns rendering as `Question 12 of 11` and `Question 13 of 11`.
The wrap-up prompt briefly appeared, then the UI reverted to the
follow-up question while listening. A wrap-up answer like "I don't have
any questions at the moment" was longer than 5 characters, so the client
treated it as a candidate question and played the hardcoded "That's a
great question" close.

**Fixes in PR #431:**
- UI labels now come from `questionDisplay`, not raw `questionIndex`.
  Main turns render as `Question N`; probes/re-anchors/deferred turns
  render as `Follow-up N`; intro hides the counter; wrap-up stays
  `Wrap-up` with complete progress.
- The three interview-mode wrap-up paths share one wrap-up sequence.
  It sets the visible question to the wrap-up line before TTS and keeps
  the wrap-up display while `listenForAnswer()` moves the phase to
  `LISTENING`.
- Wrap-up answers are classified deterministically as empty,
  no-questions, thank-you-only, or has-question. Only real questions call
  the Safe Q&A route; no-question and thank-you closes never say "great
  question".
- Mid-interview candidate questions now use the same Safe Q&A route and
  then redirect back to the active interview question. Because this adds
  an LLM round-trip to a live path, the client immediately shows
  "Sure - let me answer that briefly." and plays a short ack before the
  await.

**Safety constraint:** Safe Q&A is intentionally conservative. It may
personalize from role, interview type, experience, target company name,
JD-derived context, and public company-profile style context, but it
must not invent exact timelines, compensation, benefits, visa policy,
team structure, headcount, internal tools, manager names, or other
company-specific facts. Unsupported exact-detail questions get generic
guidance and should point candidates to the recruiter or next interviewer;
details explicitly grounded in the JD/trusted context may route through
Safe Q&A.

**Verification note:** Unit/API checks cover classifier behavior,
TranscriptPanel labels, Safe Q&A safety/fallbacks, wrap-up no-LLM paths,
wrap-up question paths, and mid-interview redirect behavior. A full
browser interview with real Deepgram/TTS/model keys remains the manual
post-deploy verification for this hot path.

### 2026-06-11 · Case-study "you're the PM" seat + cross-session repeats

**Symptom (prod QA matrix, two runs):** every case-study question seated the
candidate as *"Imagine you are the PM for a media app…"* regardless of the actual
role (finance, data-analyst, mechanical, designer…), and repeated interviews of
the same domain × type re-used the same scenarios. Behavioral/technical were
already role-authentic after the QA résumé fix; case-study was not.

**Root cause:**
1. **Seat** — `generate-question`'s case-study `typeInstructions` literally hardcoded
   the example *"Imagine you are the PM for X."* The LLM copied that seat. Behavioral/
   technical carry no seat ("tell me about a time *you*…"), which is why the résumé
   personalized those but not case-study.
2. **Repeats** — no cross-session question history existed anywhere; the generator
   only saw within-session `previousQA`, so nothing forced variety across repeated
   same-domain×type interviews.

**Fix:**
1. The case-study instruction now seats the candidate AS `${domainLabel}` (the role
   being interviewed for), grounded in their résumé + JD + DOMAIN CONTEXT, explicitly
   forbids the "PM / media app" default unless the role IS product management, and
   asks the generator to vary the company/industry context.
2. New cross-session **ANTI-REPEAT** block: at `questionIndex <= 1` the route queries
   the candidate's prior COMPLETED sessions for the same `config.role` ×
   `config.interviewType`, pulls `evaluations[].question`, and injects an
   "already asked — do not repeat" list (built by `buildAntiRepeatBlock` in
   `modules/interview/flow/promptBuilder.ts`). Query is `.limit(6).select(...).lean()`,
   gated to the first two questions, wrapped in try/catch → degrades to no block on
   any DB issue.

**Latency:** the anti-repeat query adds one lean read to generate-question at Q0–Q1
only (~10–50ms typical; the DB connection is already open from the profile block).
Well within the ≤1500ms p95 budget; later questions are unaffected (within-session
`previousQA` + thread context handle variety there).

**Verification:** `buildAntiRepeatBlock` unit tests (dedup/cap/truncate/empty),
`tsc --noEmit` clean, `npm run build` green. The seat source was confirmed against QA
report `qa-browser-full-1781116704635`. A full browser interview with real keys —
including a *repeat* of the same domain×type to confirm non-repetition — remains the
manual post-deploy verification for this hot path.

---

### 8.x — Coding interview v2: difficulty calibration, runnable example tests, pacing (2026-06-16)

**Symptom (candidate feedback):** (1) a problem "given for 10 min" was barely solvable
in 25; (2) the runner wasn't interactive and examples weren't runnable ("I can't tell
how input/output works"); (3) after Submit, Alex asks a verbal follow-up but there was
no visible timer if the candidate stayed silent; (4) the whole thing took too long.

**Root cause:** difficulty was derived from EXPERIENCE only (duration ignored); the
generator had no time-awareness; examples were display-only with a function-starter vs
program-Run mismatch; the post-submit follow-up used a 30s `listenForAnswer` timeout
with no surfaced countdown; and the eval fetch + a hard-coded 2000ms pause added
unbounded/extra wall-clock.

**Fix (hot-path `useInterview.ts` coding branch + supporting files):**
- **Difficulty ⇄ time** — `resolveCodingTimeBudget(duration, problemCount)` +
  `resolveCodingDifficulty(experience, budget)` (the *easier* of the two caps); threaded
  through `selectProblem`/`generateCodingProblem`/`page.tsx`; generator prompt now
  scopes to the budget; `expectedTimeMinutes = budget` shown as a "⏱ ~N min" badge.
- **Runnable examples** — `runExampleTests()` (LLM-judged) behind `/api/code/run` when
  `examples` are sent; CodeEditor "Run" shows per-case expected/actual + pass/fail.
- **Pacing + timer** — eval fetch bounded by a **12s AbortController** (falls back to
  default feedback); the post-feedback pause trimmed **2000ms → 600ms**; the post-submit
  follow-up listen reduced **30s → 25s** with a new `answerSecondsLeft` state driving a
  visible "Ns to answer" countdown (auto-advances on elapse).

**Latency:** the eval timeout only *shortens* the worst case; the countdown is a 1s
interval local to the follow-up (cleared in `finally`). No added cost on the
generate-question/evaluate-answer hot loops.

**Verification:** `resolveCodingDifficulty`/`runExampleTests` unit tests; `tsc --noEmit`
clean; `npm run build` green. A full browser coding interview with real keys — confirming
a right-sized problem, Run-against-examples pass/fail, and the visible post-submit
countdown auto-advancing on silence — remains the manual post-deploy verification.

### 2026-06-17 · Domain coverage gap: 17 selectable domains had no skill/flow; `general` backstop added

**Symptom.** The taxonomy expansion (Phases 4–6) made 24 domains selectable but only
authored skill files + flow templates for 7. For the other 17, `resolveFlow` returned
`null` (no topic sequencing, no `experienceAngle`) and `getSkillContent` returned `''`
(no domain scoring-emphasis / sample questions) — interviews ran on the base prompt only,
and 4 domains (devops/finance/marketing/sales) had *regressed* from deleted pre-migration
content.

**Root cause.** No test tied "selectable domain" to "has skill + flow." Coverage was
authored by hand for the original 7 and never extended when the catalog grew; the
QuestionBank backfill (the one layer that *was* extended) made the gap look filled.

**Fix.** Authored banded skill files + flow templates for all 17 (recovered git content
for the 4 regressed; workflow fan-out for the rest). Added `skillFlowCoverage.test.ts`,
which derives the live cell set from `STATIC_DOMAINS × STATIC_DEPTHS` and fails if any
cell lacks a skill file or registered flow template — so this cannot silently recur.
Also wired a `general` backstop in BOTH `resolveFlow` and `getSkillContent`: a domain with
no template/skill falls back to the fully-covered `general` domain for the same
depth+experience, so an interview always gets general topic sequencing AND general skill
prompt (not general flow with empty skill — caught in QA review). This branch is
**unreachable for every domain in the taxonomy** (the coverage guard proves it); it only
protects CMS-added domains absent from `STATIC_DOMAINS`.

**Verification.** `tsc --noEmit` clean; full suite green (`skillFlowCoverage` +
`rubricCoverage` guards, 4533+ tests). `resolver.ts` is hot-path: the change is additive
and provably cannot alter resolution for any covered domain, but a full browser interview
on a real domain confirming unchanged flow remains the manual post-deploy check.

### 2026-06-23 · Coach-mode dead air when the live-coaching switch is off · PR #459

**Symptom.** Feedback #1 added an in-room "Coaching on/off" master switch that
render-gates the live nudges + STAR overlay/tips (`app/interview/page.tsx`). For a
candidate with `coachMode` ON, turning the switch OFF hid the visible `CoachingTip`
but the engine still entered `COACHING` and **blocked 3-6s after every answer**
(`showCoachingTip`, `useInterview.ts`) — dead air with nothing on screen. Caught by
the Codex PR review, not by unit/type/lint (it's a state-machine timing interaction).

**Root cause.** The feedback-#1 change was render-gate-only and never told the engine.
`showCoachingTip`'s blocking branch was gated solely on `config.coachMode`, independent
of the new preference. Hiding the UI without skipping the engine pause left the wait.

**Fix.** Threaded `liveCoachingEnabled` into `useInterview` via an always-current ref
(`liveCoachingEnabledRef`, mirroring the `liveTranscriptRef` pattern — the block runs
from a stale `runInterviewLoop` closure, so a primitive prop would not reflect a
mid-interview toggle). The blocking branch now uses a pure predicate
`shouldBlockForCoaching(coachMode, liveCoachingEnabled)` (`hooks/coachingGate.ts`):
block only when coach mode is on AND coaching is not silenced, else fall through to the
existing non-blocking branch (no dead air). Also fires the existing `coachingAbortRef`
when the switch flips off mid-block, so a candidate escaping coaching doesn't eat the
remaining pause. The two other `transitionTo('COACHING')` sites (coding/design feedback
beats, ~2303/2502) are NOT on this path and were left untouched; the main-answer eval
path is already non-blocking.

**Verification.** `coachingGate.test.ts` (4 cases; load-bearing one = coach-on +
switch-off → no block); full `useInterview` suite + interview module green; `tsc
--noEmit` clean; lint clean. `useInterview.ts` is hot-path: the change is additive and
the coach-on + switch-on path is provably unchanged (identical predicate result), but a
full browser interview in coach mode toggling the switch mid-answer remains the manual
post-deploy check (no Deepgram/Anthropic keys in CI).

**Follow-up (same review cycle, PR #459).** Codex's re-review of the dead-air fix caught
a second, related bug: feedback #1 render-gated the `<CoachingTip>` component on
`liveCoachingEnabled`, but the `coachingTip` state channel is **overloaded** — besides
STAR coaching tips it also carries STATUS notices (usage-limit at `useInterview.ts:585`,
time warnings `623`/`628`, "Time is up" `666`/`686`, and the coding/design feedback text
`2329`/`2528` which is also spoken by the avatar). Hiding the whole channel meant a
candidate who silenced coaching also lost the "Time is up, please finish your current
thought" notice — the only on-screen reason the interview was ending. **Fix:** un-gate the
`<CoachingTip>` render (restores the original ungated render) and instead gate ONLY the
two real coaching producers at the source (`showCoachingTip` and
`appendEvaluationAndMaybeCoach`) on `liveCoachingEnabledRef`. Status notices and the
coding/design spoken feedback share the channel and stay visible. Regression guard:
`useInterview.test.ts` "keeps STATUS notices visible even when live coaching is disabled".

**Follow-up 2 (same review cycle).** Codex's third pass caught the interaction between
the two prior fixes: toggling coaching off mid read-pause aborts the sleep, but
`showCoachingTip`'s abort branch intentionally skips `setCoachingTip(null)` (for
interrupt/end), and since the render is now unconditional (Follow-up 1) the silenced
coaching card lingered into the next question. **Fix:** the toggle-off effect now also
clears the tip — guarded by `coachingAbortRef.current` (set ONLY during the coaching
read-pause), so it clears an active coaching tip but never a status notice.

**Design supersession — toggle moved to the lobby.** After the three follow-ups above,
the root cause became clear: every one of them stemmed from the toggle being *mutable
mid-interview*, racing the async state machine. The control was therefore moved to the
**lobby** (`app/lobby/page.tsx`, alongside the `privacyMode` opt-in), where it is chosen
before the room loads and is **immutable for the session**. This deletes the entire
mid-toggle interaction class: the abort-on-toggle effect and the active-tip clearing in
`useInterview.ts` were **removed** (the effect now only mirrors the value into
`liveCoachingEnabledRef`), and the in-room toggle UI in `InterviewControls.tsx` was
reverted to End-only. What REMAINS load-bearing — and applies equally to a lobby-set
"off" — is the source-gating: `showCoachingTip` / `appendEvaluationAndMaybeCoach` skip the
coaching tip (and the 3-6s read-pause) when coaching is off, while the `<CoachingTip>`
render stays ungated so status notices remain visible. Net: coaching-off is now a simple
constant the engine reads once, not a live signal it must react to.

The lobby→room handoff passes the choice via the room URL (`?lc=0` when off) on the join
navigation — a storage-independent channel, so it cannot be lost to a failed localStorage
write (quota / private browsing) the way a config/flag write could, and it forces no
write on the common "on" path. The room reads `?lc` client-side (effect, SSR-safe);
default on. The device-wide preference (`liveCoachingPreference.ts`) is only a
cross-session default that seeds the lobby toggle; it is not on the path that reaches the
room. (Earlier iterations routed this through `InterviewConfig.liveCoachingEnabled` —
that field was removed when the URL channel replaced it.)

### 2026-06-24 · Opt-in Indian-accent interviewer voice via Azure AI Speech (feedback #4)

**What.** Deepgram Aura has **no Indian-English voice** (only US/UK/AU/IE/PH). Added
Azure AI Speech as an **opt-in second TTS provider** so candidates can pick a natural
en-IN interviewer voice (default `en-IN-Aarti:DragonHDLatestNeural` — Azure's most
realistic "Dragon HD" tier, confirmed GA in `centralindia` via the voices/list endpoint).

**Design (purely additive — the Deepgram hot path is untouched).** Azure's
`cognitiveservices/v1` REST endpoint returns a **chunked MP3** stream, the same shape
Deepgram returns, so it plugs straight into the existing `tee()` + R2 pipeline and the
client's MediaSource plays it with **zero playback changes**. The Azure branch in
`/api/tts/stream` + `/api/tts` only fires when the request carries `?voice=indian` **AND**
Azure is configured (`isAzureTTSConfigured()`); otherwise the route is byte-for-byte the
Deepgram path. The lobby picker (gated by `NEXT_PUBLIC_FEATURE_VOICE_PICKER`) carries the
choice to the room via a **`?voice=indian` URL handoff** (same storage-independent channel
as `?lc`); `useAvatarSpeech` reads `?voice` once on mount and appends it to all four TTS
fetches (stream / buffered / prefetch / ack). R2 cache is keyed by `model=azure-<voice>`
(`ttsCacheKey` already partitions by model) so Azure and Deepgram audio can never collide.
New adapter: `shared/services/providers/azureTTS.ts` (`azureSynthesize` / `buildSsml`
with XML escaping / `isAzureTTSConfigured` / `AZURE_TTS_MODEL`).

**Failure modes (all hit during bring-up — documented so they aren't rediscovered):**
1. **401 from the wrong key.** The Azure **AI Foundry project** "API key" (from
   `ai.azure.com`) is NOT a Speech key — it only authenticates `services.ai.azure.com` /
   `openai.azure.com`. Speech TTS needs **KEY 1/KEY 2 from a dedicated "Speech service"
   resource** (`portal.azure.com` → Keys and Endpoint). Diagnosis: a key rejected by the
   data-plane voices/list across *all* regions ⇒ wrong key (not a Speech key at all). The
   key is a clean 32-char value in both cases, so length doesn't disambiguate — probe it.
2. **401 from region mismatch.** A Speech key only authenticates its **own** region's
   `{region}.tts.speech.microsoft.com`. `AZURE_SPEECH_REGION` must equal the resource's
   region (centralindia here). Azure's own 401 body says "use a correct regional API
   endpoint for your resource."
3. **TTFB is geography-bound — do NOT benchmark it from a laptop.** Measured locally,
   Azure TTFB was 0.75–2.5s, but that is dominated by the dev machine's **~1.5s RTT floor**
   to `centralindia` (baseline TLS handshake, before any synthesis) — not Azure's speed.
   The real ≤600ms budget check (§5) must be run from a **datacenter** (Vercel
   preview/prod). For the India launch the TTS function should run near the Azure region
   (Vercel `bom1`/Mumbai), where Azure neural TTS streams first-byte in ~250–450ms.
   Mitigations that hide most of the cost in a real interview: the **R2 cache** (the fixed
   intro greeting + repeated acks are cached after first synthesis → R2 fetch on repeat)
   and **prefetch** of the upcoming question while the candidate answers.

**Status: merged DARK.** `NEXT_PUBLIC_FEATURE_VOICE_PICKER` is unset in production, so the
picker is hidden, no `?voice` is ever sent, and the live path is **Deepgram-only** — zero
risk. Flip the flag on for users only after a datacenter TTFB measurement passes.

**Verification.** `azureTTS.test.ts` (SSML build + XML escaping, 3/3); voices/list
confirmed Aarti Dragon HD is GA in centralindia; Aarti HD synthesized 49–56KB of valid MP3
through the streaming path; `tsc --noEmit` 0, eslint clean, `next build` green, interview
suite 2811/2811; `detect_changes` confined to the two TTS `POST` handlers + `useAvatarSpeech`
+ `LobbyPageInner`; the Deepgram path is provably unchanged when `?voice` is absent. Local
TTFB was deliberately NOT used as the gate (network-bound). `scripts/measure-azure-tts-ttfb.mjs`
added for the datacenter measurement; the live in-interview listen-test on a preview is the
remaining manual step before flipping the flag.

**Region pin (2026-06-24, two PRs).** Goal: run the TTS function near India users + the
Azure centralindia endpoint (Vercel Pro supports per-function regions; the rest of the app
stays in iad1 for Mongo Atlas proximity, and TTS uses no Mongo so the split is safe).

- **First attempt was INERT (caught by Codex).** Adding `export const preferredRegion = 'bom1'`
  to the route did NOTHING: for Next.js/Vercel, `preferredRegion` is an **Edge-runtime-only**
  knob. On these `runtime = 'nodejs'` handlers it compiled to nothing — confirmed by
  `.next/server/functions-config-manifest.json`, which listed `/api/tts` and `/api/tts/stream`
  as `{}`. (The repo's pre-existing `app/api/resume/pdf` `preferredRegion = 'iad1'` is **also**
  inert for the same reason; it only "works" because iad1 is the default region anyway. Worth a
  separate cleanup.)
- **Correct mechanism: `vercel.json`.** Node function regions are set there — a project-level
  `"regions": ["iad1"]` plus a per-function override `"functions": { "app/api/tts/route.ts":
  { "regions": ["bom1"] }, "app/api/tts/stream/route.ts": { "regions": ["bom1"] } }`. The route
  files keep only a breadcrumb comment pointing here.

**Still must verify with a real post-deploy TTFB measurement** before trusting bom1: (1) the
Deepgram DEFAULT voice is US-side, so bom1 adds a hop to the non-Indian path; (2) the Upstash
rate-limit Redis (region not in the hostname) is on the critical path — if it's US-East, bom1
adds an RTT to EVERY TTS request. Measure bom1 vs iad1 (the JWT-cookie harness against a
preview deploy works without login; also check `process.env.VERCEL_REGION` to confirm the
function actually landed in bom1) and revert the pin if the default path or rate-limit regresses.

### 2026-06-24 · Adaptive grace — clean answers close ~2s faster (turn-latency feedback)

**Symptom (owner feedback).** Too long between the candidate going silent and the AI asking the
next question. Measured budget: **~5.5s just to CLOSE the listening state** on a clean answer =
Deepgram `utterance_end_ms=2500` (server VAD) + `GRACE_MS_BY_INTENT.complete=3000` (client grace).
The processing→next-question side is already optimized (fast turn-router + prefetched question +
background eval), so it is NOT where the seconds are.

**Root cause.** The 3000ms `complete` grace is a uniform belt-and-suspenders buffer applied to
EVERY complete answer — even one that has already had 2500ms of true silence AND ends in terminal
punctuation / Deepgram `speech_final` (endpoint-confident). For those, the extra 3s is dead air.

**Fix (flag-gated, `NEXT_PUBLIC_FEATURE_ADAPTIVE_GRACE`, `useDeepgramRecognition.ts`).**
- Wired up the previously-unused `speech_final` signal (`sawSpeechFinalRef`, set per is_final,
  reset per turn) — it was parsed for diagnostics but never drove control flow.
- New pure helper `selectGraceMs(intent, text, sawSpeechFinal, adaptive)`: a CONFIDENTLY-complete
  answer (intent 'complete' AND (speech_final OR terminal punctuation)) closes in
  `COMPLETE_CONFIDENT_GRACE_MS=1100` instead of 3000. **Ambiguous / incomplete / 'let me think'
  answers keep their full `GRACE_MS_BY_INTENT` window** — so there is NO added mid-pause cutoff
  risk. Flag OFF ⇒ `selectGraceMs` returns exactly the legacy window. Grace stays cancellable by
  any interim/is_final.
- Single-sourced the duplicated Deepgram WS URL into `DEEPGRAM_LISTEN_URL` — `utterance_end_ms`
  was hardcoded in two literals (warmUp + connectWebSocket); editing one silently desynced warm
  vs cold sessions. **`utterance_end_ms` left at 2500** (NOT lowered — that's the retired
  `earlyQuestion` cutoff territory, close code 4002).
- Net: a clean confident answer closes in ~2500 + 1100 ≈ **3.6s (down from 5.5s)**.

**Phase 2 (probe-path prefetch) — investigated, NOT shipped.** The brainstorm proposed priming R2
TTS for probe questions + reusing the prefetched main question. On implementation both fell
through: (a) the reuse is ALREADY done — `prefetchedQuestionRef` is consumed at the top of every
topic, including after a probe loop (`useInterview.ts:1639-1641`); (b) there is no prewarm window
— every probe question is computed synchronously from that answer's eval (`buildProbeQuestion`,
`useInterview.ts:2122`) and spoken immediately, with no `await` before `avatarSpeak`. Priming R2
there fires microseconds before playback (zero benefit, wasted double-synth). The only remaining
probe-path lever is backgrounding the deep-probe `evaluate-answer` (a behavioral change to probe
cadence) — deferred as its own change.

**Verification.** `selectGraceMs.test.ts` 6/6 (safety property: only complete+confident is
shortened; incomplete/thinking/flag-off keep their full window). tsc 0, eslint clean. HOT-PATH e2e
OUTSTANDING (CLAUDE.md rule #3): ship dark, then measure in a REAL interview via
`window.__deepgramDebug` — p95 last-word→close, **mid-answer cutoff rate** (candidate resumed
within old-grace-but-not-new), ≥3-word interrupt still fires, one-word noise does NOT close. Flip
the flag only after the cutoff rate stays flat.

### 2026-06-25 · Academic / Subject Viva depth for campus freshers (feedback #5)

**Request (owner).** Colleges pitch a campus "academics round": a panel asks a 0-2yr fresher
"what's your favourite subject?" then grills its fundamentals, theorems/frameworks, and adjacent
subjects. Wanted as one more interview *type* against the existing domains for the 0-2 experience
band — same oral format, no separate flow engine, no B2B, no placement tags; accuracy via the model
plus strong guardrails (NOT a curated KB/RAG).

**Design (per-domain grain preserved).** New `academics` depth alongside behavioral/technical/
case-study/system-design/coding. A rigorous subject-grain evaluation collapsed the 19 eng/mgmt/IT
domains into **12 distinct academic content sets** (cs-core shared across the 6 software roles;
data-ml-core across the 3 data roles; mech/civil/ee/ece distinct; marketing/finance/operations/
sales/strategy/business each distinct — management does NOT collapse). Authored as 12 sets, written
out to **19 per-domain `{domain}-academics.md` skill files** (the architecture's per-domain grain).
One **shared subject-agnostic flow shape** (`flow/templates/academics.ts`, favourite → fundamentals
→ derive → adjacent → connect → close) is registered for all 19 domains × 3 bands; the per-domain
subject pool + adjacency + accuracy guardrails live in the skill files.

**Gating.** New `applicableExperience` field on the depth model + `StaticDepth` + `FALLBACK_DEPTHS`.
academics → `['0-2']`, so it is **hidden outside the 0-2 band** (DepthSelector + `/api/interview-types`
both filter on it; absent experience hides it). All 3 flow bands are still registered so the
`skillFlowCoverage` guard passes; only 0-2 is ever resolved live.

**HOT-PATH touch (`app/api/evaluate-answer/route.ts`).** Academic answers are subject
explanations/derivations, not STAR stories — the single hardcoded STAR-anchored `scoringGuide`
(G.11) would mis-score them. The scoring *dimensions* are already data-driven from the depth doc
(academics → correctness / conceptual_depth / derivation / breadth, coerced positionally), so the
ONLY route change is swapping the inline guide for `buildScoringGuide(interviewType)` — a pure,
unit-tested helper (`services/eval/scoringGuide.ts`) that returns the academic conceptual-viva guide
for `academics` and the **byte-for-byte legacy STAR guide for every other depth**. Blast radius for
existing depths = zero. The favourite-subject opener and subject drilling are carried by the flow +
skill content + transcript — no `useInterview`/`generate-question` change.

**Verification.** Full suite **4917 passing** (incl. the `skillFlowCoverage` guard now covering all
19 academic cells, and `scoringGuide.test.ts`), tsc 0, eslint clean, production build clean. One
anticipatory QA-harness test (`strongAnswerRouter` template scan) caught a regex false-positive on
the band/comment literals in `academics.ts` — fixed by not embedding a three-element band array
literal. HOT-PATH live e2e OUTSTANDING (CLAUDE.md rule #3, auth is prod-only): select Academic /
Subject Viva for a 0-2 fresher on prod, confirm the opener asks the favourite subject, the drill
stays on-syllabus + accurate, and scores spread on conceptual correctness (not STAR).

### 2026-06-27 · Interviewer goes silent after Q1 on iPhone/iPad (not Android, not Mac) · Phase 1

**Report (owner).** Users on small Apple devices (iPhone, iPad, iPad-mini) intermittently
hear nothing from the interviewer after the first question — both the default Deepgram voice
and the opt-in Azure voice. **Works on laptops/desktops and on Android**; the user was present
on-screen the whole time (so NOT screen-lock / backgrounding).

**Investigation (evidence, not theory).** Vercel runtime logs: every `POST /api/tts/stream`
returns `200` including the 2nd–10th call within a session → server delivers audio for every
question; the failure is **client-side playback**. Git: the playback code (`voiceMixer.ts`
2026-04-08, `useStreamingAudio.ts` 2026-04-12) is unchanged for months, and the only June-24
TTS-path change appends `voiceQueryRef` (`''` for Deepgram) → a literal no-op → recent code
**exonerated**. The decisive signal: **Android works, iOS doesn't**, on the same WebKit — so it
is not a Web-Audio/code bug, it is the iOS **`AVAudioSession`** layer.

**Root cause (architecture × iOS).** The live interview stands up **two mic-bound AudioContexts**
— Deepgram STT (`new AudioContext({sampleRate:16000})` + `createMediaStreamSource(mic)`, rebuilt
**every turn**) and the voice mixer (`~48kHz`, `createMediaStreamSource(mic)` **and**
`createMediaElementSource(TTS)` → `ctx.destination`) — plus two `MediaRecorder`s. iOS gives the
tab ONE shared `AVAudioSession`; a live mic forces it into **PlayAndRecord**, which (a) routes
Web-Audio output to the **receiver/earpiece** not the speaker and (b) intermittently flips the
playback context into the iOS-only **`'interrupted'`** state. Because Context A is torn down/up
each turn, the session renegotiates per question and Context B's TTS playback loses → **silent,
intermittent, after Q1** (Q1 rides the Start-tap gesture and wins the session first). macOS and
Android don't arbitrate a single session, so they're fine. `createMediaElementSource` hijacks the
element so a suspended context yields **silence with no throw** — the existing catch-fallback
never fires.

**Phase-1 fix (this commit) — HOT PATH `modules/interview/audio/voiceMixer.ts`.** One guard
inside `tapAudioElement`: `if (isAppleTouchDevice()) return`. On Apple touch devices we **don't**
route TTS through the mic-bound AudioContext — the `<audio>` element plays **natively** (always
audible). Covers Deepgram + Azure and all three playback paths (`streamAndPlay`, `playBlob`,
`playAck`) because the gate is in the single shared helper. `isAppleTouchDevice()` uses
`maxTouchPoints` to catch iPad-reports-as-Macintosh. **Desktop/Android byte-identical** (still
tapped + recorded). **Trade-off:** AI voice absent from the recorded webm on iOS only — the
analysis pipeline already falls back to the live Deepgram transcript, so nothing downstream breaks.
Impact analysis: LOW, 3 d=1 callers, 0 processes; signature unchanged so callers untouched.

**Verification.** `voiceMixer.test.ts` (5 cases: taps on Windows/Android/Mac, does NOT tap on
iPhone + iPad-as-Mac) + neighbouring suites green (9 passing), tsc 0, eslint clean. **OUTSTANDING
(CLAUDE.md rule #3): real-device validation** — run an interview on a physical iPhone/iPad in prod
and confirm Q2+ is audible; if a question is still silent, hold the device to your ear — faint
audio from the top earpiece = PlayAndRecord routing persists (Context A's mic forces it), which
Phase-1 native playback may not fully escape. **Phase 2 (only if validated):** consider removing
the iOS gate for universal native playback — but that drops AI voice from the recording on ALL
platforms, so it's a product call, not cleanup.

### 2026-06-27 · Academics Q1 re-asked the favourite-subject opener (duplication)

**Symptom.** In a campus Academics viva (0–2 band), the spoken intro asks "which academic
subject are you strongest in?" and then the *first generated question (Q1)* sometimes asked
it again ("so, which subject are you strongest in?") — duplicating the opener.

**Root cause (two compounding layers; NOT prefetch timing alone).** Q1 is prefetched during
the intro speech, *before* the candidate's intro answer is captured (intentional — see
`d2c04c9`: Q1 is the generic "roadmap" warm-up slot; the intro-pin only feeds Q2+). So at
Q1-gen time no subject is in context. Meanwhile the `{domain}-academics.md` skill files —
written *before* `4fc96b9` moved the favourite-subject question into the spoken intro — still
told the model to *open by asking which subject*, in **three injected places**: the persona
("You open every viva the same way: 'Which subject are you strongest in?'"), the Question
Strategy lead, and the **All-Levels / Entry-Level Sample Questions** (which `selectSkillQuestions`
always merges into the Q0–Q3 inspiration pool). With no named subject in context and the skill
content nudging it, the model re-asked the opener. The pre-existing `academicGrounding` guard
only forbade *switching subjects*, not *re-asking which subject*.

**Fix (content + prompt guard — NOT a prefetch change; the prefetch is deliberate).**
- **Prompt guard (hot-path `app/api/generate-question/route.ts`)** — extracted the academics
  grounding text into `academicGroundingDirective` (`modules/interview/services/core/academicsPrompt.ts`)
  and added an explicit *NEVER RE-ASK THE OPENER* rule: the favourite-subject question was the
  spoken opening; on the first generated question (before the answer is in context) open with a
  roadmap of the subject they just named, never "which subject."
- **Content scrub (all 20 `*-academics.md` skill files)** — removed the favourite-subject opener
  from persona, Question Strategy, and the injectable Sample Questions; replaced sample openers
  with roadmap/depth questions that *assume the subject is already named*. Also diverged the 6
  byte-identical cs-core files and 3 byte-identical data files per-domain (adjacent-subject tilt).
- **QA guard** — `matrixQuality.mjs` now emits `AUTO-ACAD-001` if any generated academics question
  matches the opener pattern; added `backend/marketing/mechanical × academics` smoke cells + an
  academics answer fixture to the roster matrix.

**Latency.** Zero change to the hot loop — the Q1 prefetch is preserved (no added wait); the guard
is static prompt text (cacheable) and the skill files are the same size.

**Verification.** New `academicsPrompt.test.ts` (anti-repeat contract) + `matrixQuality.test.ts`
(opener detector) + updated `rosterMatrix.test.ts` counts; full vitest suite 4979 passing / 0
failing; `tsc --noEmit` clean; `npm run build` green. Impact analysis on the route handler: LOW
(no d=1 callers — framework-invoked; additive prompt string only). **OUTSTANDING (CLAUDE.md rule
#3): manual prod self-interview** — run a 0–2 Academics viva on two domains (one cs-core, one
business) with real keys and confirm Q1 is a roadmap/fundamentals question on the named subject,
never a repeat of the favourite-subject opener.

### 2026-06-28 · Live STT model nova-2 → nova-3 (accent accuracy)

**Change.** Flipped the single-sourced `DEEPGRAM_LISTEN_URL` (useDeepgramRecognition.ts) from
`model=nova-2` to `model=nova-3`. nova-3 is Deepgram's current GA streaming model and is
materially more accurate on accented / Indian English (Deepgram cites ~21% relative streaming
WER reduction vs nova-2, with larger gains on accented speech), and it is the prerequisite for
`keyterm` prompting we may add next. **Only the model changed** — `language` stays `en` and all
other params (smart_format, filler_words, utterance_end_ms=2500, interim_results, encoding,
sample_rate) are nova-3-compatible and unchanged, so the model is isolated as the sole variable.
`en-IN` and per-interview `keyterm` boosting are deliberate follow-ups, not in this change.

**Why this was safe to scope tightly.** The edit is a string-constant value, not a signature —
impact analysis on the hook shows the change has no symbol blast radius (the d=1 consumers
`warmUp`/`connectWebSocket` receive the same string type; only the runtime model differs). No
caller breaks.

**Verification.** `deepgramRecognition.test.ts` gains an assertion that the opened WS URL carries
`model=nova-3` (not nova-2) plus the full STT param contract (so a future edit can't silently
drop a flag); deepgram + grace suites 97 passing; `tsc --noEmit` clean; `npm run build` green.
**OUTSTANDING (CLAUDE.md rule #3, auth is prod-only): a real prod interview** — confirm (a) STT
accuracy on Indian-accented speech improves, (b) first-token/interim latency stays within budget,
and critically (c) nova-3's utterance-finalization cadence still matches the `GRACE_MS_BY_INTENT`
/ `utterance_end_ms=2500` interrupt+grace timers (these were calibrated against nova-2; if
interrupts mis-fire or finals truncate, retune the grace windows alongside the model).

### 2026-06-28 · STT language=en-IN tied to the Indian-English choice + made the default

**Change.** STT `language` is now per-session instead of a hardcoded `en`. The
single-sourced URL became `buildListenUrl(resolveSttLanguage())` (useDeepgramRecognition.ts):
`resolveSttLanguage()` reads the same `?voice=indian` choice the TTS path already uses
(mirrors useAvatarSpeech) → `en-IN` for Indian English, `en` otherwise. The lobby voice
control now **defaults to Indian English** (`indianVoice` initial state `false → true`,
app/lobby/page.tsx) — this is an India-first product, so the one choice drives BOTH the Azure
interviewer voice AND Deepgram `language=en-IN`. US/International users opt out via the picker.

**No feature flag (deliberate).** The gate is the user's explicit lobby choice, not a new
flag — `?voice=indian` already existed. The existing `NEXT_PUBLIC_FEATURE_VOICE_PICKER` only
controls whether the opt-out UI renders; **it must stay enabled in prod so non-Indian users
have a visible way to switch back to en** (with Indian now the default, that picker is the
only escape hatch).

**Correctness without live telemetry.** US/International is protected *by construction*, proven
by a unit test: `buildListenUrl('en')` is byte-identical to the prior URL and `en-IN` differs
*only* in the `language=` param — so any non-Indian session is unchanged. No production A/B
needed for that guarantee.

**Verification.** `deepgramRecognition.test.ts` adds `buildListenUrl` (en byte-identical / en-IN
differs only in language / empty→en) and `resolveSttLanguage` (`?voice=indian`→en-IN; else en)
unit tests; deepgram suite 93 passing; `tsc` clean; `npm run build` green.

**Grace timing: no change needed.** Finalization is driven by `UtteranceEnd` (governed by the
configured `utterance_end_ms=2500` + word-gap timing — model-independent per Deepgram) and, under
the already-in-prod `NEXT_PUBLIC_FEATURE_ADAPTIVE_GRACE`, by `speech_final` (VAD/endpointing). That
VAD-driven `speech_final` mechanism is identical in kind to nova-2 (which has run with adaptive
grace in prod) — `en` vs `en-IN` is the same nova-3 model with Indian-English tuning and changes
transcription accuracy, not silence/endpoint detection. So `GRACE_MS_BY_INTENT` /
`COMPLETE_CONFIDENT_GRACE_MS` / `utterance_end_ms` stay as-is. Nice-to-have (not a blocker): a
casual prod self-interview on the Indian path; only if clean answers visibly clip at ~1.1s would
you bump `COMPLETE_CONFIDENT_GRACE_MS` — there is no a-priori reason to.

### 2026-06-28 · Live transcript: dim the interim tail (no "text rewrote itself" flicker)

**Symptom.** The live "Your answer" panel rendered Deepgram's interim + finalized text as one
undifferentiated string, so when an interim result was revised on finalization it looked like the
text glitched/rewrote under the candidate.

**Fix (display-layer only — no STT/grace/VAD change).** `useDeepgramRecognition` now exposes
`finalTranscript` (finalized, solid, never revises) and `interimTranscript` (the current interim
tail, may change) alongside the unchanged merged `liveTranscript` (coaching/word-count consumers
untouched). All three are set in the same RAF block. `TranscriptPanel` renders finalized text
solid + the interim tail in a dimmed italic span, so a revision reads as "still settling," not a
glitch. The interim tail still feeds `utterance_end_ms`/grace/interrupt exactly as before —
`interim_results=true` is required for those — only the *rendering* split changed. Coding/Design
layouts keep the merged string. Web Speech fallback maps `interimTranscript=''` (renders solid).

**Verification.** `TranscriptPanel.test.tsx` (solid final + dimmed-italic interim span; interim-only;
empty→Listening placeholder) + a `deepgramRecognition.test.ts` hook-shape test (RAF-throttled state
isn't observable via result.current — same as the long-standing `liveTranscript` — so the live
update behavior is covered by the panel render). Full vitest 4994 passing; `tsc` clean; build green.

### 2026-06-29 · Academics questions drift to the candidate's résumé, not the named subject · PR #478

**Symptom (internal QA feedback; the example below is synthetic/de-identified).** In a Marketing →
Academics → 0-2 viva, the candidate names one subject in the spoken intro but the interviewer keeps
asking about a DIFFERENT area that dominates their résumé. Pattern: the prefetched Q1 asks for a
roadmap of the résumé's dominant theme rather than the named subject (the candidate has to correct it
mid-interview), and a later question lifts a specific résumé bullet (e.g. an ad-campaign metric)
instead of probing the named subject. Net: the viva tracks the *résumé*, not the *named subject*.
Side damage: the drift also depresses the score — the candidate's correction to the fabricated
question and their confusion at a vague probe get graded as candidate failures (the system's bad
questions count against them).

**Root cause (two compounding sources, both feeding `/api/generate-question`).**
1. **Résumé/JD/profile/domain topic-steering was injected for academics like every other depth.**
   `contextBlock` (`<candidate_resume_analysis> … Probe the highlighted experiences`), `profileBlock`
   ("probe their top skills" = the candidate's résumé-derived skills), `personalizationBlock`
   (résumé/JD session brief), `ragBlock`, and `domainContext` (the marketing `systemPromptContext` =
   SEO/SEM/CTR/CPC/ROAS/CAC *job* topics) all overrode `academicGroundingDirective`'s "anchor to the
   named subject, never switch."
2. **The grounding directive seeded its own wrong answer.** `academicGroundingDirective` hard-coded
   "digital marketing" TWICE as its worked example. Q1 is prefetched BEFORE the intro answer is
   captured (d2c04c9 — Q1 is the warm-up slot), so the named subject isn't in context yet; a 300-token
   gpt-5.4-mini filled the void by copying the directive's OWN example, reinforced by the résumé.

**Fix (prompt-only, two files).**
- `app/api/generate-question/route.ts`: a subject viva is grounded ONLY on the directive + the
  per-domain skill file + persona. For academics, **gate every résumé/JD/company-derived builder**
  (`contextBlock` JD + `<candidate_resume_analysis>`, `profileBlock`, `personalizationBlock` =
  `generateSessionBrief`, `ragBlock` = question-bank retrieval, `companyBlock` = targetCompany/
  targetIndustry themes, and the cross-session `antiRepeatBlock`) on `!isAcademics` so the work is
  never done (no JD/résumé cache reads, no profile read, no session-brief LLM call, no bank
  retrieval, no prior-session lookup on the hot path — not built-then-discarded). Also suppress the
  **dynamic** steering: `threadContext`'s `JD COVERAGE CHECK` note, the `EMPLOYER DIVERSITY` note,
  and the generic `diversityNote` (the "switch to a different competency area — failure handling,
  data-driven decisions, innovation" nudge after Q3, which is behavioural/job steering that drifts a
  viva off-subject; subject breadth is the directive's job), and the **JD flow overlay**
  (`jdOverlay` stays null so `resolveFlow`/`buildFlowPromptContext`
  emit no JD-derived insertions / `JD ALIGNMENT` even when `FEATURE_FLAG_JD_FLOW_OVERLAY` is on).
  `domainContext` (the domain `systemPromptContext` job-topics) is built from the shared
  domain/depth fetch, so it's nulled post-hoc rather than gated. `recallContext` (the candidate's
  OWN previous answers) is intentionally KEPT (continuity within the subject; carries no résumé
  once the above are gone). [JD-coverage note, JD overlay, builder-gating, company/anti-repeat
  gating were three Codex review rounds on PR #478 — `antiRepeatBlock` mattered because at the
  prefetched Q1 a prior viva's question texts would be the only concrete subject in the prompt.]
- `academicsPrompt.ts`: de-seed the directive — removed the "digital marketing"/"operating systems"
  examples; added "NEVER infer, substitute, or guess a subject from the candidate's résumé, work
  experience, the domain, or any example — use ONLY the subject they explicitly stated"; on the
  prefetched Q1 (subject not yet visible) "do NOT name, guess, or infer a subject — ask for a roadmap
  of their strongest subject (let them state it)."
- **Base framing + escalation (the full sweep — not just the suppressible blocks).** A second pass
  audited EVERY component feeding the prompt, not only the résumé/JD blocks. Four more injected
  *workplace-behavioural* content into a viva and are now academics-aware: (a) `basePrompt` framed it
  as "an interview **for a {domain} role**" → now "an **academic subject viva in the {domain} subject
  area** (a student)" with academics `roleLabels`/`typeLabels`/`typeInstructions`; (b) `difficultyBlock`
  ("strong" escalated to "ethical dilemmas, cross-functional conflicts") → `academicDifficultyGuidance`
  that escalates WITHIN the subject (derivations, edge cases, comparisons); (c) `pressureInstructions`
  (elevated/high → "cross-functional conflict, defend a trade-off") → `academicPressureInstructions`
  (justify a definition, prove a result, subtle aspects — on-subject); (d) the **curveball**
  (workplace hypotheticals like "unlimited budget, 2 weeks" after Q3) is disabled for academics.
  Lesson: the drift had MANY scattered sources; gating the obvious blocks left the base framing +
  difficulty/pressure/curveball escalators leaking. The audit (not Codex one-at-a-time) found them.
- **`flow/promptBuilder.ts` deep-dive guidance (found by an adversarial verification pass, not Codex).**
  The academics flow template (`academics.ts`) authored viva-toned deep-dive slots (`VIVA_DEEP_DIVE_*`)
  but deliberately reused the ids `adaptive-deep-dive-1/2` to keep coverage wiring unchanged.
  `buildFlowPromptContext` rewrites any `phase==='deep-dive' && id.startsWith('adaptive-deep-dive')`
  slot via `buildAdaptiveDeepDiveGuidance`, which emits SHARED behavioural strings ("force a
  trade-off, present a constraint", "what would you do differently?", "best example in a domain where
  they showed comfort") — defeating the authored viva guidance and injecting job framing into the
  viva's deep-dive slot. Fixed by gating that rewrite on `flow.depth !== 'academics'` (the resolved
  flow carries `depth`), so academics deep-dives use their authored guidance. Regression tests in
  `flowEngine.test.ts` (academics keeps viva guidance; non-academics still gets the rewrite).

**Why prompt-only (no Q1-prefetch-timing change).** Removing the résumé + the directive's example
removes everything Q1 could grab; with no subject in context it now asks a subject-agnostic roadmap
(the intended warm-up) instead of fabricating one. Re-sequencing the prefetch (useInterview.ts) was
unnecessary and would add Q1 latency on the hot path.

**Deferred to follow-up PRs (from the same audit).** (4) scoring still penalises the candidate for
system-caused turns — no off-base-question guard in `evaluate-answer`/`perQAggregation`; (6) the probe
path (`turn-router` on Haiku + `evaluate-answer`) omits the academic grounding + named subject (latent
drift on other sessions); (8) `generate-question` `temperature` is uncontrolled (P2). STT accent
corruption ("learning"→"leadership") was a separate factor already fixed by nova-3 + en-IN (#475/#476).

**Verification.** `academicsPrompt.test.ts` adds de-seed contract tests (directive contains NO
"digital marketing"/"operating systems"; forbids résumé inference; "only the subject they explicitly
stated"; "never attribute a subject they did not say") and the existing anti-repeat/anchor assertions
still pass (8 passing). `tsc` clean; full vitest 4996 passing; build green. End-to-end prod self-interview on
the academics path pending (auth is prod-only) — to confirm: name a subject UNRELATED to your résumé
and verify Q1 and every question stays on it.

### 2026-06-30 · Probe/advance loop wasn't bounded — viva ground 4 probes into one dead topic

**Symptom (academics, but the bug is all-depths).** A candidate named "consumer behaviour", then
gave escalating non-answers ("the master law of hierarchical theory", "It's mash law", "Second
question, Again, question" — scored 10/5/0/0, 5/0/0/0, 5/0/0/0). The interviewer kept **re-probing
the same micro-topic** (expand → clarify → challenge → expand) for Q2–Q5 instead of moving to a
different sub-topic or wrapping up; the candidate ended the session early. The drift fix (#478) was
working — questions stayed on-subject — this is a separate *bounding* failure. A later probe also
degraded to a subject-less generic ("Can you walk me through the specific example?").

**Root cause.** Probing had **no score/content bound**. `probeDecision.shouldProbe` is the LLM's call
(evaluate-answer/route.ts) with the only hard stop being `answer.length < 5`. The client advance gate
`shouldProbeOrAdvance` (useInterview.ts flow-aware path + interviewUtils.ts fallback) advanced only on
`!shouldProbe`, `time < 60`, per-slot `maxProbes`, or coverage pressure — **none of which read the
scores**. Worse, an academics/no-JD session has `flowHints = null` (flowHints are only set on the JD
flow-overlay path), so it used the *weakest* fallback (time + topic-count only). So a collapsing
score trajectory (34→34→10→5→5) and outright non-answers never forced an advance or an early wrap.

**Fix (prompt-free, all depths).**
- `interviewUtils.ts`: new pure `isNonAnswer(eval)` (avg of the 4 dims < 12 AND specificity < 10;
  a `status:'failed'` eval is never a non-answer) + `countTrailingNonAnswers(evals)`.
- **Advance-on-non-answer**: `shouldProbeOrAdvance` (BOTH the flow-aware path in `useInterview.ts`
  and the `interviewUtils.ts` fallback) now returns `advance` on a non-answer — re-probing a
  collapsed answer never helps, so it moves to a fresh topic instead of grinding.
- **Disengagement early-wrap**: after finalizing each topic, if `countTrailingNonAnswers >= 3` the
  topic loop `break`s, which falls through to `runWrapUpSequence()` — a graceful close instead of
  dragging a disengaged candidate through all 11 planned questions. Fires only on genuine collapse
  (≥3 consecutive avg<12 answers), which a normal interview of any depth never reaches → inert for
  real candidates (so no non-academics regression).
- Deferred follow-ups: subject-anchored probe *fallback* wording (the generic "specific example"),
  and wiring the academics flow's `maxProbes` so academics stops using the time-only fallback. The
  advance/wrap bounds above already cap the grind for every depth.

**Verification.** `interviewUtils.test.ts` adds `isNonAnswer` (flags 5/0/0/0 + 10/5/0/0; spares the
weak-but-real 34/8/12/18; failed≠non-answer), `countTrailingNonAnswers` (streak/reset), and
`shouldProbeOrAdvance` advances-on-non-answer. `tsc` clean; full vitest green; build green. The
disengagement `break` is in the `while (qIdx < maxQ)` body (probe loop closed) → reaches
`runWrapUpSequence()`. End-to-end prod confirmation pending (auth is prod-only).

**Review follow-ups (PR #479).** (1) `evaluationsRef` is appended in eval-COMPLETION order, not
answer order (the main answer's eval is backgrounded), so `countTrailingNonAnswers` now sorts by
`questionIndex` (monotonic across main questions AND probes) before counting — a late-landing main
eval can no longer scramble the streak. (2) On the disengagement `break`, `disengagedRef` is set so
the close skips the optional "you mentioned earlier…" deferred-topic surfacing (a disengaged
candidate gets a clean wrap). (3) The duplicate flow-aware `shouldProbeOrAdvanceWithFlow`
(coveragePressure.ts — tested, not yet wired into production) got the same `isNonAnswer` guard so it
can't drift if useInterview later switches to it. Known/accepted: the FIRST probe after a main
answer is still driven by the turn-router (for low latency), so a main answer that is itself a
non-answer gets ONE clarifying probe before the bound advances — re-probing once is reasonable, and
gating probe #1 on the (backgrounded) full eval would regress probe-start latency on the hot path.

### 2026-06-30 · Probe questions were generic for EVERY depth — grounded the probe path

**Symptom.** Follow-up/probe questions were generic across all depths ("Can you walk me through a
specific example?", "Can you tell me more?") — most visible in academics, where a viva should be
framework-dense every turn (no "derive CLV", "positioning vs differentiation", "explain Maslow").

**Root cause (cross-depth, not academics-specific).** The MAIN/flow questions are persona- and
framework-grounded for all depths (generate-question loads `interviewer-persona` + `question-strategy`
from the per-domain×depth skill file). But the PROBE path had none of it: (a) the **turn-router**
(probe #1) is called for every depth with an intentionally minimal payload — *no persona, no
question-strategy, not even the domain* — so it can only emit generic follow-ups; (b) **evaluate-answer**
(which supplies `probeTarget` for probe #2+) fetched only scoring sections (`scoring-emphasis`,
`red-flags`, `experience-calibration`), so its probeTarget was a generic "gap/claim", never a named
framework. So depths DID use the persona in main questions, but NO depth used it in probes.

**Fix (full grounding, all depths).**
- **turn-router (probe #1):** accepts `role` (passed from `useInterviewAPI` via `config?.role`), fetches
  `interviewer-persona` + `question-strategy` for that domain×depth, and injects an "INTERVIEWER
  PERSONA & PROBE STRATEGY" block so the probe is in-voice and pushes on the framework / mechanism /
  derivation / distinction the round expects. `role` is optional → older/edge clients fall back to the
  unchanged generic probe.
- **evaluate-answer (probe #2+): NOT grounded — reverted (see below).** An attempt to make
  `probeTarget` prefer a named framework was reverted: it fought the existing `isWeakProbeTarget`
  question-overlap filter (a concept named in the question got rejected → generic anyway) and created
  a warm-up depth-resolution edge. Probe #2+ keeps its original generic target; grounding probe #2+
  is a focused follow-up. Probe #1 (turn-router) is the grounded path.

**Latency (known, follow-up).** The turn-router now does one (cached) skill-file read + a larger
prompt, so probe-start is slightly slower. The turn-router exists precisely to keep probe #1 fast
(<400ms); tuning this (e.g. cache the assembled probe-grounding block per session, or trim the
injected strategy) is tracked as a deliberate next step — full grounding shipped first, latency
optimisation second, by decision.

**Verification.** `tsc` clean; full vitest 5007 passing (no regressions — grounding is additive, `role`
optional); build green. No new unit tests: both routes need full auth+LLM mocking to invoke and the
effect is LLM-driven probe wording; the change is additive (generic fallback when `role` absent).
End-to-end prod confirmation pending (auth is prod-only) — probes should now name frameworks per depth.

**Review follow-up (Codex #480 P2).** The grounding fires only on a REAL concept turn: it's gated on
`resolveEvalDepthSlug(interviewType, questionIndex) === interviewType`. `resolveEvalDepthSlug` remaps
the academics warm-up turns (index 0 = spoken intro, 1 = "roadmap" ease-in) to `behavioral` — those
are not concept/derivation probes (the slot says "no deep probing yet"), so the framework grounding
is skipped there and a vague roadmap answer no longer gets a "derive CLV" first probe. Matches how
evaluate-answer already resolves the depth for those turns (the turn-router is called on the MAIN
answer, so it gets the main index — verified).

**Turn-router DB-stall guard + source-layer negative caching (Codex #480 P3 + follow-up).**
`getSkillSections` is DB-first (CMS override → file fallback), so on a cold process the Mongo
connect/find could add seconds to — or stall — the fast turn-router path (<400ms). Two-layer fix:
(1) the turn-router's grounding read is bounded by a 200 ms `Promise.race` (timeout → generic probe,
no stall); (2) **negative caching at the SOURCE layers** — the `screening` depth has NO skill files
(and is the *default* depth) and misses weren't cached, so every screening probe re-ran the DB-first
lookup. `loadSkillFromFile` now caches a permanent file-miss (`null`), and `loadSkillFromDB` caches a
**confirmed not-found** (`content: null`) — but NEVER an error (a caught Mongo failure returns null
*uncached* and is retried). So a no-skill-file combo is looked up once per process, while a transient
DB blip can't poison a real CMS skill for the TTL. (An earlier version cached the negative in
`parsedCache`, which conflated errors with not-found — that was reverted in favour of this.)

**Probe #2+ grounding — reverted (resolves Codex #480 P2 and the question-overlap finding).** Making
`probeTarget` prefer a named framework had two problems: (a) `buildProbeQuestion`'s `isWeakProbeTarget`
rejects a target whose tokens overlap the interviewer question (anti-re-ask filter), so a concept
named in the question fell back to a generic probe anyway; (b) the probe loop increments
`questionIndex`, so a probe of the academics index-1 roadmap resolved to academics and could fire a
framework probe on a warm-up. The depth-from-`questionIndex - probeDepth` reconstruction was *also*
unsafe (the nonsensical-retry path reuses `qIdx` with `probeDepth=1` without incrementing → mis-scored
real retries). Rather than relax the shared probe-quality filter + thread a true topic index through
the evaluate API, the `probeTarget` nudge was **reverted to its original generic form** — cleanly
removing both edges. Grounding probe #2+ (filter relaxation + client-passed topic index, ideally an
options-object refactor of the evaluate API) is a focused follow-up; probe #1 grounding stands.

### 2026-07-01 · The REAL reason probes were generic in prod: sanitize stripped good probes

**Symptom (live prod, multiple academics interviews).** Despite #480's probe-#1 grounding, probes on
screen were STILL generic — "Can you walk me through the specific example?" and warm-ups that never
named the subject. The grounding work was real but **dead on arrival**: something downstream replaced
the grounded probe with the generic fallback. (This is why the earlier PRs "felt like beating around
the bush" — they grounded the turn-router's *input* and never traced the probe's *output* path.)

**Root cause (found by mapping the call graph in gitnexus, not grep).** Both probe paths funnel
through one filter: `runInterviewLoop` → `sanitizeProbeQuestion` (probe #1, the turn-router probe) and
`buildProbeQuestion` (probe #2+) → **`isWeakProbeTarget`** → on "weak" → `fallbackProbeQuestion`
("Can you walk me through the specific example?"). `isWeakProbeTarget` rejected **any** target matching
`/^(what|why|how|which|...)\b/`. That rule was written to reject a bare TARGET PHRASE ("what", "why"),
but `sanitizeProbeQuestion` passes it the **whole turn-router question** — so every well-formed
"How does X work?" / "Walk me through how Y…" / "Why does Z…" probe was judged "weak" and stripped to
the generic fallback. Confirmed empirically: with the real prod question/answer, grounded probes like
"How does motivation differ from a need?" → stripped to "specific example".

**Fix (one choke point, both paths — `interviewUtils.ts`).** In `isWeakProbeTarget`, only reject the
interrogative prefix for SHORT fragments (`significantTokens <= 3`) — a bare "why"/"what" stays weak,
but a full interrogative question is kept. (Also moved the token-count computation above the check.)
The question/previous-probe OVERLAP rejections are unchanged (they already gate on `answerOverlap`, so
they distinguish a genuine re-ask from a deeper probe). gitnexus `impact` confirmed the blast radius:
LOW — exactly `sanitizeProbeQuestion` + `buildProbeQuestion` (both probe paths) in the Hooks module.

**Verification.** `interviewUtils.test.ts` adds regression tests: full "How does X differ from Y?" and
"Walk me through how X explains Y" probes are KEPT verbatim; a bare "Why?" still falls back. Empirically
re-ran the live-transcript inputs through `sanitizeProbeQuestion` — grounded probes now survive, weak
ones still fall back. `tsc` clean; full vitest green; build green. NOTE: the warm-up Q1 still doesn't
name the subject (it's prefetched before the intro answer) — separate, tracked in CLAUDE.md backlog.

**Follow-up (cross-depth review of this PR — two regressions the relaxation introduced, fixed in the
same PR).** A multi-agent impact review flagged that relaxing `isWeakProbeTarget` for ALL callers was
too broad — the two probe paths use the target differently:
- **Grammar regression (probe #2+, `buildProbeQuestion`).** This path TEMPLATES the target
  (`Can you tell me more about <t>?`), so a full interrogative target ("how does your feature selection
  avoid leakage", a non-compliant evaluate-answer output most likely on technical/case-study) rendered
  ungrammatically. Fix: `isWeakProbeTarget` takes `opts.templated`; `buildProbeQuestion` passes
  `{templated:true}` → rejects ALL interrogative targets (clean fallback, restoring pre-relaxation
  behavior). `sanitizeProbeQuestion` stays relaxed (it speaks the probe verbatim, so a full
  interrogative is fine). The relaxation is now correctly scoped to the verbatim path only.
- **Clarify-echo (probe #1, `sanitizeProbeQuestion`).** When a candidate asks to clarify a term, the
  turn-router is prompted to rephrase the question — parroting the question's words back at someone who
  said they didn't understand them. The rephrase has high `questionOverlap` but the clarify request
  itself re-quotes the question (`answerOverlap >= 0.5`), so the existing re-ask guard missed it. Fix:
  a NARROW clarify-echo guard — if the candidate's utterance matches `CLARIFY_REQUEST_RE` AND the probe
  re-states the question (`questionOverlap >= 0.6`), fall back. Gated on an actual clarify request so it
  cannot strip a genuine grounded probe (verified by a negative test). The deeper fix (turn-router
  defines the term instead of rephrasing) is a separate turn-router-prompt follow-up.

Verification: `interviewUtils.test.ts` adds tests for the templated rejection, the verbatim/templated
asymmetry, the clarify-echo, and the narrow-guard negative. `tsc` clean; full vitest green; build green.

**Codex review round (two more P2s on the above, both fixed).**
- **Concise grounded interrogatives were still stripped.** The first fix used `significantTokens <= 3`
  as the "bare fragment" test, but a complete short question ("why does motivation matter?", "how does
  CLV change?") also has only 3 content tokens — so it was still routed to the generic fallback (the
  original bug, for short probes). Root realization: the `< 2` content-token guard ALREADY catches true
  bare fragments by shape ("why?" → 0 tokens; "what about that?" → 1). So the verbatim path needs NO
  interrogative-by-shape rejection at all — the token-count threshold was removed; only the templated
  path (`buildProbeQuestion`) still rejects interrogatives (it can't render them grammatically).
- **Clarify regex false-positived on narrative uncertainty.** `CLARIFY_REQUEST_RE` matched mid-sentence
  ("if I don't understand user needs, I'd run interviews"; "I didn't know what was causing it, so…"),
  so a real answer's question-overlapping follow-up was wrongly stripped. Fixed: the regex is now
  ANCHORED to the start of the utterance (modulo "sorry/wait/hmm" filler) and gated by a new
  `isClarifyRequest` that also requires a SHORT utterance (≤14 words). Past-tense "didn't"/"do not
  follow [metrics]" narrative forms were dropped. Validated against both Codex false-positive examples
  (now excluded) and six real clarify phrasings (still caught). Two regression tests added.
- **Term-specific clarifications were then MISSED (over-corrected).** Anchoring narrowed the "mean"
  branches to `you|that|this`, so "what does unit economics mean?" (a real term clarification) no longer
  matched → the rephrase parroted the term back. Fixed: the `what does <…> mean` / `what's <…> mean`
  branches now accept an arbitrary 1–6 word TERM, still start-anchored + short-gated (narrative
  uncertainty stays excluded; validated). One regression test added. The remaining borderline
  (rhetorical "what does X mean? it means Y") is protected by the `questionOverlap >= 0.6` conjunct — an
  answered utterance yields a real probe, not a question-echo, so the guard doesn't fire.

### 2026-07-01 · Academics warm-up Q1 said "that subject" instead of naming it — prefetch timing

**Symptom.** The academics warm-up Q1 read "give me a roadmap of the main topics within *that subject*"
(generic) instead of "...within *consumer behaviour*" (the subject the candidate just named in their
intro answer). Reported with prod screenshots.

**Root cause.** `start()` prefetched Q1 (`generateQuestion(1)`) *during* the intro speech — i.e.
**before** `listenForAnswer` captured the intro answer. So at Q1-gen time the candidate's named
subject was not yet in the transcript. `academicGroundingDirective` is explicitly written for this:
when the subject is "NOT yet visible in the conversation above (this happens only on the very first
question you generate, before their opening answer is in context)", it deliberately falls back to
"ask them to give a quick roadmap of their strongest subject (let them state it)" — the generic
wording. The deliberate Q1 prefetch (commit d2c04c9) was the thing keeping the subject out of context.

**Fix (`useInterview.ts`, in `start`).** For academics ONLY, don't prefetch Q1 before the intro
answer. Instead prefetch it *right after* `addToTranscript('candidate', introAnswer, 0)` — which
updates `transcriptRef.current` synchronously — so `generateQuestion(1)` (which reads live
`transcriptRef.current` → `buildPreviousQA`) now sees the named subject, and the directive's MAIN
rule ("Identify that EXACT subject ... anchor the ENTIRE round to it") names it. Non-academics keep
the pre-intro prefetch (latency win; their Q1 doesn't depend on the intro answer). The flow-slot index
is unchanged — academics excludes the intro from `flowSlotIndex`, and both the old and new prefetch
run before `finalizeThread(intro)`, so Q1 stays the same warm-up roadmap slot, just subject-named.
The added latency is minimal: the new prefetch overlaps `finalizeThread` + the loop transition. If the
candidate gives no intro answer, `runInterviewLoop` falls back to generating Q1 (no subject to name).

**Blast radius (gitnexus `impact`).** `start` has 0 upstream callers (entry point via
`setTimeout(start, 200)`); LOW. `generateQuestion` / `prefetchedQuestionRef` consumers unchanged.

**Verification.** Data path traced symbol-by-symbol (addToTranscript sync ref write → generateQuestion
live transcript → buildPreviousQA includes intro for short transcripts → directive names subject when
visible). `tsc` clean; full vitest green; build green. End-to-end prod confirmation pending (auth is
prod-only — a real academics self-interview is the final check).

**Codex follow-up (silent-intro slot, P2).** The first version put the academics Q1 prefetch INSIDE
`if (introAnswer)`. If an academics candidate gives NO intro answer, that block is skipped →
`finalizeThread(intro)` bumps the completed-thread count → `runInterviewLoop(1)`'s on-demand
`generateQuestion(1)` is computed at thread-count 1, so `/api/generate-question` returns `flowHints`
from the raw count and tags the warm-up Q1 with slot 1's fundamentals probe limits/phase instead of
slot 0's warm-up hints. Fix: moved the academics prefetch OUT of the `if (introAnswer)` block to run
unconditionally (still before `finalizeThread`), so the silent path also prefetches at thread-count 0
and gets slot 0's warm-up `flowHints`. The answered path is unchanged (the intro answer is already in
`transcriptRef` before this prefetch, so Q1 still names the subject).

### 2026-07-01 · Interviews ended early with time left — make TIME (not the count) govern the loop

**Symptom.** Interviews frequently ran out of *questions* before the clock — the candidate finished all
planned questions with minutes to spare and the session ended early, wasting time that could carry more
signal.

**Root cause.** `runInterviewLoop` bounded itself by `getQuestionCount(duration)` (the ~0.5 Q/min
target: 10→6, 20→11, 30→16). That same number is ALSO the completion-scoring denominator
(`plannedQuestionCount`). So the count did two jobs — pacing the loop AND scoring completeness — and any
candidate faster than 0.5 Q/min hit the count and stopped early. The interview already has a
time-governor (`timeRemaining < 60s` → final-topic fast-path; `< 15s` → hard stop); it just never fired
because the count exhausted first.

**Fix — decouple the loop ceiling from the scoring target.** New `getQuestionCeiling(duration)`
(interviewConfig.ts, anchors 10→11 / 20→21 / 30→31, ~2× the target) is a headroom BACKSTOP; the loop's
`maxQ` now uses it, so the loop keeps asking until the existing time-governor wraps up ~60s before the
buzzer. `getQuestionCount` is UNCHANGED and still drives `plannedQuestionCount` (session create +
`getPlannedQuestionCountForFeedback`). Safe because the completion multiplier clamps at 1.0
(`completionAdjustment.ts`: `Math.max(0, Math.min(1, tapered))`) — a candidate who now answers MORE than
the target clamps to 100%, never over- or under-scored; a slow candidate scores exactly as before.
Questions beyond the ~9 flow-template slots run free-form (persona + domain + subject grounding +
anti-repeat still apply; `promptBuilder` returns an empty slot block past `totalSlots`).

**Blast radius (gitnexus).** `runInterviewLoop` LOW (1 caller, `start`). `getQuestionCount` and the
`flowMatrix` invariant #8 (`totalSlots <= getQuestionCount - 1`) untouched.

**Verification.** `interviewConfig.test.ts` adds `getQuestionCeiling` tests (ceiling strictly > target
per duration; pinned anchors; monotonic). `completionAdjustment`/`flowMatrix` suites still green. `tsc`
clean; full vitest green; build green. **PENDING — hot-path E2E:** a real 30-min interview to (a) confirm
the timer now governs (session fills the time, wraps up ~60s before end) and (b) read back
`answeredCount` vs `plannedQuestionCount` to confirm completion still reports 100% for a full session.
Bonus questions past the target COUNT toward the score (more signal) — revisit if that's unfair for the
free-form tail.

**Codex review round (two P2s on the bonus tail, both fixed).**
- **Generator numbering / premature "final question."** `/api/generate-question` derived `totalQuestions`
  and `isLastQuestion` from `getQuestionCount` (the target). With the higher ceiling the loop asks past
  the target, so the prompt could say "Generate question 17 of 16" and the target-1 index was framed as
  "the FINAL substantive question before wrap-up" while the loop continued. Fix: the route now uses
  `getQuestionCeiling` for those generation-facing numbers (never contradicts; the real wrap-up is the
  timer's `runWrapUpSequence`, not this count). `plannedQuestionCount` stays on `getQuestionCount`.
- **Stale flow hints on the free-form tail.** Past the resolved slots the route omits `flowHints`, but
  `useInterviewAPI` only SET `flowHintsRef.current` when hints were present and never cleared it — so the
  tail kept the LAST slot's hints. Closing slots carry `maxProbes:0`, so the flow-aware probe path
  suppressed follow-ups on every bonus question. Fix: `flowHintsRef.current = data.flowHints ?? null`, so
  the tail falls back to normal type-based probing (verified against both consumers — `shouldProbeOrAdvance`'s
  `if (hints)` guard and the `?? probeLimit[...]` path).
