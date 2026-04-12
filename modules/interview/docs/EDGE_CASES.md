# Interview Pipeline — Edge Case Catalog

Timing constants extracted from code. Mocked API latencies based on production observations.

## Timing Constants (from code)

| Constant | Value | Source |
|----------|-------|--------|
| `utterance_end_ms` | 2500ms | useDeepgramRecognition.ts:425 |
| Grace period (<15 words) | 2500ms | useDeepgramRecognition.ts:405 |
| Grace period (>=15 words) | 1500ms | useDeepgramRecognition.ts:405 |
| Interrupt threshold | >=3 words | useDeepgramRecognition.ts:328 |
| Interrupt accum reset | 2000ms | useDeepgramRecognition.ts:322 |
| `timeoutMs` (inactivity) | 30000ms | useInterview.ts:465 |
| `MAX_ANSWER_MS` | 180000ms | useInterview.ts:461 |
| Emotion check interval | 3000ms | useInterview.ts:479 |
| Ack delay | 1500ms | useInterview.ts:722 |
| Coaching tip dismiss (short) | 2000ms | useInterview.ts (deriveCoachingTip) |
| Coaching tip dismiss (long) | 6000ms | useInterview.ts (deriveCoachingTip) |
| Timer milestone 90s | coaching tip | useInterview.ts:382 |
| Timer milestone 30s | coaching tip | useInterview.ts:387 |
| Timer=0 grace (LISTENING) | 15000ms | useInterview.ts:396 |
| Nudge cooldown | 120000ms | useInterview.ts:1078 |
| evaluateAnswer timeout | 5000ms | useInterviewAPI.ts:115 |
| pendingEval await timeout | 3000ms | useInterview.ts:799 |
| persistSession timeout | 10000ms | useInterview.ts:834 |
| WS reconnect delay | 800ms * attempt | useDeepgramRecognition.ts:473 |
| WS max reconnects | 2 | useDeepgramRecognition.ts:459 |
| Token fetch retry delay | 1500ms | useDeepgramRecognition.ts:267 |
| Token fetch fallback | 30000ms | useDeepgramRecognition.ts:191 |
| captureReady safety | 1500ms | useDeepgramRecognition.ts:135 |
| Suppress interrupt clear | on `setSuppressInterrupt(false)` | useInterview.ts:162 |
| Wrap-up listen timeout | 15000ms | useInterview.ts:1514 |
| Deferred topic time gate | >90s remaining | useInterview.ts:1462 |

## Mocked API Latencies

| API | Cold (no cache) | Warm (cached) | Timeout |
|-----|-----------------|---------------|---------|
| POST /api/tts/stream | 400-600ms TTFB | 50ms (R2 cache) | — |
| POST /api/tts (buffered) | 300-500ms | 10ms (R2 cache) | — |
| POST /api/generate-question | 1000-2000ms | — | — |
| POST /api/evaluate-answer | 1000-3000ms | — | 5000ms |
| POST /api/turn-router | 300-500ms | — | — |
| POST /api/transcribe/token | 100-200ms | 0ms (cached) | — |
| Deepgram WS connect | 200-400ms | 0ms (warm-up) | — |
| POST /api/interviews (create) | 500-1000ms | — | — |
| PATCH /api/interviews/[id] | 500-1500ms | — | 10000ms |
| POST /api/generate-feedback | 3000-8000ms | — | — |

---

## Edge Case Groups

### Group 1: Startup + First Word Latency

| # | Scenario | Timeline | Expected | Risk |
|---|----------|----------|----------|------|
| 1.1 | Happy path: warm WS, cached TTS | config ready → createDbSession(500ms) ‖ start() → intro TTS(50ms cache) → first word at **~550ms** | Intro text visible + audio <=600ms | LOW |
| 1.2 | Cold start: no WS warm-up, no TTS cache | config ready → createDbSession(1000ms) → intro TTS stream(500ms TTFB) → first word at **~1500ms** | Acceptable, <2s | LOW |
| 1.3 | Deepgram token fetch fails on first call | Token fetch(200ms) → fail → retry(1500ms) → fail → connectFresh fallback(30s timer) | 30s silent wait. User sees LISTENING but nothing happens. | HIGH |
| 1.4 | createDbSession returns limitReached | createDbSession(500ms) → limitReached=true → abort + ENDED + redirect(4s) | User sees "limit reached" msg, redirected home. No interview starts. | LOW |
| 1.5 | config available but voicesReady=false | useEffect guard: `if (!config \|\| !voicesReady) return` → interview never starts | User stuck on lobby. No error. Silent failure. | MEDIUM |

### Group 2: Answer Duration + Timeout Behavior

