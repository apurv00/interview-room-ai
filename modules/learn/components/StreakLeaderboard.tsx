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
    return <div className="h-48 bg-[#f8fafc] rounded-xl animate-pulse" />
  }

  if (entries.length === 0) {
    return (
      <div className="surface-card-bordered p-5 text-center text-sm text-[#71767b]">
        No active streaks yet. Be the first!
      </div>
    )
  }

  return (
    <div className="surface-card-bordered overflow-hidden">
      <div className="px-5 py-3 border-b border-[#e1e8ed]">
        <h2 className="text-sm font-semibold text-[#0f1419]">Streak Leaderboard</h2>
      </div>
      <div className="divide-y divide-[#eff3f4]">
        {entries.slice(0, 10).map((entry, i) => (
          <div key={i} className="flex items-center justify-between px-5 py-2.5">
            <div className="flex items-center gap-3">
              <span className="w-6 text-xs text-[#71767b] text-right">#{i + 1}</span>
              <span className="text-sm text-[#536471]">{entry.name}</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-[#71767b]">Lv {entry.level}</span>
              <span className="text-sm font-medium text-[#d97706]">
                🔥 {entry.currentStreak}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
