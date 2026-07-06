'use client'

import { useEffect, useState } from 'react'

interface ScoreBarProps {
  label: string
  score: number          // 0–100
  color?: 'blue' | 'emerald' | 'amber' | 'rose' | 'cyan'
  detail?: string
  delay?: number         // ms animation delay
}

const COLOR_MAP = {
  blue: {
    bar: 'bg-blue-500',
    text: 'text-blue-600',
    glow: 'shadow-blue-500/30',
  },
  emerald: {
    bar: 'bg-emerald-500',
    text: 'text-emerald-600',
    glow: 'shadow-emerald-500/30',
  },
  amber: {
    bar: 'bg-amber-500',
    text: 'text-amber-600',
    glow: 'shadow-amber-500/30',
  },
  rose: {
    bar: 'bg-rose-500',
    text: 'text-rose-600',
    glow: 'shadow-rose-500/30',
  },
  cyan: {
    bar: 'bg-cyan-500',
    text: 'text-cyan-600',
    glow: 'shadow-cyan-500/30',
  },
}

/**
 * Canonical score-band thresholds for interview scores. MUST match the hero band
 * LABEL (feedback page), QuestionBreakdown, and ScoreSummaryHeader — all of which
 * use 75/55. This file previously used 70/50 for the ring + bars, so the SAME
 * number could be painted a different band than the label / Scores tab (e.g. a 72
 * green in the hero ring but amber in "Overall 72") — a subtle trust bug once both
 * surfaces show the overall score. Single source so they can't drift again. (#498)
 */
export function scoreBand(score: number): 'strong' | 'ok' | 'weak' {
  if (score >= 75) return 'strong'
  if (score >= 55) return 'ok'
  return 'weak'
}

/** Tailwind text-color class for a score band (emerald / amber / red). */
export function scoreTextClass(score: number): string {
  const band = scoreBand(score)
  return band === 'strong' ? 'text-emerald-600' : band === 'ok' ? 'text-amber-600' : 'text-red-500'
}

const BAND_HEX: Record<'strong' | 'ok' | 'weak', string> = {
  strong: '#10b981', // emerald-500
  ok: '#f59e0b', // amber-500
  weak: '#ef4444', // red-500
}

function scoreToColor(score: number): 'emerald' | 'amber' | 'rose' {
  const band = scoreBand(score)
  return band === 'strong' ? 'emerald' : band === 'ok' ? 'amber' : 'rose'
}

export function ScoreBar({ label, score: rawScore, color, detail, delay = 0 }: ScoreBarProps) {
  const score = typeof rawScore === 'number' ? rawScore : Number(rawScore) || 0
  const [width, setWidth] = useState(0)
  const resolvedColor = color ?? scoreToColor(score)
  const c = COLOR_MAP[resolvedColor]

  useEffect(() => {
    const t = setTimeout(() => setWidth(score), delay + 100)
    return () => clearTimeout(t)
  }, [score, delay])

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-sm">
        <span className="text-[#0f1419] font-medium">{label}</span>
        <div className="flex items-center gap-2">
          {detail && <span className="text-[#71767b] text-xs">{detail}</span>}
          <span className={`font-bold tabular-nums ${c.text}`}>{score}</span>
        </div>
      </div>
      <div className="h-2 bg-[#eff3f4] rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full ${c.bar} shadow-sm ${c.glow} transition-all duration-700 ease-out`}
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  )
}

// ─── Overall score ring ────────────────────────────────────────────────────────

interface ScoreRingProps {
  score: number
  size?: number
}

export function ScoreRing({ score: rawScore, size = 120 }: ScoreRingProps) {
  const score = typeof rawScore === 'number' ? rawScore : Number(rawScore) || 0
  const [displayed, setDisplayed] = useState(0)
  const radius = (size / 2) * 0.8
  const circumference = 2 * Math.PI * radius
  const color = BAND_HEX[scoreBand(score)]

  useEffect(() => {
    let start = 0
    const step = () => {
      start += 2
      if (start <= score) {
        setDisplayed(start)
        requestAnimationFrame(step)
      } else {
        setDisplayed(score)
      }
    }
    const t = setTimeout(() => requestAnimationFrame(step), 200)
    return () => clearTimeout(t)
  }, [score])

  const offset = circumference - (displayed / 100) * circumference

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="#eff3f4"
          strokeWidth={size * 0.08}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={size * 0.08}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 0.05s linear' }}
        />
      </svg>
      <div className="absolute flex flex-col items-center">
        <span className="text-3xl font-bold text-[#0f1419] tabular-nums">{displayed}</span>
        <span className="text-xs text-[#71767b]">/ 100</span>
      </div>
    </div>
  )
}
