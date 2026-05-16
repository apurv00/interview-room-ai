'use client'

interface ConfidenceArcCardProps {
  /** Claude's per-session 1-sentence narrative read of how confidence shifted.
   *  Sourced from `FusionSummary.confidenceProgression` — already emitted by
   *  the fusion LLM, previously discarded. */
  confidenceProgression?: string | null
  /** Per-question audio-derived confidence band, from
   *  `prosodySegments[i].confidenceMarker`. Each entry is 'high' | 'medium' |
   *  'low'. Drives the small dot-height sparkline below the narrative. */
  perQuestionConfidence?: ReadonlyArray<'high' | 'medium' | 'low'>
}

const MARKER_HEIGHT: Record<'high' | 'medium' | 'low', number> = {
  high: 16,
  medium: 10,
  low: 5,
}

const MARKER_COLOR: Record<'high' | 'medium' | 'low', string> = {
  high: '#059669', // emerald-600
  medium: '#d97706', // amber-600
  low: '#dc2626', // red-600
}

/**
 * Confidence Arc card — sits below the existing Confidence Trend chart in
 * the Overview (Feedback) tab. The chart shows the *quantitative* story
 * (numbers per question); this card shows the *qualitative* story
 *
 *   - Italic narrative line from Claude — recall-friendly per Schank &
 *     Abelson (narrative is remembered ~7× better than numbers)
 *   - Tiny per-question bar sparkline — at-a-glance shape of the arc, in
 *     the same colors the rest of the page uses for high/med/low bands
 *
 * Hidden entirely when neither input is present (multimodal analysis didn't
 * run, or fusion fell back without a narrative). Renders just the narrative
 * if perQuestionConfidence is empty, or just the sparkline if narrative is
 * missing — both pieces stand alone.
 *
 * Round 5a feature #2.
 */
export default function ConfidenceArcCard({
  confidenceProgression,
  perQuestionConfidence,
}: ConfidenceArcCardProps) {
  const hasNarrative = !!confidenceProgression && confidenceProgression.trim().length > 0
  const hasSparkline = !!perQuestionConfidence && perQuestionConfidence.length > 0

  if (!hasNarrative && !hasSparkline) return null

  return (
    <div
      className="mt-3 rounded-lg border border-stone-200 bg-stone-50 px-3.5 py-3 flex items-start gap-3.5"
      data-testid="confidence-arc-card"
    >
      {hasSparkline && (
        <div
          className="flex items-end gap-1 h-4 flex-shrink-0 pt-0.5"
          aria-label="Per-question confidence sparkline"
        >
          {perQuestionConfidence!.map((band, i) => (
            <div
              key={i}
              className="w-1 rounded-sm"
              style={{
                height: MARKER_HEIGHT[band],
                background: MARKER_COLOR[band],
              }}
              title={`Q${i + 1}: ${band}`}
            />
          ))}
        </div>
      )}
      {hasNarrative && (
        <p className="text-[13px] italic text-stone-700 leading-snug flex-1 min-w-0">
          {confidenceProgression}
        </p>
      )}
    </div>
  )
}
