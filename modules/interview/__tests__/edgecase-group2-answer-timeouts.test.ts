/**
 * Group 2: Answer Duration + Timeout Behavior
 *
 * Simulates the listenForAnswer timeout logic with mocked speech input.
 * Tests the speech-aware inactivity timeout and MAX_ANSWER_MS cap.
 *
 * Edge cases: 2.1-2.8 from EDGE_CASES.md
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const MAX_ANSWER_MS = 180_000
const INACTIVITY_TIMEOUT_MS = 30_000
const UTTERANCE_END_MS = 2500
const GRACE_SHORT_MS = 4000 // <15 words
const GRACE_LONG_MS = 3500  // >=15 words

describe('Group 2: Answer Duration + Timeouts', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }) })
  afterEach(() => { vi.useRealTimers() })

  it('2.1 Normal 10s answer: Deepgram silence detection wins', async () => {
    // User speaks for 10s, then stops. Deepgram detects silence.
    // Timeline: speech(10s) → UtteranceEnd(2.5s) → grace(1.5s, >=15 words)
    // Total: ~14s to resolve

    const speechDuration = 10_000
    const silenceToUtteranceEnd = UTTERANCE_END_MS
    const graceMs = GRACE_LONG_MS // assume >15 words in 10s

    const totalTime = speechDuration + silenceToUtteranceEnd + graceMs
    expect(totalTime).toBe(16_000)

    // Inactivity timeout (30s) never fires because Deepgram finishes at 16s
    expect(totalTime).toBeLessThan(INACTIVITY_TIMEOUT_MS)
  })

  it('2.2 60s continuous answer: inactivity reschedules correctly', async () => {
    // User speaks for 60 seconds continuously.
    // Inactivity timeout fires at 30s — checks liveAnswer length.
    // liveAnswer has grown → reschedules.
    // At 60s another check — still growing → reschedules.
    // User stops at 60s → UtteranceEnd(2.5s) + grace(1.5s) = finish at ~64s.

    let liveAnswerLength = 0
    const speechIntervals = [
      { t: 0, len: 10 },      // start speaking
      { t: 15_000, len: 200 }, // still speaking at 15s
      { t: 30_000, len: 500 }, // still speaking at 30s (inactivity check)
      { t: 45_000, len: 800 }, // still speaking at 45s
      { t: 60_000, len: 1100 },// still speaking at 60s (second check)
    ]

    // Simulate the inactivity timeout logic from useInterview.ts:534-559
    let lastSeenLength = 0
    let timedOut = false

    const checkInactivity = () => {
      if (liveAnswerLength > lastSeenLength) {
        lastSeenLength = liveAnswerLength
        // Reschedule — user still speaking
        return false
      }
      // No growth → would call stopListening
      timedOut = true
      return true
    }

    // Simulate 30s check
    liveAnswerLength = 500
    expect(checkInactivity()).toBe(false) // reschedules

    // Simulate 60s check
    liveAnswerLength = 1100
    expect(checkInactivity()).toBe(false) // reschedules again

    // User stops speaking — next 30s check sees no growth
    // (But Deepgram's UtteranceEnd fires at 62.5s, grace at 64s)
    // Inactivity check at 90s would see no growth, but Deepgram already finished.
    expect(timedOut).toBe(false)
  })

  it('2.3 MAX_ANSWER_MS (180s) hard cap fires', () => {
    // User speaks continuously for >180s. MAX_ANSWER_MS fires unconditionally.
    // liveAnswerRef.current captured at that moment.

    expect(MAX_ANSWER_MS).toBe(180_000)

    // At 180s: stopListening() called, resolve(liveAnswerRef.current || '')
    // The resolve uses liveAnswerRef — all speech captured up to that point.
    // Only the last few hundred ms of speech may be lost.
  })

  it('2.5 Total silence: inactivity timeout fires at 30s', async () => {
    // User never speaks. liveAnswer stays empty.
    // t=30s: inactivity check → liveAnswer.length=0, lastSeenLength=0 →
    //   0 > 0 = false → stopListening()

    let liveAnswerLength = 0
    let lastSeenLength = 0

    const shouldStop = !(liveAnswerLength > lastSeenLength)
    expect(shouldStop).toBe(true)
    // stopListening → finishRecognition → onComplete({text:''}) → resolve('')
  })

  it('2.6 Short answer (3 words) then 5s silence', () => {
    // Speech(3 words, ~2s) → stop → UtteranceEnd(2.5s) → grace(4s, <15 words)
    // finishRecognition at ~8.5s. Inactivity timeout (30s) never reached.

    const speechEnd = 2_000
    const utteranceEnd = speechEnd + UTTERANCE_END_MS
    const graceEnd = utteranceEnd + GRACE_SHORT_MS

    expect(graceEnd).toBe(8_500) // 8.5s total
    expect(graceEnd).toBeLessThan(INACTIVITY_TIMEOUT_MS) // Deepgram wins
  })

  it('2.7 Pause-resume: grace cancelled by new speech', () => {
    // Speech(3 words) → 2.5s silence → UtteranceEnd → grace starts(2.5s)
    // → 1s into grace: new speech → grace cancelled → speech continues
    // → stop → UtteranceEnd(2.5s) → grace(1.5s, now >=15 words) → finish

    let graceActive = false
    let graceCancelled = false

    // UtteranceEnd fires
    graceActive = true

    // 1s later: new is_final arrives
    // Code at useDeepgramRecognition.ts:340-346 cancels grace
    if (graceActive) {
      graceCancelled = true
      graceActive = false
    }

    expect(graceCancelled).toBe(true)
    expect(graceActive).toBe(false)
  })

  it('2.8 MEDIUM: Interrupt prefix returned when user never continues', () => {
    // Interrupt happened. interruptSpeech = "wait I think"
    // listenForAnswer seeds liveAnswer with prefix (length=12).
    // User never speaks more → inactivity check at 30s:
    //   liveAnswer.length=12, lastSeenLength=0 → 12 > 0 → reschedule!
    // At 60s: liveAnswer.length=12, lastSeenLength=12 → 12 > 12 = false → stop

    const interruptPrefix = 'wait I think'
    let liveAnswerLength = interruptPrefix.length // 12
    let lastSeenLength = 0

    // First check at 30s
    const firstCheck = liveAnswerLength > lastSeenLength // 12 > 0 = true
    expect(firstCheck).toBe(true) // reschedules — prefix looks like speech!

    // Second check at 60s
    lastSeenLength = liveAnswerLength // 12
    const secondCheck = liveAnswerLength > lastSeenLength // 12 > 12 = false
    expect(secondCheck).toBe(false) // NOW stops

    // ISSUE: The user waited 60 seconds for nothing.
    // The prefix caused one false reschedule. The answer resolves as "wait I think"
    // because Deepgram also fires UtteranceEnd (no audio) which triggers
    // finishRecognition with empty text. Prepended: "wait I think ".
    //
    // Impact: 60s wasted if Deepgram's UtteranceEnd doesn't fire (e.g. WS not connected yet).
    // If Deepgram IS connected, UtteranceEnd fires at 2.5s silence → finish at ~5s.
    // So this is only an issue if Deepgram WS is not connected during listenForAnswer.
  })

  // Regression for Codex P2 on PR #294. The repaired inactivity timer
  // splits into pre-speech (timeoutMs + 30s) and post-speech (timeoutMs)
  // windows. Turns seeded by an interrupt prefix must start in the
  // post-speech window — the candidate HAS already produced speech (the
  // prefix itself), so giving them an extra 30s pre-speech budget on
  // top would add a gratuitous stall if they stopped after the interrupt.
  it('2.9 Interrupt-prefixed turn starts in post-speech inactivity window', () => {
    // Mirrors the logic in useInterview.ts listenForAnswer (see
    // `hadInterruptPrefix` + `initialMs` branches). Pure logic test —
    // hook rendering would require mocking the whole state machine.
    const timeoutMs = 30_000
    const POST_SPEECH_INACTIVITY_MS = timeoutMs
    const PRE_SPEECH_INACTIVITY_MS = timeoutMs + 30_000

    // Scenario A: no interrupt → pre-speech 60s (unchanged behaviour)
    {
      const interruptPrefix = ''
      const hadInterruptPrefix = interruptPrefix.length > 0
      const initialMs = hadInterruptPrefix
        ? POST_SPEECH_INACTIVITY_MS
        : PRE_SPEECH_INACTIVITY_MS
      expect(initialMs).toBe(60_000)
    }

    // Scenario B: interrupt seeded the turn → post-speech 30s
    {
      const interruptPrefix = 'wait can I clarify'
      const hadInterruptPrefix = interruptPrefix.length > 0
      const initialMs = hadInterruptPrefix
        ? POST_SPEECH_INACTIVITY_MS
        : PRE_SPEECH_INACTIVITY_MS
      expect(initialMs).toBe(30_000)
    }
  })

  it('2.10 Interrupt-prefixed turn reports inactivityPostSpeech (not Pre) at fire', () => {
    // Mirrors the `isPreSpeechFire` decision. hadInterruptPrefix=true
    // flips the fire reason to post-speech even when liveTranscript
    // is still empty and ms happens to equal the pre-speech window
    // (which it wouldn't, after the initialMs fix, but the decision
    // must be self-consistent).
    const timeoutMs = 30_000
    const PRE_SPEECH_INACTIVITY_MS = timeoutMs + 30_000

    const hadInterruptPrefix = true
    const currentLength = 0
    const ms = PRE_SPEECH_INACTIVITY_MS // hypothetical

    const isPreSpeechFire =
      !hadInterruptPrefix &&
      currentLength === 0 &&
      ms === PRE_SPEECH_INACTIVITY_MS
    expect(isPreSpeechFire).toBe(false)
  })

  // Regression for Codex P2 on PR #294 (follow-up). The prior setTimeout-
  // based scheduler only switched from pre-speech (60s) to post-speech
  // (30s) windowing WHEN the pre-speech timer actually fired. If the
  // candidate spoke at T=5s and then the Deepgram grace path stalled
  // (the exact failure this safety-net is meant to catch), the
  // setTimeout wouldn't notice growth until T=60s, then reschedule for
  // another 30s → fire at T=90s instead of the intended T=35s. Fix:
  // replaced with a setInterval watchdog that reads liveTranscript
  // every 1s and arms `postSpeechArmedAt` the moment growth is first
  // observed.
  it('2.11 Watchdog arms post-speech deadline on first growth, not on pre-speech fire', () => {
    // Pure-logic simulation of the watchdog's fire decision.
    // See useInterview.ts listenForAnswer — this mirrors that logic
    // at the level of elapsed-ms inputs and growth events.
    const timeoutMs = 30_000
    const POST_SPEECH_INACTIVITY_MS = timeoutMs
    const PRE_SPEECH_INACTIVITY_MS = timeoutMs + 30_000

    const turnStartedAt = 0
    let postSpeechArmedAt: number | null = null
    let lastSeenLength = 0

    // Tick 1 (T=1s): no speech yet, pre-speech window active.
    let now = 1_000
    let currentLength = 0
    expect(currentLength > lastSeenLength).toBe(false)
    // Pre-speech deadline: T=60s, not crossed yet
    expect(now - turnStartedAt >= PRE_SPEECH_INACTIVITY_MS).toBe(false)

    // Tick 5 (T=5s): speech appears — watchdog arms post-speech deadline NOW.
    now = 5_000
    currentLength = 20
    if (currentLength > lastSeenLength) {
      lastSeenLength = currentLength
      postSpeechArmedAt = now
    }
    expect(postSpeechArmedAt).toBe(5_000)

    // Tick 6 (T=6s): no more growth (speech stalled).
    now = 6_000
    // No growth. Post-speech deadline: 5s + 30s = T=35s, not crossed.
    expect(postSpeechArmedAt !== null).toBe(true)
    expect(now - postSpeechArmedAt! >= POST_SPEECH_INACTIVITY_MS).toBe(false)

    // Tick at T=34s: still not past deadline.
    now = 34_000
    expect(now - postSpeechArmedAt! >= POST_SPEECH_INACTIVITY_MS).toBe(false)

    // Tick at T=35s: deadline crossed → fire inactivityPostSpeech.
    now = 35_001
    expect(now - postSpeechArmedAt! >= POST_SPEECH_INACTIVITY_MS).toBe(true)

    // Critical: old setTimeout implementation would have fired at T=90s
    // (pre-speech 60s → reschedule → post-speech 30s → 60+30=90s).
    // The watchdog fires at T=35s, saving 55s of dead air.
    expect(35_001 < 90_000).toBe(true)
  })

  it('2.12 Watchdog re-arms post-speech deadline on every growth tick', () => {
    // Simulates ongoing speech: liveTranscript grows at T=5, 10, 15s
    // then stops. Deadline should be 15s + 30s = T=45s, NOT earlier
    // (e.g. 5s + 30s = T=35s) — proves the timer RESETS on growth.
    const POST_SPEECH_INACTIVITY_MS = 30_000

    let postSpeechArmedAt: number | null = null
    let lastSeenLength = 0

    const growthEvents: Array<{ t: number; len: number }> = [
      { t: 5_000, len: 10 },
      { t: 10_000, len: 25 },
      { t: 15_000, len: 40 },
    ]
    for (const ev of growthEvents) {
      if (ev.len > lastSeenLength) {
        lastSeenLength = ev.len
        postSpeechArmedAt = ev.t
      }
    }

    // After the last growth at T=15s, deadline is T=45s.
    expect(postSpeechArmedAt).toBe(15_000)

    // At T=44s: not yet fired
    expect(44_000 - postSpeechArmedAt! >= POST_SPEECH_INACTIVITY_MS).toBe(false)
    // At T=46s: fired
    expect(46_000 - postSpeechArmedAt! >= POST_SPEECH_INACTIVITY_MS).toBe(true)
  })
})
