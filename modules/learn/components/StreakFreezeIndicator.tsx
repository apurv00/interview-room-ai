'use client'

interface StreakFreezeIndicatorProps {
  available: number
}

export default function StreakFreezeIndicator({ available }: StreakFreezeIndicatorProps) {
  if (available <= 0) return null

  return (
    <span
      className="text-xs text-[#3b82f6] cursor-help"
      title={`You have ${available} streak freeze${available !== 1 ? 's' : ''} available. If you miss a day, your streak will be saved automatically.`}
    >
      ❄️ {available} freeze{available !== 1 ? 's' : ''}
    </span>
  )
}
