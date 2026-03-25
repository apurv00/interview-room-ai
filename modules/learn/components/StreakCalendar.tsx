'use client'

import { useEffect, useState } from 'react'

interface StreakDayData {
  date: string
  type: 'active' | 'freeze'
  activities: number
}

export default function StreakCalendar() {
  const [calendar, setCalendar] = useState<StreakDayData[]>([])
  const [currentStreak, setCurrentStreak] = useState(0)
  const [longestStreak, setLongestStreak] = useState(0)
  const [freezeAvailable, setFreezeAvailable] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/learn/streak')
      .then(r => r.json())
      .then(data => {
        setCalendar(data.calendar || [])
        setCurrentStreak(data.currentStreak || 0)
        setLongestStreak(data.longestStreak || 0)
        setFreezeAvailable(data.freezeAvailable || 0)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  if (loading) {
    return <div className="h-24 bg-[#f7f9f9] rounded-xl animate-pulse" />
  }

  // Build a map of date -> activity
  const activityMap = new Map(calendar.map(d => [d.date, d]))

  // Generate last 90 days
  const days: Array<{ date: string; data?: StreakDayData }> = []
  for (let i = 89; i >= 0; i--) {
    const d = new Date()
    d.setUTCDate(d.getUTCDate() - i)
    const dateStr = d.toISOString().split('T')[0]
    days.push({ date: dateStr, data: activityMap.get(dateStr) })
  }

  return (
    <div className="surface-card-bordered p-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-[#0f1419]">Practice Streak</h2>
        <div className="flex items-center gap-3 text-xs text-[#71767b]">
          {currentStreak > 0 && (
            <span className="text-[#34d399] font-medium">
              🔥 {currentStreak} day{currentStreak !== 1 ? 's' : ''}
            </span>
          )}
          <span>Best: {longestStreak}</span>
          {freezeAvailable > 0 && (
            <span title="Streak freeze available">❄️ {freezeAvailable}</span>
          )}
        </div>
      </div>

      {/* Heatmap grid */}
      <div className="flex flex-wrap gap-[3px]">
        {days.map(day => {
          let bg = 'bg-[#eff3f4]' // inactive
          let title = `${day.date}: No activity`

          if (day.data) {
            if (day.data.type === 'freeze') {
              bg = 'bg-[#3b82f6]/30'
              title = `${day.date}: Streak freeze`
            } else if (day.data.activities >= 3) {
              bg = 'bg-[#22c55e]'
              title = `${day.date}: ${day.data.activities} activities`
            } else if (day.data.activities >= 2) {
              bg = 'bg-[#34d399]'
              title = `${day.date}: ${day.data.activities} activities`
            } else {
              bg = 'bg-[#4ade80]/60'
              title = `${day.date}: ${day.data.activities} activity`
            }
          }

          return (
            <div
              key={day.date}
              className={`w-[10px] h-[10px] rounded-[2px] ${bg}`}
              title={title}
            />
          )
        })}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-3 mt-3 text-micro text-[#71767b]">
        <span className="flex items-center gap-1">
          <span className="w-[10px] h-[10px] rounded-[2px] bg-[#eff3f4]" /> None
        </span>
        <span className="flex items-center gap-1">
          <span className="w-[10px] h-[10px] rounded-[2px] bg-[#4ade80]/60" /> Active
        </span>
        <span className="flex items-center gap-1">
          <span className="w-[10px] h-[10px] rounded-[2px] bg-[#3b82f6]/30" /> Freeze
        </span>
      </div>
    </div>
  )
}
