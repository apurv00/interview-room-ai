'use client'

import { useMemo } from 'react'
import type { TimelineEvent } from '@shared/types/multimodal'

interface TimelineTrackProps {
  events: TimelineEvent[]
  totalDurationSec: number
  currentTimeSec: number
  onSeek: (seconds: number) => void
}

const EVENT_COLORS: Record<TimelineEvent['type'], string> = {
  strength: 'bg-emerald-500/60 hover:bg-emerald-500/80',
  improvement: 'bg-amber-500/60 hover:bg-amber-500/80',
  coaching_tip: 'bg-blue-500/60 hover:bg-blue-500/80',
  observation: 'bg-[#8b98a5]/40 hover:bg-[#8b98a5]/60',
}

export default function TimelineTrack({ events, totalDurationSec, currentTimeSec, onSeek }: TimelineTrackProps) {
  const playheadPosition = totalDurationSec > 0 ? (currentTimeSec / totalDurationSec) * 100 : 0

  // Sort events by start time for consistent rendering
  const sortedEvents = useMemo(() => [...events].sort((a, b) => a.startSec - b.startSec), [events])

  return (
    <div className="space-y-2">
      {/* Legend */}
      <div className="flex gap-4 text-xs text-[#71767b]">
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-emerald-500" /> Strength
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-amber-500" /> Improvement
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-blue-500" /> Coaching
        </span>
      </div>

      {/* Track */}
      <div
        className="relative h-8 bg-[#eff3f4] rounded-lg overflow-hidden cursor-pointer border border-[#e1e8ed]"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          const ratio = (e.clientX - rect.left) / rect.width
          onSeek(ratio * totalDurationSec)
        }}
        role="slider"
        aria-label="Timeline"
        aria-valuemin={0}
        aria-valuemax={Math.round(totalDurationSec)}
        aria-valuenow={Math.round(currentTimeSec)}
      >
        {/* Event segments */}
        {sortedEvents.map((event, i) => {
          const left = (event.startSec / totalDurationSec) * 100
          const width = ((event.endSec - event.startSec) / totalDurationSec) * 100
          return (
            <div
              key={i}
              className={`absolute top-1 bottom-1 rounded transition-colors ${EVENT_COLORS[event.type]}`}
              style={{ left: `${left}%`, width: `${Math.max(width, 0.5)}%` }}
              title={`${event.title}: ${event.description}`}
              onClick={(e) => {
                e.stopPropagation()
                onSeek(event.startSec)
              }}
            />
          )
        })}

        {/* Playhead */}
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-[#0f1419] z-10 transition-[left] duration-100"
          style={{ left: `${playheadPosition}%` }}
        />
      </div>
    </div>
  )
}
