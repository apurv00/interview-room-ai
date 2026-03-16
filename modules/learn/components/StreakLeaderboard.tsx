'use client'

import { useEffect, useState } from 'react'

interface LeaderboardEntry {
  name: string
  currentStreak: number
  level: number
}

export default function StreakLeaderboard() {
  const [entries, setEntries] = useState<LeaderboardEntry[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/learn/streak/leaderboard')
      .then(r => r.json())
      .then(data => {
        setEntries(data.leaderboard || [])
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  if (loading) {
    return <div className="h-48 bg-slate-800 rounded-xl animate-pulse" />
  }

  if (entries.length === 0) {
    return (
      <div className="surface-card-bordered p-5 text-center text-sm text-[#6b7280]">
        No active streaks yet. Be the first!
      </div>
    )
  }

  return (
    <div className="surface-card-bordered overflow-hidden">
      <div className="px-5 py-3 border-b border-[rgba(255,255,255,0.06)]">
        <h2 className="text-sm font-semibold text-[#f0f2f5]">Streak Leaderboard</h2>
      </div>
      <div className="divide-y divide-[rgba(255,255,255,0.04)]">
        {entries.slice(0, 10).map((entry, i) => (
          <div key={i} className="flex items-center justify-between px-5 py-2.5">
            <div className="flex items-center gap-3">
              <span className="w-6 text-xs text-[#6b7280] text-right">#{i + 1}</span>
              <span className="text-sm text-[#d1d5db]">{entry.name}</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-[#6b7280]">Lv {entry.level}</span>
              <span className="text-sm font-medium text-[#f59e0b]">
                🔥 {entry.currentStreak}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
