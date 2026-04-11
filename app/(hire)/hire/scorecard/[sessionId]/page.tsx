'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter, useParams } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Quote, AlertTriangle, TrendingUp, Target } from 'lucide-react'
import StateView from '@shared/ui/StateView'
import Badge from '@shared/ui/Badge'
import Button from '@shared/ui/Button'
import MetricCard from '@shared/ui/MetricCard'
import { ScoreRing, ScoreBar } from '@shared/ui/ScoreBar'
import Accordion from '@shared/ui/Accordion'

interface RecruiterScorecard {
  domain: string
  interviewType: string
  experience: string
  overallScore: number
  passProb: string
  createdAt: string
  durationSeconds: number

  dimensions: {
    answerQuality: number
    communication: number
    engagement: number
  }

  questionSummaries: Array<{
    questionIndex: number
    question: string
    score: number
    strengths: string[]
    weaknesses: string[]
  }>

  competencyScores: Array<{
    name: string
    score: number
    trend: string
  }>

  keyQuotes: Array<{
    text: string
    context: string
    sentiment: 'positive' | 'neutral' | 'negative'
  }>

  recruiterSummary: string
  strengths: string[]
  improvements: string[]
  redFlags: string[]
}

function passProbVariant(prob: string): 'success' | 'caution' | 'danger' {
  const lower = prob.toLowerCase()
  if (lower.includes('high') || lower.includes('strong')) return 'success'
  if (lower.includes('medium') || lower.includes('moderate')) return 'caution'
  return 'danger'
}

function sentimentBorder(sentiment: string): string {
  if (sentiment === 'positive') return 'border-l-emerald-500'
  if (sentiment === 'negative') return 'border-l-rose-500'
  return 'border-l-amber-500'
}

function formatDuration(seconds: number): string {
  const mins = Math.round(seconds / 60)
  if (mins < 1) return '<1 min'
  return `${mins} min`
}

