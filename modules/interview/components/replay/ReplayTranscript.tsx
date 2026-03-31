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
      <div className="space-y-4 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
        {whisperSegments.map((segment) => (
          <div key={segment.id} className="space-y-1">
            <span className="text-xs text-gray-500 tabular-nums">
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
                        ? 'bg-blue-500/30 text-white font-medium'
                        : isPast
                        ? 'text-gray-300'
                        : 'text-gray-500'
                    } hover:bg-blue-500/20`}
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
    <div className="space-y-3 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
      {transcript.map((entry, i) => (
        <div
          key={i}
          className={`p-3 rounded-lg ${
            entry.speaker === 'interviewer'
              ? 'bg-gray-800/50 border-l-2 border-blue-500/50'
              : 'bg-gray-800/30 border-l-2 border-purple-500/50'
          }`}
        >
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-medium text-gray-400 uppercase">
              {entry.speaker === 'interviewer' ? 'Alex Chen' : 'You'}
            </span>
            <span className="text-xs text-gray-500 tabular-nums">
              {formatTime(entry.timestamp)}
            </span>
          </div>
          <p className="text-sm text-gray-200">{entry.text}</p>
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
