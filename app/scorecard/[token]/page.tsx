'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { motion } from 'framer-motion'

interface PublicScorecard {
  domain: string
  interviewType: string
  experience: string
  overallScore: number
  dimensions: {
    answerQuality: number
    communication: number
    engagement: number
  }
  strengths: string[]
  questionCount: number
  duration: number
  createdAt: string
}

function ScoreRing({ score, size = 80 }: { score: number; size?: number }) {
  const radius = (size - 8) / 2
  const circumference = 2 * Math.PI * radius
  const offset = circumference - (score / 100) * circumference

  const color = score >= 75 ? '#34d399' : score >= 50 ? '#fbbf24' : '#f87171'

  return (
    <svg width={size} height={size} className="transform -rotate-90">
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#1e293b" strokeWidth={6} />
      <motion.circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth={6}
        strokeLinecap="round"
        strokeDasharray={circumference}
        initial={{ strokeDashoffset: circumference }}
        animate={{ strokeDashoffset: offset }}
        transition={{ duration: 1, ease: 'easeOut' }}
      />
    </svg>
  )
}

function DimensionBar({ label, score }: { label: string; score: number }) {
  const color = score >= 75 ? 'bg-emerald-500' : score >= 50 ? 'bg-amber-500' : 'bg-red-500'
  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span className="text-[#9ca3af]">{label}</span>
        <span className="text-[#d1d5db] font-medium">{score}/100</span>
      </div>
      <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
        <motion.div
          className={`h-full rounded-full ${color}`}
          initial={{ width: 0 }}
          animate={{ width: `${score}%` }}
          transition={{ duration: 0.8, ease: 'easeOut' }}
        />
      </div>
    </div>
  )
}

export default function ScorecardPage() {
  const { token } = useParams<{ token: string }>()
  const [data, setData] = useState<PublicScorecard | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!token) return
    fetch(`/api/public/scorecard/${token}`)
      .then(r => {
        if (!r.ok) throw new Error('Not found')
        return r.json()
      })
      .then(d => { setData(d); setLoading(false) })
      .catch(() => { setError(true); setLoading(false) })
  }, [token])

  if (loading) {
    return (
      <main className="min-h-screen bg-[#0a0f1a] flex items-center justify-center">
        <div className="animate-pulse space-y-4 w-full max-w-md px-4">
          <div className="h-8 bg-slate-800 rounded w-48 mx-auto" />
          <div className="h-48 bg-slate-800 rounded-2xl" />
        </div>
      </main>
    )
  }

  if (error || !data) {
    return (
      <main className="min-h-screen bg-[#0a0f1a] flex items-center justify-center text-center px-4">
        <div>
          <h1 className="text-xl font-bold text-[#f0f2f5] mb-2">Scorecard Not Found</h1>
          <p className="text-[#6b7280] mb-6">This scorecard may have expired or been revoked.</p>
          <a
            href="/"
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
          >
            Practice Your Own Interview
          </a>
        </div>
      </main>
    )
  }

  const date = new Date(data.createdAt).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
  const minutes = Math.round(data.duration / 60)

  return (
    <main className="min-h-screen bg-[#0a0f1a] py-12 px-4">
      <motion.div
        className="max-w-md mx-auto"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
      >
        {/* Card */}
        <div className="bg-gradient-to-br from-slate-900 to-slate-800 border border-slate-700/50 rounded-2xl p-6 sm:p-8 space-y-6">
          {/* Header */}
          <div className="text-center">
            <div className="text-xs text-blue-400 font-medium uppercase tracking-wider mb-2">
              Interview Scorecard
            </div>
            <h1 className="text-lg font-bold text-[#f0f2f5] capitalize">
              {data.domain.replace(/-/g, ' ')} — {data.interviewType.replace(/-/g, ' ')}
            </h1>
            <p className="text-xs text-[#6b7280] mt-1">
              {date} &middot; {data.questionCount} questions &middot; {minutes}min
            </p>
          </div>

          {/* Score ring */}
          <div className="flex flex-col items-center">
            <div className="relative">
              <ScoreRing score={data.overallScore} size={100} />
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-2xl font-bold text-[#f0f2f5]">{data.overallScore}</span>
              </div>
            </div>
            <span className="text-xs text-[#6b7280] mt-2">Overall Score</span>
          </div>

          {/* Dimension bars */}
          <div className="space-y-3">
            <DimensionBar label="Answer Quality" score={data.dimensions.answerQuality} />
            <DimensionBar label="Communication" score={data.dimensions.communication} />
            <DimensionBar label="Engagement" score={data.dimensions.engagement} />
          </div>

          {/* Strengths */}
          {data.strengths.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-[#9ca3af] uppercase tracking-wide mb-2">Key Strengths</h3>
              <ul className="space-y-1">
                {data.strengths.map((s, i) => (
                  <li key={i} className="text-sm text-[#d1d5db] flex items-start gap-2">
                    <span className="text-emerald-400 mt-0.5 shrink-0">+</span>
                    {s}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Verified badge */}
          <div className="flex items-center justify-center gap-2 pt-2 border-t border-slate-700/50">
            <svg className="w-4 h-4 text-blue-400" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M6.267 3.455a3.066 3.066 0 001.745-.723 3.066 3.066 0 013.976 0 3.066 3.066 0 001.745.723 3.066 3.066 0 012.812 2.812c.051.643.304 1.254.723 1.745a3.066 3.066 0 010 3.976 3.066 3.066 0 00-.723 1.745 3.066 3.066 0 01-2.812 2.812 3.066 3.066 0 00-1.745.723 3.066 3.066 0 01-3.976 0 3.066 3.066 0 00-1.745-.723 3.066 3.066 0 01-2.812-2.812 3.066 3.066 0 00-.723-1.745 3.066 3.066 0 010-3.976 3.066 3.066 0 00.723-1.745 3.066 3.066 0 012.812-2.812zm7.44 5.252a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
            </svg>
            <span className="text-xs text-[#6b7280]">Verified by Interview Prep Guru</span>
          </div>
        </div>

        {/* CTA */}
        <div className="text-center mt-8">
          <a
            href="/"
            className="inline-flex items-center gap-2 px-6 py-3 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
          >
            Practice Your Own Interview
          </a>
        </div>
      </motion.div>
    </main>
  )
}
