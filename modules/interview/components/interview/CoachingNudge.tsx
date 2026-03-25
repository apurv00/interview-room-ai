'use client'

import { motion, AnimatePresence } from 'framer-motion'
import type { CoachingNudge as NudgeType } from '@interview/config/coachingNudges'

interface CoachingNudgeProps {
  nudge: NudgeType | null
}

const SEVERITY_STYLES = {
  warning: 'border-amber-500/30 bg-amber-500/10 text-amber-600',
  info: 'border-[#e1e8ed] bg-white text-[#536471]',
}

const ICONS = {
  pace: (
    <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
    </svg>
  ),
  filler: (
    <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
    </svg>
  ),
  length: (
    <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  ),
  detail: (
    <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
    </svg>
  ),
}

export default function CoachingNudge({ nudge }: CoachingNudgeProps) {
  return (
    <AnimatePresence mode="wait">
      {nudge && (
        <motion.div
          key={nudge.id}
          initial={{ opacity: 0, y: 8, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -4, scale: 0.95 }}
          transition={{ duration: 0.25 }}
          className={`flex items-center gap-2 px-3 py-2 rounded-xl border backdrop-blur-sm text-xs font-medium ${SEVERITY_STYLES[nudge.severity]}`}
        >
          {ICONS[nudge.type]}
          <span>{nudge.message}</span>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
