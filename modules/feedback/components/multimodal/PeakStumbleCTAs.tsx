'use client'

import type { TimelineEvent } from '@shared/types/multimodal'
import { FONT_MONO } from './tokens'

interface PeakStumbleCTAsProps {
  topMoments?: TimelineEvent[]
  improvementMoments?: TimelineEvent[]
  onSeek: (sec: number) => void
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

/**
 * Peak-end-rule shortcuts: two pill buttons that jump the video to the
 * single most-defining peak and the single most-defining stumble of the
 * session. Powered by `FusionSummary.topMoments[0]` and
 * `improvementMoments[0]` (Claude already orders both lists by severity /
 * importance, so the first entry is the right one to surface).
 *
 * Hidden when neither array has an entry (privacy-mode sessions, brand-
 * new sessions before fusion completes). When only one side exists, we
 * show only that button — never an empty placeholder.
 *
 * Round 5a feature #10.
 */
export default function PeakStumbleCTAs({
  topMoments,
  improvementMoments,
  onSeek,
}: PeakStumbleCTAsProps) {
  const peak = topMoments && topMoments.length > 0 ? topMoments[0] : null
  const stumble = improvementMoments && improvementMoments.length > 0 ? improvementMoments[0] : null

  if (!peak && !stumble) return null

  return (
    <div className="flex gap-2 flex-shrink-0" aria-label="Jump to defining moments">
      {peak && (
        <button
          type="button"
          onClick={() => onSeek(peak.startSec)}
          className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 cursor-pointer transition-colors min-w-0"
          title={peak.title}
        >
          <span className="text-[11px] font-semibold" style={{ fontFamily: FONT_MONO }}>
            ▶ Peak
          </span>
          <span className="text-[11px] text-emerald-700 truncate min-w-0 max-w-[260px]">
            {peak.title}
          </span>
          <span className="text-[10px] text-emerald-700/70 flex-shrink-0" style={{ fontFamily: FONT_MONO }}>
            {formatTime(peak.startSec)}
          </span>
        </button>
      )}
      {stumble && (
        <button
          type="button"
          onClick={() => onSeek(stumble.startSec)}
          className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100 cursor-pointer transition-colors min-w-0"
          title={stumble.title}
        >
          <span className="text-[11px] font-semibold" style={{ fontFamily: FONT_MONO }}>
            ▶ Stumble
          </span>
          <span className="text-[11px] text-amber-700 truncate min-w-0 max-w-[260px]">
            {stumble.title}
          </span>
          <span className="text-[10px] text-amber-700/70 flex-shrink-0" style={{ fontFamily: FONT_MONO }}>
            {formatTime(stumble.startSec)}
          </span>
        </button>
      )}
    </div>
  )
}
