'use client'

import { useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import type { InterviewState, Duration } from '@shared/types'
import { getQuestionCount } from '@interview/config/interviewConfig'

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
  const answerRef = useRef<HTMLDivElement>(null)
  const totalQuestions = getQuestionCount(duration)
  const isActive = phase === 'LISTENING' || phase === 'FOLLOW_UP'
  const progressPct = totalQuestions > 0 ? ((questionIndex + 1) / totalQuestions) * 100 : 0

  // Auto-scroll answer text to bottom as it grows
  useEffect(() => {
    if (answerRef.current) {
      answerRef.current.scrollTop = answerRef.current.scrollHeight
    }
  }, [liveAnswer])

  return (
    <div className="px-3 sm:px-4 pb-2 shrink-0">
      <div className="bg-white/90 backdrop-blur-sm border border-[#e1e8ed] rounded-2xl overflow-hidden shadow-sm">
        {/* Question progress bar */}
        <div className="h-[2px] bg-[#eff3f4] w-full">
          <motion.div
            className="h-full bg-gradient-to-r from-indigo-500 to-indigo-400"
            initial={false}
            animate={{ width: `${progressPct}%` }}
            transition={{ duration: 0.6, ease: 'easeOut' }}
          />
        </div>

        <div className="p-4 space-y-3">
          {/* Question header row */}
          <div className="flex items-center justify-between">
            <p className="text-[11px] text-[#8b98a5] font-semibold uppercase tracking-widest">
              {phase === 'WRAP_UP'
                ? 'Wrap-up'
                : phase === 'FOLLOW_UP'
                ? 'Follow-up'
                : `Question ${questionIndex + 1} of ${totalQuestions}`}
            </p>

            {/* Question dots */}
            {phase !== 'WRAP_UP' && (
              <div className="flex items-center gap-1">
                {Array.from({ length: totalQuestions }).map((_, i) => (
                  <motion.div
                    key={i}
                    className="rounded-full"
                    animate={{
                      width: i === questionIndex ? 12 : 4,
                      height: 4,
                      backgroundColor:
                        i < questionIndex
                          ? 'rgb(99,102,241)'
                          : i === questionIndex
                          ? 'rgb(129,140,248)'
                          : 'rgb(225,232,237)',
                    }}
                    transition={{ duration: 0.3, ease: 'easeOut' }}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Current question — animated crossfade */}
          <AnimatePresence mode="wait">
            <motion.p
              key={currentQuestion || 'loading'}
              className="text-sm text-[#0f1419] leading-relaxed"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.3, ease: 'easeOut' }}
            >
              {currentQuestion || (
                <span className="text-[#8b98a5] italic">Preparing next question...</span>
              )}
            </motion.p>
          </AnimatePresence>

          {/* Live answer */}
          <AnimatePresence>
            {isActive && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
                className="overflow-hidden"
              >
                <div className="pt-3 border-t border-[#e1e8ed]">
                  <div className="flex items-center gap-2 mb-1.5">
                    <motion.div
                      className="w-1.5 h-1.5 rounded-full bg-emerald-400"
                      animate={{ opacity: [0.4, 1, 0.4] }}
                      transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
                    />
                    <p className="text-[11px] text-emerald-400/80 font-semibold uppercase tracking-widest">
                      Your answer
                    </p>
                  </div>
                  <div
                    ref={answerRef}
                    className="text-sm text-[#536471] leading-relaxed max-h-24 sm:max-h-20 overflow-y-auto transcript-scroll"
                  >
                    {liveAnswer ? (
                      <span>
                        {liveAnswer}
                        <motion.span
                          className="inline-block w-[2px] h-3.5 bg-emerald-400 ml-0.5 align-text-bottom"
                          animate={{ opacity: [1, 0] }}
                          transition={{ duration: 0.6, repeat: Infinity, ease: 'steps(2)' }}
                        />
                      </span>
                    ) : (
                      <span className="text-[#8b98a5] italic flex items-center gap-2">
                        <svg className="w-3.5 h-3.5 text-[#8b98a5]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                        </svg>
                        Listening — speak when ready
                      </span>
                    )}
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}
