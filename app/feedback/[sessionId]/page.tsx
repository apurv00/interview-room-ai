'use client'

import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { ScoreRing } from '@interview/components/ScoreBar'
import ScoreTrendChart from '@interview/components/feedback/ScoreTrendChart'
import QuestionBreakdown from '@interview/components/feedback/QuestionBreakdown'
import AudioPlayer from '@interview/components/feedback/AudioPlayer'
import OverviewTab from '@interview/components/feedback/OverviewTab'
import TranscriptTab from '@interview/components/feedback/TranscriptTab'
import type { PeerData } from '@interview/components/feedback/PeerComparison'
import type { FeedbackData, StoredInterviewData } from '@shared/types'
import { ROLE_LABELS, getDomainLabel } from '@interview/config/interviewConfig'
import { computeOffsetSeconds } from '@interview/utils/offsetHelpers'
import { mergeWithLocalData, readLocalInterviewData, cleanupLocalInterviewData } from '@interview/utils/mergeSessionData'
import { fetchWithRetry } from '@shared/fetchWithRetry'
import { bisectLastLE } from '@shared/utils'
import { PROBABILITY_COLORS } from '@interview/config/feedbackConfig'
import ComparisonCard from '@learn/components/feedback/ComparisonCard'
import ShareButton from '@learn/components/feedback/ShareButton'

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
        <div className="min-h-screen bg-white flex flex-col items-center justify-center gap-5 px-4">
          <div className="surface-card-bordered p-6 max-w-sm w-full text-center space-y-4">
            <p className="text-subheading text-[#0f1419]">Something went wrong rendering feedback</p>
            <p className="text-body text-[#71767b]">{String(this.state.error?.message || 'Unknown error')}</p>
            <button
              onClick={() => { window.location.href = '/' }}
              className="px-5 py-2 bg-brand-500 hover:bg-brand-600 text-white rounded-[var(--radius-md)] text-sm font-medium transition"
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
              // Recover stuck sessions: if feedback exists but status is not completed, fix it
              if (session.status && session.status !== 'completed') {
                fetchWithRetry(`/api/interviews/${sessionId}`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ status: 'completed', completedAt: new Date().toISOString() }),
                }).catch(() => {})
              }
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
      let fb
      try {
        fb = await res.json()
      } catch {
        throw new Error(`Feedback API returned non-JSON response (status ${res.status})`)
      }
      if (!res.ok) {
        throw new Error(fb.error || `Feedback generation failed (status ${res.status})`)
      }
      if (!fb.dimensions || !fb.overall_score) {
        throw new Error('Feedback response is incomplete — missing required fields')
      }
      setFeedback(fb as FeedbackData)

      // Persist feedback + ensure session is marked completed (recovers from stuck in_progress)
      if (sid && sid !== 'local') {
        const saved = await fetchWithRetry(`/api/interviews/${sid}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            feedback: fb,
            status: 'completed',
            completedAt: new Date().toISOString(),
          }),
        })
        if (!saved) {
          setSaveWarning('Feedback generated but could not be saved. It may not appear in history.')
        }
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      const msg = e instanceof Error ? e.message : 'Unknown error'
      setFeedbackError(`Failed to generate feedback: ${msg}`)
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
        if (e.speaker !== 'interviewer' || e.questionIndex == null) return false
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
      <div className="min-h-screen bg-white flex flex-col items-center justify-center gap-4">
        <div className="w-8 h-8 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
        <p className="text-body text-[#71767b]">Generating your feedback report...</p>
      </div>
    )
  }

  if (feedbackError && !feedback) {
    return (
      <div className="min-h-screen bg-white flex flex-col items-center justify-center gap-5 px-4">
        <div className="surface-card-bordered border-red-500/30 p-6 max-w-sm w-full text-center space-y-4">
          <div className="w-12 h-12 rounded-full bg-red-600/20 flex items-center justify-center mx-auto">
            <svg className="w-6 h-6 text-[#f4212e]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div>
            <p className="text-subheading text-[#0f1419]">Something went wrong</p>
            <p className="text-body text-[#71767b] mt-1">{feedbackError}</p>
          </div>
          <div className="flex gap-3 justify-center">
            <button onClick={handleRetry} className="px-5 py-2 bg-brand-500 hover:bg-brand-600 text-white rounded-[var(--radius-md)] text-sm font-medium transition">
              Try again
            </button>
            <button onClick={() => router.push('/')} className="px-5 py-2 bg-[#f7f9f9] hover:bg-[#eff3f4] border border-[#e1e8ed] text-[#536471] rounded-[var(--radius-md)] text-sm font-medium transition">
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
      <div className="min-h-screen bg-white flex flex-col items-center justify-center gap-5 px-4">
        <div className="surface-card-bordered border-red-500/30 p-6 max-w-sm w-full text-center space-y-4">
          <p className="text-subheading text-[#0f1419]">Invalid feedback data</p>
          <p className="text-body text-[#71767b]">The feedback response had an unexpected format. Please try again.</p>
          <button onClick={handleRetry} className="px-5 py-2 bg-brand-500 hover:bg-brand-600 text-white rounded-[var(--radius-md)] text-sm font-medium transition">
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
    <div className="min-h-screen bg-white text-[#0f1419]">
      {/* Header */}
      <header className="sticky top-14 z-10 bg-white border-b border-[#e1e8ed] h-[52px] flex items-center px-6">
        <div className="max-w-[800px] mx-auto w-full flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.back()}
              className="p-1.5 rounded-lg hover:bg-[#f7f9f9] transition text-[#536471] hover:text-[#0f1419]"
              aria-label="Go back"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <h1 className="text-heading">Interview Feedback</h1>
          </div>
          <p className="text-caption text-[#71767b]">
            {data.config &&
              `${getDomainLabel(data.config.role)} · ${data.config.experience} yrs · ${data.config.duration} min`}
          </p>
        </div>
      </header>

      {/* Save warning banner */}
      {saveWarning && (
        <div className="max-w-[800px] mx-auto px-4 mt-4">
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-[var(--radius-md)] px-5 py-3 text-sm text-amber-600 flex items-center gap-2">
            <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            {saveWarning}
          </div>
        </div>
      )}

      <main className="max-w-[800px] mx-auto px-4 py-8 space-y-8">
        {/* Audio Player */}
        {recordingUrl && (
          <AudioPlayer
            src={recordingUrl}
            questionMarkers={questionMarkers}
            onTimeUpdate={setCurrentAudioTime}
            onSeek={handleSeekExpose}
          />
        )}

        {/* Hero: overall score */}
        <section className="flex flex-col items-center gap-4 surface-card-bordered p-6 sm:p-8 animate-fade-in">
          <ScoreRing score={overall_score} size={140} />
          <div className="text-center space-y-2">
            <h2 className="text-heading">
              {overall_score >= 75
                ? 'Strong Performance'
                : overall_score >= 55
                ? 'Competent'
                : 'Needs Development'}
            </h2>
            <p className="text-body text-[#71767b]">
              {overall_score >= 75
                ? 'You demonstrated clear, structured answers with solid examples.'
                : overall_score >= 55
                ? 'Solid foundation — refining structure and specificity will elevate your score.'
                : 'Focus on the STAR framework and concrete examples in your next attempt.'}
            </p>
          </div>
          <div className="flex items-center gap-3 justify-center flex-wrap">
            <div className={`px-3 py-1 rounded-full border text-sm font-medium ${PROBABILITY_COLORS[pass_probability]}`}>
              {s(pass_probability)} pass probability
            </div>
            <div className="px-3 py-1 rounded-full border border-[#e1e8ed] text-[#536471] text-sm">
              {s(feedback.confidence_level)} confidence
            </div>
          </div>
          <ShareButton sessionId={sessionId} />
          <div className="w-full pt-2">
            <p className="text-caption text-[#8b98a5] mb-1">Score trend</p>
            <ScoreTrendChart currentScore={overall_score} sessionId={sessionId} />
          </div>
        </section>

        {/* Comparative Feedback */}
        {data.evaluations.length > 0 && (() => {
          const evals = data.evaluations
          const avg = (key: 'relevance' | 'structure' | 'specificity' | 'ownership') =>
            Math.round(evals.reduce((s, e) => s + (e[key] || 0), 0) / evals.length)
          return (
            <ComparisonCard
              currentScores={{
                relevance: avg('relevance'),
                structure: avg('structure'),
                specificity: avg('specificity'),
                ownership: avg('ownership'),
              }}
              overallScore={overall_score}
              domain={data.config?.role}
            />
          )
        })()}

        {/* Tab navigation */}
        <div className="flex gap-1 surface-card-bordered p-1 w-fit">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                activeTab === tab.key
                  ? 'bg-brand-500 text-white'
                  : 'text-[#71767b] hover:text-[#0f1419]'
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
          <div className="animate-fade-in">
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
        <div className="flex gap-3 justify-center pb-8 animate-fade-in">
          <button
            onClick={() => router.push('/')}
            className="px-8 py-3 bg-brand-500 hover:bg-brand-600 text-white rounded-[var(--radius-md)] font-semibold btn-glow transition"
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
            className="px-8 py-3 bg-[#f7f9f9] hover:bg-[#eff3f4] border border-[#e1e8ed] text-[#536471] rounded-[var(--radius-md)] font-medium transition"
          >
            Download Transcript
          </button>
        </div>
      </main>
    </div>
  )
}
