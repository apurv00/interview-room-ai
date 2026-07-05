'use client'

import { useRef } from 'react'
import { Play, Pause } from 'lucide-react'
import type { TimelineEvent } from '@shared/types/multimodal'
import { FONT_MONO, KIND_STYLES, timelineTypeToKind } from './tokens'

interface ScrubberProps {
  currentTimeSec: number
  totalDurationSec: number
  onSeek: (sec: number) => void
  playing: boolean
  setPlaying: (p: boolean) => void
  /** Key moments — drives the 2×10 colored ticks on the rail. */
  keyMoments: TimelineEvent[]
  /**
   * Optional filler-word timestamps (seconds from session start). When
   * provided, each filler is rendered as a tiny rose dot below the rail.
   * Round 5a feature #3 — Goal-setting theory says specific timestamps
   * make a quantity goal ("8 fillers → 4") actionable in a way "lower
   * your filler rate" never is.
   */
  fillerTimestamps?: number[]
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

/**
 * The 28-px-tall video scrubber. Layers stacked inside the track:
 *   1. base rail (full-width gray)
 *   2. progress fill (dark)
 *   3. key-moment ticks (2×10 colored bars by kind)
 *   4. filler-word dots (rose, below the rail)
 *   5. playhead (12×12 circle, dark, white border)
 *
 * Per-question boundary ticks and the active-question band were removed in the
 * timeline declutter — question navigation lives on the video caption, and the
 * scrubber only carries event signal (moments, fillers).
 *
 * Click anywhere on the track → seek to (clickX / width * totalDuration).
 * `role="slider"` + ARIA values for keyboard / screen reader support.
 */
export default function Scrubber({
  currentTimeSec,
  totalDurationSec,
  onSeek,
  playing,
  setPlaying,
  keyMoments,
  fillerTimestamps,
}: ScrubberProps) {
  const trackRef = useRef<HTMLDivElement>(null)

  const onTrackClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!trackRef.current || totalDurationSec <= 0) return
    const rect = trackRef.current.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    onSeek(ratio * totalDurationSec)
  }

  const playheadPct = totalDurationSec > 0
    ? Math.max(0, Math.min(100, (currentTimeSec / totalDurationSec) * 100))
    : 0

  return (
    <div className="flex items-center gap-3 flex-shrink-0">
      {/* Play/pause */}
      <button
        type="button"
        onClick={() => setPlaying(!playing)}
        className="w-7 h-7 rounded-md grid place-items-center bg-stone-900 text-white cursor-pointer flex-shrink-0"
        aria-label={playing ? 'Pause' : 'Play'}
      >
        {playing ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3 translate-x-px" />}
      </button>

      {/* Track */}
      <div
        ref={trackRef}
        onClick={onTrackClick}
        className="flex-1 relative h-7 cursor-pointer flex items-center"
        role="slider"
        aria-label="Video timeline"
        aria-valuemin={0}
        aria-valuemax={Math.round(totalDurationSec)}
        aria-valuenow={Math.round(currentTimeSec)}
        tabIndex={0}
        onKeyDown={(e) => {
          if (totalDurationSec <= 0) return
          if (e.key === 'ArrowLeft') onSeek(Math.max(0, currentTimeSec - 5))
          if (e.key === 'ArrowRight') onSeek(Math.min(totalDurationSec, currentTimeSec + 5))
        }}
      >
        {/* Base rail */}
        <div className="absolute left-0 right-0 h-1 bg-stone-300 rounded-full" />

        {/* Progress fill */}
        <div
          className="absolute left-0 h-1 bg-stone-900 rounded-full"
          style={{ width: `${playheadPct}%` }}
        />

        {/* Key-moment ticks (2×10 colored bars) */}
        {totalDurationSec > 0 && keyMoments.map((km, i) => {
          const kind = timelineTypeToKind(km.type)
          return (
            <div
              key={`km-${i}`}
              className="absolute w-0.5 h-2.5 rounded-sm"
              style={{
                left: `${(km.startSec / totalDurationSec) * 100}%`,
                background: KIND_STYLES[kind].dot,
                transform: 'translateX(-1px)',
              }}
              aria-hidden="true"
              title={km.title}
            />
          )
        })}

        {/* Filler-word dots — small rose ticks slightly below the rail so they
            don't overlap the key-moment ticks above. Click bubbles to the
            track for seeking; we add a title so hover names the filler word
            and timestamp. */}
        {totalDurationSec > 0 && fillerTimestamps && fillerTimestamps.length > 0 &&
          fillerTimestamps.map((ts, i) => {
            if (!Number.isFinite(ts) || ts < 0 || ts > totalDurationSec) return null
            return (
              <div
                key={`fl-${i}`}
                className="absolute w-1 h-1 rounded-full"
                style={{
                  left: `${(ts / totalDurationSec) * 100}%`,
                  background: '#f43f5e', // rose-500
                  transform: 'translate(-50%, 7px)',
                }}
                aria-hidden="true"
                title={`Filler word at ${formatTime(ts)}`}
              />
            )
          })}

        {/* Playhead */}
        <div
          className="absolute w-3 h-3 rounded-full bg-stone-900"
          style={{
            left: `${playheadPct}%`,
            transform: 'translateX(-50%)',
            border: '2px solid white',
            boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
          }}
          aria-hidden="true"
        />
      </div>

      {/* Time readout */}
      <div
        className="text-xs text-stone-600 min-w-[84px] text-right flex-shrink-0"
        style={{ fontFamily: FONT_MONO }}
      >
        {formatTime(currentTimeSec)} / {formatTime(totalDurationSec)}
      </div>

      {/* Playback-rate pill — placeholder for now (prototype shows it stubbed). */}
      <button
        type="button"
        className="px-2.5 py-1 rounded-md border border-stone-200 bg-white text-xs text-stone-900 cursor-pointer flex-shrink-0"
        style={{ fontFamily: FONT_MONO }}
        title="Playback speed (not yet wired)"
      >
        1×
      </button>
    </div>
  )
}