| # | Scenario | Timeline | Expected | Risk |
|---|----------|----------|----------|------|
| 2.1 | User answers in 10s (normal) | Speech starts → Deepgram transcribes → UtteranceEnd(2.5s silence) → grace(1.5s) → finishRecognition at **~14s** | Clean answer captured. | LOW |
| 2.2 | User answers for 60s continuously | Speech → inactivity timeout checks every 30s → liveAnswer growing → reschedules each time → UtteranceEnd only when user stops | Never cut off mid-speech. Terminates 4-5s after last word. | LOW |
| 2.3 | User answers for 180s (MAX_ANSWER_MS) | Speech → MAX_ANSWER_MS fires → stopListening() → resolves with liveAnswerRef | Hard cap fires. `liveAnswerRef.current` has full text. | LOW |
| 2.4 | User answers for 181s | Same as 2.3 — MAX_ANSWER_MS fires at 180s, captures text | Last ~1s of speech lost. Acceptable tradeoff. | LOW |
| 2.5 | User never speaks (total silence) | listenForAnswer → 30s inactivity → liveAnswer empty (length=0, unchanged) → stopListening → onComplete text='' → resolve('') | Empty speech. Conversation loop nudges "take your time". | LOW |
| 2.6 | User speaks 3 words then goes silent for 30s | Speech(3 words) → UtteranceEnd(2.5s) → grace(2.5s, <15 words) → finishRecognition at **~5s**. Inactivity 30s never fires (recognition finished first). | Deepgram's 5s silence detection wins the race. 3 words captured. | LOW |
| 2.7 | User speaks 3 words, pauses 2s, speaks 3 more, stops | Speech → UtteranceEnd(2.5s) → grace starts(2.5s) → new speech arrives → grace cancelled → continues → UtteranceEnd(2.5s) → grace(2.5s) → finish | Both phrases captured. Grace cancellation works. | LOW |
| 2.8 | **NEW** Inactivity timeout with interrupt prefix | Interrupt happened, interruptPrefix="wait I think" → listenForAnswer seeds liveAnswer → 30s inactivity timer starts → liveAnswer.length=14 (prefix) → never grows → timeout fires → stopListening → resolve("wait I think") | Interrupt prefix returned as the answer even though user never spoke more. **Potential issue**: classifyIntent gets "wait I think" — classified as 'answer' (too short for other intents). | MEDIUM |

### Group 3: Silence Detection + Abrupt Stop

| # | Scenario | Timeline | Expected | Risk |
|---|----------|----------|----------|------|
| 3.1 | User speaks then mic cut (hardware) | Speech → mic track ends → Deepgram WS receives no more audio → UtteranceEnd(2.5s) → grace → finish | Text captured up to mic cut. Normal flow. | LOW |
| 3.2 | User ends sentence with "?" (<20 words) | Speech "Can I ask about the team?" → is_final with "?" + 7 words → question detection → finishRecognition() immediately | No grace period. Instant finish. Classified as 'question' intent. | LOW |
| 3.3 | User says "?" in a long answer (>20 words) | "...we increased revenue by 30%, right?" → '?' detected but wordCount=25 (>=20) → question detection SKIPPED → normal UtteranceEnd flow | Correct — long answers with embedded questions are not terminated early. | LOW |
| 3.4 | Deepgram WS disconnects mid-answer (text captured) | WS close event → handleDisconnect → maybeReconnectOrFinish → finalText.length > 0 → finishRecognition() immediately | Text captured so far is returned. No reconnect attempted. | MEDIUM |
| 3.5 | Deepgram WS disconnects mid-answer (no text yet) | WS close → handleDisconnect → finalText empty → reconnect attempt #1 (800ms) → connect → resume capture | Reconnects. User doesn't notice if <1s gap. | MEDIUM |
| 3.6 | Deepgram WS disconnects twice (no text) | Attempt #1 (800ms) → fail → attempt #2 (1600ms) → fail → max reconnects → finishRecognition → empty text | Empty answer. Conversation loop nudges. 2.4s lost. | MEDIUM |
| 3.7 | Browser tab backgrounded during answer | Browser may throttle timers. Deepgram WS stays open (not affected by tab throttle). Audio capture may pause if `AudioContext` is suspended. | **Risk**: `AudioContext.state='suspended'` → no audio sent to Deepgram → UtteranceEnd fires → answer terminated. User returns to foreground and sees answer was cut. | HIGH |

### Group 4: Interrupt Scenarios

