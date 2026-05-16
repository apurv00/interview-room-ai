'use client'

import { useMemo, Fragment } from 'react'
import type { WhisperSegment } from '@shared/types/multimodal'
import { FONT_MONO } from './tokens'
import { getLiveCaptionText } from './liveCaption'

interface VideoCaptionOverlayProps {
  /** Word-level segments from Whisper. */
  whisperSegments?: WhisperSegment[]
  currentTimeSec: number
}

/**
 * Inline filler-word chips. Only chip explicit `[xxx]` bracketed tokens;
 * plain occurrences of common filler words pass through (chipping these
 * would false-positive too often — e.g. "I LIKE running").
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

/**
 * Bottom-of-video live caption. Renders a true word-by-word rolling window
 * of recently-spoken words (via `getLiveCaptionText`), clamped to 2 lines.
 *
 * Per user feedback on the Round 4 polish: the prior version showed the
 * entire active WhisperSegment text and looked static between segment
 * boundaries — not actually "live". The header row (LIVE TRANSCRIPT · time ·
 * auto-scrolls) was also dropped because (a) it's obvious from the visual
 * update that the caption is live and (b) the timestamp duplicated info
 * already visible in the scrubber row below.
 */
export default function VideoCaptionOverlay({
  whisperSegments,
  currentTimeSec,
}: VideoCaptionOverlayProps) {
  const text = useMemo(
    () => getLiveCaptionText(whisperSegments, currentTimeSec),
    [whisperSegments, currentTimeSec],
  )

  if (!text) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className="absolute bottom-3.5 left-3.5 right-3.5 rounded-[10px] px-3.5 py-2 backdrop-blur-md"
      style={{
        background: 'rgba(0,0,0,0.58)',
      }}
    >
      <div
        className="text-[13.5px] leading-[1.45] -tracking-[0.005em]"
        style={{
          color: 'rgba(255,255,255,0.95)',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}
      >
        {renderWithFillerChips(text)}
      </div>
    </div>
  )
}
