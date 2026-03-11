'use client'

import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { ScoreRing } from '@/components/ScoreBar'
import ScoreTrendChart from '@/components/feedback/ScoreTrendChart'
import QuestionBreakdown from '@/components/feedback/QuestionBreakdown'
import AudioPlayer from '@/components/feedback/AudioPlayer'
import OverviewTab from '@/components/feedback/OverviewTab'
import TranscriptTab from '@/components/feedback/TranscriptTab'
import type { PeerData } from '@/components/feedback/PeerComparison'
import type { FeedbackData, StoredInterviewData } from '@/lib/types'
import { ROLE_LABELS } from '@/lib/interviewConfig'
import { computeOffsetSeconds } from '@/lib/offsetHelpers'
import { mergeWithLocalData, readLocalInterviewData, cleanupLocalInterviewData } from '@/lib/mergeSessionData'
import { fetchWithRetry } from '@/lib/fetchWithRetry'
import { bisectLastLE } from '@/lib/utils'
import { PROBABILITY_COLORS } from '@/lib/feedbackConfig'

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

type FeedbackTab = 'overview' | 'questions' | 'transcript'

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
    const abortCtrl = new AbortController()
    const { signal } = abortCtrl

    async function loadData() {
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

            d = mergeWithLocalData(d, sessionId)
            setData(d)
            cleanupLocalInterviewData(sessionId)
            if (session.recordingUrl) setRecordingUrl(session.recordingUrl)
            if (session.startedAt) setSessionStartedAt(new Date(session.startedAt).getTime())

            fetchPeerData(d.config, signal)

            if (session.feedback) {
              setFeedback(session.feedback)
              setLoading(false)
              return
            }

            await generateFeedback(d, sessionId, signal)
            return
          }
        } catch (e) {
          if ((e as Error).name === 'AbortError') return
        }
      }

      const localSid = sessionId !== 'local' ? sessionId : undefined
      const d = readLocalInterviewData(localSid)
      if (!d) {
        router.push('/')
        return
      }
      setData(d)
      cleanupLocalInterviewData(localSid)
      if (d.transcript.length > 0) {
        setSessionStartedAt(d.transcript[0].timestamp)
      }
      setPeerLoading(false)
      await generateFeedback(d, sessionId !== 'local' ? sessionId : undefined, signal)
    }

    loadData()
    return () => abortCtrl.abort()
  }, [sessionId, router]) // eslint-disable-line

  // ── Peer data fetch with sessionStorage cache ─────────────────────────────

  async function fetchPeerData(config: StoredInterviewData['config'], signal?: AbortSignal) {
    if (!config) { setPeerLoading(false); return }

    const cacheKey = `${PEER_CACHE_PREFIX}${config.role}:${config.experience}`

    try {
      const cached = sessionStorage.getItem(cacheKey)
      if (cached) {
        setPeerData(JSON.parse(cached))
        setPeerLoading(false)
        return
      }
    } catch {
      // sessionStorage unavailable — fall through
    }

    try {
      const searchParams = new URLSearchParams({ role: config.role, experience: config.experience })
      const res = await fetch(`/api/analytics/peer-comparison?${searchParams}`, { signal })
      if (res.ok) {
        const json = await res.json()
        setPeerData(json)
        try {
          sessionStorage.setItem(cacheKey, JSON.stringify(json))
        } catch {
          // Non-critical
        }
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
    } finally {
      setPeerLoading(false)
    }
  }

  // ── Feedback generation ───────────────────────────────────────────────────

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
      if (!res.ok || !fb.dimensions || !fb.overall_score) {
        throw new Error(fb.error || `Feedback API returned status ${res.status}`)
      }
      setFeedback(fb as FeedbackData)

      // Persist feedback to DB with retry (no abort signal — must survive navigation)
      if (sid && sid !== 'local') {
        const saved = await fetchWithRetry(`/api/interviews/${sid}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ feedback: fb }),
        })
        if (!saved) {
          setSaveWarning('Feedback generated but could not be saved. It may not appear in history.')
        }
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      setFeedbackError('Failed to generate feedback. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  // ── Retry handler ─────────────────────────────────────────────────────────

  function handleRetry() {
    if (!data) return
    setLoading(true)
    setFeedbackError(null)
    generateFeedback(data, sessionId !== 'local' ? sessionId : undefined)
  }

  // ── Derived memos (MUST be before early returns to comply with Rules of Hooks) ──

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
            <button onClick={handleRetry} className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-sm font-medium transition">
              Try again
            </button>
            <button onClick={() => router.push('/')} className="px-5 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-sm font-medium transition">
              Go home
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (!feedback) return null

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

  const { overall_score, pass_probability } = feedback

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
              <div className={`px-3 py-1 rounded-full border text-sm font-medium ${PROBABILITY_COLORS[pass_probability]}`}>
                {s(pass_probability)} pass probability
              </div>
              <div className="px-3 py-1 rounded-full border border-slate-700 text-slate-400 text-sm">
                {s(feedback.confidence_level)} confidence
              </div>
            </div>
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
          <OverviewTab
            data={data}
            feedback={feedback}
            sessionId={sessionId}
            peerData={peerData}
            peerLoading={peerLoading}
          />
        )}

        {/* Questions tab */}
        {activeTab === 'questions' && (
          <div className="animate-slide-up">
            <QuestionBreakdown transcript={data.transcript} evaluations={data.evaluations} />
          </div>
        )}

        {/* Transcript tab */}
        {activeTab === 'transcript' && (
          <TranscriptTab
            transcript={data.transcript}
            activeTranscriptIndex={activeTranscriptIndex}
            activeEntryRef={activeEntryRef}
            recordingUrl={recordingUrl}
            sessionStartedAt={sessionStartedAt}
            seekTo={seekToRef.current}
          />
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
