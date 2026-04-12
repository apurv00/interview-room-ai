# Interview Pipeline — Complete Call Map (Post-Interrupt Layer)

Updated after Phases 1-6. Source: gitnexus rebuild (4,376 nodes, 9,007 edges).

**Legend:**
- `[A]` = **A**lways fires (unconditional)
- `[C]` = **C**onditional (only fires if condition met)
- `→` = calls
- `⊘` = terminates flow / exits
- `🆕` = new in interrupt layer (Phases 1-6)
- Times are measured/estimated from code constants + API latencies

---

## 1. BOOTSTRAP

```
InterviewPage (app/interview/page.tsx)
  → [A] useSpeechRecognitionAdapter()
      → [A] useDeepgramRecognition()       — returns { startListening, stopListening, warmUp,
                                              setOnInterrupt, setSuppressInterrupt,
                                              🆕 getAndClearInterruptAccum }
  → [A] useInterview(options)              :86
      → [A] useAvatarSpeech()              — returns { avatarSpeak, cancelTTS, 🆕 softCancelTTS,
                                              playAck, cancelAck, prefetchTTS }
          → [A] useStreamingAudio()        — returns { streamAndPlay, cancel, 🆕 softCancel }
      → [A] useInterviewAPI()              — returns { generateQuestion, evaluateAnswer,
                                              callTurnRouter (🆕 + interruptContext param) }
      → [A] 🆕 interruptContextRef = null
      → [A] 🆕 deferredTopicsRef = []
```

## 2. SESSION CREATION (parallel)

```
useEffect (config + voicesReady)           :1542
  → [A] interviewAbortRef = new AbortController
  → [A] createDbSession(config)            — POST /api/interviews
      → [C] limitReached                   → ⊘ abort + ENDED + redirect
      → [C] sessionId                      → store in sessionIdRef
```

## 3. TIMER (every 1s, independent)

```
useEffect (1s tick)                        :372
  → [A] timeRemaining -= 1
  → [C] t=90  → coaching tip "running low"
  → [C] t=30  → coaching tip "last 30 seconds"
  → [C] t=0 && phase=LISTENING → 15s grace → finishInterview() ⊘
  → [C] t=0 && phase≠LISTENING → finishInterview() ⊘
```

## 4. MAIN LOOP — `runInterviewLoop(startingQIndex)` :1002

