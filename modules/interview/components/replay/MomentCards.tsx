'use client'

import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { Eye, Mic, Brain, Lightbulb } from 'lucide-react'
import type {
  TimelineEvent,
  ProsodySegment,
  FacialSegment,
  WhisperSegment,
} from '@shared/types/multimodal'
import QuestionRefChip from '@interview/components/feedback/QuestionRefChip'

interface QuestionMarker {
  label: string
  offsetSeconds: number
}

interface MomentCardsProps {
  moments: TimelineEvent[]
  /** Seeks the video player to the given second. Wired to analysisSeekRef from page.tsx. */
  onSeek: (seconds: number) => void
  /** Single source of truth for which card is active. Drives auto-expand and auto-scroll. */
  currentTimeSec: number
  /** Per-question audio signals — feed the active card's mini stats row. */
  prosodySegments?: ProsodySegment[]
  /** Per-question facial signals. */
  facialSegments?: FacialSegment[]
  /** Word-level transcript — feeds the active card's "what was said" excerpt. */
  whisperTranscript?: WhisperSegment[]
  /** Question boundaries — maps the active moment's startSec → questionIndex for the Q-chip. */
  questionMarkers?: QuestionMarker[]
  /** Highest valid question index — used by the Q-chip out-of-range guard. */
  maxQuestionIndex?: number
}

const SEVERITY_STYLES: Record<string, { bg: string; border: string; badge: string; ring: string; text: string }> = {
  positive: {
    bg: 'bg-emerald-50',
    border: 'border-emerald-200',
    badge: 'bg-emerald-600',
    ring: 'ring-emerald-400',
    text: 'text-emerald-700',
  },
  attention: {
    bg: 'bg-amber-50',
    border: 'border-amber-200',
    badge: 'bg-amber-600',
    ring: 'ring-amber-400',
    text: 'text-amber-700',
  },
  neutral: {
    bg: 'bg-slate-50',
    border: 'border-slate-200',
    badge: 'bg-slate-500',
    ring: 'ring-slate-400',
    text: 'text-slate-700',
  },
}

const SIGNAL_ICONS: Record<string, ReactNode> = {
  audio: <Mic className="w-3.5 h-3.5" />,
  facial: <Eye className="w-3.5 h-3.5" />,
  content: <Brain className="w-3.5 h-3.5" />,
  fused: <Lightbulb className="w-3.5 h-3.5" />,
}

const SIGNAL_DESCRIPTIONS: Record<string, string> = {
  audio: 'Detected from speech pace, fillers, and pauses',
  facial: 'Detected from eye contact, head pose, and expression',
  content: 'Detected from what was said (answer content)',
  fused: 'Detected from a combination of speech, expression, and content signals',
}

