'use client'

import { FONT_MONO } from './tokens'
import type { EmotionMarker } from './emotionChangeMarkers'

/** The 4 non-neutral MediaPipe expression classes → single-glyph emoji. */
const EXPRESSION_EMOJI: Record<string, string> = {
  smile: '🙂',
  frown: '😟',
  surprise: '😯',
  focused: '🤔',
}
const EXPRESSION_VERB: Record<string, string> = {
  smile: 'Smiled',
  frown: 'Looked concerned',
  surprise: 'Looked surprised',
  focused: 'Looked focused',
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

interface EmotionMarkersProps {
  /** Sparse emotion-change markers from computeEmotionChangeMarkers (already non-neutral). */
  markers: EmotionMarker[]
  /** Total session duration (denominator for left-percent positioning). */
  totalDurationSec: number
  /** Seek the replay to a timestamp (seconds). */
  onSeek: (sec: number) => void
}

/**
 * A thin marker row above the scrubber that shows an emoji ONLY where the
 * candidate's expression changed (see computeEmotionChangeMarkers) — replacing
 * the old one-emoji-per-question ExpressionStrip. Because markers are sparse and
 * event-based, this scales to any interview length without the overlap the
 * per-question grid produced. Hidden entirely when there are no changes.
 */
export default function EmotionMarkers({ markers, totalDurationSec, onSeek }: EmotionMarkersProps) {
  if (!markers.length || totalDurationSec <= 0) return null

  return (
    <div
      className="relative h-[20px] mx-10 mr-[100px]"
      data-testid="emotion-markers"
      aria-label="Expression changes"
    >
      {markers.map((m, i) => {
        const left = Math.max(0, Math.min(100, (m.sec / totalDurationSec) * 100))
        const emoji = EXPRESSION_EMOJI[m.expression] ?? '•'
        const verb = EXPRESSION_VERB[m.expression] ?? m.expression
        const hoverLabel = `${verb} · ${formatTime(m.sec)}`
        return (
          <button
            key={i}
            type="button"
            onClick={() => onSeek(m.sec)}
            className="absolute top-0 grid place-items-center w-6 h-5 cursor-pointer hover:scale-110 transition-transform bg-transparent border-0 p-0"
            style={{
              left: `${left}%`,
              transform: 'translateX(-50%)',
              fontSize: '14px',
              lineHeight: 1,
              fontFamily: FONT_MONO,
            }}
            title={hoverLabel}
            aria-label={hoverLabel}
          >
            <span aria-hidden="true">{emoji}</span>
          </button>
        )
      })}
    </div>
  )
}
