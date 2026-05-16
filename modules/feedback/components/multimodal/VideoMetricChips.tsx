'use client'

import type { FusionSummary } from '@shared/types/multimodal'
import type { SpeechMetrics } from '@shared/types'
import { FONT_MONO } from './tokens'

interface VideoMetricChipsProps {
  fusionSummary?: FusionSummary
  speechMetrics?: SpeechMetrics[]
}

interface ChipDatum {
  label: string
  value: string
  note: string
}

/**
 * 4 chips at the bottom of the video panel — quick-read summary stats:
 *   WPM · Fillers · Eye contact · Body language
 *
 * Tiny mono label, big numeric value, tiny note. Data sources:
 *   - WPM, Fillers → aggregated from `speechMetrics[]`
 *   - Eye contact → fusionSummary.eyeContactScore
 *   - Body language → fusionSummary.overallBodyLanguageScore (Claude's
 *     holistic posture/head/expression score, already in the schema)
 *
 * Missing data renders "N/A" with no note. Layout uses `flex` with each chip
 * `flex-1 min-w-0` so they share the row evenly without overflow.
 */
function buildChips(
  fusion: FusionSummary | undefined,
  metrics: SpeechMetrics[] | undefined,
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
  const eye = fusion?.eyeContactScore ?? null
  const body = fusion?.overallBodyLanguageScore ?? null

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

  const eyeNote =
    eye == null ? '' :
    eye >= 75 ? 'strong' :
    eye >= 55 ? 'fair' :
    'low'

  const bodyNote =
    body == null ? '' :
    body >= 75 ? 'confident' :
    body >= 55 ? 'fair' :
    'work on it'

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
      label: 'Eye contact',
      value: eye != null ? `${eye}%` : 'N/A',
      note: eyeNote,
    },
    {
      label: 'Body language',
      value: body != null ? `${body}/100` : 'N/A',
      note: bodyNote,
    },
  ]
}

export default function VideoMetricChips({
  fusionSummary,
  speechMetrics,
}: VideoMetricChipsProps) {
  const chips = buildChips(fusionSummary, speechMetrics)

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