const TYPE_EMOJI: Record<string, string> = {
  strength: '↗️',
  improvement: '↘️',
  observation: '🔍',
  coaching_tip: '💡',
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

/**
 * Map a timestamp to its containing question index. Walks questionMarkers
 * (sorted by offsetSeconds ascending) and returns the marker whose
 * offsetSeconds is the largest one <= startSec. Returns null when no marker
 * covers the timestamp (moment occurs before Q1's start).
 */
function questionIndexForMoment(
  startSec: number,
  questionMarkers: QuestionMarker[] | undefined
): number | null {
  if (!questionMarkers || questionMarkers.length === 0) return null
  let last: number | null = null
  for (let i = 0; i < questionMarkers.length; i++) {
    if (questionMarkers[i].offsetSeconds <= startSec) {
      last = i
    } else {
      break
    }
  }
  return last
}

/**
 * Pull words spoken inside [startSec, endSec] from the whisper transcript
 * and join them into a short excerpt. Caps at 200 chars to keep the active
 * card readable.
 */
function transcriptExcerpt(
  startSec: number,
  endSec: number,
  whisper: WhisperSegment[] | undefined
): string {
  if (!whisper || whisper.length === 0) return ''
  const words: string[] = []
  for (const seg of whisper) {
    if (seg.end < startSec) continue
    if (seg.start > endSec) break
    for (const w of seg.words) {
      if (w.start >= startSec && w.end <= endSec) {
        words.push(w.word.trim())
      }
    }
    if (words.length > 50) break
  }
  const text = words.join(' ').replace(/\s+([,.!?;:])/g, '$1').trim()
  if (text.length > 200) return text.slice(0, 200).trimEnd() + '…'
  return text
}

interface MiniStat {
  label: string
  value: string
  hint?: string
}

function buildPerQuestionStats(
  questionIdx: number | null,
  prosody: ProsodySegment[] | undefined,
  facial: FacialSegment[] | undefined
): MiniStat[] {
  if (questionIdx == null) return []
  const stats: MiniStat[] = []

  const prosodySeg =
    prosody?.find((p) => p.questionIndex === questionIdx) ??
    (questionIdx < (prosody?.length ?? 0) ? prosody?.[questionIdx] : undefined)
  if (prosodySeg) {
    if (prosodySeg.wpm > 0) stats.push({ label: 'WPM', value: String(Math.round(prosodySeg.wpm)) })
    stats.push({ label: 'Fillers', value: String(prosodySeg.fillerWords?.length ?? 0) })
    if (prosodySeg.pauseDurationSec > 0) {
      stats.push({
        label: 'Pause',
        value: `${prosodySeg.pauseDurationSec.toFixed(1)}s`,
        hint: 'Total pause time during this question',
      })
    }
  }

  const facialSeg =
    facial?.find((f) => f.questionIndex === questionIdx) ??
    (questionIdx < (facial?.length ?? 0) ? facial?.[questionIdx] : undefined)
  if (facialSeg) {
    stats.push({
      label: 'Eye Contact',
      value: `${Math.round((facialSeg.avgEyeContact || 0) * 100)}%`,
    })
    if (facialSeg.dominantExpression && facialSeg.dominantExpression !== 'neutral') {
      stats.push({
        label: 'Expression',
        value: facialSeg.dominantExpression,
      })
    }
    if (facialSeg.gestureLevel && facialSeg.gestureLevel !== 'minimal') {
      stats.push({
        label: 'Gestures',
        value: facialSeg.gestureLevel,
      })
    }
  }

  return stats
}

/**
 * Derive which moment is "active" purely from currentTimeSec — no useState,
 * no useEffect. Last matching range wins so overlapping events resolve to
 * the most-recent. Returns null when current time is outside any range.
 * Exported for unit testing.
 */
export function findActiveIndex(moments: TimelineEvent[], currentTimeSec: number): number | null {
  for (let i = moments.length - 1; i >= 0; i--) {
    const m = moments[i]
    const end = m.endSec || m.startSec + 5
    if (currentTimeSec >= m.startSec && currentTimeSec <= end) {
      return i
    }
  }
  return null
}

export default function MomentCards({
  moments,
  onSeek,
  currentTimeSec,
  prosodySegments,
  facialSegments,
  whisperTranscript,
  questionMarkers,
  maxQuestionIndex,
}: MomentCardsProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const cardRefs = useRef<Array<HTMLDivElement | null>>([])
  // True while the user is actively scrolling the strip — suppresses
  // auto-scroll-to-active-card so user pinch/wheel scrolling is not fought.
  // Ref instead of state so flipping it never triggers a re-render.
  const userIsScrollingRef = useRef(false)
  const userScrollTimerRef = useRef<number | null>(null)

  const activeIdx = useMemo(() => findActiveIndex(moments, currentTimeSec), [moments, currentTimeSec])

  // Auto-scroll the active card into horizontal center when it changes,
  // unless the user is currently mid-scroll.
  useEffect(() => {
    if (activeIdx == null) return
    if (userIsScrollingRef.current) return
    const el = cardRefs.current[activeIdx]
    if (!el) return
    requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
    })
  }, [activeIdx])

  // Mark user-scrolling for ~1s after any wheel / touch input on the strip.
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return

    const markScrolling = () => {
      userIsScrollingRef.current = true
      if (userScrollTimerRef.current != null) {
        window.clearTimeout(userScrollTimerRef.current)
      }
      userScrollTimerRef.current = window.setTimeout(() => {
        userIsScrollingRef.current = false
      }, 1000)
    }

    scroller.addEventListener('wheel', markScrolling, { passive: true })
    scroller.addEventListener('touchmove', markScrolling, { passive: true })
    return () => {
      scroller.removeEventListener('wheel', markScrolling)
      scroller.removeEventListener('touchmove', markScrolling)
      if (userScrollTimerRef.current != null) {
        window.clearTimeout(userScrollTimerRef.current)
      }
    }
  }, [])

  if (moments.length === 0) return null

  return (
    <div
      ref={scrollerRef}
      className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1 snap-x scroll-smooth"
      role="list"
      aria-label="Key moments"
    >
      {moments.map((moment, i) => {
        const severity = moment.severity || 'neutral'
        const styles = SEVERITY_STYLES[severity] || SEVERITY_STYLES.neutral
        const isActive = activeIdx === i
        const questionIdx = isActive
          ? questionIndexForMoment(moment.startSec, questionMarkers)
          : null
        const stats = isActive
          ? buildPerQuestionStats(questionIdx, prosodySegments, facialSegments)
          : []
        const excerpt = isActive
          ? transcriptExcerpt(moment.startSec, moment.endSec || moment.startSec + 5, whisperTranscript)
          : ''

        return (
          <div
            key={i}
            ref={(el) => { cardRefs.current[i] = el }}
            data-moment-idx={i}
            data-active={isActive}
            role="listitem"
            className={`shrink-0 snap-start ${styles.bg} ${styles.border} border rounded-xl text-left transition-[width,box-shadow] duration-200 ${
              isActive
                ? `ring-2 ${styles.ring}`
                : 'hover:shadow-md'
            }`}
            style={{
              width: isActive ? 'min(560px, calc(100vw - 32px))' : '180px',
            }}
          >
            <button
              type="button"
              onClick={() => onSeek(moment.startSec)}
              className="w-full text-left p-3 cursor-pointer rounded-xl"
              aria-pressed={isActive}
              aria-label={isActive ? `${moment.title} (active)` : `Jump to ${moment.title} at ${formatTime(moment.startSec)}`}
            >
              <div className="flex items-center gap-2 mb-1.5">
                <span className={`${styles.badge} text-white text-xs font-mono px-2 py-0.5 rounded-md`}>
                  {formatTime(moment.startSec)}
                </span>
                <span className="text-sm">{TYPE_EMOJI[moment.type] || ''}</span>
                {!isActive && (
                  <span className="ml-auto text-[#8b98a5]">
                    {SIGNAL_ICONS[moment.signal] || <Lightbulb className="w-3.5 h-3.5" />}
                  </span>
                )}
              </div>
              <p className="text-sm font-medium text-[#0f1419] leading-snug">{moment.title}</p>
              {/* Compact card: title + tiny truncated description so the user
                  can scan the strip horizontally; full description lives in the
                  active expanded body below. */}
              {!isActive && (
                <p className="text-caption text-[#71767b] mt-0.5 line-clamp-2">{moment.description}</p>
              )}
            </button>

            {/* Active expanded body — only renders for the card matching currentTimeSec.
                No separate Watch button: clicking the header above seeks. */}
            {isActive && (
              <div className="px-3 pb-3 pt-0 border-t border-current/10 space-y-2.5">
                <p className="text-body text-[#0f1419] leading-relaxed pt-2">
                  {moment.description}
                </p>

                {/* Question reference */}
                {questionIdx != null && (
                  <div className="flex items-center gap-2">
                    <span className="text-caption text-[#71767b] font-medium">Asked during</span>
                    <QuestionRefChip
                      questionIndex={questionIdx}
                      maxQuestionIndex={maxQuestionIndex}
                      tone="accent"
                    />
                  </div>
                )}

                {/* Per-question signal mini-row */}
                {stats.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {stats.map((stat) => (
                      <span
                        key={stat.label}
                        className="inline-flex items-baseline gap-1.5 px-2.5 py-1 rounded-md bg-white border border-[#e1e8ed] text-xs"
                        title={stat.hint}
                      >
                        <span className="text-[#71767b]">{stat.label}</span>
                        <span className="font-bold text-[#0f1419]">{stat.value}</span>
                      </span>
                    ))}
                  </div>
                )}

                {/* Transcript excerpt — what was said here */}
                {excerpt && (
                  <div>
                    <p className="text-caption text-[#71767b] uppercase tracking-wide font-medium mb-1">
                      What was said
                    </p>
                    <p className="text-xs text-[#0f1419] leading-relaxed bg-white/70 border border-current/10 rounded-md p-2 italic">
                      &ldquo;{excerpt}&rdquo;
                    </p>
                  </div>
                )}

                {/* Signal-source narrative */}
                <div className="flex items-center gap-1.5 text-[#536471]">
                  {SIGNAL_ICONS[moment.signal] || <Lightbulb className="w-3.5 h-3.5" />}
                  <span className="text-xs">
                    {SIGNAL_DESCRIPTIONS[moment.signal] || `Signal: ${moment.signal}`}
                  </span>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
