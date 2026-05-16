'use client'

import { useEffect, useMemo, useRef, Fragment } from 'react'
import type { TranscriptEntry } from '@shared/types'
import { FONT_MONO } from './tokens'

interface TranscriptTabBodyProps {
  transcript: TranscriptEntry[]
  /** Drives active-line highlighting. */
  currentTimeSec: number
  /** Optional anchor for converting `timestamp` (epoch ms) to seconds-from-start.
   *  If absent, we assume `timestamp` is already seconds. */
  sessionStartedAt?: number | null
  onSeek: (sec: number) => void
}

/**
 * Convert a transcript entry's `timestamp` field to seconds-from-session-start.
 * Two regimes observed in practice:
 *  (a) `timestamp` is a real epoch ms (e.g. 1747370812345). Subtract
 *      sessionStartedAt and divide by 1000.
 *  (b) `timestamp` is already seconds-from-start (small number).
 * Heuristic: anything > 1e10 is treated as epoch ms; smaller as seconds.
 */
function entrySeconds(entry: TranscriptEntry, sessionStartedAt?: number | null): number {
  const t = entry.timestamp
  if (!Number.isFinite(t)) return 0
  if (t > 1e10) {
    if (!sessionStartedAt) return 0
    return Math.max(0, (t - sessionStartedAt) / 1000)
  }
  return Math.max(0, t)
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function renderWithFillerChips(text: string) {
  if (!text || !text.includes('[')) return text
  const parts = text.split(/(\[[^\]]+\])/g)
  return parts.map((p, i) => {
    if (p.startsWith('[') && p.endsWith(']')) {
      return (
        <span
          key={i}
          className="px-1 py-px mx-0.5 rounded-sm text-[12px] align-baseline"
          style={{
            background: '#FCE7E7',
            color: '#9F1239',
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
 * Line-level transcript list. Per the prototype:
 *   - Each row is a horizontal pair: mono timestamp button (left) + body text (right)
 *   - Active line (the latest whose start time <= currentTimeSec) gets
 *     accent color + 500 font weight + scrolls into view
 *   - Click timestamp → seek to that line's start
 *   - Filler tokens (bracketed) render as inline red chips
 *
 * Skip empty / interviewer-system lines? For now we render everything as-is;
 * the production transcript should be filtered upstream if needed.
 */
export default function TranscriptTabBody({
  transcript,
  currentTimeSec,
  sessionStartedAt,
  onSeek,
}: TranscriptTabBodyProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const lineRefs = useRef<Array<HTMLDivElement | null>>([])

  // Derive timestamps once and find active index.
  const { secs, activeIndex } = useMemo(() => {
    const list = transcript.map((e) => entrySeconds(e, sessionStartedAt))
    let idx = -1
    for (let i = 0; i < list.length; i++) {
      if (list[i] <= currentTimeSec) idx = i
      else break
    }
    return { secs: list, activeIndex: idx }
  }, [transcript, currentTimeSec, sessionStartedAt])

  // Auto-scroll active line into view. Mirrors ReplayTranscript's pattern
  // (the existing word-level transcript component). Smooth scroll; no
  // user-scroll debounce here yet — keep simple.
  useEffect(() => {
    if (activeIndex < 0) return
    const el = lineRefs.current[activeIndex]
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [activeIndex])

  if (transcript.length === 0) {
    return <p className="text-sm text-stone-400 italic p-2">Transcript not available.</p>
  }

  return (
    <div ref={containerRef} className="flex flex-col gap-3.5">
      {transcript.map((row, i) => {
        const t0 = secs[i]
        const isActive = activeIndex === i
        return (
          <div
            key={i}
            ref={(el) => { lineRefs.current[i] = el }}
            className="flex gap-3"
            data-active={isActive}
            data-line-idx={i}
          >
            <button
              type="button"
              onClick={() => onSeek(t0)}
              className={`bg-transparent border-none cursor-pointer p-0 self-start pt-[3px] min-w-[36px] text-left text-[11px] ${
                isActive
                  ? 'text-blue-600 font-semibold'
                  : 'text-stone-400 font-normal hover:text-stone-600'
              }`}
              style={{ fontFamily: FONT_MONO }}
            >
              {formatTime(t0)}
            </button>
            <div
              className={`text-[13px] leading-[1.55] ${
                isActive
                  ? 'text-stone-900 font-medium'
                  : 'text-stone-600 font-normal'
              }`}
            >
              {renderWithFillerChips(row.text)}
            </div>
          </div>
        )
      })}
    </div>
  )
}