| # | Scenario | Timeline | Expected | Risk |
|---|----------|----------|----------|------|
| 4.1 | Candidate interrupts AI mid-question (3 words) | TTS playing → Deepgram detects 3 words → onInterrupt fires → softCancelTTS → buffer drains(~1-2s) → avatarSpeak resolves {interrupted:true} → listenForAnswer with interruptPrefix | AI finishes sentence, then listens. Interrupt words prepended. | LOW |
| 4.2 | Candidate says 2 words during TTS (below threshold) | TTS playing → Deepgram accumulates 2 words → threshold not met → interrupt NOT fired → TTS completes normally | Correct suppression. No false interrupt. | LOW |
| 4.3 | Candidate says 1 word, 2.5s silence, 1 word during TTS | Word1 → accum timer starts(2s) → 2.5s silence → timer fires → accum reset → Word2 → accum=1 word → threshold not met | Correct: stale fragment reset prevents false interrupt. | LOW |
| 4.4 | Candidate says 2 words, 1s pause, 2 words during TTS | Word1+2 → accum=2 → 1s pause (timer not fired, 2s timeout) → Word3+4 → accum=4 → threshold met → interrupt fires | Correct: multi-packet accumulation catches real interrupts. | LOW |
| 4.5 | **NEW** softCancelTTS during cached/buffered playback (playBlob) | Interrupt fires → softCancelTTS → softCancelStream() (no-op, stream not active) → browser speech cancelled → but playBlob's Audio element continues playing! | **ISSUE**: `softCancelTTS` doesn't stop `playBlob`. The `currentAudioRef` audio element keeps playing. `softCancelTTS` only calls `softCancelStream()` which only affects MediaSource streaming. For buffered playback, the audio finishes the entire clip, not just the current sentence. | HIGH |
| 4.6 | **NEW** Interrupt during browser speechSynthesis fallback | Interrupt fires → softCancelTTS → `window.speechSynthesis.cancel()` → speech hard-stops (no sentence-level control) | `speechSynthesis.cancel()` is always a hard stop. No soft-stop available. Acceptable — fallback is rare. | LOW |
| 4.7 | **NEW** interruptPrefix is stale from prior question | Q1: interrupt happened, interruptContextRef set → Q1 answer captured normally → Q2: avatarSpeak resets interruptContextRef=null (line 131) → listenForAnswer checks interruptContextRef → null → no prefix | Correct: `avatarSpeak` clears `interruptContextRef` on every call. No stale prefix. | LOW |
| 4.8 | **NEW** Double interrupt (candidate speaks ≥3 words twice during one TTS) | First interrupt fires → onInterruptRef.current() called → interruptAccumRef cleared → onInterrupt set to null (after softCancel resolves?) — NO, softCancel is async but setOnInterrupt(null) is at line 165, AFTER avatarSpeak resolves | **ISSUE**: Between softCancel firing and avatarSpeak resolving (~1-2s buffer drain), the onInterrupt handler is still armed. If candidate speaks another 3 words during drain, onInterrupt fires AGAIN. Second fire: `interruptedRef` already true (no-op), `getAndClearInterruptAccum()` returns new words (overwrites interruptSpeech), `softCancelTTS()` called again (no-op). Mostly harmless but interruptSpeech gets overwritten. | MEDIUM |

### Group 5: Timer Expiry + finishInterview Races

| # | Scenario | Timeline | Expected | Risk |
|---|----------|----------|----------|------|
| 5.1 | Timer=0 while user is in LISTENING phase | Timer tick → t=0 → phase=LISTENING → coaching tip → 15s grace setTimeout → if still not SCORING after 15s → finishInterview() | User gets 15s to finish thought. | LOW |
| 5.2 | Timer=0 while AI is speaking (ASK_QUESTION phase) | Timer tick → t=0 → phase=ASK_QUESTION (≠LISTENING) → finishInterview() immediately | AI speech hard-cancelled. No grace period. User hears AI cut off mid-sentence. | MEDIUM |
| 5.3 | Timer=0 during PROCESSING phase | Timer tick → t=0 → phase=PROCESSING → finishInterview() immediately | Evaluation in progress. `pendingEvalRef.current` awaited (3s timeout). | LOW |
| 5.4 | User clicks End during pendingEval await | finishInterview → abort → cancelTTS → stopListening → SCORING → await pendingEvalRef(3s) → abort signal causes eval fetch to fail → catch pushes fallback → pendingEval resolves → evaluationsRef has fallback scores | Fallback scores for last answer. Acceptable. | LOW |
| 5.5 | **NEW** finishInterview called twice rapidly | First call: interviewAbortRef.abort() → SCORING. Second call: already in SCORING phase. BUT no guard at top of finishInterview! Both proceed. Double persistSession, double feedback generation, double navigation. | **ISSUE**: `finishInterview` has no idempotency guard. `isInterviewOver()` is checked at call sites in the loop, but the timer's `setTimeout` and the user's End button can both fire `finishInterview` independently. | HIGH |
| 5.6 | **NEW** Timer=0 grace fires AFTER user already finished | User finishes answer at t=2s remaining → evaluation → probe → at t=0 timer fires → phase=PROCESSING (from probe eval) → finishInterview called → interrupts probe flow | Interview ends mid-probe. Probe evaluation lost. Last eval may be incomplete. `pendingEvalRef` catches this (3s await). | MEDIUM |

