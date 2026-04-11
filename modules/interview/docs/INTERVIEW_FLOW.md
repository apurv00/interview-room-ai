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

_Follow-up considerations (not fixed in this commit):_ contract test
for `/api/tts/stream` that asserts `Transfer-Encoding: chunked` and
first chunk arrives before full body; making `test:pipeline`
PR-blocking in CI; nightly scripted interview against real APIs.
