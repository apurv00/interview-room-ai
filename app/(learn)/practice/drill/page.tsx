'use client'

import { useEffect, useRef, useState, Suspense } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useSearchParams } from 'next/navigation'
import { deduplicatedFetch } from '@shared/cachedFetch'
import { parseSSEStream } from '@learn/lib/sse'
import PathwayEntryStrip from '@learn/components/drill/PathwayEntryStrip'
import QuestionInsightStrip from '@learn/components/drill/QuestionInsightStrip'
import DeltaContextNote from '@learn/components/drill/DeltaContextNote'
import SourceFeedbackDrawer from '@learn/components/drill/SourceFeedbackDrawer'
// Reuses the production Web-Speech-API hook the live interview falls
// back to when Deepgram is unavailable. Web Speech is free + runs
// client-side — appropriate for drill (practice) traffic. We don't
// want to burn Deepgram cost on every retry.
// eslint-disable-next-line no-restricted-imports -- direct import: no
// barrel exists at modules/interview/hooks/ and the @interview barrel
// pulls in server-only types we don't need here.
import { useSpeechRecognition } from '@interview/hooks/useSpeechRecognition'
import StrongAnswerOutlineCard from '@learn/components/drill/StrongAnswerOutlineCard'

/** Web Speech API capability check — runs in the browser only.
 *  When false we hide the mic button entirely so unsupported browsers
 *  (older Firefox, some embedded webviews) don't see a broken affordance. */
