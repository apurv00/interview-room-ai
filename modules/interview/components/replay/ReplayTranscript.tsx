'use client'

import { useEffect, useRef } from 'react'
import type { WhisperSegment } from '@shared/types/multimodal'
import type { TranscriptEntry } from '@shared/types'

interface ReplayTranscriptProps {
  whisperSegments: WhisperSegment[]
  transcript: TranscriptEntry[]
  currentTimeSec: number
  onWordClick: (timestampSec: number) => void
}

export default function ReplayTranscript({
  whisperSegments,
  transcript,
  currentTimeSec,
  onWordClick,
}: ReplayTranscriptProps) {
  const activeRef = useRef<HTMLSpanElement>(null)

  // Auto-scroll to active word
  useEffect(() => {
    activeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [currentTimeSec])

  // If we have Whisper word-level data, show karaoke-style transcript
  if (whisperSegments.length > 0) {
    return (
      <div className="space-y-4 max-h-[400px] overflow-y-auto pr-2 transcript-scroll">
        {whisperSegments.map((segment) => (
          <div key={segment.id} className="space-y-1">
            <span className="text-caption text-[#8b98a5] tabular-nums">
              {formatTime(segment.start)}
            </span>
            <p className="text-sm leading-relaxed">
              {segment.words.map((word, wi) => {
                const isActive = currentTimeSec >= word.start && currentTimeSec < word.end
                const isPast = currentTimeSec >= word.end
                return (
                  <span
                    key={`${segment.id}-${wi}`}
                    ref={isActive ? activeRef : undefined}
                    onClick={() => onWordClick(word.start)}
                    className={`cursor-pointer transition-colors rounded px-0.5 ${
                      isActive
                        ? 'bg-blue-500/20 text-blue-700 font-medium'
                        : isPast
                        ? 'text-[#0f1419]'
                        : 'text-[#8b98a5]'
                    } hover:bg-blue-500/10`}
                  >
                    {word.word}{' '}
                  </span>
                )
              })}
            </p>
          </div>
        ))}
      </div>
    )
  }

  // Fallback: show existing transcript entries
  return (
    <div className="space-y-3 max-h-[400px] overflow-y-auto pr-2 transcript-scroll">
      {transcript.map((entry, i) => (
        <div
          key={i}
          className={`p-3 rounded-lg ${
            entry.speaker === 'interviewer'
              ? 'bg-[#f8fafc] border-l-2 border-blue-500/40'
              : 'bg-white border-l-2 border-purple-500/40'
          }`}
        >
          <div className="flex items-center gap-2 mb-1">
            <span className="text-caption font-medium text-[#71767b] uppercase">
              {entry.speaker === 'interviewer' ? 'Alex Chen' : 'You'}
            </span>
            <span className="text-caption text-[#8b98a5] tabular-nums">
              {formatTime(entry.timestamp)}
            </span>
          </div>
          <p className="text-body text-[#0f1419]">{entry.text}</p>
        </div>
      ))}
    </div>
  )
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}
