'use client'

interface InterviewControlsProps {
  muted: boolean
  onToggleMute: () => void
  onEndInterview: () => void
  isScoring: boolean
}

export default function InterviewControls({
  muted,
  onToggleMute,
  onEndInterview,
  isScoring,
}: InterviewControlsProps) {
  return (
    <footer className="flex items-center justify-center gap-4 px-5 py-4 bg-slate-900/80 backdrop-blur border-t border-slate-800 shrink-0">
      <button
        onClick={onToggleMute}
        className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${
          muted
            ? 'bg-red-600/20 border border-red-500/30 text-red-400'
            : 'bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700'
        }`}
      >
        {muted ? '🔇 Unmute' : '🎤 Mute'}
      </button>

      <button
        onClick={onEndInterview}
        disabled={isScoring}
        className="px-6 py-2.5 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white rounded-xl text-sm font-medium transition-all"
      >
        {isScoring ? 'Scoring…' : 'End Interview'}
      </button>
    </footer>
  )
}
