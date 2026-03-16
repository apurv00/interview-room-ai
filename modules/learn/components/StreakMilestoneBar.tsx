'use client'

const MILESTONES = [3, 7, 14, 30, 100]

interface StreakMilestoneBarProps {
  currentStreak: number
}

export default function StreakMilestoneBar({ currentStreak }: StreakMilestoneBarProps) {
  // Find next milestone
  const nextMilestone = MILESTONES.find(m => m > currentStreak) || MILESTONES[MILESTONES.length - 1]
  const prevMilestone = MILESTONES.filter(m => m <= currentStreak).pop() || 0

  const progress = nextMilestone > prevMilestone
    ? ((currentStreak - prevMilestone) / (nextMilestone - prevMilestone)) * 100
    : 100

  if (currentStreak === 0) return null

  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-[#6b7280] whitespace-nowrap">
        🔥 {currentStreak}
      </span>
      <div className="flex-1 h-2 rounded-full bg-[#1e293b] overflow-hidden">
        <div
          className="h-full rounded-full bg-gradient-to-r from-[#f59e0b] to-[#ef4444] transition-all duration-500"
          style={{ width: `${Math.min(progress, 100)}%` }}
        />
      </div>
      <span className="text-xs text-[#6b7280] whitespace-nowrap">
        {nextMilestone} days
      </span>
    </div>
  )
}
