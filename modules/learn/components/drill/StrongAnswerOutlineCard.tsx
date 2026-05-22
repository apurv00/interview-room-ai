'use client'

interface Props {
  /** The "strong-answer outline" — full prose model answer that demonstrates
   *  how the question SHOULD be answered. Source: post-interview
   *  enrichment populates `FeedbackData.ideal_answers[].strongAnswer`. */
  strongAnswer: string
  /** Bullet-list of the concrete elements a strong answer contains
   *  (e.g. "Cites funnel data", "Explains the tradeoff between options"). */
  keyElements: string[]
}

/**
 * Drill-mode coach card. Replaces the heavier IdealAnswerComparisonCard
 * on the drill page — which showed 5 sections (Q label + score, original
 * answer, score breakdown, why it scored low, strong-answer outline, key
 * elements) and visibly duplicated content the user already had access
 * to elsewhere on the drill page:
 *
 *   - Question text is the heading right above the card
 *   - Avg score + weak-dim are chips above the card
 *   - Original answer is in the source-feedback drawer (PR #393)
 *   - Score breakdown + why-it-scored-low are in that same drawer
 *
 * What's left — and the only thing the user explicitly asked us to keep
 * ("good to accomodate the suggested structure") — is the prescriptive
 * guidance: what a strong answer looks like, and which elements make
 * it strong. Hence this slim 2-section card.
 *
 * Used only by the drill page; the feedback page continues to use the
 * full IdealAnswerComparisonCard.
 */
export default function StrongAnswerOutlineCard({ strongAnswer, keyElements }: Props) {
  const hasOutline = !!strongAnswer
  const hasElements = keyElements && keyElements.length > 0
  if (!hasOutline && !hasElements) return null

  return (
    <article
      data-testid="strong-answer-outline-card"
      className="surface-card-bordered p-4 sm:p-5 space-y-4"
    >
      {hasOutline && (
        <section>
          <p className="text-[11px] uppercase tracking-wide text-[#71767b] font-medium mb-1.5">
            Example strong answer
          </p>
          <p className="text-sm text-[#0f1419] leading-relaxed bg-emerald-50 border border-emerald-200 rounded-xl p-3 whitespace-pre-line">
            {strongAnswer}
          </p>
        </section>
      )}

      {hasElements && (
        <section>
          <p className="text-[11px] uppercase tracking-wide text-[#71767b] font-medium mb-2">
            What to include
          </p>
          <div className="flex flex-wrap gap-1.5">
            {keyElements.map((el, i) => (
              <span
                key={i}
                className="inline-block text-xs text-[#536471] bg-[#f8fafc] border border-[#e1e8ed] rounded-full px-2.5 py-1"
              >
                {el}
              </span>
            ))}
          </div>
        </section>
      )}
    </article>
  )
}
