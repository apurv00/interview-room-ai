'use client'

import { useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ScoreBar } from '@shared/ui/ScoreBar'
import { answerSuggestion } from '@shared/lib/answerSuggestion'

interface FourDimScores {
  relevance: number
  structure: number
  specificity: number
  ownership: number
}

interface Props {
  open: boolean
  onClose: () => void
  sessionId: string
  question: string
  originalAnswer: string
  scores: FourDimScores | null
  /** Source session's interview-type slug — drives domain-aware suggestion copy
   *  (coding/system-design/academics get non-STAR advice). From the drill
   *  context API. Omitted → behavioral copy. */
  interviewType?: string | null
  /** Source answer's LLM-declared weakest dimension, if any (drill context API). */
  primaryGap?: string | null
}

/**
 * Slide-in drawer that surfaces "source feedback" for the question
 * the user is drilling — replaces the prior `/feedback/[id]` page
 * navigation. Shows the original answer + score breakdown + a
 * deterministic suggestion (lifted from QuestionBreakdown so the
 * copy stays consistent between the feedback page and the drill).
 * A trailing link still lets users open the full session feedback
 * in a new tab if they want the page-level view (multimodal, all
 * questions, etc.).
 *
 * Why a drawer and not a modal: doesn't block the question, easy to
 * reference the drill content while reading feedback, room for richer
 * content than a center modal.
 *
 * Why no LLM-generated prose per question: there isn't any in this
 * codebase. `AnswerEvaluation` carries scores + primaryGap +
 * answerSummary, never a long-form qualitative narrative. The
 * feedback page itself renders the same deterministic suggestion
 * we reuse here (see modules/feedback/components/QuestionBreakdown).
 */
export default function SourceFeedbackDrawer({
  open,
  onClose,
  sessionId,
  question,
  originalAnswer,
  scores,
  interviewType,
  primaryGap,
}: Props) {
  // Esc closes the drawer. Bound only when open to avoid wasted
  // listener churn.
  //
  // NOTE on coordination with the drill page's own Esc handler:
  // both listeners are on `window`, so stopPropagation/Immediate
  // from here would NOT stop a sibling window listener (and the
  // drill listener was registered first, so it would run before
  // this one anyway). The coordination lives on the drill side —
  // it short-circuits when `feedbackDrawerOpenRef` is true. So
  // closing the drawer via Esc only dismisses the drawer; the
  // drill stays open. Codex P1 on PR #393.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Shared weakest-dimension helper — keeps the drill and the feedback page in
  // lockstep. Domain-aware via the source session's interviewType + primaryGap
  // (from the drill context API), so a coding/design/academics-sourced drill
  // doesn't get behavioral STAR advice. Returns null when avg ≥ 60.
  const suggestion = scores
    ? answerSuggestion({ ...scores, primaryGap: primaryGap ?? undefined }, interviewType ?? undefined)
    : null

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop — click outside to close. z-index sits ABOVE
              the drill page chrome but BELOW the drawer panel so
              the panel's own click events don't bubble through. */}
          <motion.div
            className="fixed inset-0 bg-black/30 z-40"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={onClose}
            aria-hidden
          />
          <motion.aside
            data-testid="source-feedback-drawer"
            className="fixed top-0 right-0 h-full w-full sm:max-w-md bg-white shadow-2xl z-50 flex flex-col"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 28, stiffness: 280 }}
            role="dialog"
            aria-modal="true"
            aria-label="Source feedback for this question"
          >
            {/* Header — sticky so the close button is always reachable
                while the content scrolls. */}
            <div className="shrink-0 border-b border-[#e1e8ed] px-5 py-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-[#0f1419]">Source feedback</h2>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close source feedback"
                className="inline-flex items-center justify-center w-8 h-8 rounded-lg text-[#536471] hover:bg-[#f8fafc] hover:text-[#0f1419] transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Body — scrollable. */}
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
              <section>
                <p className="text-[11px] font-medium uppercase tracking-wide text-[#8b98a5] mb-1">Question</p>
                <p className="text-sm text-[#536471] leading-relaxed">{question}</p>
              </section>

              <section>
                <p className="text-[11px] font-medium uppercase tracking-wide text-[#8b98a5] mb-1">
                  Your original answer
                </p>
                <p className="text-sm text-[#536471] leading-relaxed bg-[#f8fafc] rounded-xl p-3 whitespace-pre-wrap">
                  {originalAnswer || (
                    <span className="italic text-[#8b98a5]">No answer captured</span>
                  )}
                </p>
              </section>

              {scores && (
                <section>
                  <p className="text-[11px] font-medium uppercase tracking-wide text-[#8b98a5] mb-2">
                    Score breakdown
                  </p>
                  <div className="space-y-2">
                    <ScoreBar label="Relevance" score={scores.relevance} delay={0} />
                    <ScoreBar label="Structure (STAR)" score={scores.structure} delay={50} />
                    <ScoreBar label="Specificity" score={scores.specificity} delay={100} />
                    <ScoreBar label="Ownership" score={scores.ownership} delay={150} />
                  </div>
                </section>
              )}

              {suggestion && (
                <section className="rounded-xl bg-amber-50 border border-amber-200 p-3">
                  <p className="text-[11px] font-medium uppercase tracking-wide text-amber-700 mb-1">
                    Suggestion
                  </p>
                  <p className="text-xs text-amber-700 leading-relaxed">{suggestion}</p>
                </section>
              )}

              <a
                href={`/feedback/${encodeURIComponent(sessionId)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-blue-500 hover:text-blue-600 font-medium"
              >
                Open full session feedback
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M14 5l7 7m0 0l-7 7m7-7H3" />
                </svg>
              </a>
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  )
}
