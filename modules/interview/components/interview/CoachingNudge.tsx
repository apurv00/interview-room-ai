'use client'

import { motion, AnimatePresence } from 'framer-motion'
import type { CoachingNudge as NudgeType } from '@interview/config/coachingNudges'

interface CoachingNudgeProps {
  nudge: NudgeType | null
}

const SEVERITY_STYLES = {
  warning:
    'border-amber-500/60 bg-amber-50 text-amber-700 shadow-[0_0_0_3px_rgba(245,158,11,0.12)]',
  info: 'border-slate-300 bg-white text-slate-700 shadow-[0_0_0_3px_rgba(148,163,184,0.10)]',
}

const ICONS: Record<string, React.ReactNode> = {
  pace: (
    <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
    </svg>
  ),
  filler: (
    <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
    </svg>
  ),
  length: (
    <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  ),
  detail: (
    <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
    </svg>
  ),
  visual: (
    <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
    </svg>
  ),
  prosody: (
    <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
    </svg>
  ),
}

export default function CoachingNudge({ nudge }: CoachingNudgeProps) {
  return (
    <AnimatePresence mode="wait">
      {nudge && (
        <motion.div
          key={nudge.id}
          data-testid="coaching-nudge"
          data-severity={nudge.severity}
          initial={{ opacity: 0, y: 10, scale: 0.9 }}
          animate={{ opacity: 1, y: 0, scale: [0.9, 1.04, 1] }}
          exit={{ opacity: 0, y: -4, scale: 0.95 }}
          transition={{
            duration: 0.4,
            scale: { duration: 0.4, times: [0, 0.6, 1], ease: 'easeOut' },
          }}
          className={`flex items-center gap-2.5 px-4 py-3 rounded-2xl border backdrop-blur-sm text-sm font-medium ${SEVERITY_STYLES[nudge.severity]}`}
        >
          {ICONS[nudge.type]}
          <span>{nudge.message}</span>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
