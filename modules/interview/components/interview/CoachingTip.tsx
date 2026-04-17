'use client'

import { motion, AnimatePresence } from 'framer-motion'

interface CoachingTipProps {
  tip: string | null
  coachMode?: boolean
}

function coachDismissMs(tip: string): number {
  const len = tip.length
  const normalMs = len > 100 ? 6000 : len > 50 ? 4000 : 2000
  return Math.max(3000, normalMs)
}

export default function CoachingTip({ tip, coachMode }: CoachingTipProps) {
  return (
    <AnimatePresence mode="wait">
      {tip && (
        <motion.div
          key={tip}
          initial={{ opacity: 0, y: 12, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8, scale: 0.95 }}
          transition={{ duration: 0.3 }}
          className="flex flex-col gap-1.5 px-4 py-3 rounded-2xl border border-violet-500/30 bg-violet-500/10 backdrop-blur-sm"
        >
          <div className="flex items-center gap-2.5">
            <svg className="w-4 h-4 shrink-0 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
            </svg>
            <span className="text-sm text-violet-200 font-medium">{tip}</span>
          </div>
          {coachMode && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-violet-400/70">Pausing for you to read</span>
              <div className="flex-1 h-0.5 rounded-full bg-violet-500/20 overflow-hidden">
                <div
                  className="h-full bg-violet-400/50 rounded-full"
                  style={{
                    animation: `shrink ${coachDismissMs(tip)}ms linear forwards`,
                  }}
                />
              </div>
              <style>{`@keyframes shrink { from { width: 100%; } to { width: 0%; } }`}</style>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
