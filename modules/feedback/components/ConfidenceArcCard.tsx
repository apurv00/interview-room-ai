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

type ConfidenceBand = 'high' | 'medium' | 'low'

const MARKER_HEIGHT: Record<ConfidenceBand, number> = {
  high: 16,
  medium: 10,
  low: 5,
}

const MARKER_COLOR: Record<ConfidenceBand, string> = {
  high: '#059669', // emerald-600
  medium: '#d97706', // amber-600
  low: '#dc2626', // red-600
}

/**
 * Defensive coercion for prosody.confidenceMarker. The TS type is
 * `'high' | 'medium' | 'low'`, but the runtime source is a service-emitted
 * string — if the prosody service ever adds a band, renames one, or
 * upstream casts an unexpected value through, `MARKER_HEIGHT[band]` /
 * `MARKER_COLOR[band]` would silently return undefined and break the
 * inline style render.
 *
 * Codex P2 review on Round 5b — same precedent as
 * `CoachingTipsTabBody.normalizeCategory` (commit 02becb4 on PR #370).
 * Unknown values fall back to `low` so the user at least sees a marker
 * rather than a missing bar; `low` is the safest fallback because it
 * implies "we're not confident in this signal", which is consistent
 * with the actual situation.
 */
function normalizeBand(b: string | undefined): ConfidenceBand {
  if (b === 'high' || b === 'medium' || b === 'low') return b
  return 'low'
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
          {perQuestionConfidence!.map((rawBand, i) => {
            const band = normalizeBand(rawBand)
            return (
              <div
                key={i}
                className="w-1 rounded-sm"
                style={{
                  height: MARKER_HEIGHT[band],
                  background: MARKER_COLOR[band],
                }}
                title={`Q${i + 1}: ${band}`}
                data-band={band}
              />
            )
          })}
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
