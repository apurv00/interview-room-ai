'use client'

import { motion } from 'framer-motion'

interface InterviewControlsProps {
  muted: boolean
  onToggleMute: () => void
  onEndInterview: () => void
  isScoring: boolean
  darkMode?: boolean
}

// SVG Icons
function MicIcon({ muted }: { muted: boolean }) {
  if (muted) {
    return (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
      </svg>
    )
  }
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
    </svg>
  )
}

function PhoneIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M16 8l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2M5 3a2 2 0 00-2 2v1c0 8.284 6.716 15 15 15h1a2 2 0 002-2v-3.28a1 1 0 00-.684-.948l-4.493-1.498a1 1 0 00-1.21.502l-1.13 2.257a11.042 11.042 0 01-5.516-5.517l2.257-1.128a1 1 0 00.502-1.21L9.228 3.683A1 1 0 008.279 3H5z" />
    </svg>
  )
}

export default function InterviewControls({
  muted,
  onToggleMute,
  onEndInterview,
  isScoring,
  darkMode = false,
}: InterviewControlsProps) {
  return (
    <footer className={`flex items-center justify-center gap-2 sm:gap-3 px-3 sm:px-5 py-3 sm:py-4 backdrop-blur-md shrink-0 fixed bottom-0 left-0 right-0 sm:relative z-10 ${darkMode ? 'bg-[#1e1f2e]/90 border-t border-gray-700/50' : 'bg-white/90 border-t border-[#e1e8ed]'}`}>
      {/* Mute button */}
      <motion.button
        onClick={onToggleMute}
        whileHover={{ scale: 1.03 }}
        whileTap={{ scale: 0.97 }}
        className={`
          flex items-center gap-2 px-3 sm:px-5 py-2.5 min-h-[44px] rounded-xl text-sm font-medium transition-colors
          ${muted
            ? 'bg-red-500/15 border border-red-500/25 text-red-500 hover:bg-red-500/20'
            : darkMode
              ? 'bg-gray-800 border border-gray-600/50 text-gray-300 hover:bg-gray-700'
              : 'bg-[#f7f9f9] border border-[#e1e8ed] text-[#536471] hover:bg-[#eff3f4]'
          }
        `}
        aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
      >
        <MicIcon muted={muted} />
        <span>{muted ? 'Unmute' : 'Mute'}</span>
        <kbd className={`hidden sm:inline-block text-[10px] px-1.5 py-0.5 rounded ml-1 font-mono ${darkMode ? 'text-gray-500 bg-gray-800 border border-gray-600/50' : 'text-[#8b98a5] bg-[#f7f9f9] border border-[#e1e8ed]'}`}>
          M
        </kbd>
      </motion.button>

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
              : 'bg-[#f7f9f9] border border-[#e1e8ed] text-[#8b98a5] cursor-not-allowed'
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
