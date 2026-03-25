'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'

interface DimensionDelta {
  dimension: string
  label: string
  current: number
  previous: number | null
  rollingAvg: number | null
  delta: number | null
  deltaAvg: number | null
  direction: 'up' | 'down' | 'same' | 'new'
}

interface ComparisonResult {
  dimensions: DimensionDelta[]
  overallDelta: number | null
  overallDirection: 'up' | 'down' | 'same' | 'new'
  sessionsCompared: number
  sinceFirstDelta: number | null
}

interface ComparisonCardProps {
  currentScores: {
    relevance: number
    structure: number
    specificity: number
    ownership: number
  }
  overallScore: number
  domain?: string
}

function DeltaBadge({ delta, label }: { delta: number | null; label: string }) {
  if (delta === null) return null

  const isPositive = delta > 0
  const isNeutral = Math.abs(delta) <= 2
  const color = isNeutral
    ? 'text-[#71767b] bg-[#f7f9f9]'
    : isPositive
    ? 'text-emerald-600 bg-emerald-500/10'
    : 'text-[#f4212e] bg-red-500/10'

  const arrow = isNeutral ? '' : isPositive ? '+' : ''

  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium ${color}`}>
      {arrow}{delta} {label}
    </span>
  )
}

function ArrowIcon({ direction }: { direction: 'up' | 'down' | 'same' | 'new' }) {
  if (direction === 'up') {
    return (
      <svg className="w-3.5 h-3.5 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 10l7-7m0 0l7 7m-7-7v18" />
      </svg>
    )
  }
  if (direction === 'down') {
    return (
      <svg className="w-3.5 h-3.5 text-[#f4212e]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
      </svg>
    )
  }
  if (direction === 'same') {
    return (
      <svg className="w-3.5 h-3.5 text-[#71767b]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14" />
      </svg>
    )
  }
  return null
}

export default function ComparisonCard({ currentScores, overallScore, domain }: ComparisonCardProps) {
  const [data, setData] = useState<ComparisonResult | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const params = new URLSearchParams({
      relevance: String(currentScores.relevance),
      structure: String(currentScores.structure),
      specificity: String(currentScores.specificity),
      ownership: String(currentScores.ownership),
      overall: String(overallScore),
    })
    if (domain) params.set('domain', domain)

    fetch(`/api/learn/comparison?${params}`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [currentScores, overallScore, domain])

  if (loading) {
    return (
      <div className="surface-card-bordered p-5 animate-pulse">
        <div className="h-4 bg-[#f7f9f9] rounded w-40 mb-4" />
        <div className="grid grid-cols-2 gap-3">
          {[1, 2, 3, 4].map(i => <div key={i} className="h-12 bg-[#f7f9f9] rounded" />)}
        </div>
      </div>
    )
  }

  if (!data || data.sessionsCompared === 0) return null

  return (
    <motion.section
      className="surface-card-bordered p-5 sm:p-6 space-y-4"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.2 }}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[#0f1419]">Compared to Previous</h3>
        <span className="text-xs text-[#71767b]">
          Based on {data.sessionsCompared} past session{data.sessionsCompared !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Overall delta */}
      {data.overallDelta !== null && (
        <div className="flex items-center gap-3 p-3 rounded-xl bg-[#f7f9f9]">
          <ArrowIcon direction={data.overallDirection} />
          <div className="flex-1">
            <span className="text-sm text-[#0f1419] font-medium">Overall Score</span>
          </div>
          <DeltaBadge delta={data.overallDelta} label="vs last" />
          {data.sinceFirstDelta !== null && data.sinceFirstDelta !== data.overallDelta && (
            <DeltaBadge delta={data.sinceFirstDelta} label="since start" />
          )}
        </div>
      )}

      {/* Per-dimension deltas */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {data.dimensions.map(dim => (
          <div key={dim.dimension} className="flex items-center gap-3 p-3 rounded-xl bg-[#f7f9f9]">
            <ArrowIcon direction={dim.direction} />
            <div className="flex-1 min-w-0">
              <div className="text-sm text-[#536471]">{dim.label}</div>
              <div className="text-xs text-[#71767b]">{dim.current}/100</div>
            </div>
            <div className="flex flex-col items-end gap-0.5">
              {dim.delta !== null && <DeltaBadge delta={dim.delta} label="" />}
              {dim.deltaAvg !== null && (
                <span className="text-[10px] text-[#8b98a5]">
                  {dim.deltaAvg > 0 ? '+' : ''}{dim.deltaAvg} vs avg
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </motion.section>
  )
}
