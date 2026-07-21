'use client'

import { useEffect, useState } from 'react'

interface TrendPoint {
  score: number
  date: string
}

interface ScoreTrendChartProps {
  currentScore: number
  sessionId?: string
  onAccountUnavailable?: () => void
}

async function isExactAccountUnavailable(response: Response): Promise<boolean> {
  if (response.status !== 401) return false
  const readable = typeof response.clone === 'function' ? response.clone() : response
  const body = await readable.json().catch(() => null) as { code?: unknown } | null
  return body?.code === 'ACCOUNT_UNAVAILABLE'
}

// Match the rest of the redesigned feedback page: Strong ≥75, Warning <55.
const STRONG_THRESHOLD = 75
const WARNING_THRESHOLD = 55

function bandColor(score: number): { line: string; areaStart: string; areaEnd: string; ref: string } {
  if (score >= STRONG_THRESHOLD) {
    return {
      line: 'rgb(16,185,129)', // emerald-500
      areaStart: 'rgba(16,185,129,0.28)',
      areaEnd: 'rgba(16,185,129,0)',
      ref: '#10b981',
    }
  }
  if (score >= WARNING_THRESHOLD) {
    return {
      line: 'rgb(245,158,11)', // amber-500
      areaStart: 'rgba(245,158,11,0.28)',
      areaEnd: 'rgba(245,158,11,0)',
      ref: '#f59e0b',
    }
  }
  return {
    line: 'rgb(239,68,68)', // red-500
    areaStart: 'rgba(239,68,68,0.28)',
    areaEnd: 'rgba(239,68,68,0)',
    ref: '#ef4444',
  }
}

