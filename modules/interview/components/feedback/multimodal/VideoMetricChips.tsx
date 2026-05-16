'use client'

import type { FusionSummary } from '@shared/types/multimodal'
import type { SpeechMetrics } from '@shared/types'
import { FONT_MONO } from './tokens'

interface VideoMetricChipsProps {
  fusionSummary?: FusionSummary
  speechMetrics?: SpeechMetrics[]
  /** Optional dominant expression — derived in MultimodalAnalysisTab from per-Q facial segments. */
  dominantExpression?: string | null
}

interface ChipDatum {
  label: string
  value: string
  note: string
}

/**
 * 5 chips at the bottom of the video panel — quick-read summary stats:
 *   WPM · Fillers · Avg pause · Eye contact · Expression
 *
 * Mirrors the prototype's `OVERALL_METRICS` shape: tiny mono label, big
 * numeric value, tiny note. Data sources:
 *   - WPM, Fillers count, Avg pause → aggregated from `speechMetrics[]`
 *   - Eye contact → fusionSummary.eyeContactScore
 *   - Expression → caller-provided (page level derives from facialSegments)
 *
 * Missing data renders "N/A" with no note. Layout uses `flex` with each chip
 * `flex-1 min-w-0` so they share the row evenly without overflow.
 */
function buildChips(
  fusion: FusionSummary | undefined,
  metrics: SpeechMetrics[] | undefined,
  dominantExpression: string | null | undefined
): ChipDatum[] {
  const valid = (metrics || []).filter((m) => m && m.totalWords > 0)
  const totalWords = valid.reduce((s, m) => s + m.totalWords, 0)
  const avgWpm = valid.length > 0
    ? Math.round(valid.reduce((s, m) => s + (m.wpm || 0), 0) / valid.length)
    : null
  const totalFillers = valid.reduce((s, m) => s + Math.round((m.fillerRate || 0) * (m.totalWords || 0)), 0)
  const fillerRate = totalWords > 0 ? (totalFillers / totalWords) : null
  const totalDurationMinutes = valid.reduce((s, m) => s + (m.durationMinutes || 0), 0)
  const fillersPerMin = totalDurationMinutes > 0
    ? (totalFillers / totalDurationMinutes).toFixed(1)
    : null
  const avgPauseScore = valid.length > 0
    ? valid.reduce((s, m) => s + (m.pauseScore || 0), 0) / valid.length
    : null
  // Convert the 0–100 pauseScore into an approximate "average pause length"
  // for display. Lower score = longer pauses; we just show the score with
  // a note rather than fabricating a seconds figure we don't have.
  const eye = fusion?.eyeContactScore ?? null

  const wpmNote =
    avgWpm == null ? '' :
    avgWpm < 110 ? 'slow' :
    avgWpm > 170 ? 'fast' :
    'ideal 130–150'

  const fillerNote =
    fillerRate == null ? '' :
    fillerRate > 0.08 ? 'high' :
    fillerRate > 0.04 ? `${fillersPerMin ?? '?'}/min` :
    'low'

  const pauseNote =
    avgPauseScore == null ? '' :
    avgPauseScore >= 70 ? 'on target' :
    avgPauseScore >= 50 ? 'fair' :
    'above target'

  const eyeNote =
    eye == null ? '' :
    eye >= 75 ? 'strong' :
    eye >= 55 ? 'fair' :
    'low'

  return [
    {
      label: 'WPM',
      value: avgWpm != null ? String(avgWpm) : 'N/A',
      note: wpmNote,
    },
    {
      label: 'Fillers',
      value: fillerRate != null ? `${(fillerRate * 100).toFixed(0)}%` : 'N/A',
      note: fillerNote,
    },
    {
      label: 'Avg pause',
      value: avgPauseScore != null ? `${Math.round(avgPauseScore)}/100` : 'N/A',
      note: pauseNote,
    },
    {
      label: 'Eye contact',
      value: eye != null ? `${eye}%` : 'N/A',
      note: eyeNote,
    },
    {
      label: 'Expression',
      value: dominantExpression || 'N/A',
      note: dominantExpression ? 'most-common' : '',
    },
  ]
}

export default function VideoMetricChips({
  fusionSummary,
  speechMetrics,
  dominantExpression,
}: VideoMetricChipsProps) {
  const chips = buildChips(fusionSummary, speechMetrics, dominantExpression)

  return (
    <div className="flex gap-2 flex-shrink-0">
      {chips.map((chip) => (
        <div
          key={chip.label}
          className="flex-1 min-w-0 px-2.5 py-2 rounded-lg bg-white border border-stone-200 flex flex-col gap-0.5"
        >
          <div
            className="text-[10px] text-stone-400 uppercase tracking-[0.04em]"
            style={{ fontFamily: FONT_MONO }}
          >
            {chip.label}
          </div>
          <div className="text-[17px] font-semibold text-stone-900 -tracking-[0.02em]">
            {chip.value}
          </div>
          {chip.note && (
            <div className="text-[10px] text-stone-600 truncate">{chip.note}</div>
          )}
        </div>
      ))}
    </div>
  )
}
