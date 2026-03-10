'use client'

import { motion, AnimatePresence } from 'framer-motion'

interface CoachingTipProps {
  tip: string | null
}

export default function CoachingTip({ tip }: CoachingTipProps) {
  return (
    <AnimatePresence mode="wait">
      {tip && (
        <motion.div
          key={tip}
          initial={{ opacity: 0, y: 12, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8, scale: 0.95 }}
          transition={{ duration: 0.3 }}
          className="flex items-center gap-2.5 px-4 py-3 rounded-2xl border border-violet-500/30 bg-violet-500/10 backdrop-blur-sm"
        >
          <svg className="w-4 h-4 shrink-0 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
          </svg>
          <span className="text-sm text-violet-200 font-medium">{tip}</span>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
