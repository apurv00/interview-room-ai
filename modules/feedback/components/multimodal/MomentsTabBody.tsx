'use client'

import { useMemo, useState } from 'react'
import type {
  TimelineEvent,
  ProsodySegment,
  FacialSegment,
  WhisperSegment,
} from '@shared/types/multimodal'
import { FONT_MONO, KIND_STYLES, timelineTypeToKind } from './tokens'

interface QuestionMarker {
  label: string
  offsetSeconds: number
}

interface MomentsTabBodyProps {
  moments: TimelineEvent[]
  onSeek: (sec: number) => void
  /** Per-question prosody/facial signals — drives the metric mini-row in the expanded card. */
  prosodySegments?: ProsodySegment[]
  facialSegments?: FacialSegment[]
  /** Word-level transcript — drives the quote excerpt in the expanded card. */
  whisperSegments?: WhisperSegment[]
  /** Question boundaries — maps a moment's startSec to its containing questionIndex. */
  questions?: QuestionMarker[]
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function questionIndexForMoment(startSec: number, questions?: QuestionMarker[]): number | null {
  if (!questions || questions.length === 0) return null
  let last: number | null = null
  for (let i = 0; i < questions.length; i++) {
    if (questions[i].offsetSeconds <= startSec) last = i
    else break
  }
  return last
}

function transcriptExcerpt(
  startSec: number,
  endSec: number,
  whisper?: WhisperSegment[]
): string {
  if (!whisper || whisper.length === 0) return ''
  const words: string[] = []
  for (const seg of whisper) {
    if (seg.end < startSec) continue
    if (seg.start > endSec) break
    for (const w of seg.words) {
      if (w.start >= startSec && w.end <= endSec) words.push(w.word.trim())
    }
    if (words.length > 40) break
  }
  const text = words.join(' ').replace(/\s+([,.!?;:])/g, '$1').trim()
  if (text.length > 180) return text.slice(0, 180).trimEnd() + '…'
  return text
}

interface FillerCount { word: string; count: number }

/**
 * Top-N filler words used inside a moment's time window.
 *
 * Round 5b feature #11 — surfaces the *specific* filler vocabulary the
 * candidate used, not just the aggregate rate. Behavior-change literature
 * (Locke's goal-setting theory) consistently finds "you said 'um' 4 times"
 * produces measurable change where "your filler rate is high" does not.
 *
 * Case-folds and groups: "Um" and "um" become one entry. Limits to `maxN`
 * (default 3 per Hick's Law — beyond 3 the user can't act on them anyway).
 * Returns [] for moments with no fillers (renderer hides the row entirely).
 */
export function topFillerWords(
  prosody: ProsodySegment[] | undefined,
  windowStartSec: number,
  windowEndSec: number,
  maxN: number = 3,
): FillerCount[] {
  if (!prosody || prosody.length === 0) return []
  const counts = new Map<string, number>()
  for (const seg of prosody) {
    for (const f of seg.fillerWords || []) {
      if (!Number.isFinite(f.timestampSec)) continue
      if (f.timestampSec < windowStartSec || f.timestampSec >= windowEndSec) continue
      const key = (f.word || '').toLowerCase().trim()
      if (!key) continue
      counts.set(key, (counts.get(key) || 0) + 1)
    }
  }
  return Array.from(counts.entries())
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word))
    .slice(0, maxN)
}

interface MiniStat { label: string; value: string }

function buildStats(
  qIdx: number | null,
  prosody?: ProsodySegment[],
  facial?: FacialSegment[]
): MiniStat[] {
  if (qIdx == null) return []
  const out: MiniStat[] = []
  const ps =
    prosody?.find((p) => p.questionIndex === qIdx) ??
    (qIdx < (prosody?.length ?? 0) ? prosody?.[qIdx] : undefined)
  if (ps) {
    if (ps.wpm > 0) out.push({ label: 'WPM', value: String(Math.round(ps.wpm)) })
    out.push({ label: 'Fillers', value: String(ps.fillerWords?.length ?? 0) })
    if (ps.pauseDurationSec > 0) {
      out.push({ label: 'Pause', value: `${ps.pauseDurationSec.toFixed(1)}s` })
    }
  }
  const fs =
    facial?.find((f) => f.questionIndex === qIdx) ??
    (qIdx < (facial?.length ?? 0) ? facial?.[qIdx] : undefined)
  if (fs) {
    // avgEyeContact === -1 is the aggregator's "no frames in this window" sentinel
    // (facialAggregator). `-1 || 0` is -1 (truthy), so guard on >= 0 — otherwise an
    // empty window renders "Eye contact -100%" instead of being omitted.
    if (fs.avgEyeContact >= 0) {
      out.push({ label: 'Eye contact', value: `${Math.round(fs.avgEyeContact * 100)}%` })
    }
    if (fs.dominantExpression && fs.dominantExpression !== 'neutral') {
      out.push({ label: 'Expression', value: fs.dominantExpression })
    }
  }
  return out
}

