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
