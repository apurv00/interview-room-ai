'use client'

import { motion, AnimatePresence } from 'framer-motion'
import type { CoachModeState, StarStep } from '@interview/hooks/useCoachMode'

interface CoachOverlayProps {
  state: CoachModeState
}

const STEPS: { key: StarStep; label: string; icon: string }[] = [
  { key: 'situation', label: 'Situation', icon: 'S' },
  { key: 'task', label: 'Task', icon: 'T' },
  { key: 'action', label: 'Action', icon: 'A' },
  { key: 'result', label: 'Result', icon: 'R' },
]

export default function CoachOverlay({ state }: CoachOverlayProps) {
  if (!state.suggestion && state.completedSteps.length === 0) return null

  return (
    <div className="px-4 pb-2">
      {/* STAR step indicator */}
      <div className="flex items-center gap-1 mb-2">
        {STEPS.map((step, i) => {
          const isCompleted = state.completedSteps.includes(step.key)
          const isCurrent = state.currentStep === step.key

          return (
            <div key={step.key} className="flex items-center">
              <div
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-all duration-300 ${
                  isCompleted
                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                    : isCurrent
                    ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30 animate-pulse'
                    : 'bg-gray-800/50 text-gray-500 border border-gray-700/30'
                }`}
              >
                <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold ${
                  isCompleted ? 'bg-emerald-500 text-white' : isCurrent ? 'bg-blue-500 text-white' : 'bg-gray-700 text-gray-400'
                }`}>
                  {isCompleted ? '✓' : step.icon}
                </span>
                <span className="hidden sm:inline">{step.label}</span>
              </div>
              {i < STEPS.length - 1 && (
                <div className={`w-4 h-px mx-0.5 ${isCompleted ? 'bg-emerald-500/50' : 'bg-gray-700/50'}`} />
              )}
            </div>
          )
        })}

        {/* Progress fraction */}
        <span className="ml-auto text-xs text-gray-500 tabular-nums">
          {state.completedSteps.length}/4
        </span>
      </div>

      {/* Suggestion */}
      <AnimatePresence mode="wait">
        {state.suggestion && (
          <motion.div
            key={state.suggestion}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.2 }}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-blue-500/10 border border-blue-500/20 text-xs text-blue-300"
          >
            <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
            </svg>
            <span>{state.suggestion}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