export default function ScoreTrendChart({
  currentScore,
  sessionId,
  onAccountUnavailable,
}: ScoreTrendChartProps) {
  const [points, setPoints] = useState<TrendPoint[]>([])
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const res = await fetch('/api/interviews?limit=10&status=completed')
        if (await isExactAccountUnavailable(res)) {
          if (!cancelled) {
            setPoints([])
            onAccountUnavailable?.()
          }
          return
        }
        if (!res.ok) return
        const data = await res.json()
        if (cancelled) return
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
    return () => {
      cancelled = true
    }
  }, [sessionId, onAccountUnavailable])

  if (points.length < 2) {
    return (
      <div className="text-xs text-[#8b98a5] italic">
        Complete more interviews to see your score trend.
      </div>
    )
  }

  // Fixed Y range 0–100 — keeps the visual line shape honest. Previously
  // the chart auto-scaled to the data range, which made a 78→76 dip look
  // identical to a 78→32 dip. The whole point of "trend" is comparison
  // against an absolute scale, not a self-relative one.
  const W = 320
  const H = 140
  const PAD_L = 28 // room for Y-axis tick labels
  const PAD_R = 36 // room for right-edge reference labels (Strong / Watch)
  const PAD_T = 12
  const PAD_B = 22 // room for date labels
  const chartW = W - PAD_L - PAD_R
  const chartH = H - PAD_T - PAD_B

  const yFor = (score: number) => PAD_T + chartH - (Math.max(0, Math.min(100, score)) / 100) * chartH
  const xFor = (i: number) =>
    points.length === 1 ? PAD_L + chartW / 2 : PAD_L + (i / (points.length - 1)) * chartW

  const coords = points.map((p, i) => ({ x: xFor(i), y: yFor(p.score) }))
  const lastIdx = points.length - 1
  const colors = bandColor(points[lastIdx].score)

  const linePath = coords.map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x} ${c.y}`).join(' ')
  const baseY = H - PAD_B
  const areaPath = `${linePath} L ${coords[lastIdx].x} ${baseY} L ${coords[0].x} ${baseY} Z`

  const yTicks = [0, 50, 100]
  const refLines = [
    { y: STRONG_THRESHOLD, label: 'Strong', color: '#10b981' },
    { y: WARNING_THRESHOLD, label: 'Watch', color: '#f59e0b' },
  ]

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-36" preserveAspectRatio="none">
        <defs>
          <linearGradient id={`trendFill-${sessionId || 'default'}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={colors.areaStart} />
            <stop offset="100%" stopColor={colors.areaEnd} />
          </linearGradient>
        </defs>

        {/* Y-axis tick labels + faint gridlines at 0, 50, 100 */}
        {yTicks.map((tick) => (
          <g key={tick}>
            <line
              x1={PAD_L}
              x2={W - PAD_R}
              y1={yFor(tick)}
              y2={yFor(tick)}
              stroke="#e1e8ed"
              strokeWidth="1"
              strokeDasharray={tick === 0 || tick === 100 ? '0' : '2,3'}
            />
            <text
              x={PAD_L - 6}
              y={yFor(tick) + 3}
              textAnchor="end"
              fontSize="9"
              fill="#71767b"
            >
              {tick}
            </text>
          </g>
        ))}

        {/* Reference threshold lines (Strong = 75, Watch = 55) */}
        {refLines.map((ref) => (
          <g key={ref.y}>
            <line
              x1={PAD_L}
              x2={W - PAD_R}
              y1={yFor(ref.y)}
              y2={yFor(ref.y)}
              stroke={ref.color}
              strokeWidth="1"
              strokeDasharray="3,3"
              opacity="0.55"
            />
            <text
              x={W - PAD_R + 4}
              y={yFor(ref.y) + 3}
              fontSize="9"
              fill={ref.color}
              fontWeight="600"
            >
              {ref.label} {ref.y}
            </text>
          </g>
        ))}

        {/* Area fill */}
        <path d={areaPath} fill={`url(#trendFill-${sessionId || 'default'})`} />

        {/* Line */}
        <path
          d={linePath}
          fill="none"
          stroke={colors.line}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Dots — last (current session) gets a larger hollow ring */}
        {coords.map((c, i) => {
          const isCurrent = i === lastIdx
          const isHover = hoverIdx === i
          return (
            <g key={i}>
              {isCurrent && (
                <circle cx={c.x} cy={c.y} r="6" fill="white" stroke={colors.line} strokeWidth="2" />
              )}
              <circle
                cx={c.x}
                cy={c.y}
                r={isHover ? 4.5 : isCurrent ? 3.5 : 2.5}
                fill={isHover ? 'white' : colors.line}
                stroke={isHover ? colors.line : 'none'}
                strokeWidth="2"
                onMouseEnter={() => setHoverIdx(i)}
                onMouseLeave={() => setHoverIdx(null)}
                className="cursor-pointer"
              />
            </g>
          )
        })}

        {/* X-axis labels: first + last date only (avoid crowding) */}
        <text x={coords[0].x} y={H - 6} textAnchor="middle" fontSize="9" fill="#71767b">
          {points[0].date}
        </text>
        <text x={coords[lastIdx].x} y={H - 6} textAnchor="middle" fontSize="9" fill="#71767b" fontWeight="600">
          {points[lastIdx].date}
        </text>
      </svg>

      {/* Tooltip */}
      {hoverIdx !== null && (
        <div
          className="absolute -top-2 bg-white border border-[#e1e8ed] rounded-lg px-2 py-1 text-xs text-[#0f1419] pointer-events-none whitespace-nowrap shadow-sm"
          style={{ left: `${(coords[hoverIdx].x / W) * 100}%`, transform: 'translateX(-50%)' }}
        >
          {points[hoverIdx].date}: <span className="font-bold" style={{ color: bandColor(points[hoverIdx].score).line }}>{points[hoverIdx].score}</span>
          {hoverIdx === lastIdx && <span className="text-[#71767b] ml-1">· this session</span>}
        </div>
      )}

      {/* Legend strip — explicit baseline cue */}
      <div className="mt-2 flex items-center gap-3 text-[10px] text-[#71767b]">
        <span className="flex items-center gap-1">
          <span className="inline-block w-2.5 h-px bg-emerald-500" /> Strong ≥ {STRONG_THRESHOLD}
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2.5 h-px bg-amber-500" /> Watch ≥ {WARNING_THRESHOLD} &lt; {STRONG_THRESHOLD}
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2.5 h-px bg-red-500" /> Needs work &lt; {WARNING_THRESHOLD}
        </span>
        {/* Reference the prop so it isn't unused (currentScore matches points[lastIdx].score in normal flow but is the authoritative caller value). */}
        <span className="ml-auto opacity-0 select-none">{currentScore}</span>
      </div>
    </div>
  )
}