```
while (qIdx < maxQ)
│
│ → [A] checkAbort()                       — throws if aborted ⊘
│ → [C] isInterviewOver()                  — return ⊘
│ → [C] timeRemaining < 15 && qIdx > 0    — break ⊘
│
│ ── GENERATE QUESTION ──
│ → [A] transitionTo('ASK_QUESTION')
│ → [C] prefetchedQuestionRef             — use prefetched (0ms)
│ → [C] !prefetched                       — generateQuestion() → POST /api/generate-question
│ → [A] setCurrentQuestion + addToTranscript
│
│ ── AVATAR SPEAKS QUESTION ──
│ → [C] qIdx >= 2 && random < 0.4         — prepend transition filler
│ → [C] warmUpListening?.()               — pre-warm Deepgram WebSocket
│ → [A] avatarSpeak(question, emotion)     🆕 returns { interrupted, interruptContext }
│     ├─ [A] interruptedRef = false; interruptContextRef = null
│     ├─ [A] setSuppressInterrupt(true)
│     ├─ [A] setOnInterrupt(handler)       — arms interrupt detection
│     ├─ [A] rawAvatarSpeak(text)          — fetch /api/tts/stream → streaming playback
│     │   └─ onAudioStart → setSuppressInterrupt(false) → interrupts now armed
│     ├─ 🆕 [C] CANDIDATE INTERRUPT (≥3 words during TTS)
│     │   ├─ interruptedRef = true
│     │   ├─ 🆕 interruptContextRef = { utterance, interruptSpeech, phase, qIdx }
│     │   ├─ 🆕 interruptSpeech = getAndClearInterruptAccum()
│     │   ├─ 🆕 softCancelTTS()            — drain current buffer (~1-2s), not hard kill
│     │   ├─ coachingAbortRef.abort()
│     │   └─ avatarSpeak resolves with { interrupted: true, interruptContext }
│     ├─ [A] setOnInterrupt(null)
│     └─ [A] setSuppressInterrupt(false)
│
│ → [C] isInterviewOver() after TTS        — return ⊘
│
│ ── CONVERSATIONAL LISTEN LOOP ──         while (turns <= 5)
│ │
│ │ → [A] listenForAnswer(true, 30000)
│ │     ├─ 🆕 [C] interruptContextRef?.interruptSpeech → seed liveAnswer + prepend to result
│ │     ├─ [A] startListening(onComplete)
│ │     │   ├─ [C] warm WebSocket ready    — instant start
│ │     │   └─ [C] connectFresh()          — token fetch + WS connect (2-5s)
│ │     │
│ │     │ ── DEEPGRAM MESSAGE LOOP ──
│ │     │ → [C] is_final + transcript
│ │     │     ├─ [A] cancel grace timer (user speaking)
│ │     │     ├─ [A] finalTextRef += transcript
│ │     │     └─ [C] ends with '?' && <20 words → finishRecognition() ⊘
│ │     │ → [C] UtteranceEnd (2500ms silence)
│ │     │     └─ grace timer: <15 words → 2500ms, ≥15 words → 1500ms
│ │     │         → finishRecognition() ⊘
│ │     │
│ │     ├─ INACTIVITY TIMEOUT (30s, speech-aware)
│ │     │   → [C] liveAnswer grew → reschedule
│ │     │   → [C] liveAnswer unchanged → stopListening() ⊘
│ │     └─ HARD CAP (180s) → stopListening() ⊘
│ │
│ │ ── INTENT CLASSIFICATION ──
│ │ → [C] !speech → nudge / skip / continue
│ │ → [A] classifyIntent(speech)
│ │ → [C] 'answer'
│ │     → [C] "I don't know" (1st → probe, 2nd → advance)
│ │     → [A] answer = speech; break
│ │ → [C] 'distress'      — comfort, don't count turn, continue
│ │ → [C] 'correction'    — let restart, continue
│ │ → [C] 'repetition'    — re-read question, continue
│ │ → [C] 'timecheck'     — report time, continue
│ │ → [C] 'hint'          — scaffold hint, count turn, continue
│ │ → [C] 'challenge_question' — reframe, continue
│ │ → [C] 'gaming'        — deflect, continue
│ │ → [C] 'clarification' — rephrase, count turn, continue
│ │ → [C] 'redirect'      — guide back, count turn, continue
│ │ → [C] 'thinking'      — thinking mode, continue
│ │ → [C] 'question'      — AI answers via LLM, continue
│ │ end while
│
│ → [C] !answer → finalizeThread + skip ⊘
│
│ ── INTENTIONAL SILENCE ──
│ → [C] maybeIntentionalSilence(answer)
│     → [C] skip conditions (probe, time<90, qIdx=0, struggling)
│     → [C] <15 words: 2500ms window, 15-30: 35% × 2000ms, 30+: 1500ms
│
│ ── FAST-PATH EVALUATION ──
│ → [A] addToTranscript('candidate', finalAnswer)
│ → [A] checkAbort()
│ → [C] shouldPrefetch → generateQuestion(nextQIdx) in parallel
│ → [A] evaluateMainAnswer(q, answer, qIdx)
│     ├─ [A] transitionTo('PROCESSING')
│     ├─ [C] shouldAck (every 3rd) → 1500ms → avatarSpeak("Got it")
│     ├─ [A] Promise.all([callTurnRouter(~400ms), nextQ])
│     ├─ [A] pendingEvalRef = evaluateAnswer(...) — BACKGROUND
│     │   ├─ POST /api/evaluate-answer (~1-3s)
│     │   ├─ .then → evaluationsRef.push + computePerformanceSignal + coaching tip
│     │   └─ .catch → push fallback eval (60/55/55/60)
│     └─ [A] return { routerResult, prefetchedQ }
│
│ ── POST-EVAL BRANCHES ──
│ → [C] routerResult.isNonsensical → re-ask + listen + evaluateAndCoach (BLOCKING)
│ → [C] routerResult.isPivot       → re-anchor + listen + evaluateAndCoach (BLOCKING)
│
│ ── PROBE LOOP ──
│ limits: case-study=5, technical=3, behavioral/screening=2
│ while (action='probe' && depth < MAX)
│ │ → [A] avatarSpeak(probeQ)
│ │ → [A] listenForAnswer(30000)
│ │ → [C] !probeAnswer → break ⊘
│ │ → [A] evaluateAndCoach(probeQ, probeAnswer) — BLOCKING eval
│ │ → [A] shouldProbeOrAdvance(eval)
│ │ → [A] buildProbeQuestion(type, target)
│ │ end while
│
│ → [A] finalizeThread(topicQuestion)
│ → [A] qIdx++
│
│ ── 🆕 DEFERRED TOPIC INJECTION ──
│ → [C] deferredTopicsRef.length > 0 && timeRemaining > 90 && qIdx < maxQ
│     → [A] avatarSpeak("Earlier you mentioned...")
│     → [A] listenForAnswer(30000)
│     → [C] deferredAnswer → evaluateAndCoach
│     → [A] qIdx++
│
end while
```

