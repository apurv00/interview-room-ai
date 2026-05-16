'use client'

import type { TimelineEvent } from '@shared/types/multimodal'
import { FONT_MONO, KIND_STYLES, timelineTypeToKind } from './tokens'

interface QuestionMarker {
  label: string
  offsetSeconds: number
}

interface SignalTrackProps {
  /** Session-wide timeline events; filtered/displayed by kind. */
  timeline: TimelineEvent[]
  /** Subset of `timeline` shown as KM circle markers on the track. */
  keyMoments: TimelineEvent[]
  totalDurationSec: number
  currentTimeSec: number
  /** Question boundaries — drives white vertical Q lines overlaid on segments. */
  questions: QuestionMarker[]
}

const LEGEND: Array<{ kind: 'strength' | 'improvement' | 'coaching'; label: string }> = [
  { kind: 'strength', label: 'Strength' },
  { kind: 'improvement', label: 'Improvement' },
  { kind: 'coaching', label: 'Coaching' },
]

/**
 * Session-wide colored-band track below the scrubber. Renders each timeline
 * event as an absolutely-positioned colored band stretching from `startSec`
 * to `endSec`. Q boundary lines overlay (thin white verticals). Key-moment
 * white-bordered circles overlay at moment positions. Playhead bar overlays
 * at currentTimeSec.
 *
 * Compared to the scrubber, this track shows the SHAPE of the interview —
 * where strengths cluster, where improvement opportunities are, etc.
 * Useful for "where in the session was the rough patch?" at a glance.
 */
export default function SignalTrack({
  timeline,
  keyMoments,
  totalDurationSec,
  currentTimeSec,
  questions,
}: SignalTrackProps) {
  if (totalDurationSec <= 0) return null

  // Only render segments of the three kinds we have legend entries for.
  // 'observation' is dropped (visually noisy, not in legend).
  const SHOWN = new Set(['strength', 'improvement', 'coaching_tip'])

  return (
    <div className="flex flex-col gap-1.5 flex-shrink-0">
      {/* Legend */}
      <div
        className="flex items-center gap-3.5 text-[11px] text-stone-600 uppercase tracking-[0.02em]"
        style={{ fontFamily: FONT_MONO }}
      >
        <span className="text-stone-400">Signal track</span>
        {LEGEND.map((entry) => (
          <span key={entry.kind} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block w-1.5 h-1.5 rounded-full"
              style={{ background: KIND_STYLES[entry.kind].dot }}
            />
            {entry.label}
          </span>
        ))}
      </div>

      {/* Track */}
      <div className="relative h-[22px] bg-stone-100 rounded-md overflow-hidden">
        {/* Colored segments */}
        {timeline
          .filter((e) => SHOWN.has(e.type))
          .map((event, i) => {
            const kind = timelineTypeToKind(event.type)
            const left = (event.startSec / totalDurationSec) * 100
            const width = ((event.endSec - event.startSec) / totalDurationSec) * 100
            return (
              <div
                key={`seg-${i}`}
                className="absolute top-0 bottom-0"
                style={{
                  left: `${left}%`,
                  width: `${Math.max(width, 0.4)}%`,
                  background: KIND_STYLES[kind].dot,
                  opacity: 0.85,
                }}
                title={event.title}
                aria-hidden="true"
              />
            )
          })}

        {/* Q boundary white lines (skip the first which is at 0%) */}
        {questions.slice(1).map((q, i) => (
          <div
            key={`qline-${i}`}
            className="absolute top-0 bottom-0 w-px"
            style={{
              left: `${(q.offsetSeconds / totalDurationSec) * 100}%`,
              background: 'rgba(255,255,255,0.85)',
              transform: 'translateX(-0.5px)',
            }}
            aria-hidden="true"
          />
        ))}

        {/* Key-moment circle markers (white-bordered, kind-colored) */}
        {keyMoments.map((km, i) => {
          const kind = timelineTypeToKind(km.type)
          return (
            <div
              key={`kmc-${i}`}
              className="absolute top-1/2 w-2 h-2 rounded-full"
              style={{
                left: `${(km.startSec / totalDurationSec) * 100}%`,
                background: KIND_STYLES[kind].dot,
                border: '1.5px solid white',
                transform: 'translate(-50%, -50%)',
              }}
              aria-hidden="true"
              title={km.title}
            />
          )
        })}

        {/* Playhead */}
        <div
          className="absolute w-0.5 bg-stone-900"
          style={{
            left: `${(currentTimeSec / totalDurationSec) * 100}%`,
            top: -2,
            bottom: -2,
            transform: 'translateX(-1px)',
          }}
          aria-hidden="true"
        />
      </div>
    </div>
  )
}
