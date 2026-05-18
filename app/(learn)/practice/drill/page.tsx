'use client'

import { useEffect, useRef, useState, Suspense } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useSearchParams } from 'next/navigation'
import { deduplicatedFetch } from '@shared/cachedFetch'
import { parseSSEStream } from '@learn/lib/sse'
import PathwayEntryStrip from '@learn/components/drill/PathwayEntryStrip'
import QuestionInsightStrip from '@learn/components/drill/QuestionInsightStrip'
import DeltaContextNote from '@learn/components/drill/DeltaContextNote'
// eslint-disable-next-line no-restricted-imports -- direct import: the
// @feedback barrel transitively pulls server-only types/Mongoose into
// this client component.
import IdealAnswerComparisonCard from '@feedback/components/IdealAnswerComparisonCard'
// eslint-disable-next-line no-restricted-imports -- same reason.
import type { AnswerEvaluation } from '@shared/types'

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
  const [showOriginal, setShowOriginal] = useState(false)
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

  useEffect(() => {
    setLoading(true)
    const params = new URLSearchParams()
    if (filter) params.set('competency', filter)
    fetch(`/api/learn/drill/questions?${params}`)
      .then(r => r.json())
      .then(d => { setQuestions(d.questions || []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [filter])

  // Cancel any in-flight drill submission on unmount so the SSE
  // reader stops and we don't fire setState on an unmounted tree.
  useEffect(() => {
    return () => {
      submitControllerRef.current?.abort()
    }
  }, [])

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
      const el = e.target as HTMLElement | null
      const tag = el?.tagName
      if (tag === 'TEXTAREA' || tag === 'INPUT' || el?.isContentEditable) return
      resetDrill()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resetDrill
    // is stable enough (only reads setters); rebuilding the effect
    // on every render would attach/detach the listener pointlessly.
  }, [activeQuestion, evaluating])

  const startDrill = (q: WeakQuestion) => {
    setActiveQuestion(q)
    setNewAnswer('')
    setResult(null)
    setShowOriginal(false)
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
    if (!activeQuestion || !newAnswer.trim()) return
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
    setActiveQuestion(null)
    setNewAnswer('')
    setResult(null)
    setShowOriginal(false)
    setStreamingBreakdown(null)
    setPersistFailed(false)
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

              {/* Toggle original answer */}
              <button
                onClick={() => setShowOriginal(!showOriginal)}
                className="text-xs text-blue-400 hover:text-blue-300 mb-3"
              >
                {showOriginal ? 'Hide' : 'Show'} original answer
              </button>
              {showOriginal && (
                <div className="p-3 rounded-lg bg-[#f8fafc] text-sm text-[#8b98a5] mb-4 border border-[#e1e8ed]">
                  {activeQuestion.answer}
                </div>
              )}

              {/* Pathway P2 Wave 5 (5B) — per-question coach context.
                  Primary path: IdealAnswerComparisonCard with the
                  precomputed strong-answer outline. Fallback when
                  ideal_answers absent: thin QuestionInsightStrip with
                  the deriveCoachingTip output. Both gated on context
                  having loaded; show nothing during the fetch (the
                  textarea below is still rendered so users aren't
                  blocked on a slow context load). */}
              {!result && !questionCtxLoading && questionCtx && (
                <div className="mb-4 space-y-3">
                  {questionCtx.idealAnswer ? (
                    <IdealAnswerComparisonCard
                      ideal={{
                        questionIndex: activeQuestion.questionIndex,
                        strongAnswer: questionCtx.idealAnswer.strongAnswer,
                        keyElements: questionCtx.idealAnswer.keyElements,
                      }}
                      originalQuestion={activeQuestion.question}
                      userAnswer={activeQuestion.answer}
                      evaluation={
                        questionCtx.scores
                          ? ({
                              questionIndex: activeQuestion.questionIndex,
                              question: activeQuestion.question,
                              answer: activeQuestion.answer,
                              relevance: questionCtx.scores.relevance,
                              structure: questionCtx.scores.structure,
                              specificity: questionCtx.scores.specificity,
                              ownership: questionCtx.scores.ownership,
                              primaryGap: questionCtx.primaryGap ?? undefined,
                            } as AnswerEvaluation)
                          : null
                      }
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
                  <a
                    href={`/feedback/${encodeURIComponent(activeQuestion.sessionId)}`}
                    className="inline-block text-xs text-blue-500 hover:text-blue-600 font-medium"
                  >
                    View source feedback →
                  </a>
                </div>
              )}

              {/* New answer input */}
              {!result && (
                <>
                  <textarea
                    value={newAnswer}
                    onChange={e => setNewAnswer(e.target.value)}
                    placeholder="Type your improved answer here..."
                    rows={6}
                    className="w-full p-4 bg-white border border-[#e1e8ed] rounded-xl text-sm text-[#0f1419] placeholder:text-[#8b98a5] focus:outline-none focus:ring-2 focus:ring-blue-500/50 resize-none"
                  />
                  <button
                    onClick={submitAnswer}
                    disabled={evaluating || !newAnswer.trim()}
                    className="mt-3 px-5 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-[#eff3f4] disabled:text-[#71767b] text-white text-sm font-medium rounded-lg transition-colors"
                  >
                    {evaluating ? 'Evaluating...' : 'Submit Answer'}
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
                      <h3 className="text-sm font-medium text-[#0f1419] line-clamp-2">{q.question}</h3>
                      <div className="flex items-center gap-3 mt-2">
                        <span className="text-xs text-[#71767b]">Score: {q.avgScore}/100</span>
                        <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${
                          q.avgScore < 30 ? 'bg-red-500/10 text-[#f4212e]' :
                          q.avgScore < 50 ? 'bg-amber-500/10 text-[#d97706]' :
                          'bg-yellow-500/10 text-[#d97706]'
                        }`}>
                          {q.competency}
                        </span>
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
    </main>
  )
}
