'use client'

import { useState, type ReactNode } from 'react'
import { Eye, Mic, Brain, Lightbulb, Play, ChevronDown } from 'lucide-react'
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
  /** Optional context: per-question audio signals. Drives the expanded card's mini stats row. */
  prosodySegments?: ProsodySegment[]
  /** Optional context: per-question facial signals. */
  facialSegments?: FacialSegment[]
  /** Optional context: word-level transcript. Drives the "what was said here" excerpt. */
  whisperTranscript?: WhisperSegment[]
  /** Optional context: question boundaries (offsetSeconds). Maps moment.startSec → questionIndex. */
  questionMarkers?: QuestionMarker[]
  /** Highest valid question index — used by the Q-chip out-of-range guard. */
  maxQuestionIndex?: number
}

const SEVERITY_STYLES: Record<string, { bg: string; border: string; badge: string; ring: string }> = {
  positive: {
    bg: 'bg-emerald-50',
    border: 'border-emerald-200',
    badge: 'bg-emerald-600',
    ring: 'ring-emerald-300',
  },
  attention: {
    bg: 'bg-amber-50',
    border: 'border-amber-200',
    badge: 'bg-amber-600',
    ring: 'ring-amber-300',
  },
  neutral: {
    bg: 'bg-slate-50',
    border: 'border-slate-200',
    badge: 'bg-slate-500',
    ring: 'ring-slate-300',
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
 * (sorted by offsetSeconds ascending) and returns the index of the marker
 * whose offsetSeconds is the largest one <= startSec. Returns null when no
 * marker covers the timestamp (moment occurs before Q1's start).
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
 * Pull the words spoken inside [startSec, endSec] from the whisper transcript
 * and join them into a short excerpt. Caps at 200 chars to keep the expanded
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

export default function MomentCards({
  moments,
  onSeek,
  prosodySegments,
  facialSegments,
  whisperTranscript,
  questionMarkers,
  maxQuestionIndex,
}: MomentCardsProps) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)

  if (moments.length === 0) return null

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 items-start">
      {moments.map((moment, i) => {
        const severity = moment.severity || 'neutral'
        const styles = SEVERITY_STYLES[severity] || SEVERITY_STYLES.neutral
        const isExpanded = expandedIdx === i
        const questionIdx = questionIndexForMoment(moment.startSec, questionMarkers)
        const stats = isExpanded
          ? buildPerQuestionStats(questionIdx, prosodySegments, facialSegments)
          : []
        const excerpt = isExpanded
          ? transcriptExcerpt(moment.startSec, moment.endSec || moment.startSec + 5, whisperTranscript)
          : ''

        return (
          <div
            key={i}
            data-moment-idx={i}
            className={`${styles.bg} ${styles.border} border rounded-xl text-left transition-all ${
              isExpanded ? `ring-2 ${styles.ring} sm:col-span-2 lg:col-span-3` : 'hover:shadow-md'
            }`}
          >
            {/* Header — always visible. Click anywhere here toggles expansion. */}
            <button
              type="button"
              onClick={() => setExpandedIdx(isExpanded ? null : i)}
              className="w-full text-left p-4 cursor-pointer rounded-xl"
              aria-expanded={isExpanded}
              aria-label={isExpanded ? `Collapse ${moment.title}` : `Expand ${moment.title}`}
            >
              <div className="flex items-center gap-2 mb-2">
                <span className={`${styles.badge} text-white text-xs font-mono px-2 py-0.5 rounded-md`}>
                  {formatTime(moment.startSec)}
                </span>
                <span className="text-sm">{TYPE_EMOJI[moment.type] || ''}</span>
                <span className="ml-auto flex items-center gap-1 text-[#71767b]">
                  {/* Watch button — independent of expansion */}
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation()
                      onSeek(moment.startSec)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        e.stopPropagation()
                        onSeek(moment.startSec)
                      }
                    }}
                    className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md border border-current/20 bg-white/60 hover:bg-white text-[#536471] hover:text-[#0f1419] transition-colors"
                    title="Jump video to this moment"
                  >
                    <Play className="w-3 h-3" />
                    Watch
                  </span>
                  <ChevronDown
                    className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                  />
                </span>
              </div>
              <p className="text-sm font-medium text-[#0f1419] leading-snug">{moment.title}</p>
              {/* Description — no truncation. Wrapping freely is the whole point. */}
              <p className="text-caption text-[#71767b] mt-1 leading-relaxed">{moment.description}</p>
              {!isExpanded && (
                <div className="flex items-center gap-1 mt-2 text-[#8b98a5]">
                  {SIGNAL_ICONS[moment.signal] || <Lightbulb className="w-3.5 h-3.5" />}
                  <span className="text-xs capitalize">{moment.signal}</span>
                </div>
              )}
            </button>

            {/* Expanded body — Q-chip + per-Q signals + transcript excerpt + signal-source narrative */}
            {isExpanded && (
              <div className="px-4 pb-4 pt-1 border-t border-current/10 space-y-3">
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
