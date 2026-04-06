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

  return (
    <section className="bg-white border border-[#e1e8ed] rounded-2xl p-5 space-y-4 animate-fade-in">
      <h3 className="font-semibold text-[#0f1419]">Full Transcript</h3>
      <div className="space-y-4 max-h-[600px] overflow-y-auto transcript-scroll pr-2">
        {transcript.map((entry: TranscriptEntry, i: number) => {
          const isActive = i === activeTranscriptIndex
          return (
            <div
              key={i}
              ref={isActive ? (activeEntryRef as React.RefObject<HTMLDivElement>) : undefined}
              className={`flex gap-3 ${entry.speaker === 'interviewer' ? '' : 'flex-row-reverse'} ${
                canSeek ? 'cursor-pointer' : ''
              } ${isActive ? 'ring-2 ring-blue-500/50 rounded-2xl' : ''} transition-all duration-200`}
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
                    ? 'bg-[#f7f9f9] text-[#0f1419]'
                    : 'bg-blue-50 border border-blue-200 text-blue-900'
                }`}
              >
                {s(entry.text)}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
