'use client'

import type { FusionSummary } from '@shared/types/multimodal'
import type { SpeechMetrics } from '@shared/types'

interface MultimodalScoreChipsProps {
  fusionSummary?: FusionSummary
  speechMetrics?: SpeechMetrics[]
}

interface Chip {
  label: string
  value: string
  numeric: number | null
  invertColor?: boolean // true = lower is better (e.g. filler rate)
  tooltip?: string
}

function bandClass(numeric: number | null, invert: boolean): string {
  if (numeric == null) return 'border-[#e1e8ed] bg-[#f8fafc] text-[#71767b]'
  // Normalize to "higher is better" before banding
  const v = invert ? 100 - numeric : numeric
  if (v >= 75) return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700'
  if (v >= 55) return 'border-amber-500/30 bg-amber-500/10 text-amber-700'
  return 'border-red-500/30 bg-red-500/10 text-red-700'
}

function buildChips(
  fusion: FusionSummary | undefined,
  metrics: SpeechMetrics[] | undefined
): Chip[] {
  // Eye contact + body language come from the multimodal fusion summary
  const eye = fusion?.eyeContactScore ?? null
  const body = fusion?.overallBodyLanguageScore ?? null

  // Filler rate + WPM come from per-question speech metrics; aggregate across questions
  const validMetrics = (metrics || []).filter((m) => m && m.totalWords > 0)
  const totalWords = validMetrics.reduce((s, m) => s + m.totalWords, 0)
  const avgFillerRate =
    totalWords > 0
      ? validMetrics.reduce((s, m) => s + (m.fillerRate || 0) * m.totalWords, 0) / totalWords
      : null
  const avgWpm =
    validMetrics.length > 0
      ? Math.round(
          validMetrics.reduce((s, m) => s + (m.wpm || 0), 0) / validMetrics.length
        )
      : null

  const fillerPct = avgFillerRate != null ? Math.round(avgFillerRate * 100) : null
  // Score filler rate: 0–4% = excellent (90+), 4–8% = ok, 8%+ = poor.
  // Surface as a 0–100 numeric for banding (invertColor = true).
  const fillerNumeric = fillerPct != null ? Math.min(100, fillerPct * 8) : null

  // WPM ideal range 120–160. Distance from 140 maps to a 0–100 quality score.
  const wpmNumeric =
    avgWpm != null ? Math.max(0, 100 - Math.abs(avgWpm - 140) * 2) : null

  return [
    {
      label: 'Eye Contact',
      value: eye != null ? `${eye}/100` : 'N/A',
      numeric: eye,
      tooltip: eye == null ? 'No facial data captured' : undefined,
    },
    {
      label: 'Body Language',
      value: body != null ? `${body}/100` : 'N/A',
      numeric: body,
      tooltip: body == null ? 'No facial data captured' : undefined,
    },
    {
      label: 'Filler Rate',
      value: fillerPct != null ? `${fillerPct}%` : 'N/A',
      numeric: fillerNumeric,
      invertColor: true,
      tooltip: fillerPct == null ? 'No speech data captured' : 'Lower is better',
    },
    {
      label: 'Speaking Pace',
      value: avgWpm != null ? `${avgWpm} wpm` : 'N/A',
      numeric: wpmNumeric,
      tooltip: avgWpm == null ? 'No speech data captured' : 'Ideal range: 120–160 wpm',
    },
  ]
}

export default function MultimodalScoreChips({
  fusionSummary,
  speechMetrics,
}: MultimodalScoreChipsProps) {
  const chips = buildChips(fusionSummary, speechMetrics)

  return (
    <section className="grid grid-cols-2 sm:grid-cols-4 gap-3" aria-label="Multimodal aggregate scores">
      {chips.map((chip) => (
        <div
          key={chip.label}
          className={`rounded-xl border px-4 py-3 ${bandClass(chip.numeric, chip.invertColor ?? false)}`}
          title={chip.tooltip}
        >
          <p className="text-[11px] uppercase tracking-wide opacity-70 font-medium">
            {chip.label}
          </p>
          <p className="text-xl font-bold mt-1">{chip.value}</p>
        </div>
      ))}
    </section>
  )
}
