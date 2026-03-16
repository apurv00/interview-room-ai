'use client'

import { useEffect, useState } from 'react'

interface LeaderboardEntry {
  name: string
  score: number
  rank: number
}

export default function DailyChallengeLeaderboard() {
  const [entries, setEntries] = useState<LeaderboardEntry[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/learn/daily-challenge/leaderboard')
      .then(r => r.json())
      .then(data => {
        setEntries(data.leaderboard || [])
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  if (loading) {
    return <div className="h-32 bg-slate-800 rounded-xl animate-pulse" />
  }

  if (entries.length === 0) {
    return (
      <div className="surface-card-bordered p-5 text-center text-sm text-[#6b7280]">
        No submissions yet today. Be the first!
      </div>
    )
  }

  return (
    <div className="surface-card-bordered overflow-hidden">
      <div className="px-5 py-3 border-b border-[rgba(255,255,255,0.06)]">
        <h2 className="text-sm font-semibold text-[#f0f2f5]">Today&apos;s Top Scorers</h2>
      </div>
      <div className="divide-y divide-[rgba(255,255,255,0.04)]">
        {entries.slice(0, 10).map((entry) => (
          <div key={entry.rank} className="flex items-center justify-between px-5 py-2.5">
            <div className="flex items-center gap-3">
              <span className="w-6 text-xs text-[#6b7280] text-right">
                {entry.rank <= 3 ? ['🥇', '🥈', '🥉'][entry.rank - 1] : `#${entry.rank}`}
              </span>
              <span className="text-sm text-[#d1d5db]">{entry.name}</span>
            </div>
            <span className="text-sm font-medium text-[#f0f2f5]">{entry.score}/100</span>
          </div>
        ))}
      </div>
    </div>
  )
}