### Group 6: Deferred Topics + Wrap-Up

| # | Scenario | Timeline | Expected | Risk |
|---|----------|----------|----------|------|
| 6.1 | One deferred topic, time > 90s | Between questions → deferredTopicsRef.length=1 → timeRemaining=120 → AI speaks bridge → listens → evaluates → qIdx++ | Topic surfaced and evaluated. | LOW |
| 6.2 | Deferred topic but time <= 90s | deferredTopicsRef.length=1 → timeRemaining=60 → condition fails → topic stays in ref → checked again during wrap-up surface | Topic surfaces during wrap-up (no eval, just transcript). | LOW |
| 6.3 | Deferred topic but qIdx >= maxQ | deferredTopicsRef.length=1 → qIdx=maxQ → `qIdx < maxQ` fails → skipped → wrap-up surface handles it | Topic surfaces during wrap-up. | LOW |
| 6.4 | **NEW** Deferred topic avatarSpeak interrupted | AI says "Earlier you mentioned..." → candidate interrupts → avatarSpeak returns {interrupted:true} → BUT no interrupt handling after this avatarSpeak! Code just proceeds to listenForAnswer. | **ISSUE**: The deferred topic bridge at line 1469 doesn't check `interrupted`. If interrupted, `listenForAnswer` starts with interruptPrefix, which may contain words unrelated to the deferred topic. The answer gets evaluated against the bridge question but the candidate was responding to something else. | MEDIUM |
| 6.5 | 3 deferred topics accumulated | Topics pushed over multiple interrupts. Between-question injection pops one (line 1463 `shift()`). Wrap-up `splice(0,2)` takes up to 2 more. Total: all 3 surfaced. | All surfaced. Max 1 between questions per cycle, max 2 during wrap-up. | LOW |
| 6.6 | **NEW** Wrap-up deferred topic but isInterviewOver mid-loop | First deferred topic during wrap-up → avatarSpeak → isInterviewOver() → false → listenForAnswer → answer → second topic → timer fires during this → isInterviewOver() → true → break | Second topic cut short but first is captured. Acceptable. | LOW |

### Group 7: WebSocket + Network Failures

| # | Scenario | Timeline | Expected | Risk |
|---|----------|----------|----------|------|
| 7.1 | Network goes offline mid-answer | navigator.onLine=false → next WS connect attempt → `connectWebSocket` checks → finishRecognition() | Answer captured so far returned. | MEDIUM |
| 7.2 | getUserMedia denied | startAudioCapture → getUserMedia → error → finishRecognition → empty text | Conversation loop nudges. No crash. | LOW |
| 7.3 | /api/evaluate-answer returns 500 | evaluateAnswer fetch → 500 → `!res.ok` → fallback scores (60/55/55/60) returned | Evaluation degraded but not lost. Pipeline continues. | LOW |
| 7.4 | /api/turn-router returns 500 | callTurnRouter fetch → catch → TURN_ROUTER_FALLBACK {nextAction:'advance'} | AI advances to next question. No probe. | LOW |
| 7.5 | /api/generate-question hangs for 10s | generateQuestion fetch → eventual response → question returned late → TTS starts | User sees "Preparing next question..." for 10s. No crash. | MEDIUM |
| 7.6 | /api/tts/stream returns non-200 | avatarSpeak → streaming fetch → !res.ok → falls through to buffered → if also fails → browser speechSynthesis | Graceful degradation chain. Three fallback levels. | LOW |

---

## Issues Found — Priority

| ID | Description | Severity | Group |
|----|-------------|----------|-------|
| **E-4.5** | `softCancelTTS` doesn't stop `playBlob` buffered audio — only affects MediaSource streaming | HIGH | 4 |
| **E-5.5** | `finishInterview` has no idempotency guard — can be called twice by timer + End button | HIGH | 5 |
| **E-1.3** | Token fetch double-failure → 30s silent wait with no user feedback | HIGH | 1 |
| **E-3.7** | Browser tab backgrounded → AudioContext suspended → answer terminated | HIGH | 3 |
| **E-2.8** | Interrupt prefix returned as full answer when user never continues speaking | MEDIUM | 2 |
| **E-4.8** | Double interrupt overwrites interruptSpeech during buffer drain | MEDIUM | 4 |
| **E-5.6** | Timer=0 fires during probe evaluation, interrupts mid-flow | MEDIUM | 5 |
| **E-6.4** | Deferred topic bridge avatarSpeak not checked for interrupt | MEDIUM | 6 |
| **E-5.2** | Timer=0 during ASK_QUESTION — no grace period, AI cut mid-sentence | MEDIUM | 5 |
