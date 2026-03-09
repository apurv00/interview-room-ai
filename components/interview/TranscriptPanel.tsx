'use client'

import type { InterviewState, Duration } from '@/lib/types'
import { QUESTION_COUNT } from '@/lib/interviewConfig'

interface TranscriptPanelProps {
  phase: InterviewState
  questionIndex: number
  duration: Duration
  currentQuestion: string
  liveAnswer: string
}

export default function TranscriptPanel({
  phase,
  questionIndex,
  duration,
  currentQuestion,
  liveAnswer,
}: TranscriptPanelProps) {
  return (
    <div className="px-4 pb-2 shrink-0">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
        {/* Current question */}
        <div>
          <p className="text-xs text-slate-500 mb-1 font-medium uppercase tracking-wide">
            {phase === 'WRAP_UP'
              ? 'Wrap-up'
              : `Question ${questionIndex + 1} of ${QUESTION_COUNT[duration]}`}
          </p>
          <p className="text-sm text-slate-200 leading-relaxed">
            {currentQuestion || 'Preparing…'}
          </p>
        </div>

        {/* Live answer */}
        {(phase === 'LISTENING' || phase === 'FOLLOW_UP') && (
          <div className="pt-2 border-t border-slate-800">
            <p className="text-xs text-slate-500 mb-1 font-medium uppercase tracking-wide">
              Your answer (live)
            </p>
            <p className="text-xs text-slate-400 leading-relaxed min-h-[1.25rem]">
              {liveAnswer || (
                <span className="text-slate-600 italic">Listening… speak when ready</span>
              )}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
