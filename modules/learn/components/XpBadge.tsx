'use client'

import { useXp } from '@shared/providers/XpProvider'

export default function XpBadge() {
  const { level, title, xp, xpForCurrentLevel, xpForNextLevel } = useXp()

  const progress = xpForNextLevel > xpForCurrentLevel
    ? ((xp - xpForCurrentLevel) / (xpForNextLevel - xpForCurrentLevel)) * 100
    : 0

  return (
    <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-[#1e293b] border border-[rgba(255,255,255,0.06)]">
      <span
        className="w-5 h-5 rounded-full bg-[#6366f1] flex items-center justify-center text-[10px] font-bold text-white"
        title={title}
      >
        {level}
      </span>
      <div className="w-12 h-1.5 rounded-full bg-[#334155] overflow-hidden">
        <div
          className="h-full rounded-full bg-[#818cf8] transition-all duration-500"
          style={{ width: `${Math.min(progress, 100)}%` }}
        />
      </div>
    </div>
  )
}
