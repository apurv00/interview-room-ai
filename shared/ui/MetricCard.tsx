'use client'

import { useState } from 'react'
import { ScoreBar } from '@interview/components/ScoreBar'

type MetricColor = 'primary' | 'success' | 'caution' | 'danger' | 'auto'

interface Metric {
  label: string
  value: number
  detail?: string
}

interface MetricCardProps {
  title: string
  score: number
  color?: MetricColor
  metrics?: Metric[]
  insights?: {
    strengths?: string[]
    improvements?: string[]
  }
  expandable?: boolean
}

function resolveColor(score: number, color: MetricColor): 'emerald' | 'amber' | 'rose' | 'indigo' {
  if (color === 'auto') {
    if (score >= 70) return 'emerald'
    if (score >= 50) return 'amber'
    return 'rose'
  }
  const map: Record<string, 'emerald' | 'amber' | 'rose' | 'indigo'> = {
    primary: 'indigo',
    success: 'emerald',
    caution: 'amber',
    danger: 'rose',
  }
  return map[color] || 'indigo'
}

const scoreTextColor: Record<string, string> = {
  emerald: 'text-emerald-600',
  amber: 'text-amber-600',
  rose: 'text-rose-600',
  indigo: 'text-indigo-600',
}

export default function MetricCard({
  title,
  score,
  color = 'auto',
  metrics = [],
  insights,
  expandable = false,
}: MetricCardProps) {
  const [expanded, setExpanded] = useState(!expandable)
  const resolved = resolveColor(score, color)

  return (
    <div className="surface-card-bordered p-5">
      <div
        className={`flex items-center justify-between ${expandable ? 'cursor-pointer' : ''}`}
        onClick={expandable ? () => setExpanded(!expanded) : undefined}
      >
        <span className="text-subheading text-[#0f1419]">{title}</span>
        <div className="flex items-center gap-2">
          <span className={`text-heading font-bold tabular-nums ${scoreTextColor[resolved]}`}
            role="meter"
            aria-valuenow={score}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${title} score: ${score} out of 100`}
          >
            {score}
          </span>
          {expandable && (
            <svg
              className={`w-4 h-4 text-[#8b98a5] transition-transform duration-[250ms] ${expanded ? 'rotate-180' : ''}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          )}
        </div>
      </div>

      {expanded && (
        <div className="mt-4 space-y-3">
          {metrics.map((m) => (
            <ScoreBar
              key={m.label}
              label={m.label}
              score={m.value}
              detail={m.detail}
            />
          ))}

          {insights && (
            <div className="mt-3 space-y-2">
              {insights.strengths?.map((s, i) => (
                <p key={i} className="text-caption text-[#059669] flex items-start gap-1.5">
                  <span className="mt-0.5">&#10003;</span> {s}
                </p>
              ))}
              {insights.improvements?.map((s, i) => (
                <p key={i} className="text-caption text-[#d97706] flex items-start gap-1.5">
                  <span className="mt-0.5">&#9651;</span> {s}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
