'use client'

import { useEffect, useState } from 'react'
import DailyChallengeResult from './DailyChallengeResult'

interface ChallengeData {
  date: string
  question: string
  domain: string
  difficulty: string
  participantCount: number
  avgScore: number
  completed: boolean
}

interface SubmissionResult {
  score: number
  breakdown: { relevance: number; structure: number; specificity: number; ownership: number }
  percentile: number
  communityAvg: number
  participantCount: number
}

export default function DailyChallengeCard() {
  const [challenge, setChallenge] = useState<ChallengeData | null>(null)
  const [answer, setAnswer] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<SubmissionResult | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/learn/daily-challenge')
      .then(r => r.json())
      .then(data => {
        if (data.question) setChallenge(data)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  const handleSubmit = async () => {
    if (!answer.trim() || answer.length < 10 || submitting) return
    setSubmitting(true)
    try {
      const res = await fetch('/api/learn/daily-challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer }),
      })
      if (res.ok) {
        const data = await res.json()
        setResult(data)
      }
    } catch {
      // Show error
    } finally {
      setSubmitting(false)
    }
  }

  // Countdown to next challenge (midnight UTC)
  const [timeLeft, setTimeLeft] = useState('')
  useEffect(() => {
    const updateTime = () => {
      const now = new Date()
      const midnight = new Date(now)
      midnight.setUTCDate(midnight.getUTCDate() + 1)
      midnight.setUTCHours(0, 0, 0, 0)
      const diff = midnight.getTime() - now.getTime()
      const hours = Math.floor(diff / (1000 * 60 * 60))
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60))
      setTimeLeft(`${hours}h ${minutes}m`)
    }
    updateTime()
    const interval = setInterval(updateTime, 60000)
    return () => clearInterval(interval)
  }, [])

  if (loading) {
    return <div className="h-48 bg-slate-800 rounded-xl animate-pulse" />
  }

  if (!challenge) return null

  // Already completed or just submitted
  if (result || challenge.completed) {
    return (
      <div className="surface-card-bordered p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-[#f0f2f5]">Daily Challenge</h2>
          <span className="text-xs text-[#6b7280]">Next in {timeLeft}</span>
        </div>
        {result ? (
          <DailyChallengeResult
            score={result.score}
            breakdown={result.breakdown}
            percentile={result.percentile}
            communityAvg={result.communityAvg}
            participantCount={result.participantCount}
          />
        ) : (
          <p className="text-sm text-[#34d399]">
            ✓ You&apos;ve completed today&apos;s challenge!
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="surface-card-bordered p-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-[#f0f2f5]">Daily Challenge</h2>
        <div className="flex items-center gap-2 text-xs text-[#6b7280]">
          <span className="px-2 py-0.5 bg-[#1e293b] rounded text-[#9ca3af] capitalize">{challenge.domain.replace('-', ' ')}</span>
          <span>{challenge.participantCount} participants</span>
        </div>
      </div>

      <p className="text-sm text-[#d1d5db] mb-4 leading-relaxed">{challenge.question}</p>

      <textarea
        value={answer}
        onChange={e => setAnswer(e.target.value)}
        placeholder="Type your answer here... (minimum 10 characters)"
        className="w-full bg-[#0f172a] border border-[rgba(255,255,255,0.08)] rounded-lg px-3 py-2 text-sm text-[#d1d5db] placeholder-[#4b5563] focus:outline-none focus:border-[#6366f1] resize-none"
        rows={5}
        maxLength={5000}
      />

      <div className="flex items-center justify-between mt-3">
        <span className="text-micro text-[#4b5563]">{answer.length}/5000</span>
        <button
          onClick={handleSubmit}
          disabled={answer.length < 10 || submitting}
          className="px-4 py-2 bg-[#6366f1] hover:bg-[#5558e6] disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors"
        >
          {submitting ? 'Scoring...' : 'Submit Answer'}
        </button>
      </div>
    </div>
  )
}