export default function ScorecardPage() {
  const router = useRouter()
  const params = useParams()
  const sessionId = params.sessionId as string
  const { status: authStatus } = useSession()
  const [scorecard, setScorecard] = useState<RecruiterScorecard | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (authStatus === 'unauthenticated') { router.push('/signin'); return }
    if (authStatus !== 'authenticated') return

    fetch('/api/hire/scorecard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
      .then(r => {
        if (!r.ok) throw new Error('Failed to load scorecard')
        return r.json()
      })
      .then(data => {
        if (data.scorecard) setScorecard(data.scorecard)
        else throw new Error('Scorecard not found')
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }, [authStatus, router, sessionId])

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto space-y-6">
        <Link href="/hire/candidates" className="flex items-center gap-2 text-caption text-[var(--foreground-tertiary)] hover:text-[var(--foreground-secondary)] transition-colors">
          <ArrowLeft className="w-3.5 h-3.5" /> Back to Candidates
        </Link>
        <StateView state="loading" skeletonLayout="card" skeletonCount={4} />
      </div>
    )
  }

  if (error || !scorecard) {
    return (
      <div className="max-w-4xl mx-auto space-y-6">
        <Link href="/hire/candidates" className="flex items-center gap-2 text-caption text-[var(--foreground-tertiary)] hover:text-[var(--foreground-secondary)] transition-colors">
          <ArrowLeft className="w-3.5 h-3.5" /> Back to Candidates
        </Link>
        <StateView state="error" error={error || 'Scorecard not found. The interview may not be completed yet.'} onRetry={() => window.location.reload()} />
      </div>
    )
  }

  const { dimensions, questionSummaries, keyQuotes, competencyScores } = scorecard

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      {/* Back nav */}
      <Link href="/hire/candidates" className="flex items-center gap-2 text-caption text-[var(--foreground-tertiary)] hover:text-[var(--foreground-secondary)] transition-colors">
        <ArrowLeft className="w-3.5 h-3.5" /> Back to Candidates
      </Link>

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-heading text-[var(--foreground)]">Interview Scorecard</h1>
          <div className="flex flex-wrap items-center gap-2 mt-2">
            <Badge variant="primary">{scorecard.domain}</Badge>
            <Badge variant="default">{scorecard.interviewType}</Badge>
            <Badge variant="default">{scorecard.experience} yrs</Badge>
            <span className="text-caption text-[var(--foreground-tertiary)]">
              {formatDuration(scorecard.durationSeconds)} &middot; {new Date(scorecard.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            </span>
          </div>
        </div>
        <Badge variant={passProbVariant(scorecard.passProb)} dot>
          {scorecard.passProb} Pass Probability
        </Badge>
      </div>

      {/* Hero score + AI summary */}
      <section className="surface-card-bordered p-6 flex flex-col sm:flex-row items-center gap-6">
        <ScoreRing score={scorecard.overallScore} size={140} />
        <div className="flex-1 min-w-0">
          <h2 className="text-subheading text-[var(--foreground)] mb-2">AI Assessment</h2>
          <p className="text-body text-[var(--foreground-secondary)] leading-relaxed">
            {scorecard.recruiterSummary}
          </p>
        </div>
      </section>

      {/* Dimension breakdown */}
      <section className="space-y-3">
        <h2 className="text-subheading text-[var(--foreground)]">Performance Dimensions</h2>
        <div className="grid md:grid-cols-3 gap-4">
          <MetricCard
            title="Answer Quality"
            score={dimensions.answerQuality}
            color="auto"
          />
          <MetricCard
            title="Communication"
            score={dimensions.communication}
            color="auto"
          />
          <MetricCard
            title="Engagement"
            score={dimensions.engagement}
            color="auto"
          />
        </div>
      </section>

      {/* Competency scores */}
      {competencyScores.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-subheading text-[var(--foreground)]">Competency Scores</h2>
          <div className="surface-card-bordered p-5 space-y-3">
            {competencyScores.map((comp) => (
              <ScoreBar
                key={comp.name}
                label={comp.name}
                score={comp.score}
                detail={comp.trend === 'improving' ? 'Improving' : comp.trend === 'declining' ? 'Declining' : 'Stable'}
              />
            ))}
          </div>
        </section>
      )}

      {/* Per-question breakdown */}
      {questionSummaries.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-subheading text-[var(--foreground)]">Question-by-Question</h2>
          <Accordion
            mode="multi"
            items={questionSummaries.map((q) => ({
              title: `Q${q.questionIndex + 1}: ${q.question}`,
              content: (
                <div className="space-y-3">
                  <ScoreBar label="Score" score={q.score} />
                  {q.strengths.length > 0 && (
                    <div>
                      <p className="step-label mb-1">Strengths</p>
                      <ul className="space-y-1">
                        {q.strengths.map((s, i) => (
                          <li key={i} className="text-caption text-emerald-600 flex items-start gap-1.5">
                            <span className="mt-0.5">&#10003;</span> {s}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {q.weaknesses.length > 0 && (
                    <div>
                      <p className="step-label mb-1">Areas for Improvement</p>
                      <ul className="space-y-1">
                        {q.weaknesses.map((w, i) => (
                          <li key={i} className="text-caption text-amber-600 flex items-start gap-1.5">
                            <span className="mt-0.5">&#9651;</span> {w}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              ),
            }))}
          />
        </section>
      )}

      {/* Key quotes */}
      {keyQuotes.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-subheading text-[var(--foreground)] flex items-center gap-2">
            <Quote className="w-4 h-4" /> Key Quotes
          </h2>
          <div className="space-y-3">
            {keyQuotes.map((quote, i) => (
              <div key={i} className={`surface-card-bordered p-4 border-l-4 ${sentimentBorder(quote.sentiment)}`}>
                <p className="text-body text-[var(--foreground)] italic leading-relaxed">
                  &ldquo;{quote.text}&rdquo;
                </p>
                <p className="text-caption text-[var(--foreground-tertiary)] mt-2">
                  {quote.context}
                </p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Strengths / Improvements / Red Flags */}
      <section className="grid md:grid-cols-3 gap-4">
        {/* Strengths */}
        <div className="surface-card-bordered p-5">
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp className="w-4 h-4 text-emerald-600" />
            <h3 className="text-subheading text-[var(--foreground)]">Strengths</h3>
          </div>
          {scorecard.strengths.length > 0 ? (
            <ul className="space-y-2">
              {scorecard.strengths.map((s, i) => (
                <li key={i} className="text-caption text-emerald-600 flex items-start gap-1.5">
                  <span className="mt-0.5">&#10003;</span> {s}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-caption text-[var(--foreground-tertiary)]">No strengths noted</p>
          )}
        </div>

        {/* Improvements */}
        <div className="surface-card-bordered p-5">
          <div className="flex items-center gap-2 mb-3">
            <Target className="w-4 h-4 text-amber-600" />
            <h3 className="text-subheading text-[var(--foreground)]">Improvements</h3>
          </div>
          {scorecard.improvements.length > 0 ? (
            <ul className="space-y-2">
              {scorecard.improvements.map((s, i) => (
                <li key={i} className="text-caption text-amber-600 flex items-start gap-1.5">
                  <span className="mt-0.5">&#9651;</span> {s}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-caption text-[var(--foreground-tertiary)]">No improvements noted</p>
          )}
        </div>

        {/* Red Flags */}
        <div className="surface-card-bordered p-5">
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle className="w-4 h-4 text-rose-500" />
            <h3 className="text-subheading text-[var(--foreground)]">Red Flags</h3>
          </div>
          {scorecard.redFlags.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {scorecard.redFlags.map((f, i) => (
                <Badge key={i} variant="danger">{f}</Badge>
              ))}
            </div>
          ) : (
            <p className="text-caption text-[var(--foreground-tertiary)]">No red flags</p>
          )}
        </div>
      </section>
    </div>
  )
}
