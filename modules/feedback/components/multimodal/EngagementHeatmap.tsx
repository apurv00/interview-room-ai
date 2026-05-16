'use client'

import { useMemo } from 'react'
import type { FacialSegment } from '@shared/types/multimodal'
import { FONT_MONO } from './tokens'
import {
  bandForEyeContact,
  downsampleHeatmap,
  type EngagementBand,
} from './engagementBands'

interface EngagementHeatmapProps {
  /** Per-second facial aggregate timeseries from
   *  `analysis.facialTimeseries[]`. Already computed by the multimodal
   *  pipeline; this is the first UI surface to consume it. */
  facialTimeseries?: FacialSegment[]
  /** Used for the percentage-width math when the strip is downsampled —
   *  we want each bucket to span (endSec − startSec) / totalDurationSec. */
  totalDurationSec: number
  /** Optional click handler. When provided, clicking a bucket seeks to its
   *  start. Mirrors the seek pattern used by every other timeline element. */
  onSeek?: (sec: number) => void
}

const BAND_COLOR: Record<EngagementBand, string> = {
  strong: '#10b981',  // emerald-500 — ≥75% eye contact
  okay: '#fbbf24',    // amber-400 — 50–74%
  weak: '#ef4444',    // red-500 — <50%
  'no-data': '#e7e5e4', // stone-200, rendered at low opacity
}

const BAND_OPACITY: Record<EngagementBand, number> = {
  strong: 1,
  okay: 1,
  weak: 1,
  'no-data': 0.15,
}

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function describeBand(band: EngagementBand, avg: number | null): string {
  if (band === 'no-data') return 'no data'
  const pct = avg != null ? `${Math.round(avg * 100)}%` : ''
  return `${band} ${pct}`.trim()
}

/**
 * Per-second engagement heatmap — a thin colored strip showing how
 * sustained the candidate's eye contact was at each second of the
 * interview. Sits directly below the SignalTrack so the SignalTrack's
 * qualitative narrative (Claude's coaching moments) and the heatmap's
 * quantitative raw signal stack as complementary readouts.
 *
 *   ▓▓▓▒▒░░░▒▓▓▓  ← per-second engagement
 *   ████████████  ← SignalTrack moments above
 *
 * Stepped 3-band color (emerald / amber / red + stone-no-data) instead
 * of a smooth gradient. Categorical perception is faster — the user
 * reads "good / okay / poor" instantly without parsing shade differences
 * that are imperceptible at 1-pixel-wide segments anyway.
 *
 * Downsampling: when the per-second timeseries would render more than
 * ~600 buckets, we group adjacent seconds into bucket means. Keeps DOM
 * count bounded AND keeps each rendered span ≥1 pixel wide so the
 * color is actually visible.
 *
 * Hidden entirely when no facialTimeseries data exists (older sessions,
 * privacy mode, camera off the whole interview) — same honest-data
 * rule as the rest of Round 5b. No placeholder grey row when we have
 * literally nothing to show.
 *
 * Round 5c feature #7.
 */
export default function EngagementHeatmap({
  facialTimeseries,
  totalDurationSec,
  onSeek,
}: EngagementHeatmapProps) {
  const buckets = useMemo(
    () => downsampleHeatmap(facialTimeseries),
    [facialTimeseries],
  )

  if (buckets.length === 0 || totalDurationSec <= 0) return null

  return (
    <div
      className="flex items-center gap-2.5 flex-shrink-0"
      data-testid="engagement-heatmap"
      aria-label="Per-second engagement (eye contact)"
    >
      <span
        className="text-[9px] uppercase tracking-[0.1em] text-stone-400 flex-shrink-0"
        style={{ fontFamily: FONT_MONO }}
      >
        Attention
      </span>
      <div className="relative h-2.5 flex-1 rounded-sm overflow-hidden bg-stone-100">
        {buckets.map((b, i) => {
          const band = bandForEyeContact(b.avgEyeContact)
          const left = (b.startSec / totalDurationSec) * 100
          const width = ((b.endSec - b.startSec) / totalDurationSec) * 100
          return (
            <button
              key={i}
              type="button"
              onClick={() => onSeek?.(b.startSec)}
              className="absolute top-0 bottom-0 cursor-pointer hover:brightness-110 p-0 border-0 m-0 block"
              style={{
                left: `${left}%`,
                width: `${Math.max(width, 0.15)}%`, // floor so sub-pixel buckets are still pickable
                background: BAND_COLOR[band],
                opacity: BAND_OPACITY[band],
              }}
              title={`${formatTime(b.startSec)} · ${describeBand(band, b.avgEyeContact)}`}
              aria-label={`At ${formatTime(b.startSec)}: ${describeBand(band, b.avgEyeContact)}`}
              data-band={band}
            />
          )
        })}
      </div>
    </div>
  )
}
