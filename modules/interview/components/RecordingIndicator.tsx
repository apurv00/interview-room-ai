'use client'

interface RecordingIndicatorProps {
  isRecording: boolean
  durationSeconds: number
  hasConsent: boolean
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

export default function RecordingIndicator({
  isRecording,
  durationSeconds,
  hasConsent,
}: RecordingIndicatorProps) {
  if (!hasConsent || !isRecording) return null

  return (
    <div className="flex items-center gap-1.5">
      <span className="relative flex h-2.5 w-2.5">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
        <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
      </span>
      <span className="text-xs font-mono text-red-400 tabular-nums">
        REC {formatDuration(durationSeconds)}
      </span>
    </div>
  )
}