function browserSupportsSpeechRecognition(): boolean {
  if (typeof window === 'undefined') return false
  return Boolean(
    (window as Window & {
      SpeechRecognition?: unknown
      webkitSpeechRecognition?: unknown
    }).SpeechRecognition ||
      (window as Window & { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition,
  )
}

interface WeakQuestion {
  sessionId: string
  questionIndex: number
  question: string
  answer: string
  avgScore: number
  relevance: number
  structure: number
  specificity: number
  ownership: number
  competency: string
  sessionDate: string
  /**
   * E1: number of past attempts on the same (normalized) question.
   * Optional for backwards compatibility — old server responses
   * (pre-cluster) won't include it; we treat undefined as 1.
   */
  attemptCount?: number
}

interface DrillResult {
  newScore: number
  delta: number
  breakdown: {
    relevance: number
    structure: number
    specificity: number
    ownership: number
  }
}

/**
 * Pathway P2 Wave 5 — shape returned by /api/learn/drill/context/question.
 * Drives the rendering choice in the active-drill view:
 *
 *   - `idealAnswer` present → reuse `IdealAnswerComparisonCard`
 *     (already built with dim bars + keyElements chips + strongAnswer)
 *   - `idealAnswer` null but `scores` + `primaryGap` present →
 *     fallback to `QuestionInsightStrip` (thinner coach-tip)
 *   - All null → neither renders (legacy session pre-dating primaryGap)
 */
interface QuestionContext {
  primaryGap: string | null
  scores: {
    relevance: number
    structure: number
    specificity: number
    ownership: number
  } | null
  domain: string | null
  interviewType: string | null
  idealAnswer: { strongAnswer: string; keyElements: string[] } | null
}

const COMPETENCIES = [
  { value: '', label: 'All' },
  { value: 'relevance', label: 'Relevance' },
  { value: 'structure', label: 'Structure' },
  { value: 'specificity', label: 'Specificity' },
  { value: 'ownership', label: 'Ownership' },
]

export default function DrillPage() {
  return (
    <Suspense fallback={
      <main className="max-w-4xl mx-auto px-4 py-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-[#eff3f4] rounded w-48" />
          {[1, 2, 3].map(i => <div key={i} className="h-24 bg-[#eff3f4] rounded-xl" />)}
        </div>
      </main>
    }>
      <DrillPageInner />
    </Suspense>
  )
}

function DrillPageInner() {
  const searchParams = useSearchParams()
  const [questions, setQuestions] = useState<WeakQuestion[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState(searchParams.get('competency') || '')

  // Active drill state
  const [activeQuestion, setActiveQuestion] = useState<WeakQuestion | null>(null)
  const [newAnswer, setNewAnswer] = useState('')
  const [evaluating, setEvaluating] = useState(false)
  const [result, setResult] = useState<DrillResult | null>(null)
  // Streaming evaluator (PR feat/drill-streaming-evaluator, Phase 1).
  // While a streaming evaluation is in flight, `streamingBreakdown`
  // fills one dimension at a time as the server emits `event: score`
  // SSE frames. On `event: complete` we promote the accumulated
  // breakdown into `result` (the existing final state) and clear
  // this. Renders alongside the existing UI — when null OR result is
  // set, the existing breakdown grid takes over.
  const [streamingBreakdown, setStreamingBreakdown] = useState<
    Partial<{ relevance: number; structure: number; specificity: number; ownership: number }> | null
  >(null)
  // Streaming completion may emit `persistFailed:true` when
  // saveDrillAttempt threw after the user already saw their score.
  // We surface a warning rather than discarding the result.
  const [persistFailed, setPersistFailed] = useState(false)
  // Voice input via Web Speech API (production-tested fallback the
  // live interview uses when Deepgram is unavailable). The hook is
  // SSR-safe — it touches `window.SpeechRecognition` only inside
  // `startListening`. `voiceSupported` gates the mic button so
  // unsupported browsers (older Firefox, embedded webviews) don't
  // see a broken affordance. Detected post-mount to avoid
  // hydration mismatch.
  const { isListening, liveTranscript, startListening, stopListening } = useSpeechRecognition()
  const [voiceSupported, setVoiceSupported] = useState(false)
  useEffect(() => {
    setVoiceSupported(browserSupportsSpeechRecognition())
  }, [])

  // Voice-first input mode. Real interviews are spoken, not typed, so
  // the mic is the primary CTA and the textarea is hidden behind a
  // "Type instead" toggle. We default-open the textarea for browsers
  // without Web Speech API so unsupported users still have a working
  // input on the first paint. Once the user explicitly toggles, their
  // choice sticks for the rest of the drill session (not persisted
  // across reloads — practice is short).
  const [showTextInput, setShowTextInput] = useState(false)
  useEffect(() => {
    if (!voiceSupported) setShowTextInput(true)
  }, [voiceSupported])

  // Set true when the user clicks Submit while the mic is still
  // listening — defers the actual submit until the speech hook has
  // appended the final transcript to `newAnswer`. Codex P1 on PR #392
  // flagged that the prior version called stopListening() + read
  // `newAnswer` synchronously, but the hook appends via onComplete
  // asynchronously, so the last spoken words landed in the textarea
  // AFTER the evaluator had already scored stale text.
  const pendingSubmitRef = useRef(false)
  // Monotonic counter — every `startListening` call captures the
  // current value, and the onComplete callback only appends its
  // transcript if the value still matches. resetDrill bumps the
  // counter, so any in-flight recognition session from a previous
  // drill drops its transcript silently when the callback finally
  // fires. Codex P2 on PR #392 — without this guard, clicking
  // Back/Esc mid-recording then opening a different drill could
  // leak the prior question's spoken text into the new answer box.
  const transcriptSessionRef = useRef(0)

  // Tracks the in-flight evaluation fetch so we can abort it on
  // unmount or when the user submits again. Vercel Agent flagged the
  // unguarded version for triggering setState-on-unmounted warnings
  // when users navigate away mid-stream.
  const submitControllerRef = useRef<AbortController | null>(null)

  // Pathway P2 Wave 5 — pathway entry context (read once by parent,
  // passed down as props to avoid every child re-calling
  // useSearchParams and needing its own Suspense boundary). 5B's
  // questionCtx fetches on startDrill via the new context endpoint.
  const source = searchParams.get('source') ?? undefined
  const actionId = searchParams.get('actionId') ?? undefined
  const returnTo = searchParams.get('returnTo') ?? undefined
  const [questionCtx, setQuestionCtx] = useState<QuestionContext | null>(null)
  const [questionCtxLoading, setQuestionCtxLoading] = useState(false)
  // E2 — source-feedback drawer. Opens in place of the prior
  // /feedback/[id] page navigation. State lives here so resetDrill
  // can close it on Back; the drawer's own Esc handler closes
  // just the drawer. Mirrored to a ref so the drill page's Esc
  // handler can short-circuit when the drawer is open WITHOUT
  // adding `feedbackDrawerOpen` to the Esc effect's deps (which
  // would re-attach the listener on every toggle). Codex P1 on
  // PR #393: stopPropagation from the drawer doesn't stop the
  // drill listener because both are on `window`, so a guard at
  // the drill side is required.
  const [feedbackDrawerOpen, setFeedbackDrawerOpen] = useState(false)
  const feedbackDrawerOpenRef = useRef(false)
  useEffect(() => {
    feedbackDrawerOpenRef.current = feedbackDrawerOpen
  }, [feedbackDrawerOpen])

  useEffect(() => {
    setLoading(true)
    const params = new URLSearchParams()
    if (filter) params.set('competency', filter)
    fetch(`/api/learn/drill/questions?${params}`)
      .then(r => r.json())
      .then(d => { setQuestions(d.questions || []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [filter])

  // Cancel any in-flight drill submission AND the mic on unmount so
  // the SSE reader stops and we don't fire setState on an unmounted
  // tree, and so the mic LED doesn't stay green when the user
  // navigates away. `stopListening` is referenced via a ref-like
  // closure — the hook re-creates the function each render but the
  // underlying SpeechRecognition instance is stable.
  useEffect(() => {
    return () => {
      submitControllerRef.current?.abort()
      stopListening()
    }
    // Intentionally captures `stopListening` on first render; the
    // underlying SpeechRecognition instance it closes over is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Codex P1 follow-up: when the mic stops AND a submit is queued,
  // fire submitAnswer now. React has committed both `setIsListening
  // (false)` and `setNewAnswer(combined)` from the hook's complete()
  // callback in the same render batch, so submitAnswer reads the
  // up-to-date textarea content (including the final spoken words).
  useEffect(() => {
    if (!isListening && pendingSubmitRef.current) {
      pendingSubmitRef.current = false
      submitAnswer()
    }
    // submitAnswer reads `newAnswer` via closure — re-running this
    // effect only on `isListening` changes is correct: the LATEST
    // submitAnswer (closing over the latest newAnswer) is captured
    // at render time, and the effect fires after that render commits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isListening])

  // Esc closes an active drill back to the list — keyboard parity
  // for the Back button. Two scope guards:
  //
  //   1. Skip while `evaluating` so a mid-stream Esc can't lose the
  //      in-flight result.
  //   2. Skip when focus is inside a text input (TEXTAREA / INPUT /
  //      contenteditable). The textarea does NOT intercept Esc on
  //      its own — without this guard, hitting Esc while typing an
  //      answer would bubble to the window listener, close the
  //      drill, and lose the user's work (Vercel Agent review on
  //      PR #391).
  useEffect(() => {
    if (!activeQuestion || evaluating) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Drawer is open → Esc should close just the drawer (its own
      // handler does that). Don't reset the drill. Codex P1 on PR
      // #393: stopPropagation in the drawer's handler doesn't help
      // because both listeners are on `window` and fire in
      // registration order; the drill listener was registered
      // first (when the drill started), so it would always win
      // without this guard.
      if (feedbackDrawerOpenRef.current) return
      const el = e.target as HTMLElement | null
      const tag = el?.tagName
      if (tag === 'TEXTAREA' || tag === 'INPUT' || el?.isContentEditable) return
      resetDrill()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // `resetDrill` only reads setters; rebuilding the effect on every
    // render would attach/detach the listener pointlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeQuestion, evaluating])

  const startDrill = (q: WeakQuestion) => {
    setActiveQuestion(q)
    setNewAnswer('')
    setResult(null)
    // The synchronous clear keeps the UI from flashing a stale
    // coach card from the previous drill during the brief moment
    // between this click and the fetch effect committing. The
    // actual fetch lives in the effect below — see the race fix.
    setQuestionCtx(null)
    setQuestionCtxLoading(true)
  }

  // Pathway P2 Wave 5 (5B) — fetch the per-question coach context
  // for the active drill question.
  //
  // Codex P2 on PR #388 — this MUST be effect-driven, not imperative.
  // The previous version fired the fetch inside `startDrill` with no
  // cancellation, so a fast click A → click B sequence could land
  // A's late `.then()` AFTER B's response, displaying A's coaching
  // card alongside B's question. Effect-driven gives us free
  // cleanup: when activeQuestion changes from A to B, A's cleanup
  // sets `cancelled = true` and A's callbacks bail out.
  useEffect(() => {
    if (!activeQuestion) return
    let cancelled = false

    deduplicatedFetch(
      `/api/learn/drill/context/question?sessionId=${encodeURIComponent(activeQuestion.sessionId)}&questionIndex=${activeQuestion.questionIndex}`,
      { cache: 'no-store' },
    )
      .then((res) => (res.ok ? (res.json() as Promise<QuestionContext>) : null))
      .then((payload) => {
        if (cancelled) return
        setQuestionCtx(payload)
      })
      .catch(() => {
        if (cancelled) return
        setQuestionCtx(null)
      })
      .finally(() => {
        if (cancelled) return
        setQuestionCtxLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [activeQuestion])

  const submitAnswer = async () => {
    if (!activeQuestion) return
    // If the mic is still hot, defer: flip the pending flag, stop
    // recording, and let the `[isListening]` effect re-call this
    // function once the hook's onComplete callback has appended the
    // final transcript to `newAnswer`. Reading `newAnswer` here
    // would miss the last spoken words (Codex P1 on PR #392).
    if (isListening) {
      pendingSubmitRef.current = true
      stopListening()
      return
    }
    if (!newAnswer.trim()) return
    // Cancel any previous evaluation that's still in flight (e.g.
    // user clicked Submit twice). Race-free because the previous
    // submit's catch will see AbortError and skip its setState.
    submitControllerRef.current?.abort()
    const controller = new AbortController()
    submitControllerRef.current = controller

    setEvaluating(true)
    setStreamingBreakdown({})
    setPersistFailed(false)
    try {
      const res = await fetch('/api/learn/drill/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          sessionId: activeQuestion.sessionId,
          questionIndex: activeQuestion.questionIndex,
          question: activeQuestion.question,
          originalAnswer: activeQuestion.answer,
          originalScore: activeQuestion.avgScore,
          newAnswer: newAnswer.trim(),
          competency: activeQuestion.competency,
        }),
      })

      // Route always streams on 2xx. JSON content-type means an HTTP
      // error envelope (401/400/500) — bail to the catch so the user
      // returns to the textarea and can retry.
      if (!res.ok || !res.body || !(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
        throw new Error(`drill-evaluate: ${res.status}`)
      }
      await consumeStreamingEvaluator(res.body)
    } catch (err) {
      // Aborts (unmount or repeated-submit) aren't user-visible errors.
      if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        return
      }
      setStreamingBreakdown(null)
    } finally {
      // Only flip evaluating if this submission is still the active
      // one — a repeated submit will have replaced the ref already
      // and its own finally will own the flag.
      if (submitControllerRef.current === controller) {
        submitControllerRef.current = null
        setEvaluating(false)
      }
    }
  }

  /**
   * Consume the SSE response from /api/learn/drill/evaluate.
   *   `event: score`    → updates one entry in streamingBreakdown
   *   `event: complete` → promotes to result + clears streamingBreakdown
   *   `event: error`    → bails (silent — error message already in console.log via logger)
   */
  async function consumeStreamingEvaluator(body: ReadableStream<Uint8Array>) {
    for await (const ev of parseSSEStream(body)) {
      if (ev.event === 'score') {
        try {
          const payload = JSON.parse(ev.data) as { dimension: string; score: number }
          setStreamingBreakdown((prev) => ({ ...(prev ?? {}), [payload.dimension]: payload.score }))
        } catch {
          // ignore malformed score frame; stream continues
        }
      } else if (ev.event === 'complete') {
        try {
          const payload = JSON.parse(ev.data) as DrillResult & { persistFailed?: boolean }
          if (payload.persistFailed) setPersistFailed(true)
          setStreamingBreakdown(null)
          setResult(payload)
        } catch {
          // shouldn't happen — server-controlled JSON, but stay safe
        }
      } else if (ev.event === 'error') {
        setStreamingBreakdown(null)
        // Caller's catch path handles the rest; throwing here keeps
        // the for-await loop short-circuited.
        throw new Error('stream-error')
      }
    }
  }

  const resetDrill = () => {
    // Close the source-feedback drawer too if it's open — leaving it
    // mounted across drill changes would leak the previous question's
    // content into the new drill's drawer the next time it opens.
    setFeedbackDrawerOpen(false)
    // Call stopListening unconditionally — the hook is idempotent
    // when not recording. Avoids a stale-closure trap (Codex P1 on
    // PR #392): the Esc useEffect captures resetDrill via deps
    // `[activeQuestion, evaluating]`, so if the user starts the mic
    // AFTER the listener is attached, `isListening` in resetDrill's
    // closure stays false and an `if (isListening) stopListening()`
    // gate would skip the stop, leaving recognition active after
    // Esc-to-close. Always-call removes that whole class of bug.
    stopListening()
    // Invalidate any in-flight transcript session — stopListening is
    // sync (calls recognition.abort()) but the hook's onComplete
    // fires async. Bumping the session counter makes the about-to-
    // fire onComplete callback skip its append, preventing the
    // prior drill's spoken text from leaking into the next drill's
    // answer box. Codex P2 on PR #392.
    transcriptSessionRef.current++
    // Clear any deferred submit so Back-mid-recording doesn't auto-
    // fire the evaluator once the mic stops.
    pendingSubmitRef.current = false
    setActiveQuestion(null)
    setNewAnswer('')
    setResult(null)
    setStreamingBreakdown(null)
    setPersistFailed(false)
    // Reset to voice-first when supported so each new drill starts
    // from the same default surface.
    setShowTextInput(!voiceSupported)
  }

  /** Toggle the mic on/off. On stop, the hook's onComplete callback
   *  appends the final transcript to whatever's already in the
   *  textarea — supports mixed typing + speaking flows.
   *
   *  Session-counter guard: the callback captures `sessionId` from
   *  the moment startListening was called. resetDrill bumps the
   *  counter; if the captured id doesn't match the current value
   *  when onComplete fires, this session was superseded (user
   *  closed the drill before the transcript flushed) and the
   *  append is dropped. */
  const toggleVoice = () => {
    if (isListening) {
      stopListening()
      return
    }
    const sessionId = ++transcriptSessionRef.current
    startListening((result) => {
      if (sessionId !== transcriptSessionRef.current) return
      const text = result.text.trim()
      if (!text) return
      setNewAnswer((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text))
    })
  }

  if (loading) {
    return (
      <main className="max-w-4xl mx-auto px-4 py-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-[#eff3f4] rounded w-48" />
          <div className="h-4 bg-[#eff3f4] rounded w-72" />
          {[1, 2, 3].map(i => <div key={i} className="h-24 bg-[#eff3f4] rounded-xl" />)}
        </div>
      </main>
    )
  }

  const emptySetupParams = new URLSearchParams({
    source: 'pathway',
    actionId: filter ? `drill-${filter}` : 'drill-empty',
    returnTo: '/learn/pathway',
  })
  if (filter) emptySetupParams.set('focus', filter)
  const emptySetupHref = `/interview/setup?${emptySetupParams.toString()}`

  return (
    <main className="max-w-4xl mx-auto px-4 py-8 space-y-6">
      <div>
        <motion.h1
          className="text-2xl font-bold text-[#0f1419]"
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
        >
          Drill Mode
        </motion.h1>
        <p className="text-sm text-[#71767b] mt-1">
          Re-attempt your weakest answers and see how much you improve.
        </p>
      </div>

      {/* Pathway P2 Wave 5 (5A) — entry context strip. Self-hides
          when source !== 'pathway' or the actionId doesn't resolve
          to a current pathway task (Inngest regen may have replaced
          the task list since the URL was minted). */}
      <PathwayEntryStrip source={source} actionId={actionId} returnTo={returnTo} />

      {/* Competency filter — hidden during an active drill so it can't
          be clicked while in-question (Bug: switching filters mid-drill
          left the user stuck on the previous question because filter
          changes don't reset `activeQuestion`). Returning to the list
          via Back/Esc brings the filter row back. */}
      {!activeQuestion && (
        <div className="flex gap-2 flex-wrap">
          {COMPETENCIES.map(c => (
            <button
              key={c.value}
              onClick={() => setFilter(c.value)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                filter === c.value
                  ? 'bg-blue-600 text-white'
                  : 'bg-[#eff3f4] text-[#8b98a5] hover:text-[#536471]'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}

      <AnimatePresence mode="wait">
        {activeQuestion ? (
          <motion.div
            key="drill-active"
            className="space-y-6"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
          >
            {/* Prominent Back button — replaces the prior 12px text
                link in the question-card corner, which users were
                missing (no obvious "exit" affordance once a drill
                started). Esc-key handler bound at the page level
                (see useEffect above) provides keyboard parity. */}
            <button
              type="button"
              onClick={resetDrill}
              className="inline-flex items-center gap-1.5 text-sm text-[#536471] hover:text-[#0f1419] -mb-2"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              Back to drill list
            </button>

            {/* Question */}
            <div className="surface-card-bordered p-5 sm:p-6">
              <h2 className="text-base font-semibold text-[#0f1419] mb-4">{activeQuestion.question}</h2>

              <div className="flex items-center gap-3 mb-4">
                <span className="text-xs text-[#71767b]">Original score: {activeQuestion.avgScore}/100</span>
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                  activeQuestion.avgScore < 40 ? 'bg-red-500/10 text-[#f4212e]' : 'bg-amber-500/10 text-[#d97706]'
                }`}>
                  Weak: {activeQuestion.competency}
                </span>
              </div>

              {/* Drill coach card — slim version showing ONLY the
                  prescriptive guidance (strong-answer outline + key
                  elements). User feedback on the prior
                  IdealAnswerComparisonCard usage: "while it's good to
                  accommodate the suggested structure, rest of the
                  things added doesn't make sense."
                  Reasons the old card's other 3 sections were noise
                  in the drill context:
                    - Q-label / question text → already the heading
                      above this card
                    - Avg score → already the "Original score: N/100"
                      chip above
                    - YOUR ANSWER / SCORE BREAKDOWN / WHY IT SCORED LOW
                      → already in the source-feedback drawer (PR #393)
                  Fallback path (no idealAnswer) still uses
                  QuestionInsightStrip — that's a different shape
                  (coach-tip prose, not strong-answer guidance) and
                  doesn't have the redundancy problem. */}
              {!result && !questionCtxLoading && questionCtx && (
                <div className="mb-4 space-y-3">
                  {questionCtx.idealAnswer ? (
                    <StrongAnswerOutlineCard
                      strongAnswer={questionCtx.idealAnswer.strongAnswer}
                      keyElements={questionCtx.idealAnswer.keyElements}
                    />
                  ) : (
                    <QuestionInsightStrip
                      question={activeQuestion.question}
                      questionIndex={activeQuestion.questionIndex}
                      scores={questionCtx.scores}
                      primaryGap={questionCtx.primaryGap}
                      domain={questionCtx.domain}
                      interviewType={questionCtx.interviewType}
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => setFeedbackDrawerOpen(true)}
                    className="inline-flex items-center gap-1 text-xs text-blue-500 hover:text-blue-600 font-medium"
                  >
                    View source feedback
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                  </button>
                </div>
              )}

              {/* New answer input — voice-first (real interviews are
                  spoken, not typed). The primary surface is a big mic
                  button + live transcript display. Typing is hidden
                  behind a "Type instead" toggle so the affordance
                  matches the user's mental model: open mouth, not
                  open keyboard. Toggling reveals the textarea
                  (pre-filled with whatever was spoken so the user can
                  edit before submitting). Browsers without Web Speech
                  API skip the toggle and show the textarea by default
                  (voiceSupported effect above). */}
              {!result && (
                <>
                  {/* Voice-first primary surface — mic button + live
                      transcript display. Hidden when the user only
                      has the type-instead surface (no voice). */}
                  {voiceSupported && (
                    <div className="rounded-xl border border-[#e1e8ed] bg-white p-5 flex flex-col items-center gap-3 text-center">
                      <button
                        type="button"
                        onClick={toggleVoice}
                        disabled={evaluating}
                        aria-label={isListening ? 'Stop recording' : 'Start voice answer'}
                        aria-pressed={isListening}
                        data-testid="drill-mic-button"
                        className={`flex items-center justify-center w-20 h-20 rounded-full transition-colors shadow-sm ${
                          isListening
                            ? 'bg-red-500 hover:bg-red-600 text-white'
                            : 'bg-blue-600 hover:bg-blue-500 text-white'
                        } disabled:opacity-40 disabled:cursor-not-allowed`}
                      >
                        {isListening ? (
                          <svg className="w-7 h-7" viewBox="0 0 24 24" fill="currentColor">
                            <rect x="6" y="6" width="12" height="12" rx="1.5" />
                          </svg>
                        ) : (
                          <svg className="w-9 h-9" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M19 11a7 7 0 01-14 0m7 7v3m-4 0h8m-4-7a3 3 0 01-3-3V5a3 3 0 016 0v6a3 3 0 01-3 3z" />
                          </svg>
                        )}
                      </button>

                      {isListening ? (
                        <div
                          data-testid="drill-listening-banner"
                          className="flex items-center justify-center gap-2 text-xs font-medium text-red-700"
                        >
                          <span className="relative flex h-2 w-2 shrink-0">
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
                            <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
                          </span>
                          <span>Listening — tap mic to stop</span>
                        </div>
                      ) : (
                        <p className="text-xs text-[#71767b]">
                          {newAnswer.trim()
                            ? 'Tap the mic to keep speaking, or submit your answer.'
                            : 'Tap the mic and answer out loud — real interviews are spoken.'}
                        </p>
                      )}

                      {/* Captured / interim transcript display — read-
                          only mirror of what's been spoken so the user
                          sees their answer take shape without needing
                          the textarea. liveTranscript is the
                          mid-utterance interim text; newAnswer is the
                          flushed accumulated transcript. */}
                      {(newAnswer.trim() || liveTranscript) && (
                        <div
                          data-testid="drill-spoken-transcript"
                          className="w-full text-left rounded-lg bg-[#f7f9f9] border border-[#eff3f4] px-4 py-3 text-sm text-[#0f1419] whitespace-pre-wrap"
                        >
                          {newAnswer.trim()}
                          {isListening && liveTranscript && (
                            <span className="text-[#536471]">
                              {newAnswer.trim() ? ' ' : ''}
                              {liveTranscript}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* "Type instead" toggle — only shown when voice is
                      supported (otherwise the textarea is already the
                      only surface). Once expanded, stays open for the
                      rest of the drill (resetDrill clears it). */}
                  {voiceSupported && !showTextInput && (
                    <button
                      type="button"
                      onClick={() => setShowTextInput(true)}
                      data-testid="drill-type-instead"
                      className="mt-3 inline-flex items-center gap-1 text-xs text-[#536471] hover:text-blue-600 font-medium"
                    >
                      Can&rsquo;t speak right now? Type instead
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>
                  )}

                  {showTextInput && (
                    <div className={voiceSupported ? 'mt-3' : ''}>
                      <textarea
                        value={newAnswer}
                        onChange={e => setNewAnswer(e.target.value)}
                        placeholder={voiceSupported
                          ? 'Edit what you spoke, or type your full answer here.'
                          : 'Type your improved answer here…'}
                        rows={6}
                        className="w-full p-4 bg-white border border-[#e1e8ed] rounded-xl text-sm text-[#0f1419] placeholder:text-[#8b98a5] focus:outline-none focus:ring-2 focus:ring-blue-500/50 resize-none"
                      />
                    </div>
                  )}

                  <button
                    onClick={submitAnswer}
                    // Enabled when listening even if the textarea is
                    // empty: a voice-only user clicks Submit while
                    // speaking; submitAnswer's deferred-submit path
                    // (Codex P1 fix) stops the mic, waits for the
                    // final transcript to flush into newAnswer, then
                    // re-fires. If they hadn't actually spoken, the
                    // second pass short-circuits on the empty check.
                    // Codex P2 on PR #392.
                    disabled={evaluating || (!newAnswer.trim() && !isListening)}
                    className="mt-3 px-5 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-[#eff3f4] disabled:text-[#71767b] text-white text-sm font-medium rounded-lg transition-colors"
                  >
                    {evaluating ? 'Evaluating...' : isListening ? 'Stop & Submit' : 'Submit Answer'}
                  </button>

                  {/* Streaming progress strip — visible only while a
                      streaming evaluation is in flight (feature flag
                      on + provider supports streaming). Each dim
                      card fills in as its `event: score` lands.
                      Disappears the moment `event: complete` arrives
                      and the existing result block below takes over. */}
                  {evaluating && streamingBreakdown && (
                    <motion.div
                      data-testid="drill-streaming-progress"
                      className="mt-4 grid grid-cols-2 gap-3"
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                    >
                      {(['relevance', 'structure', 'specificity', 'ownership'] as const).map((dim) => {
                        const score = streamingBreakdown[dim]
                        const arrived = typeof score === 'number'
                        return (
                          <div
                            key={dim}
                            data-testid={`drill-streaming-dim-${dim}`}
                            data-arrived={arrived ? 'true' : 'false'}
                            className={`p-3 rounded-lg ${arrived ? 'bg-[#f8fafc]' : 'bg-[#f8fafc] animate-pulse'}`}
                          >
                            <div className="text-xs text-[#8b98a5] capitalize mb-1">{dim}</div>
                            <div className="text-sm font-medium text-[#0f1419] tabular-nums">
                              {arrived ? score : '—'}
                            </div>
                          </div>
                        )
                      })}
                    </motion.div>
                  )}
                </>
              )}

              {/* Result */}
              {result && (
                <motion.div
                  className="space-y-4 mt-4"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                >
                  {/* Streaming evaluator may emit `complete` with
                      `persistFailed:true` when saveDrillAttempt threw
                      after the user already saw their score. Surface
                      a non-blocking warning so they know the attempt
                      didn't save and can retry to record it. */}
                  {persistFailed && (
                    <div
                      data-testid="drill-persist-failed-warning"
                      className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2"
                    >
                      We couldn&apos;t save this attempt to your history. Your score above is correct; try the drill again to record it.
                    </div>
                  )}
                  {/* Score comparison */}
                  <div className="flex items-center gap-4 p-4 rounded-xl bg-[#f8fafc]">
                    <div className="text-center">
                      <div className="text-xs text-[#71767b]">Original</div>
                      <div className="text-xl font-bold text-[#8b98a5]">{activeQuestion.avgScore}</div>
                    </div>
                    <svg className="w-5 h-5 text-[#8b98a5]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                    </svg>
                    <div className="text-center">
                      <div className="text-xs text-[#71767b]">New</div>
                      <div className="text-xl font-bold text-[#0f1419]">{result.newScore}</div>
                    </div>
                    <div className={`ml-auto px-3 py-1 rounded-lg text-sm font-semibold ${
                      result.delta > 0
                        ? 'bg-emerald-500/10 text-[#059669]'
                        : result.delta < 0
                        ? 'bg-red-500/10 text-[#f4212e]'
                        : 'bg-[#eff3f4] text-[#8b98a5]'
                    }`}>
                      {result.delta > 0 ? '+' : ''}{result.delta}
                    </div>
                  </div>

                  {/* Pathway P2 Wave 5 (5C) — trend context note next
                      to the delta badge. Shows "First {comp} drill"
                      or "Average +N across M prior {comp} drills",
                      plus an "approximate" caveat for large deltas.
                      Self-fetches via deduplicatedFetch; renders
                      nothing on error. */}
                  <DeltaContextNote
                    competency={activeQuestion.competency}
                    latestDelta={result.delta}
                  />

                  {/* Dimension breakdown */}
                  <div className="grid grid-cols-2 gap-3">
                    {Object.entries(result.breakdown).map(([dim, score]) => {
                      const orig = activeQuestion[dim as keyof typeof activeQuestion] as number
                      const d = score - orig
                      return (
                        <div key={dim} className="p-3 rounded-lg bg-[#f8fafc]">
                          <div className="text-xs text-[#8b98a5] capitalize mb-1">{dim}</div>
                          <div className="flex items-baseline gap-2">
                            <span className="text-sm font-medium text-[#0f1419]">{score}</span>
                            {d !== 0 && (
                              <span className={`text-xs ${d > 0 ? 'text-[#059669]' : 'text-[#f4212e]'}`}>
                                {d > 0 ? '+' : ''}{d}
                              </span>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>

                  <div className="flex gap-3">
                    <button
                      onClick={() => { setResult(null); setNewAnswer('') }}
                      className="px-4 py-2 bg-[#f8fafc] hover:bg-[#eff3f4] text-sm text-[#536471] rounded-lg transition-colors"
                    >
                      Try Again
                    </button>
                    <button
                      onClick={resetDrill}
                      className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
                    >
                      Next Question
                    </button>
                  </div>
                </motion.div>
              )}
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="drill-list"
            className="space-y-3"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            {questions.length === 0 ? (
              /* Pathway P2 Wave 5 (5E) — observational empty-state.
                 Replaces the prior dual-CTA banner with framing that
                 names what's true rather than what to do next: when
                 the filter is set, the user has cleared that specific
                 competency; when unfiltered, they've cleared the
                 sub-60 backlog. The CTAs still live below but the
                 main copy stops nagging. */
              <div className="text-center py-16">
                <p className="text-[#536471] font-medium mb-1">
                  {filter
                    ? `Nothing under 60 on ${filter} right now.`
                    : 'You’ve cleared the sub-60 backlog.'}
                </p>
                <p className="text-sm text-[#71767b] mb-5 max-w-md mx-auto">
                  {filter
                    ? 'Switch filters to see other weak areas, or run another interview to surface new drill candidates here.'
                    : 'Run another interview to surface new drill candidates here, or head back to your pathway to pick up the next action.'}
                </p>
                <div className="flex items-center justify-center gap-3 flex-wrap">
                  <a
                    href="/learn/pathway"
                    className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
                  >
                    View Pathway
                  </a>
                  <a
                    href={emptySetupHref}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-white hover:bg-blue-50 border border-blue-500/40 text-blue-600 text-sm font-medium rounded-lg transition-colors"
                  >
                    Start Interview
                  </a>
                </div>
              </div>
            ) : (
              questions.map((q, i) => (
                <motion.div
                  key={`${q.sessionId}-${q.questionIndex}`}
                  className="surface-card-bordered p-4 sm:p-5 cursor-pointer hover:border-blue-500/30 transition-colors"
                  onClick={() => startDrill(q)}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.05 }}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      {/* E1: full question available via title-tooltip
                          when line-clamp-2 truncates. Long questions
                          stay compact in the list. */}
                      <h3
                        className="text-sm font-medium text-[#0f1419] line-clamp-2"
                        title={q.question}
                      >
                        {q.question}
                      </h3>
                      <div className="flex items-center gap-2 mt-2 flex-wrap">
                        <span className="text-xs text-[#71767b]">Score: {q.avgScore}/100</span>
                        <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${
                          q.avgScore < 30 ? 'bg-red-500/10 text-[#f4212e]' :
                          q.avgScore < 50 ? 'bg-amber-500/10 text-[#d97706]' :
                          'bg-yellow-500/10 text-[#d97706]'
                        }`}>
                          {q.competency}
                        </span>
                        {/* E1: signals when the server clustered this
                            question across multiple past sessions. The
                            drill itself opens the worst-scoring attempt
                            (same as before clustering); the chip just
                            tells the user "you've tried this N times". */}
                        {(q.attemptCount ?? 1) > 1 && (
                          <span
                            className="px-2 py-0.5 rounded text-[10px] font-medium bg-blue-500/10 text-blue-600"
                            title={`This question has appeared in ${q.attemptCount} of your past sessions. Drill opens the lowest-scoring attempt.`}
                          >
                            {q.attemptCount} attempts
                          </span>
                        )}
                      </div>
                    </div>
                    <svg className="w-4 h-4 text-[#8b98a5] shrink-0 mt-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </div>
                </motion.div>
              ))
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Source feedback drawer — outside AnimatePresence so its own
          AnimatePresence-driven mount/unmount isn't tangled with the
          drill-active/list transition. Only renders meaningful chrome
          when `feedbackDrawerOpen` is true (otherwise just an empty
          AnimatePresence). Mounted at the page level so it overlays
          above all drill chrome. */}
      {activeQuestion && (
        <SourceFeedbackDrawer
          open={feedbackDrawerOpen}
          onClose={() => setFeedbackDrawerOpen(false)}
          sessionId={activeQuestion.sessionId}
          question={activeQuestion.question}
          originalAnswer={activeQuestion.answer}
          scores={
            questionCtx?.scores ?? {
              relevance: activeQuestion.relevance,
              structure: activeQuestion.structure,
              specificity: activeQuestion.specificity,
              ownership: activeQuestion.ownership,
            }
          }
        />
      )}
    </main>
  )
}