/**
 * The Moments tab body. Per the prototype: one moment is "expanded" at a
 * time (showing Q chip, metric mini-row, full body text, quote excerpt);
 * all others are compact title-only rows.
 *
 * Click a collapsed row → that row expands, the previously expanded row
 * collapses, AND the video seeks to moment.startSec. Click an already-
 * expanded row → no-op (matches prototype; auto re-seeks aren't desirable
 * since the user might be reading it after the video has moved on).
 *
 * Selection state is LOCAL to this component. Currently NOT auto-synced
 * with playback per the plan (auto-expand on range-cross would cause
 * visual churn in a list pattern; manual selection is the right model
 * here).
 */
export default function MomentsTabBody({
  moments,
  onSeek,
  prosodySegments,
  facialSegments,
  whisperSegments,
  questions,
}: MomentsTabBodyProps) {
  const [selectedIdx, setSelectedIdx] = useState<number>(0)

  // Memo per-moment derived data so re-renders triggered by parent prop
  // changes (currentTimeSec etc.) don't recompute everything.
  const enriched = useMemo(() => {
    return moments.map((m, i) => {
      if (i !== selectedIdx) return { moment: m }
      const qIdx = questionIndexForMoment(m.startSec, questions)
      const windowEnd = m.endSec || m.startSec + 5
      return {
        moment: m,
        questionIdx: qIdx,
        questionLabel: qIdx != null && questions?.[qIdx] ? questions[qIdx].label : null,
        stats: buildStats(qIdx, prosodySegments, facialSegments),
        excerpt: transcriptExcerpt(m.startSec, windowEnd, whisperSegments),
        // Round 5b feature #11 — top 3 filler words inside this moment's window.
        fillers: topFillerWords(prosodySegments, m.startSec, windowEnd),
      }
    })
  }, [moments, selectedIdx, prosodySegments, facialSegments, whisperSegments, questions])

  // Signal-source breakdown: count moments by where the signal came from
  // (audio / facial / content / fused). Round 5a feature #9 — transparency
  // builds trust (Lee & See, automation trust). Shows the user that the AI
  // didn't hallucinate from the transcript alone; some moments are driven
  // by how they sounded or looked.
  //
  // Codex P3 review (post-Round 5c): previously a missing `signal` field
  // was silently coerced to 'fused', overcounting fused and lying about
  // the channel breakdown. Missing values now bucket into 'unknown' so
  // the user sees the discrepancy rather than a misleading 'fused' count.
  // In practice Claude always emits signal — 'unknown' will normally be
  // 0 and is hidden from the rendered line.
  const signalBreakdown = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const m of moments) {
      const k = m.signal && ['audio', 'facial', 'content', 'fused'].includes(m.signal)
        ? m.signal
        : 'unknown'
      counts[k] = (counts[k] || 0) + 1
    }
    // Order: audio, facial, content, fused, unknown.
    const order = ['audio', 'facial', 'content', 'fused', 'unknown']
    return order
      .filter((k) => counts[k] > 0)
      .map((k) => `${counts[k]} ${k}`)
      .join(' · ')
  }, [moments])

  if (moments.length === 0) {
    return (
      <p className="text-sm text-stone-400 italic p-2">No key moments captured.</p>
    )
  }

  return (
    <div className="flex flex-col gap-1.5">
      {signalBreakdown && (
        <p
          className="text-[10px] text-stone-400 px-1 mb-0.5"
          style={{ fontFamily: FONT_MONO }}
          data-testid="moments-signal-breakdown"
        >
          {moments.length} {moments.length === 1 ? 'moment' : 'moments'}: {signalBreakdown}
        </p>
      )}
      {enriched.map(({ moment, questionLabel, stats, excerpt, fillers }, i) => {
        const kind = timelineTypeToKind(moment.type)
        const c = KIND_STYLES[kind]
        const isSelected = i === selectedIdx

        if (!isSelected) {
          // Collapsed row — title only
          return (
            <button
              key={i}
              type="button"
              onClick={() => {
                setSelectedIdx(i)
                onSeek(moment.startSec)
              }}
              className="text-left px-3 py-2 rounded-lg border border-stone-200 bg-white cursor-pointer flex items-center gap-2.5 hover:border-stone-300 transition-colors"
            >
              <span
                className="text-[11px] font-semibold min-w-[32px]"
                style={{ fontFamily: FONT_MONO, color: c.fg }}
              >
                {formatTime(moment.startSec)}
              </span>
              <span
                className="inline-block w-1.5 h-1.5 rounded-full"
                style={{ background: c.dot }}
                aria-hidden="true"
              />
              <span className="text-[13px] font-medium text-stone-900 flex-1 -tracking-[0.005em]">
                {moment.title}
              </span>
              <span className="text-stone-400 text-[11px]" style={{ fontFamily: FONT_MONO }}>→</span>
            </button>
          )
        }

        // Expanded card — full detail
        return (
          <div
            key={i}
            className="px-3.5 py-3 rounded-[10px] border flex flex-col gap-2"
            style={{
              background: c.bg,
              borderColor: c.border,
              borderLeft: `3px solid ${c.dot}`,
            }}
            data-active="true"
          >
            {/* Header row */}
            <div className="flex items-center gap-2">
              <span
                className="text-xs font-bold px-2 py-0.5 rounded bg-white"
                style={{ fontFamily: FONT_MONO, color: c.fg }}
              >
                {formatTime(moment.startSec)}
              </span>
              <span
                className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[10px] uppercase font-medium"
                style={{
                  fontFamily: FONT_MONO,
                  background: 'white',
                  borderColor: c.border,
                  color: c.fg,
                }}
              >
                <span
                  className="w-1 h-1 rounded-full"
                  style={{ background: c.dot }}
                  aria-hidden="true"
                />
                {kind}
              </span>
              {questionLabel && (
                <span
                  className="ml-auto text-[10px] uppercase tracking-[0.06em] text-stone-400"
                  style={{ fontFamily: FONT_MONO }}
                >
                  Asked during {questionLabel}
                </span>
              )}
              {!questionLabel && (
                <span
                  className="ml-auto text-[10px] uppercase tracking-[0.06em] text-stone-400"
                  style={{ fontFamily: FONT_MONO }}
                >
                  Expanded
                </span>
              )}
            </div>

            {/* Title */}
            <div className="text-[14px] font-semibold text-stone-900 -tracking-[0.015em]">
              {moment.title}
            </div>

            {/* Body */}
            <div className="text-[12.5px] text-stone-600 leading-[1.5]">
              {moment.description}
            </div>

            {/* Metric mini-row */}
            {stats && stats.length > 0 && (
              <div className="flex gap-1.5 flex-wrap">
                {stats.map((stat) => (
                  <div
                    key={stat.label}
                    className="px-2 py-0.5 rounded border border-stone-200 bg-white text-[11px] text-stone-600 inline-flex items-baseline gap-1"
                    style={{ fontFamily: FONT_MONO }}
                  >
                    <span className="text-stone-400">{stat.label}</span>
                    <span className="text-stone-900 font-semibold">{stat.value}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Filler-word lexicon (top 3 inside this moment's window).
                Round 5b feature #11. Rose chips echo the inline filler chips
                in the transcript so the user makes the visual link
                "this is the same kind of thing I saw in the transcript".
                Hidden entirely when this moment had 0 fillers (silence = signal). */}
            {fillers && fillers.length > 0 && (
              <div
                className="flex gap-1 flex-wrap"
                data-testid="moments-filler-lexicon"
              >
                {fillers.map((f) => (
                  <span
                    key={f.word}
                    className="px-1.5 py-px rounded bg-rose-50 text-rose-700 border border-rose-100 text-[10px] inline-flex items-baseline gap-1"
                    style={{ fontFamily: FONT_MONO }}
                  >
                    <span>{f.word}</span>
                    <span className="text-rose-400">·</span>
                    <span className="font-semibold">{f.count}</span>
                  </span>
                ))}
              </div>
            )}

            {/* Quote excerpt — only when transcript has content for this range */}
            {excerpt && (
              <div className="text-[12px] text-stone-600 italic leading-[1.5] border-l-2 border-stone-300 pl-2.5">
                “{excerpt}”
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
