'use client'

import { motion } from 'framer-motion'

interface InterviewControlsProps {
  onEndInterview: () => void
  isScoring: boolean
  darkMode?: boolean
  /**
   * Master switch for live coaching (nudges + STAR overlay/tips). When the
   * handler is provided the toggle pill renders left of the End button; when
   * omitted the control is hidden (backward-compatible default).
   */
  liveCoachingEnabled?: boolean
  onToggleLiveCoaching?: () => void
}

// SVG Icons
function PhoneIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M16 8l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2M5 3a2 2 0 00-2 2v1c0 8.284 6.716 15 15 15h1a2 2 0 002-2v-3.28a1 1 0 00-.684-.948l-4.493-1.498a1 1 0 00-1.21.502l-1.13 2.257a11.042 11.042 0 01-5.516-5.517l2.257-1.128a1 1 0 00.502-1.21L9.228 3.683A1 1 0 008.279 3H5z" />
    </svg>
  )
}

// Lightbulb — lit when coaching is on, struck-through when off.
function CoachingIcon({ on }: { on: boolean }) {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 18h6M10 21h4M12 3a6 6 0 00-3.6 10.8c.4.3.6.77.6 1.27V16h6v-.93c0-.5.2-.97.6-1.27A6 6 0 0012 3z" />
      {!on && <path strokeLinecap="round" strokeLinejoin="round" d="M4 4l16 16" />}
    </svg>
  )
}

export default function InterviewControls({
  onEndInterview,
  isScoring,
  darkMode = false,
  liveCoachingEnabled = true,
  onToggleLiveCoaching,
}: InterviewControlsProps) {
  return (
    <footer className={`flex items-center justify-center gap-2 sm:gap-3 px-3 sm:px-5 py-3 sm:py-4 backdrop-blur-md shrink-0 fixed bottom-0 left-0 right-0 sm:relative z-10 ${darkMode ? 'bg-[#1e1f2e]/90 border-t border-gray-700/50' : 'bg-white/90 border-t border-[#e1e8ed]'}`}>
      {/* Live-coaching master switch (silences nudges + STAR coach overlay/tips) */}
      {onToggleLiveCoaching && (
        <motion.button
          onClick={onToggleLiveCoaching}
          whileHover={{ scale: 1.03 }}
          whileTap={{ scale: 0.97 }}
          role="switch"
          aria-checked={liveCoachingEnabled}
          aria-label={liveCoachingEnabled ? 'Turn off live coaching tips' : 'Turn on live coaching tips'}
          title={liveCoachingEnabled ? 'Live coaching on — tap to silence tips' : 'Live coaching off — tap to show tips'}
          className={`
            flex items-center gap-2 px-3 sm:px-4 py-2.5 min-h-[44px] rounded-xl text-sm font-medium transition-colors
            ${liveCoachingEnabled
              ? darkMode
                ? 'bg-[#2563eb]/20 border border-[#2563eb]/40 text-[#93b4ff] hover:bg-[#2563eb]/30'
                : 'bg-[#eef4ff] border border-[#c7dbff] text-[#2563eb] hover:bg-[#e2edff]'
              : darkMode
                ? 'bg-gray-800 border border-gray-600/50 text-gray-400 hover:bg-gray-700/60'
                : 'bg-[#f8fafc] border border-[#e1e8ed] text-[#8b98a5] hover:bg-[#eef2f6]'
            }
          `}
        >
          <CoachingIcon on={liveCoachingEnabled} />
          <span className="hidden sm:inline">{liveCoachingEnabled ? 'Coaching on' : 'Coaching off'}</span>
        </motion.button>
      )}

      {/* End button */}
      <motion.button
        onClick={onEndInterview}
        disabled={isScoring}
        whileHover={isScoring ? {} : { scale: 1.03 }}
        whileTap={isScoring ? {} : { scale: 0.97 }}
        className={`
          flex items-center gap-2 px-4 sm:px-6 py-2.5 min-h-[44px] rounded-xl text-sm font-medium transition-colors
          ${isScoring
            ? darkMode
              ? 'bg-gray-800 border border-gray-600/50 text-gray-500 cursor-not-allowed'
              : 'bg-[#f8fafc] border border-[#e1e8ed] text-[#8b98a5] cursor-not-allowed'
            : 'bg-red-600 hover:bg-red-500 text-white shadow-lg shadow-red-600/20'
          }
        `}
        aria-label="End interview"
      >
        {isScoring ? (
          <>
            <div className="w-4 h-4 rounded-full border-2 border-[#8b98a5] border-t-transparent animate-spin" />
            <span>Scoring...</span>
          </>
        ) : (
          <>
            <PhoneIcon />
            <span>End Interview</span>
          </>
        )}
      </motion.button>
    </footer>
  )
}
