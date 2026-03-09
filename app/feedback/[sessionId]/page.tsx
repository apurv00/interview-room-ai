'use client'

import { useEffect, useState } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { ScoreBar, ScoreRing } from '@/components/ScoreBar'
import ScoreTrendChart from '@/components/feedback/ScoreTrendChart'
import QuestionBreakdown from '@/components/feedback/QuestionBreakdown'
import CommunicationDetail from '@/components/feedback/CommunicationDetail'
import type { FeedbackData, StoredInterviewData, TranscriptEntry, EngagementSignals, DeliverySignals } from '@/lib/types'
import { ROLE_LABELS } from '@/lib/interviewConfig'

const PROBABILITY_COLORS = {
  High: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30',
  Medium: 'text-amber-400 bg-amber-500/10 border-amber-500/30',
  Low: 'text-red-400 bg-red-500/10 border-red-500/30',
}

const CONFIDENCE_TREND_LABELS = {
  increasing: { text: 'Improving', color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30' },
  stable: { text: 'Stable', color: 'text-slate-400 bg-slate-500/10 border-slate-500/30' },
  declining: { text: 'Declining', color: 'text-amber-400 bg-amber-500/10 border-amber-500/30' },
}

type FeedbackTab = 'overview' | 'questions' | 'transcript'

export default function FeedbackPage() {
  const router = useRouter()
  const params = useParams()
  const sessionId = params.sessionId as string

  const [data, setData] = useState<StoredInterviewData | null>(null)
  const [feedback, setFeedback] = useState<FeedbackData | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<FeedbackTab>('overview')
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null)

  useEffect(() => {
    async function loadData() {
      // Try loading from DB first (unless it's the "local" fallback route)
      if (sessionId && sessionId !== 'local') {
        try {
          const res = await fetch(`/api/interviews/${sessionId}`)
          if (res.ok) {
            const session = await res.json()
            const d: StoredInterviewData = {
              config: session.config,
              transcript: session.transcript || [],
              evaluations: session.evaluations || [],
              speechMetrics: session.speechMetrics || [],
              feedback: session.feedback,
            }
            setData(d)
            if (session.recordingUrl) setRecordingUrl(session.recordingUrl)

            // If feedback already exists in DB, use it
            if (session.feedback) {
              setFeedback(session.feedback)
              setLoading(false)
              return
            }

            // Otherwise generate feedback
            await generateFeedback(d, sessionId)
            return
          }
        } catch {
          // Fall through to localStorage
        }
      }

      // Fallback: load from localStorage
      const stored = localStorage.getItem('interviewData')
      if (!stored) {
        router.push('/')
        return
      }
      const d: StoredInterviewData = JSON.parse(stored)
      setData(d)
      await generateFeedback(d, sessionId !== 'local' ? sessionId : undefined)
    }

    loadData()
  }, [sessionId, router]) // eslint-disable-line

  async function generateFeedback(d: StoredInterviewData, sid?: string) {
    try {
      const res = await fetch('/api/generate-feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: d.config,
          transcript: d.transcript,
          evaluations: d.evaluations,
          speechMetrics: d.speechMetrics,
          sessionId: sid,
        }),
      })
      const fb: FeedbackData = await res.json()
      setFeedback(fb)

      // Persist feedback to DB
      if (sid && sid !== 'local') {
        try {
          await fetch(`/api/interviews/${sid}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ feedback: fb }),
          })
        } catch {
          // Non-critical
        }
      }
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  if (loading || !feedback || !data) {
    return (
      <div className="min-h-screen bg-[#070b14] flex flex-col items-center justify-center gap-4">
        <div className="w-8 h-8 rounded-full border-2 border-indigo-400 border-t-transparent animate-spin" />
        <p className="text-slate-400 text-sm">Generating your feedback report...</p>
      </div>
    )
  }

  const { dimensions, red_flags, top_3_improvements, overall_score, pass_probability } = feedback
  const { answer_quality, communication } = dimensions

  // Backward compat: support both engagement_signals and legacy delivery_signals
  const engagementSignals: EngagementSignals | null = dimensions.engagement_signals || null
  const deliverySignals: DeliverySignals | null = dimensions.delivery_signals || null

  const TABS: { key: FeedbackTab; label: string }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'questions', label: 'Questions' },
    { key: 'transcript', label: 'Transcript' },
  ]

  return (
    <div className="min-h-screen bg-[#070b14] text-white">
      {/* Header */}
      <header className="px-6 py-5 border-b border-slate-800 bg-slate-900/50 backdrop-blur sticky top-14 z-10">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold">Interview Feedback</h1>
            <p className="text-xs text-slate-400 mt-0.5">
              {data.config &&
                `${ROLE_LABELS[data.config.role]} · ${data.config.experience} yrs · ${data.config.duration} min`}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {recordingUrl && (
              <a
                href={recordingUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 px-3 py-2 bg-slate-800 border border-slate-700 hover:bg-slate-700 rounded-xl text-sm text-slate-300 transition"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Playback
              </a>
            )}
            <button
              onClick={() => router.push('/')}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 rounded-xl text-sm font-medium transition"
            >
              Reattempt
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-8 space-y-8">
        {/* Hero: overall score + trend */}
        <section className="flex flex-col sm:flex-row items-center gap-8 bg-slate-900 border border-slate-800 rounded-2xl p-6 sm:p-8 animate-slide-up">
          <ScoreRing score={overall_score} size={140} />
          <div className="space-y-3 text-center sm:text-left flex-1">
            <div>
              <h2 className="text-2xl font-bold">
                {overall_score >= 75
                  ? 'Strong Performance'
                  : overall_score >= 55
                  ? 'Competent'
                  : 'Needs Development'}
              </h2>
              <p className="text-slate-400 mt-1">
                {overall_score >= 75
                  ? 'You demonstrated clear, structured answers with solid examples.'
                  : overall_score >= 55
                  ? 'Solid foundation — refining structure and specificity will elevate your score.'
                  : 'Focus on the STAR framework and concrete examples in your next attempt.'}
              </p>
            </div>
            <div className="flex items-center gap-3 justify-center sm:justify-start flex-wrap">
              <div
                className={`px-3 py-1 rounded-full border text-sm font-medium ${PROBABILITY_COLORS[pass_probability]}`}
              >
                {pass_probability} pass probability
              </div>
              <div className="px-3 py-1 rounded-full border border-slate-700 text-slate-400 text-sm">
                {feedback.confidence_level} confidence
              </div>
            </div>
            {/* Score trend */}
            <div className="pt-2">
              <p className="text-xs text-slate-500 mb-1">Score trend</p>
              <ScoreTrendChart currentScore={overall_score} sessionId={sessionId} />
            </div>
          </div>
        </section>

        {/* Tab navigation */}
        <div className="flex gap-1 bg-slate-900 border border-slate-800 rounded-xl p-1 w-fit">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                activeTab === tab.key
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Overview tab */}
        {activeTab === 'overview' && (
          <div className="space-y-6">
            {/* Score breakdown */}
            <section className="grid md:grid-cols-3 gap-4">
              {/* Answer Quality */}
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4 animate-slide-up stagger-1">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-slate-200">Answer Quality</h3>
                  <span className="text-2xl font-bold text-indigo-400">{answer_quality.score}</span>
                </div>
                <div className="space-y-3">
                  <ScoreBar
                    label="Relevance"
                    score={
                      data.evaluations.length > 0
                        ? Math.round(data.evaluations.reduce((a, e) => a + e.relevance, 0) / data.evaluations.length)
                        : answer_quality.score
                    }
                    delay={100}
                  />
                  <ScoreBar
                    label="Structure (STAR)"
                    score={
                      data.evaluations.length > 0
                        ? Math.round(data.evaluations.reduce((a, e) => a + e.structure, 0) / data.evaluations.length)
                        : answer_quality.score
                    }
                    delay={200}
                  />
                  <ScoreBar
                    label="Specificity"
                    score={
                      data.evaluations.length > 0
                        ? Math.round(data.evaluations.reduce((a, e) => a + e.specificity, 0) / data.evaluations.length)
                        : answer_quality.score
                    }
                    delay={300}
                  />
                  <ScoreBar
                    label="Ownership"
                    score={
                      data.evaluations.length > 0
                        ? Math.round(data.evaluations.reduce((a, e) => a + e.ownership, 0) / data.evaluations.length)
                        : answer_quality.score
                    }
                    delay={400}
                  />
                </div>
                {answer_quality.strengths.length > 0 && (
                  <div className="pt-2 border-t border-slate-800">
                    <p className="text-xs text-emerald-400 font-medium mb-1">Strengths</p>
                    {answer_quality.strengths.map((s) => (
                      <p key={s} className="text-xs text-slate-400">
                        · {s}
                      </p>
                    ))}
                  </div>
                )}
                {answer_quality.weaknesses.length > 0 && (
                  <div>
                    <p className="text-xs text-amber-400 font-medium mb-1">Areas to improve</p>
                    {answer_quality.weaknesses.map((w) => (
                      <p key={w} className="text-xs text-slate-400">
                        · {w}
                      </p>
                    ))}
                  </div>
                )}
              </div>

              {/* Communication */}
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4 animate-slide-up stagger-2">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-slate-200">Communication</h3>
                  <span className="text-2xl font-bold text-cyan-400">{communication.score}</span>
                </div>
                <div className="space-y-3">
                  <ScoreBar
                    label="Pacing"
                    score={communication.pause_score}
                    color="cyan"
                    delay={100}
                    detail={`${communication.wpm} wpm`}
                  />
                  <ScoreBar
                    label="Filler words"
                    score={Math.round(Math.max(0, 100 - communication.filler_rate * 500))}
                    color="cyan"
                    delay={200}
                    detail={`${(communication.filler_rate * 100).toFixed(1)}%`}
                  />
                  <ScoreBar
                    label="Conciseness"
                    score={Math.round(Math.max(0, 100 - communication.rambling_index * 100))}
                    color="cyan"
                    delay={300}
                  />
                </div>
                {/* Enhanced communication detail */}
                <div className="pt-2 border-t border-slate-800">
                  <CommunicationDetail metrics={data.speechMetrics} />
                </div>
                <div className="pt-2 border-t border-slate-800 space-y-1">
                  {[
                    { label: 'Avg. WPM', value: communication.wpm, ideal: '120-160' },
                    {
                      label: 'Filler rate',
                      value: `${(communication.filler_rate * 100).toFixed(1)}%`,
                      ideal: '<5%',
                    },
                    {
                      label: 'Rambling index',
                      value: communication.rambling_index.toFixed(2),
                      ideal: '<0.30',
                    },
                  ].map(({ label, value, ideal }) => (
                    <div key={label} className="flex justify-between text-xs">
                      <span className="text-slate-500">{label}</span>
                      <span className="text-slate-300 tabular-nums">
                        {value} <span className="text-slate-600">({ideal})</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Engagement (or legacy Delivery) */}
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4 animate-slide-up stagger-3">
                {engagementSignals ? (
                  <>
                    <div className="flex items-center justify-between">
                      <h3 className="font-semibold text-slate-200">Engagement</h3>
                      <span className="text-2xl font-bold text-violet-400">{engagementSignals.score}</span>
                    </div>
                    <div className="space-y-3">
                      <ScoreBar
                        label="Engagement depth"
                        score={engagementSignals.engagement_score}
                        color="indigo"
                        delay={100}
                      />
                      <ScoreBar
                        label="Composure under pressure"
                        score={engagementSignals.composure_under_pressure}
                        color="indigo"
                        delay={200}
                      />
                      <ScoreBar
                        label="Energy consistency"
                        score={Math.round(engagementSignals.energy_consistency * 100)}
                        color="indigo"
                        delay={300}
                      />
                    </div>
                    <div className="pt-2 border-t border-slate-800 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-slate-500">Confidence trend</span>
                        <span className={`text-xs px-2 py-0.5 rounded-full border ${CONFIDENCE_TREND_LABELS[engagementSignals.confidence_trend].color}`}>
                          {CONFIDENCE_TREND_LABELS[engagementSignals.confidence_trend].text}
                        </span>
                      </div>
                      <p className="text-xs text-slate-600">
                        Engagement scores are AI-estimated from speech patterns, answer depth, and consistency.
                      </p>
                    </div>
                  </>
                ) : deliverySignals ? (
                  <>
                    {/* Legacy delivery signals for backward compat */}
                    <div className="flex items-center justify-between">
                      <h3 className="font-semibold text-slate-200">Delivery</h3>
                      <span className="text-2xl font-bold text-violet-400">{deliverySignals.score}</span>
                    </div>
                    <div className="space-y-3">
                      <ScoreBar
                        label="Gaze / eye contact"
                        score={Math.round(deliverySignals.gaze_ratio * 100)}
                        color="indigo"
                        delay={100}
                      />
                      <ScoreBar
                        label="Head stability"
                        score={Math.round(deliverySignals.head_stability * 100)}
                        color="indigo"
                        delay={200}
                      />
                      <ScoreBar
                        label="Affect variability"
                        score={Math.round(deliverySignals.affect_variability * 100)}
                        color="indigo"
                        delay={300}
                      />
                    </div>
                    <div className="pt-2 border-t border-slate-800">
                      <div
                        className={`text-xs px-2 py-1 rounded-full border w-fit ${PROBABILITY_COLORS[deliverySignals.confidence_band]}`}
                      >
                        Confidence band: {deliverySignals.confidence_band}
                      </div>
                      <p className="text-xs text-slate-600 mt-2">
                        Delivery scores are AI-estimated. Updated engagement analysis available in new sessions.
                      </p>
                    </div>
                  </>
                ) : null}
              </div>
            </section>

            {/* JD Alignment Section — conditional */}
            {feedback.jd_match_score !== undefined && (
              <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4 animate-slide-up stagger-4">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-slate-200">JD Alignment</h3>
                  <span className="text-2xl font-bold text-cyan-400">{feedback.jd_match_score}</span>
                </div>
                <ScoreBar
                  label="Overall JD Match"
                  score={feedback.jd_match_score}
                  color="cyan"
                  delay={100}
                />
                {feedback.jd_requirement_breakdown && feedback.jd_requirement_breakdown.length > 0 && (
                  <div className="pt-2 border-t border-slate-800 space-y-2">
                    <p className="text-xs text-slate-500 font-medium uppercase tracking-wide">Requirement Breakdown</p>
                    {feedback.jd_requirement_breakdown.map((req, i) => (
                      <div key={i} className="flex items-start gap-2">
                        <span className={`shrink-0 mt-0.5 ${req.matched ? 'text-emerald-400' : 'text-red-400'}`}>
                          {req.matched ? (
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                          ) : (
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          )}
                        </span>
                        <div className="flex-1">
                          <p className="text-sm text-slate-300">{req.requirement}</p>
                          {req.evidence && (
                            <p className="text-xs text-slate-500 mt-0.5">{req.evidence}</p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}

            {/* Red flags */}
            {red_flags.length > 0 && (
              <section className="bg-red-950/30 border border-red-500/20 rounded-2xl p-5 animate-slide-up stagger-4">
                <h3 className="font-semibold text-red-400 mb-3">Red flags detected</h3>
                <ul className="space-y-2">
                  {red_flags.map((flag) => (
                    <li key={flag} className="flex items-start gap-2 text-sm text-red-300">
                      <span className="shrink-0">·</span> {flag}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* Top 3 improvements */}
            <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5 animate-slide-up stagger-5">
              <h3 className="font-semibold text-slate-200 mb-4">Top improvements for next attempt</h3>
              <div className="space-y-3">
                {top_3_improvements.map((tip, i) => (
                  <div key={tip} className="flex items-start gap-3">
                    <span className="shrink-0 w-6 h-6 rounded-full bg-indigo-600/30 border border-indigo-500/40 text-indigo-400 text-xs flex items-center justify-center font-bold">
                      {i + 1}
                    </span>
                    <p className="text-sm text-slate-300 leading-relaxed">{tip}</p>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}

        {/* Questions tab */}
        {activeTab === 'questions' && (
          <div className="animate-slide-up">
            <QuestionBreakdown transcript={data.transcript} evaluations={data.evaluations} />
          </div>
        )}

        {/* Transcript tab */}
        {activeTab === 'transcript' && (
          <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4 animate-slide-up">
            <h3 className="font-semibold text-slate-200">Full Transcript</h3>
            <div className="space-y-4 max-h-[600px] overflow-y-auto transcript-scroll pr-2">
              {data.transcript.map((entry: TranscriptEntry, i: number) => (
                <div
                  key={i}
                  className={`flex gap-3 ${entry.speaker === 'interviewer' ? '' : 'flex-row-reverse'}`}
                >
                  <div
                    className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${
                      entry.speaker === 'interviewer'
                        ? 'bg-indigo-600 text-white'
                        : 'bg-slate-700 text-slate-300'
                    }`}
                  >
                    {entry.speaker === 'interviewer' ? 'A' : 'Y'}
                  </div>
                  <div
                    className={`max-w-[78%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed ${
                      entry.speaker === 'interviewer'
                        ? 'bg-slate-800 text-slate-200'
                        : 'bg-indigo-900/40 border border-indigo-500/20 text-indigo-100'
                    }`}
                  >
                    {entry.text}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* CTA */}
        <div className="flex gap-3 justify-center pb-8 animate-slide-up">
          <button
            onClick={() => router.push('/')}
            className="px-8 py-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-2xl font-semibold btn-glow transition"
          >
            Reattempt Interview
          </button>
          <button
            onClick={() => {
              const text = data.transcript.map((e) => `${e.speaker.toUpperCase()}: ${e.text}`).join('\n\n')
              const blob = new Blob([text], { type: 'text/plain' })
              const a = document.createElement('a')
              a.href = URL.createObjectURL(blob)
              a.download = 'interview-transcript.txt'
              a.click()
            }}
            className="px-8 py-3 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 rounded-2xl font-medium transition"
          >
            Download Transcript
          </button>
        </div>
      </main>
    </div>
  )
}
