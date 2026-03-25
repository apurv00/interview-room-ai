'use client'

import { useEffect, useState } from 'react'

interface TrendPoint {
  score: number
  date: string
}

interface ScoreTrendChartProps {
  currentScore: number
  sessionId?: string
}

export default function ScoreTrendChart({ currentScore, sessionId }: ScoreTrendChartProps) {
  const [points, setPoints] = useState<TrendPoint[]>([])
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch('/api/interviews?limit=10&status=completed')
        if (!res.ok) return
        const data = await res.json()
        const pts: TrendPoint[] = (data.sessions || [])
          .filter((s: { feedback?: { overall_score: number } }) => s.feedback?.overall_score)
          .map((s: { feedback: { overall_score: number }; createdAt: string }) => ({
            score: s.feedback.overall_score,
            date: new Date(s.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          }))
          .reverse()
        setPoints(pts)
      } catch {
        // Non-critical
      }
    }
    load()
  }, [sessionId])

  if (points.length < 2) {
    return (
      <div className="text-xs text-[#8b98a5] italic">
        Complete more interviews to see your score trend.
      </div>
    )
  }

  // SVG dimensions
  const W = 280
  const H = 80
  const PAD_X = 10
  const PAD_Y = 10
  const chartW = W - PAD_X * 2
  const chartH = H - PAD_Y * 2

  const minScore = Math.min(...points.map((p) => p.score)) - 5
  const maxScore = Math.max(...points.map((p) => p.score)) + 5
  const range = maxScore - minScore || 1

  const coords = points.map((p, i) => ({
    x: PAD_X + (i / (points.length - 1)) * chartW,
    y: PAD_Y + chartH - ((p.score - minScore) / range) * chartH,
  }))

  const linePath = coords.map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x} ${c.y}`).join(' ')
  const areaPath = `${linePath} L ${coords[coords.length - 1].x} ${H - PAD_Y} L ${coords[0].x} ${H - PAD_Y} Z`

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-20" preserveAspectRatio="none">
        <defs>
          <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgb(99,102,241)" stopOpacity="0.3" />
            <stop offset="100%" stopColor="rgb(99,102,241)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Area fill */}
        <path d={areaPath} fill="url(#trendFill)" />

        {/* Line */}
        <path d={linePath} fill="none" stroke="rgb(99,102,241)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />

        {/* Dots */}
        {coords.map((c, i) => (
          <circle
            key={i}
            cx={c.x}
            cy={c.y}
            r={hoverIdx === i ? 4 : 2.5}
            fill={hoverIdx === i ? 'white' : 'rgb(99,102,241)'}
            stroke={hoverIdx === i ? 'rgb(99,102,241)' : 'none'}
            strokeWidth="2"
            onMouseEnter={() => setHoverIdx(i)}
            onMouseLeave={() => setHoverIdx(null)}
            className="cursor-pointer"
          />
        ))}
      </svg>

      {/* Tooltip */}
      {hoverIdx !== null && (
        <div
          className="absolute -top-8 bg-white border border-[#e1e8ed] rounded-lg px-2 py-1 text-xs text-[#0f1419] pointer-events-none whitespace-nowrap shadow-sm"
          style={{ left: `${(coords[hoverIdx].x / W) * 100}%`, transform: 'translateX(-50%)' }}
        >
          {points[hoverIdx].date}: <span className="font-bold text-indigo-600">{points[hoverIdx].score}</span>
        </div>
      )}
    </div>
  )
}
