'use client'

import { type RefObject } from 'react'
import type { TranscriptEntry } from '@shared/types'
import { computeOffsetSeconds } from '@interview/utils/offsetHelpers'

// Helper: safely coerce to string for rendering
function s(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

interface TranscriptTabProps {
  transcript: TranscriptEntry[]
  activeTranscriptIndex: number
  activeEntryRef: RefObject<HTMLDivElement | null>
  recordingUrl: string | null
  sessionStartedAt: number | null
  seekTo: ((seconds: number) => void) | null
}

export default function TranscriptTab({
  transcript,
  activeTranscriptIndex,
  activeEntryRef,
  recordingUrl,
  sessionStartedAt,
  seekTo,
}: TranscriptTabProps) {
  const canSeek = recordingUrl && sessionStartedAt

  // Group transcript entries by question index for section dividers
  let lastQuestionIndex = -1

  return (
    <section className="bg-white border border-[#e1e8ed] rounded-2xl p-4 sm:p-5 space-y-4 animate-fade-in">
      <div className="flex items-center justify-between">
        <h3 className="text-subheading text-[#0f1419]">Full Transcript</h3>
        {canSeek && (
          <span className="text-caption text-[#8b98a5]">Click any message to jump to that moment</span>
        )}
      </div>
      <div className="space-y-3 max-h-[calc(100vh-280px)] overflow-y-auto scroll-smooth transcript-scroll pr-2">
        {transcript.map((entry: TranscriptEntry, i: number) => {
          const isActive = i === activeTranscriptIndex
          const showDivider = entry.questionIndex != null && entry.questionIndex !== lastQuestionIndex && entry.speaker === 'interviewer'
          if (entry.questionIndex != null) lastQuestionIndex = entry.questionIndex

          return (
            <div key={i}>
              {showDivider && (
                <div className="flex items-center gap-3 py-2">
                  <div className="flex-1 h-px bg-[#e1e8ed]" />
                  <span className="text-micro text-[#8b98a5] font-semibold uppercase tracking-wider">
                    Question {(entry.questionIndex ?? 0) + 1}
                  </span>
                  <div className="flex-1 h-px bg-[#e1e8ed]" />
                </div>
              )}
              <div
                ref={isActive ? (activeEntryRef as React.RefObject<HTMLDivElement>) : undefined}
                className={`flex gap-3 ${entry.speaker === 'interviewer' ? '' : 'flex-row-reverse'} ${
                  canSeek ? 'cursor-pointer' : ''
                } ${isActive ? 'ring-2 ring-blue-500/50 rounded-2xl p-1' : ''} transition-all duration-200`}
                onClick={() => {
                  if (canSeek && seekTo) {
                    seekTo(computeOffsetSeconds(entry.timestamp, sessionStartedAt))
                  }
                }}
              >
                <div
                  className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${
                    entry.speaker === 'interviewer'
                      ? 'bg-blue-600 text-white'
                      : 'bg-[#eff3f4] text-[#536471]'
                  }`}
                >
                  {entry.speaker === 'interviewer' ? 'A' : 'Y'}
                </div>
                <div
                  className={`max-w-[78%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed ${
                    entry.speaker === 'interviewer'
                      ? 'bg-[#f8fafc] text-[#0f1419]'
                      : 'bg-blue-50 border border-blue-200 text-blue-900'
                  }`}
                >
                  {s(entry.text)}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