## 5. 🆕 DEFERRED TOPICS — WRAP-UP SURFACE

```
→ [C] deferredTopicsRef.length > 0
    → for each topic (max 2)
        → [A] avatarSpeak("Before we wrap up — you raised...")
        → [A] listenForAnswer(30000)
        → [C] topicAnswer → addToTranscript
```

## 6. WRAP-UP

```
→ [A] transitionTo('WRAP_UP')
→ [A] avatarSpeak(WRAP_UP_LINE)
→ [A] listenForAnswer(15000)
→ [C] wrapUpAnswer > 5 chars → avatarSpeak(closing)
→ [C] !wrapUpAnswer → avatarSpeak(noQuestionsClose)
→ [A] finishInterview()
```

## 7. FINISH INTERVIEW — `finishInterview()` :780

```
→ [A] interviewAbortRef.abort()
→ [A] coachingAbortRef.abort()
→ [A] cancelTTS()                          — HARD stop (not soft)
→ [A] window.speechSynthesis.cancel()
→ [A] stopListening()
→ [A] transitionTo('SCORING')
→ [C] pendingEvalRef → await (3s timeout)
→ [A] save localStorage
→ [C] sessionId
    → [A] persistSession (10s timeout)
    → [C] evals > 0 → POST /api/learn/stats (fire-and-forget)
    → [C] multimodal → POST /api/analysis/start (fire-and-forget)
    → [C] config → POST /api/generate-feedback (fire-and-forget)
→ [A] router.push(/feedback/{sid})
```

## 8. ALL TERMINATION PATHS

| # | Trigger | Scope | Type |
|---|---------|-------|------|
| 1 | User clicks End Interview | Whole interview | `[C]` |
| 2 | Timer=0, not LISTENING | Whole interview | `[C]` |
| 3 | Timer=0, LISTENING + 15s grace | Whole interview | `[C]` |
| 4 | Usage limit (createDbSession) | Whole interview | `[C]` |
| 5 | checkAbort() throws | Whole interview | `[C]` |
| 6 | isInterviewOver() guard | Whole interview | `[C]` ×8 sites |
| 7 | qIdx >= maxQ | Whole interview | `[A]` natural end |
| 8 | MAX_ANSWER_MS (180s) | Per-answer | `[C]` |
| 9 | Inactivity timeout (30s, speech-aware) | Per-answer | `[C]` |
| 10 | UtteranceEnd + grace (4-5s) | Per-answer | `[C]` |
| 11 | Question detection (? + <20 words) | Per-answer | `[C]` |
| 12 | WebSocket disconnect + text captured | Per-answer | `[C]` |
| 13 | Max WebSocket reconnects (2) | Per-answer | `[C]` |
| 14 | Browser offline | Per-answer | `[C]` |
| 15 | Audio capture failure | Per-answer | `[C]` |
| 16 | Token fetch failure (30s fallback) | Per-answer | `[C]` |
| 17 | 🆕 softCancelTTS on interrupt | Per-TTS | `[C]` (drains buffer) |

## 9. 🆕 INTERRUPT DECISION FLOW

```
Candidate speaks ≥3 words during AI TTS
  │
  ├─ Deepgram attachMessageHandler :308
  │   accumulates words in interruptAccumRef
  │   → wordCount >= 3 → fires onInterruptRef.current()
  │
  ├─ onInterrupt handler (useInterview.ts :137)
  │   ├─ interruptedRef = true
  │   ├─ 🆕 interruptContextRef = {
  │   │     interruptedUtterance: full AI text,
  │   │     interruptSpeech: getAndClearInterruptAccum(),
  │   │     phase, questionIndex
  │   │   }
  │   ├─ 🆕 softCancelTTS() — drain current audio buffer
  │   ├─ coachingAbortRef.abort()
  │   └─ setCoachingTip(null)
  │
  ├─ avatarSpeak resolves with { interrupted: true, interruptContext }
  │
  ├─ 🆕 listenForAnswer called next
  │   └─ interruptPrefix = interruptContextRef.interruptSpeech
  │       → seeded into liveAnswer + prepended to onComplete result
  │
  └─ 🆕 Turn-router can be called with interruptContext
      → AI decides: finish_then_address / abort_and_pivot /
        acknowledge_defer / absorbed
      → [C] acknowledge_defer → push to deferredTopicsRef
```
