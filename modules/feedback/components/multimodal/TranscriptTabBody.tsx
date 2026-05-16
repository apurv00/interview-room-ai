'use client'

import { useEffect, useMemo, useRef, Fragment } from 'react'
import type { TranscriptEntry } from '@shared/types'
import type { WhisperSegment } from '@shared/types/multimodal'
import { FONT_MONO } from './tokens'
import { computeTranscriptSeconds } from './transcriptOffsets'
import {
  buildWhisperWordIndex,
  clarityForLine,
  type LineWord,
} from './clarityIndex'

interface TranscriptTabBodyProps {
  transcript: TranscriptEntry[]
  /** Drives active-line highlighting. */
  currentTimeSec: number
  /** Optional anchor for converting `timestamp` (epoch ms) to seconds-from-start.
   *  If absent, the offsets util falls back to the first transcript entry's
   *  timestamp as the origin (preserves relative spacing). */
  sessionStartedAt?: number | null
  onSeek: (sec: number) => void
  /** Round 5b feature #4 — when provided, the per-word ASR confidence is
   *  used to fade candidate words below the LOW_CLARITY_THRESHOLD (0.8) so
   *  the user can see where they sounded unclear. Interviewer lines are
   *  never faded (no candidate-voice ASR data for them). */
  whisperSegments?: WhisperSegment[]
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
 * Render a line word-by-word, applying the dotted-underline + reduced
 * opacity treatment to tokens flagged as low-clarity by the clarityIndex
 * helper. Bracketed filler markers ([uh], [like]) still chip via the
 * existing pipeline — clarity flagging only applies to plain word tokens.
 *
 * Round 5b feature #4.
 */
function renderWithClarityHighlights(words: LineWord[]) {
  return words.map((w, i) => {
    // Bracketed filler — render as the chip (mirrors renderWithFillerChips).
    if (w.raw.startsWith('[') && w.raw.endsWith(']')) {
      return (
        <Fragment key={i}>
          <span
            className="px-1 py-px mx-0.5 rounded-sm text-[12px] align-baseline"
            style={{
              background: '#FCE7E7',
              color: '#9F1239',
              fontFamily: FONT_MONO,
            }}
          >
            {w.raw.slice(1, -1)}
          </span>
          {i < words.length - 1 ? ' ' : ''}
        </Fragment>
      )
    }
    if (w.isLowClarity) {
      return (
        <Fragment key={i}>
          <span
            className="underline decoration-dotted decoration-stone-400"
            style={{ opacity: 0.65 }}
            data-clarity="low"
          >
            {w.raw}
          </span>
          {i < words.length - 1 ? ' ' : ''}
        </Fragment>
      )
    }
    return (
      <Fragment key={i}>
        {w.raw}
        {i < words.length - 1 ? ' ' : ''}
      </Fragment>
    )
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
  whisperSegments,
}: TranscriptTabBodyProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const lineRefs = useRef<Array<HTMLDivElement | null>>([])

  // Derive timestamps once and find active index. Uses computeTranscriptSeconds
  // which picks sessionStartedAt as the epoch-ms origin when present, or falls
  // back to the first transcript entry's timestamp when missing (Codex P2 on
  // PR #370 — previous behavior collapsed every line to 0:00 in that case).
  const { secs, activeIndex } = useMemo(() => {
    const list = computeTranscriptSeconds(transcript, sessionStartedAt)
    let idx = -1
    for (let i = 0; i < list.length; i++) {
      if (list[i] <= currentTimeSec) idx = i
      else break
    }
    return { secs: list, activeIndex: idx }
  }, [transcript, currentTimeSec, sessionStartedAt])

  // Round 5b feature #4 — per-word clarity annotations for each line.
  // Built once per transcript/whisper change; lookup is then O(line words).
  // Interviewer lines are skipped (no candidate-voice ASR data for them).
  const clarityByLine = useMemo(() => {
    const index = buildWhisperWordIndex(whisperSegments)
    if (index.length === 0) return null
    const out: Array<LineWord[] | null> = []
    for (let i = 0; i < transcript.length; i++) {
      const row = transcript[i]
      if (row.speaker !== 'candidate') {
        out.push(null)
        continue
      }
      const start = secs[i]
      const end = i + 1 < secs.length ? secs[i + 1] : Number.POSITIVE_INFINITY
      out.push(clarityForLine(row.text, start, end, index))
    }
    return out
  }, [transcript, whisperSegments, secs])

  // Whether any word in any line is flagged low-clarity — drives the
  // one-line legend at the top of the tab body. We don't render the
  // legend pre-emptively because most users won't have low-clarity
  // words to explain.
  const hasAnyLowClarity = useMemo(() => {
    if (!clarityByLine) return false
    for (const line of clarityByLine) {
      if (!line) continue
      for (const w of line) if (w.isLowClarity) return true
    }
    return false
  }, [clarityByLine])

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
      {hasAnyLowClarity && (
        <p
          className="text-[11px] italic text-stone-400 px-1"
          data-testid="transcript-clarity-legend"
        >
          Faded words = the AI heard them unclearly — often a mumble signal.
        </p>
      )}
      {transcript.map((row, i) => {
        const t0 = secs[i]
        const isActive = activeIndex === i
        const clarityWords = clarityByLine?.[i]
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
              {clarityWords
                ? renderWithClarityHighlights(clarityWords)
                : renderWithFillerChips(row.text)}
            </div>
          </div>
        )
      })}
    </div>
  )
}
