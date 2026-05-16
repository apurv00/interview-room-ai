'use client'

import { useMemo, Fragment } from 'react'
import type { WhisperSegment } from '@shared/types/multimodal'
import { FONT_MONO } from './tokens'

interface VideoCaptionOverlayProps {
  /** Word-level segments from Whisper. The active segment is the latest
   *  one whose `start <= currentTimeSec`. */
  whisperSegments?: WhisperSegment[]
  currentTimeSec: number
}

/**
 * Inline filler-word chips. The prototype marks fillers with `[uh]`-style
 * brackets in the transcript text; production transcripts may or may not
 * carry the same markers. We support BOTH:
 *  (1) explicit `[xxx]` tokens (split + chip)
 *  (2) free-text occurrences of common filler words rendered as plain text
 *      (chipping these would false-positive too often — e.g. "I LIKE running")
 *
 * Approach: only chip `[xxx]` bracketed tokens. Plain text passes through.
 */
function renderWithFillerChips(text: string) {
  if (!text || !text.includes('[')) return text
  const parts = text.split(/(\[[^\]]+\])/g)
  return parts.map((p, i) => {
    if (p.startsWith('[') && p.endsWith(']')) {
      return (
        <span
          key={i}
          className="px-[5px] py-px mx-0.5 rounded-sm text-[12px] font-semibold align-baseline"
          style={{
            background: 'rgba(252,164,164,0.25)',
            color: '#fecaca',
            fontFamily: FONT_MONO,
          }}
        >
          {p.slice(1, -1)}
        </span>
      )
    }
    return <Fragment key={i}>{p}</Fragment>
  })
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

/**
 * Bottom-of-video live caption. Re-keyed on segment change so the new line
 * cleanly animates in (CSS keyframes defined in globals.css would be ideal;
 * for self-contained safety we use an inline animation via React state.
 * Since the key change forces a remount, the CSS `animation:` property on
 * mount-only is sufficient).
 */
export default function VideoCaptionOverlay({
  whisperSegments,
  currentTimeSec,
}: VideoCaptionOverlayProps) {
  const active = useMemo(() => {
    if (!whisperSegments || whisperSegments.length === 0) return null
    // Latest segment whose `start <= currentTimeSec`. Linear walk is fine
    // (transcripts are small; binary search would be over-engineering here).
    let found: { segment: WhisperSegment; index: number } | null = null
    for (let i = 0; i < whisperSegments.length; i++) {
      const seg = whisperSegments[i]
      if (seg.start <= currentTimeSec) {
        found = { segment: seg, index: i }
      } else {
        break
      }
    }
    // Before the first line, show the first as upcoming so the overlay isn't empty.
    return found ?? { segment: whisperSegments[0], index: 0 }
  }, [whisperSegments, currentTimeSec])

  if (!active) return null

  return (
    <div
      // `key` forces remount so the CSS animation re-fires on every line change.
      key={active.index}
      role="status"
      aria-live="polite"
      className="absolute bottom-3.5 left-3.5 right-3.5 rounded-[10px] px-3.5 py-2.5 backdrop-blur-md space-y-1"
      style={{
        background: 'rgba(0,0,0,0.58)',
        maxHeight: 110,
        overflow: 'hidden',
        animation: 'multimodal-caption-in 0.35s ease',
      }}
    >
      <div className="flex items-center gap-2">
        <span
          className="text-[10px] font-semibold uppercase tracking-[0.06em]"
          style={{
            color: 'rgba(255,255,255,0.55)',
            fontFamily: FONT_MONO,
          }}
        >
          Live transcript · {formatTime(active.segment.start)}
        </span>
        <span
          className="text-[10px]"
          style={{
            color: 'rgba(255,255,255,0.4)',
            fontFamily: FONT_MONO,
          }}
        >
          auto-scrolls with playback
        </span>
      </div>
      <div
        className="text-[13.5px] leading-[1.5] -tracking-[0.005em]"
        style={{
          color: 'rgba(255,255,255,0.95)',
          display: '-webkit-box',
          WebkitLineClamp: 3,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}
      >
        {renderWithFillerChips(active.segment.text)}
      </div>
    </div>
  )
}
