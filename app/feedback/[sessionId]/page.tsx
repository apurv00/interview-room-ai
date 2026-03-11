'use client'

import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { ScoreBar, ScoreRing } from '@/components/ScoreBar'
import ScoreTrendChart from '@/components/feedback/ScoreTrendChart'
import QuestionBreakdown from '@/components/feedback/QuestionBreakdown'
import CommunicationDetail from '@/components/feedback/CommunicationDetail'
import AudioPlayer from '@/components/feedback/AudioPlayer'
import PeerComparison, { type PeerData } from '@/components/feedback/PeerComparison'
import type { FeedbackData, StoredInterviewData, TranscriptEntry, EngagementSignals, DeliverySignals } from '@/lib/types'
import { ROLE_LABELS } from '@/lib/interviewConfig'
import { computeOffsetSeconds } from '@/lib/offsetHelpers'
import { mergeWithLocalData, readLocalInterviewData, cleanupLocalInterviewData } from '@/lib/mergeSessionData'

// ─── Error Boundary ──────────────────────────────────────────────────────────

class FeedbackErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; error: Error | null }
> {
  state = { hasError: false, error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }
  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    // Log full details to help diagnose React #310 in production
    console.error('[FeedbackErrorBoundary]', error.message, info.componentStack)
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#070b14] flex flex-col items-center justify-center gap-5 px-4">
          <div className="bg-slate-900 border border-red-500/30 rounded-2xl p-6 max-w-sm w-full text-center space-y-4">
            <p className="text-slate-200 font-medium">Something went wrong rendering feedback</p>
            <p className="text-slate-400 text-sm">{String(this.state.error?.message || 'Unknown error')}</p>
            <button
              onClick={() => { window.location.href = '/' }}
              className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-sm font-medium transition"
            >
              Go home
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

// Helper: safely coerce to string for rendering (prevents React #310 on unexpected objects)
function s(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PEER_CACHE_PREFIX = 'peerData:'

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

// ─── Binary search helper ─────────────────────────────────────────────────────

/**
 * Find the last index in a sorted `offsets` array where offsets[i] <= target.
 * Returns -1 if no such index exists. O(log n).
 */
function bisectLastLE(offsets: number[], target: number): number {
  let lo = 0
  let hi = offsets.length - 1
  let result = -1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    if (offsets[mid] <= target) {
      result = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return result
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function FeedbackPageWrapper() {
  return (
    <FeedbackErrorBoundary>
      <FeedbackPageInner />
    </FeedbackErrorBoundary>
  )
}

function FeedbackPageInner() {
  const router = useRouter()
  const params = useParams()
  const sessionId = params.sessionId as string

  const [data, setData] = useState<StoredInterviewData | null>(null)
  const [feedback, setFeedback] = useState<FeedbackData | null>(null)
  const [loading, setLoading] = useState(true)
  // Issue 6-A: feedbackError state for user-facing error + retry
  const [feedbackError, setFeedbackError] = useState<string | null>(null)
  const [saveWarning, setSaveWarning] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<FeedbackTab>('overview')
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null)
  const [sessionStartedAt, setSessionStartedAt] = useState<number | null>(null)

  // Peer comparison state
  const [peerData, setPeerData] = useState<PeerData | null>(null)
  const [peerLoading, setPeerLoading] = useState(true)

  // Audio player sync state
  const [currentAudioTime, setCurrentAudioTime] = useState(0)
  const seekToRef = useRef<((s: number) => void) | null>(null)
  const activeEntryRef = useRef<HTMLDivElement>(null)
  const handleSeekExpose = useCallback((fn: (s: number) => void) => { seekToRef.current = fn }, [])

  // ── Data loading ────────────────────────────────────────────────────────────

  useEffect(() => {
    // Issue 1-A: single AbortController for cancellable fetch/generation only.
    // The DB persist PATCH is fire-and-forget and NOT cancelled on unmount.
    const abortCtrl = new AbortController()
    const { signal } = abortCtrl

    async function loadData() {
      // Try loading from DB first (unless it's the "local" fallback route)
      if (sessionId && sessionId !== 'local') {
        try {
          const res = await fetch(`/api/interviews/${sessionId}`, { signal })
          if (res.ok) {
            const session = await res.json()
            let d: StoredInterviewData = {
              config: session.config,
              transcript: session.transcript || [],
              evaluations: session.evaluations || [],
              speechMetrics: session.speechMetrics || [],
              feedback: session.feedback,
            }

            // If DB transcript is empty (e.g. PATCH failed), merge from localStorage
            d = mergeWithLocalData(d, sessionId)

            setData(d)
            cleanupLocalInterviewData(sessionId)
            if (session.recordingUrl) setRecordingUrl(session.recordingUrl)
            if (session.startedAt) setSessionStartedAt(new Date(session.startedAt).getTime())

            // Fetch peer comparison data in parallel (non-blocking)
            // Issue 7-A: sessionId removed — route validates ownership via NextAuth userId
            fetchPeerData(d.config, signal)

            // If feedback already exists in DB, use it
            if (session.feedback) {
              setFeedback(session.feedback)
              setLoading(false)
              return
            }

            // Otherwise generate feedback
            await generateFeedback(d, sessionId, signal)
            return
          }
        } catch (e) {
          if ((e as Error).name === 'AbortError') return
          // Fall through to localStorage
        }
      }

      // Fallback: load from localStorage
      const localSid = sessionId !== 'local' ? sessionId : undefined
      const d = readLocalInterviewData(localSid)
      if (!d) {
        router.push('/')
        return
      }
      setData(d)
      cleanupLocalInterviewData(localSid)
      // Derive sessionStartedAt from first transcript entry as fallback
      if (d.transcript.length > 0) {
        setSessionStartedAt(d.transcript[0].timestamp)
      }
      setPeerLoading(false) // No peer data for local sessions
      await generateFeedback(d, sessionId !== 'local' ? sessionId : undefined, signal)
    }

    loadData()
    return () => abortCtrl.abort()
  }, [sessionId, router]) // eslint-disable-line

  // ── Peer data fetch with sessionStorage cache (Issue 13-A) ─────────────────

  async function fetchPeerData(config: StoredInterviewData['config'], signal?: AbortSignal) {
    if (!config) { setPeerLoading(false); return }

    const cacheKey = `${PEER_CACHE_PREFIX}${config.role}:${config.experience}`

    // Check sessionStorage first — avoids re-fetching on tab revisit within the session
    try {
      const cached = sessionStorage.getItem(cacheKey)
      if (cached) {
        setPeerData(JSON.parse(cached))
        setPeerLoading(false)
        return
      }
    } catch {
      // sessionStorage unavailable (e.g. private browsing) — fall through
    }

    try {
      // Issue 7-A: no sessionId param — server derives userId from NextAuth
      const searchParams = new URLSearchParams({ role: config.role, experience: config.experience })
      const res = await fetch(`/api/analytics/peer-comparison?${searchParams}`, { signal })
      if (res.ok) {
        const json = await res.json()
        setPeerData(json)
        // Persist to sessionStorage for the rest of this browser session
        try {
          sessionStorage.setItem(cacheKey, JSON.stringify(json))
        } catch {
          // Non-critical — quota or private browsing
        }
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      // Non-critical — silently fail, PeerComparison handles null gracefully
    } finally {
      setPeerLoading(false)
    }
  }

  // ── Feedback generation (Issue 1-A, 6-A) ───────────────────────────────────

  async function generateFeedback(d: StoredInterviewData, sid?: string, signal?: AbortSignal) {
    setFeedbackError(null)
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
        signal,
      })
      const fb = await res.json()
      // Guard: if the API returned an error envelope instead of valid feedback, treat it as a failure
      if (!res.ok || !fb.dimensions || !fb.overall_score) {
        throw new Error(fb.error || `Feedback API returned status ${res.status}`)
      }
      setFeedback(fb as FeedbackData)

      // Persist feedback to DB with retry (no abort signal — must survive navigation)
      if (sid && sid !== 'local') {
        let saved = false
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const patchRes = await fetch(`/api/interviews/${sid}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ feedback: fb }),
            })
            if (patchRes.ok) { saved = true; break }
          } catch { /* retry */ }
          if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)))
        }
        if (!saved) {
          setSaveWarning('Feedback generated but could not be saved. It may not appear in history.')
        }
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      // Issue 6-A: surface error with retry affordance
      setFeedbackError('Failed to generate feedback. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  // ── Retry handler (Issue 6-A) ───────────────────────────────────────────────

  function handleRetry() {
    if (!data) return
    setLoading(true)
    setFeedbackError(null)
    generateFeedback(data, sessionId !== 'local' ? sessionId : undefined)
  }

  // ── Derived memos (MUST be before early returns to comply with Rules of Hooks) ──

  // Issue 5-A: single one-pass reduce for all avg scores
  const avgScores = useMemo(() => {
    if (!data || !data.evaluations || data.evaluations.length === 0) return null
    const n = data.evaluations.length
    const sums = data.evaluations.reduce(
      (acc, e) => ({
        relevance: acc.relevance + (Number(e.relevance) || 0),
        structure: acc.structure + (Number(e.structure) || 0),
        specificity: acc.specificity + (Number(e.specificity) || 0),
        ownership: acc.ownership + (Number(e.ownership) || 0),
      }),
      { relevance: 0, structure: 0, specificity: 0, ownership: 0 }
    )
    return {
      relevance: Math.round(sums.relevance / n),
      structure: Math.round(sums.structure / n),
      specificity: Math.round(sums.specificity / n),
      ownership: Math.round(sums.ownership / n),
    }
  }, [data]) // eslint-disable-line react-hooks/exhaustive-deps

  const questionMarkers = useMemo(() => {
    if (!data || !data.transcript) return []
    const seen = new Set<number>()
    return data.transcript
      .filter((e) => {
        if (e.speaker !== 'interviewer' || e.questionIndex === undefined) return false
        if (seen.has(e.questionIndex)) return false
        seen.add(e.questionIndex)
        return true
      })
      .map((e) => ({
        label: `Q${(e.questionIndex ?? 0) + 1}`,
        offsetSeconds: computeOffsetSeconds(e.timestamp, sessionStartedAt),
      }))
  }, [data, sessionStartedAt]) // eslint-disable-line react-hooks/exhaustive-deps

  const transcriptOffsets = useMemo(() => {
    if (!data || !data.transcript) return []
    return data.transcript
      .map((e) => computeOffsetSeconds(e.timestamp, sessionStartedAt))
      .sort((a, b) => a - b)
  }, [data, sessionStartedAt]) // eslint-disable-line react-hooks/exhaustive-deps

  const activeTranscriptIndex = useMemo(() => {
    if (!recordingUrl || transcriptOffsets.length === 0) return -1
    return bisectLastLE(transcriptOffsets, currentAudioTime)
  }, [recordingUrl, transcriptOffsets, currentAudioTime])

  // Auto-scroll to active transcript entry
  useEffect(() => {
    if (activeEntryRef.current && activeTab === 'transcript') {
      activeEntryRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [activeTranscriptIndex, activeTab])

  // ── Loading / error state (AFTER all hooks) ────────────────────────────────

  if (loading || !data) {
    return (
      <div className="min-h-screen bg-[#070b14] flex flex-col items-center justify-center gap-4">
        <div className="w-8 h-8 rounded-full border-2 border-indigo-400 border-t-transparent animate-spin" />
        <p className="text-slate-400 text-sm">Generating your feedback report...</p>
      </div>
    )
  }

  // Issue 6-A: error card with retry
  if (feedbackError && !feedback) {
    return (
      <div className="min-h-screen bg-[#070b14] flex flex-col items-center justify-center gap-5 px-4">
        <div className="bg-slate-900 border border-red-500/30 rounded-2xl p-6 max-w-sm w-full text-center space-y-4">
          <div className="w-12 h-12 rounded-full bg-red-600/20 flex items-center justify-center mx-auto">
            <svg className="w-6 h-6 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div>
            <p className="text-slate-200 font-medium">Something went wrong</p>
            <p className="text-slate-400 text-sm mt-1">{feedbackError}</p>
          </div>
          <div className="flex gap-3 justify-center">
            <button
              onClick={handleRetry}
              className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-sm font-medium transition"
            >
              Try again
            </button>
            <button
              onClick={() => router.push('/')}
              className="px-5 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-sm font-medium transition"
            >
              Go home
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (!feedback) return null

  // Defensive: bail to error UI if feedback has unexpected shape
  if (!feedback.dimensions || !feedback.dimensions.answer_quality || !feedback.dimensions.communication) {
    return (
      <div className="min-h-screen bg-[#070b14] flex flex-col items-center justify-center gap-5 px-4">
        <div className="bg-slate-900 border border-red-500/30 rounded-2xl p-6 max-w-sm w-full text-center space-y-4">
          <p className="text-slate-200 font-medium">Invalid feedback data</p>
          <p className="text-slate-400 text-sm">The feedback response had an unexpected format. Please try again.</p>
          <button onClick={handleRetry} className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-sm font-medium transition">
            Try again
          </button>
        </div>
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

  // ── Render ──────────────────────────────────────────────────────────────────

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
            <button
              onClick={() => router.push('/')}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 rounded-xl text-sm font-medium transition"
            >
              Reattempt
            </button>
          </div>
        </div>
      </header>

      {/* Save warning banner */}
      {saveWarning && (
        <div className="max-w-5xl mx-auto px-4 mt-4">
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl px-5 py-3 text-sm text-amber-300 flex items-center gap-2">
            <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            {saveWarning}
          </div>
        </div>
      )}

      <main className="max-w-5xl mx-auto px-4 py-8 space-y-8">
        {/* Audio Player */}
        {recordingUrl && (
          <AudioPlayer
            src={recordingUrl}
            questionMarkers={questionMarkers}
            onTimeUpdate={setCurrentAudioTime}
            onSeek={handleSeekExpose}
          />
        )}

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
                {s(pass_probability)} pass probability
              </div>
              <div className="px-3 py-1 rounded-full border border-slate-700 text-slate-400 text-sm">
                {s(feedback.confidence_level)} confidence
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
              {/* Answer Quality — Issue 5-A: uses avgScores useMemo instead of 4 inline reduces */}
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4 animate-slide-up stagger-1">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-slate-200">Answer Quality</h3>
                  <span className="text-2xl font-bold text-indigo-400">{Number(answer_quality.score) || 0}</span>
                </div>
                <div className="space-y-3">
                  <ScoreBar
                    label="Relevance"
                    score={avgScores?.relevance ?? answer_quality.score}
                    delay={100}
                  />
                  <ScoreBar
                    label="Structure (STAR)"
                    score={avgScores?.structure ?? answer_quality.score}
                    delay={200}
                  />
                  <ScoreBar
                    label="Specificity"
                    score={avgScores?.specificity ?? answer_quality.score}
                    delay={300}
                  />
                  <ScoreBar
                    label="Ownership"
                    score={avgScores?.ownership ?? answer_quality.score}
                    delay={400}
                  />
                </div>
                {Array.isArray(answer_quality.strengths) && answer_quality.strengths.length > 0 && (
                  <div className="pt-2 border-t border-slate-800">
                    <p className="text-xs text-emerald-400 font-medium mb-1">Strengths</p>
                    {answer_quality.strengths.map((str, idx) => (
                      <p key={idx} className="text-xs text-slate-400">
                        · {s(str)}
                      </p>
                    ))}
                  </div>
                )}
                {Array.isArray(answer_quality.weaknesses) && answer_quality.weaknesses.length > 0 && (
                  <div>
                    <p className="text-xs text-amber-400 font-medium mb-1">Areas to improve</p>
                    {answer_quality.weaknesses.map((w, idx) => (
                      <p key={idx} className="text-xs text-slate-400">
                        · {s(w)}
                      </p>
                    ))}
                  </div>
                )}
              </div>

              {/* Communication */}
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4 animate-slide-up stagger-2">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-slate-200">Communication</h3>
                  <span className="text-2xl font-bold text-cyan-400">{Number(communication.score) || 0}</span>
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
                    { label: 'Avg. WPM', value: s(communication.wpm), ideal: '120-160' },
                    {
                      label: 'Filler rate',
                      value: `${(Number(communication.filler_rate) * 100).toFixed(1)}%`,
                      ideal: '<5%',
                    },
                    {
                      label: 'Rambling index',
                      value: Number(communication.rambling_index).toFixed(2),
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
                      <span className="text-2xl font-bold text-violet-400">{Number(engagementSignals.score) || 0}</span>
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
                        <span className={`text-xs px-2 py-0.5 rounded-full border ${CONFIDENCE_TREND_LABELS[engagementSignals.confidence_trend as keyof typeof CONFIDENCE_TREND_LABELS]?.color || 'text-slate-400 bg-slate-500/10 border-slate-500/30'}`}>
                          {CONFIDENCE_TREND_LABELS[engagementSignals.confidence_trend as keyof typeof CONFIDENCE_TREND_LABELS]?.text || s(engagementSignals.confidence_trend)}
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
                      <span className="text-2xl font-bold text-violet-400">{Number(deliverySignals.score) || 0}</span>
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
                          <p className="text-sm text-slate-300">{s(req.requirement)}</p>
                          {req.evidence && (
                            <p className="text-xs text-slate-500 mt-0.5">{s(req.evidence)}</p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}

            {/* Red flags */}
            {Array.isArray(red_flags) && red_flags.length > 0 && (
              <section className="bg-red-950/30 border border-red-500/20 rounded-2xl p-5 animate-slide-up stagger-4">
                <h3 className="font-semibold text-red-400 mb-3">Red flags detected</h3>
                <ul className="space-y-2">
                  {red_flags.map((flag, idx) => (
                    <li key={idx} className="flex items-start gap-2 text-sm text-red-300">
                      <span className="shrink-0">·</span> {s(flag)}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* Top 3 improvements */}
            <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5 animate-slide-up stagger-5">
              <h3 className="font-semibold text-slate-200 mb-4">Top improvements for next attempt</h3>
              <div className="space-y-3">
                {Array.isArray(top_3_improvements) && top_3_improvements.map((tip, i) => (
                  <div key={i} className="flex items-start gap-3">
                    <span className="shrink-0 w-6 h-6 rounded-full bg-indigo-600/30 border border-indigo-500/40 text-indigo-400 text-xs flex items-center justify-center font-bold">
                      {i + 1}
                    </span>
                    <p className="text-sm text-slate-300 leading-relaxed">{s(tip)}</p>
                  </div>
                ))}
              </div>
            </section>

            {/* Peer Comparison */}
            {sessionId && sessionId !== 'local' && data.config && feedback && (
              <PeerComparison
                data={peerData}
                loading={peerLoading}
                userFeedback={feedback}
              />
            )}
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
              {data.transcript.map((entry: TranscriptEntry, i: number) => {
                const isActive = i === activeTranscriptIndex
                const canSeek = recordingUrl && sessionStartedAt
                return (
                  <div
                    key={i}
                    ref={isActive ? activeEntryRef : undefined}
                    className={`flex gap-3 ${entry.speaker === 'interviewer' ? '' : 'flex-row-reverse'} ${
                      canSeek ? 'cursor-pointer' : ''
                    } ${isActive ? 'ring-2 ring-indigo-500/50 rounded-2xl' : ''} transition-all duration-200`}
                    onClick={() => {
                      if (canSeek && seekToRef.current) {
                        seekToRef.current(computeOffsetSeconds(entry.timestamp, sessionStartedAt))
                      }
                    }}
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
                      {s(entry.text)}
                    </div>
                  </div>
                )
              })}
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
