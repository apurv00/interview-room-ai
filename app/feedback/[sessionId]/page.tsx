'use client'

import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { ScoreRing } from '@shared/ui/ScoreBar'
import QuestionBreakdown from '@interview/components/feedback/QuestionBreakdown'
import AudioPlayer from '@interview/components/feedback/AudioPlayer'
import OverviewTab from '@interview/components/feedback/OverviewTab'
import TranscriptTab from '@interview/components/feedback/TranscriptTab'
import type { PeerData } from '@interview/components/feedback/PeerComparison'
import TimelineTrack from '@interview/components/replay/TimelineTrack'
import SignalCharts from '@interview/components/replay/SignalCharts'
import CoachingPanel from '@interview/components/replay/CoachingPanel'
import VideoPlayer from '@interview/components/replay/VideoPlayer'
import ReplayTranscript from '@interview/components/replay/ReplayTranscript'
import MomentCards from '@interview/components/replay/MomentCards'
import LearningPlanSection from '@interview/components/feedback/LearningPlanSection'
import type { MultimodalAnalysisData } from '@shared/types/multimodal'
import type { FeedbackData, StoredInterviewData } from '@shared/types'
import { getDomainLabel } from '@interview/config/interviewConfig'
import { computeOffsetSeconds } from '@interview/utils/offsetHelpers'
import { mergeWithLocalData, readLocalInterviewData, cleanupLocalInterviewData } from '@interview/utils/mergeSessionData'
import { fetchWithRetry } from '@shared/fetchWithRetry'
import { bisectLastLE } from '@shared/utils'
import { PROBABILITY_COLORS } from '@interview/config/feedbackConfig'
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
const SESSION_CACHE_PREFIX = 'feedback-session:'
const RECORDING_URL_PREFIX = 'recording-url:'
const SESSION_CACHE_TTL_MS = 120_000  // 2 minutes
const RECORDING_URL_TTL_MS = 600_000  // 10 minutes

function getCachedJSON<T>(key: string, ttlMs: number): T | null {
  try {
    const raw = sessionStorage.getItem(key)
    if (!raw) return null
    const { data, cachedAt } = JSON.parse(raw) as { data: T; cachedAt: number }
    if (Date.now() - cachedAt > ttlMs) {
      sessionStorage.removeItem(key)
      return null
    }
    return data
  } catch {
    return null
  }
}

function setCachedJSON<T>(key: string, data: T): void {
  try {
    sessionStorage.setItem(key, JSON.stringify({ data, cachedAt: Date.now() }))
  } catch {
    // sessionStorage unavailable or full — non-critical
  }
}

type FeedbackTab = 'overview' | 'questions' | 'transcript' | 'analysis'

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
  const [progressStep, setProgressStep] = useState(0)
  const [activeTab, setActiveTab] = useState<FeedbackTab>('overview')
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null)
  const [sessionStartedAt, setSessionStartedAt] = useState<number | null>(null)

  // Lazy transcript loading
  const [lazyTranscript, setLazyTranscript] = useState<StoredInterviewData['transcript'] | null>(null)
  const [transcriptLoading, setTranscriptLoading] = useState(false)

  // Peer comparison state
  const [peerData, setPeerData] = useState<PeerData | null>(null)
  const [peerLoading, setPeerLoading] = useState(true)

  // Multimodal analysis state
  const [analysis, setAnalysis] = useState<MultimodalAnalysisData | null>(null)
  const [analysisLoading, setAnalysisLoading] = useState(false)
  const [analysisError, setAnalysisError] = useState<string | null>(null)
  const [analysisProgress, setAnalysisProgress] = useState<string>('')
  const analysisTriggeredRef = useRef(false)
  const [hasRecording, setHasRecording] = useState(false)
  // Video for analysis tab
  const [videoSrc, setVideoSrc] = useState<string | null>(null)
  const [analysisVideoTime, setAnalysisVideoTime] = useState(0)
  const analysisSeekRef = useRef<((seconds: number) => void) | null>(null)
  const [replayFullscreen, setReplayFullscreen] = useState(false)

  // Audio player sync state
  const [currentAudioTime, setCurrentAudioTime] = useState(0)
  const seekToRef = useRef<((s: number) => void) | null>(null)
  const activeEntryRef = useRef<HTMLDivElement>(null)
  const handleSeekExpose = useCallback((fn: (s: number) => void) => { seekToRef.current = fn }, [])

  // ── Fullscreen replay overlay ──────────────────────────────────────────────
  useEffect(() => {
    if (!replayFullscreen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setReplayFullscreen(false) }
    window.addEventListener('keydown', onKey)
    return () => { document.body.style.overflow = prev; window.removeEventListener('keydown', onKey) }
  }, [replayFullscreen])

  // ── Tab switching with lazy transcript fetch ────────────────────────────────

  // ── Analysis fetch + auto-trigger ─────────────────────────────────────────

  const fetchAnalysis = useCallback(async () => {
    if (!sessionId || sessionId === 'local') return
    setAnalysisLoading(true)
    setAnalysisError(null)

    try {
      // First try to fetch existing analysis
      const res = await fetch(`/api/analysis/${sessionId}`)
      if (res.ok) {
        const data = await res.json()
        if (data.status === 'completed') {
          setAnalysis(data)
          setAnalysisLoading(false)
          return
        }
        if (data.status === 'processing' || data.status === 'pending') {
          setAnalysisProgress('Analysis in progress...')
          pollAnalysis()
          return
        }
      }

      // No analysis exists — trigger if recording available
      if (hasRecording && !analysisTriggeredRef.current) {
        analysisTriggeredRef.current = true
        setAnalysisProgress('Starting analysis...')
        const startRes = await fetch('/api/analysis/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        })
        if (startRes.ok) {
          const startData = await startRes.json()
          if (startData.status === 'completed') {
            // Pipeline completed inline
            const analysisRes = await fetch(`/api/analysis/${sessionId}`)
            if (analysisRes.ok) {
              setAnalysis(await analysisRes.json())
              setAnalysisLoading(false)
              return
            }
          }
          // Still processing — poll
          pollAnalysis()
        } else {
          const errData = await startRes.json().catch(() => ({}))
          setAnalysisError(errData.error || 'Failed to start analysis')
          setAnalysisLoading(false)
        }
      } else if (!hasRecording) {
        setAnalysisError('No recording available for analysis')
        setAnalysisLoading(false)
      } else {
        setAnalysisLoading(false)
      }
    } catch {
      setAnalysisError('Failed to load analysis')
      setAnalysisLoading(false)
    }
  }, [sessionId, hasRecording]) // eslint-disable-line react-hooks/exhaustive-deps

  const pollAnalysis = useCallback(() => {
    const phases = [
      'Transcribing audio...',
      'Aggregating facial signals...',
      'Fusing insights with AI...',
    ]
    let phaseIdx = 0
    let elapsed = 0
    const interval = setInterval(async () => {
      elapsed += 2000
      // Rotate progress phases every 5s
      if (elapsed % 5000 === 0 && phaseIdx < phases.length - 1) {
        phaseIdx++
      }
      setAnalysisProgress(phases[phaseIdx])

      try {
        const res = await fetch(`/api/analysis/${sessionId}`)
        if (res.ok) {
          const data = await res.json()
          if (data.status === 'completed') {
            clearInterval(interval)
            setAnalysis(data)
            setAnalysisLoading(false)
            return
          }
          if (data.status === 'failed') {
            clearInterval(interval)
            setAnalysisError(data.error || 'Analysis failed')
            setAnalysisLoading(false)
            return
          }
        }
      } catch { /* continue polling */ }

      // Timeout after 90s
      if (elapsed >= 90000) {
        clearInterval(interval)
        setAnalysisError('Analysis timed out — please try again later')
        setAnalysisLoading(false)
      }
    }, 2000)

    return () => clearInterval(interval)
  }, [sessionId])

  const handleTabChange = useCallback((tab: FeedbackTab) => {
    setActiveTab(tab)
    // Scroll to tab content area on switch (offset for sticky headers)
    requestAnimationFrame(() => {
      const el = document.getElementById('tab-content')
      if (el) {
        const yOffset = -180 // account for sticky nav + header + tab bar
        const y = el.getBoundingClientRect().top + window.scrollY + yOffset
        window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' })
      }
    })
    // Lazy-load transcript when the tab is first opened
    if ((tab === 'transcript' || tab === 'questions') && !lazyTranscript && !transcriptLoading && sessionId && sessionId !== 'local') {
      setTranscriptLoading(true)
      fetch(`/api/interviews/${sessionId}/transcript`)
        .then((r) => r.ok ? r.json() : null)
        .then((d) => {
          if (d?.transcript) {
            setLazyTranscript(d.transcript)
            // Also update data.transcript for QuestionBreakdown
            setData((prev) => prev ? { ...prev, transcript: d.transcript } : prev)
          }
        })
        .catch(() => {})
        .finally(() => setTranscriptLoading(false))
    }
    // Auto-load analysis when tab is first opened
    if (tab === 'analysis' && !analysis && !analysisLoading) {
      fetchAnalysis()
    }
  }, [lazyTranscript, transcriptLoading, sessionId, analysis, analysisLoading, fetchAnalysis])

  // ── Data loading ────────────────────────────────────────────────────────────

  useEffect(() => {
    const abortCtrl = new AbortController()
    const { signal } = abortCtrl

    async function loadData() {
      // Guard against null/undefined sessionIds reaching the API
      if (!sessionId || sessionId === 'null' || sessionId === 'undefined') {
        router.push('/')
        return
      }

      if (sessionId && sessionId !== 'local') {
        // Check sessionStorage cache first to avoid re-fetching on back-navigation
        const cachedSession = getCachedJSON<{ session: Record<string, unknown>; d: StoredInterviewData & { scoringDimensions?: Array<{ name: string; label: string; weight: number }> } }>(
          `${SESSION_CACHE_PREFIX}${sessionId}`, SESSION_CACHE_TTL_MS
        )

        let session: Record<string, unknown> | null = cachedSession?.session ?? null
        let d = cachedSession?.d ?? null

        if (!session) {
          try {
            const res = await fetch(`/api/interviews/${sessionId}?excludeTranscript=true`, { signal })
            if (res.ok) {
              session = await res.json()
            }
          } catch (e) {
            if ((e as Error).name === 'AbortError') return
            // fall through to local data path
          }
        }

        if (session) {
            if (!d) {
              d = {
                config: session.config as StoredInterviewData['config'],
                transcript: (session.transcript as StoredInterviewData['transcript']) || [],
                evaluations: (session.evaluations as StoredInterviewData['evaluations']) || [],
                speechMetrics: (session.speechMetrics as StoredInterviewData['speechMetrics']) || [],
                feedback: session.feedback as StoredInterviewData['feedback'],
                scoringDimensions: session.scoringDimensions as Array<{ name: string; label: string; weight: number }> | undefined,
              }
              d = mergeWithLocalData(d, sessionId)
              // Cache the session data for back-navigation
              setCachedJSON(`${SESSION_CACHE_PREFIX}${sessionId}`, { session, d })
            }

            setData(d)
            cleanupLocalInterviewData(sessionId)

            // Fetch presigned recording URL — check cache first
            if (session.hasRecording) {
              setHasRecording(true)
              const cachedUrl = getCachedJSON<string>(`${RECORDING_URL_PREFIX}${sessionId}`, RECORDING_URL_TTL_MS)
              if (cachedUrl) {
                setRecordingUrl(cachedUrl)
                setVideoSrc(cachedUrl)
              } else {
                fetch(`/api/recordings/presign?sessionId=${sessionId}`)
                  .then(r => r.ok ? r.json() : null)
                  .then(presignData => {
                    if (presignData?.url) {
                      setRecordingUrl(presignData.url)
                      setVideoSrc(presignData.url)
                      setCachedJSON(`${RECORDING_URL_PREFIX}${sessionId}`, presignData.url)
                    }
                  })
                  .catch(() => {})
              }
            } else if (session.recordingUrl) {
              setRecordingUrl(session.recordingUrl as string)
              setVideoSrc(session.recordingUrl as string)
            }
            if (session.startedAt) setSessionStartedAt(new Date(session.startedAt as string).getTime())

            fetchPeerData(d.config, signal)

            if (session.feedback) {
              setFeedback(session.feedback as FeedbackData)
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
      // Apply client-side defaults if feedback is incomplete (truncated Claude response)
      if (!fb.overall_score) fb.overall_score = 50
      if (!fb.dimensions) {
        fb.dimensions = {
          answer_quality: { score: fb.overall_score || 50, strengths: [], weaknesses: [] },
          communication: { score: 50, wpm: 120, filler_rate: 0.05, pause_score: 60, rambling_index: 0.3 },
          engagement_signals: { score: 50, engagement_score: 50, confidence_trend: 'stable', energy_consistency: 0.6, composure_under_pressure: 50 },
        }
      }
      if (!fb.dimensions.answer_quality) fb.dimensions.answer_quality = { score: fb.overall_score, strengths: [], weaknesses: [] }
      if (!fb.dimensions.communication) fb.dimensions.communication = { score: 50, wpm: 120, filler_rate: 0.05, pause_score: 60, rambling_index: 0.3 }
      if (!fb.dimensions.engagement_signals) fb.dimensions.engagement_signals = { score: 50, engagement_score: 50, confidence_trend: 'stable', energy_consistency: 0.6, composure_under_pressure: 50 }
      if (!fb.pass_probability) fb.pass_probability = fb.overall_score >= 70 ? 'High' : fb.overall_score >= 50 ? 'Medium' : 'Low'
      if (!fb.confidence_level) fb.confidence_level = 'Medium'
      if (!fb.red_flags) fb.red_flags = []
      if (!fb.top_3_improvements) fb.top_3_improvements = ['Practice structured answers']
      // Normalize enum values (Claude sometimes returns variants like "Medium-High")
      const validProbabilities = ['High', 'Medium', 'Low'] as const
      if (!validProbabilities.includes(fb.pass_probability)) {
        fb.pass_probability = fb.pass_probability?.toLowerCase?.().includes('high') ? 'High'
          : fb.pass_probability?.toLowerCase?.().includes('low') ? 'Low' : 'Medium'
      }
      if (!validProbabilities.includes(fb.confidence_level)) {
        fb.confidence_level = fb.confidence_level?.toLowerCase?.().includes('high') ? 'High'
          : fb.confidence_level?.toLowerCase?.().includes('low') ? 'Low' : 'Medium'
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
        // Update sessionStorage cache so back-navigation doesn't re-generate
        try {
          const cacheKey = `${SESSION_CACHE_PREFIX}${sid}`
          const raw = sessionStorage.getItem(cacheKey)
          if (raw) {
            const cached = JSON.parse(raw)
            if (cached.data) {
              cached.data.session.feedback = fb
              cached.data.session.status = 'completed'
              if (cached.data.d) cached.data.d.feedback = fb
              sessionStorage.setItem(cacheKey, JSON.stringify(cached))
            }
          }
        } catch { /* non-critical */ }
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

  async function handleRetrySave() {
    if (!feedback || !sessionId || sessionId === 'local') return
    setSaveWarning(null)
    try {
      const fb = { ...feedback }
      // Normalize enums before saving
      const validProbabilities = ['High', 'Medium', 'Low'] as const
      if (!validProbabilities.includes(fb.pass_probability as typeof validProbabilities[number])) {
        fb.pass_probability = fb.pass_probability?.toLowerCase?.().includes('high') ? 'High'
          : fb.pass_probability?.toLowerCase?.().includes('low') ? 'Low' : 'Medium'
      }
      if (!validProbabilities.includes(fb.confidence_level as typeof validProbabilities[number])) {
        fb.confidence_level = fb.confidence_level?.toLowerCase?.().includes('high') ? 'High'
          : fb.confidence_level?.toLowerCase?.().includes('low') ? 'Low' : 'Medium'
      }
      const saved = await fetchWithRetry(`/api/interviews/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          feedback: fb,
          status: 'completed',
          completedAt: new Date().toISOString(),
        }),
      })
      if (!saved) {
        setSaveWarning('Save failed again. The feedback is visible now but may not appear in history.')
      }
    } catch {
      setSaveWarning('Save failed again. The feedback is visible now but may not appear in history.')
    }
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

  // Key moments for replay segment (top moments + improvement moments)
  const keyMoments = useMemo(() => {
    if (!analysis?.fusionSummary) return []
    const top = (analysis.fusionSummary.topMoments || []).map(m => ({ ...m, severity: m.severity || 'positive' as const }))
    const improve = (analysis.fusionSummary.improvementMoments || []).map(m => ({ ...m, severity: m.severity || 'attention' as const }))
    return [...top, ...improve].sort((a, b) => a.startSec - b.startSec)
  }, [analysis])

  // Auto-scroll to active transcript entry
  useEffect(() => {
    if (activeEntryRef.current && activeTab === 'transcript') {
      activeEntryRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [activeTranscriptIndex, activeTab])

  // ── Loading / error state (AFTER all hooks) ────────────────────────────────

  // Progress steps for feedback generation
  useEffect(() => {
    if (!loading) { setProgressStep(0); return }
    const steps = [
      { delay: 0 },
      { delay: 2000 },
      { delay: 4000 },
      { delay: 7000 },
    ]
    const timers = steps.map((s, i) =>
      setTimeout(() => setProgressStep(i), s.delay)
    )
    return () => timers.forEach(clearTimeout)
  }, [loading])

  if (loading || !data) {
    const progressSteps = [
      'Analyzing your answers...',
      'Evaluating communication patterns...',
      'Generating personalized feedback...',
      'Finalizing your report...',
    ]
    const progress = Math.min(((progressStep + 1) / progressSteps.length) * 100, 95)
    return (
      <div className="min-h-screen bg-white flex flex-col items-center justify-center gap-6 px-4">
        <div className="w-full max-w-xs space-y-4">
          <div className="flex items-center justify-center gap-3">
            <div className="w-6 h-6 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
            <p className="text-body font-medium text-[#0f1419]">{progressSteps[progressStep]}</p>
          </div>
          <div className="w-full h-1.5 bg-[#eff3f4] rounded-full overflow-hidden">
            <div
              className="h-full bg-brand-500 rounded-full transition-all duration-1000 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>
          <div className="flex justify-between text-xs text-[#8b98a5]">
            {progressSteps.map((step, i) => (
              <div key={i} className={`w-2 h-2 rounded-full ${i <= progressStep ? 'bg-brand-500' : 'bg-[#e1e8ed]'}`} />
            ))}
          </div>
        </div>
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
            <button onClick={() => router.push('/')} className="px-5 py-2 bg-[#f8fafc] hover:bg-[#eff3f4] border border-[#e1e8ed] text-[#536471] rounded-[var(--radius-md)] text-sm font-medium transition">
              Go home
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (!feedback) return null

  // Apply safety defaults for missing nested feedback fields
  if (feedback.dimensions) {
    if (!feedback.dimensions.answer_quality) feedback.dimensions.answer_quality = { score: feedback.overall_score || 50, strengths: [], weaknesses: [] }
    if (!feedback.dimensions.communication) feedback.dimensions.communication = { score: 50, wpm: 120, filler_rate: 0.05, pause_score: 60, rambling_index: 0.3 }
    if (!feedback.dimensions.engagement_signals) feedback.dimensions.engagement_signals = { score: 50, engagement_score: 50, confidence_trend: 'stable' as const, energy_consistency: 0.6, composure_under_pressure: 50 }
  }

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
    ...(hasRecording || analysis ? [{ key: 'analysis' as const, label: 'AI Analysis' }] : []),
  ]

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-white text-[#0f1419]">
      {/* Header */}
      <header className="sticky top-[68px] z-10 bg-white/90 backdrop-blur-xl border-b border-[#e1e8ed] h-[52px] flex items-center px-4 sm:px-6">
        <div className="max-w-5xl mx-auto w-full flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.back()}
              className="p-1.5 rounded-lg hover:bg-[#f8fafc] transition text-[#536471] hover:text-[#0f1419]"
              aria-label="Go back"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <div>
              <h1 className="text-subheading sm:text-heading leading-tight">Interview Feedback</h1>
              <p className="text-caption text-[#71767b] hidden sm:block">
                {data.config &&
                  `${getDomainLabel(data.config.role)} · ${data.config.experience} yrs · ${data.config.duration} min`}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                const text = data.transcript.map((e) => `${e.speaker.toUpperCase()}: ${e.text}`).join('\n\n')
                const blob = new Blob([text], { type: 'text/plain' })
                const a = document.createElement('a')
                a.href = URL.createObjectURL(blob)
                a.download = 'interview-transcript.txt'
                a.click()
              }}
              className="p-2 rounded-lg hover:bg-[#f8fafc] transition text-[#536471] hover:text-[#0f1419]"
              aria-label="Download transcript"
              title="Download transcript"
            >
              <svg className="w-4.5 h-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3M3 17v3a2 2 0 002 2h14a2 2 0 002-2v-3" />
              </svg>
            </button>
            <ShareButton sessionId={sessionId} />
          </div>
        </div>
      </header>

      {/* Save warning banner */}
      {saveWarning && (
        <div className="max-w-5xl mx-auto px-4 mt-4">
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-[var(--radius-md)] px-5 py-3 text-sm text-amber-600 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {saveWarning}
            </div>
            {sessionId && sessionId !== 'local' && (
              <button onClick={handleRetrySave} className="shrink-0 px-3 py-1 bg-amber-500 hover:bg-amber-600 text-white rounded-md text-xs font-medium transition">
                Retry save
              </button>
            )}
          </div>
        </div>
      )}

      <main className="max-w-5xl mx-auto px-4 py-6 space-y-6">
        {/* Hero: overall score — compact horizontal layout */}
        <section className="flex flex-col sm:flex-row items-center gap-5 sm:gap-8 py-4 border-b border-[#e1e8ed] animate-fade-in">
          <ScoreRing score={overall_score} size={110} />
          <div className="flex-1 text-center sm:text-left space-y-2">
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
            <div className="flex items-center gap-3 justify-center sm:justify-start flex-wrap">
              <div className={`px-3 py-1 rounded-full border text-sm font-medium ${PROBABILITY_COLORS[pass_probability]}`}>
                {s(pass_probability)} pass probability
              </div>
              <div className="px-3 py-1 rounded-full border border-[#e1e8ed] text-[#536471] text-sm">
                {s(feedback.confidence_level)} confidence
              </div>
            </div>
          </div>
        </section>

        {/* Audio Player — below hero, above tabs. Hidden on analysis tab since VideoPlayer replaces it. */}
        {recordingUrl && activeTab !== 'analysis' && (
          <AudioPlayer
            src={recordingUrl}
            questionMarkers={questionMarkers}
            onTimeUpdate={setCurrentAudioTime}
            onSeek={handleSeekExpose}
          />
        )}

        {/* Sticky tab navigation */}
        <div className="sticky top-[120px] z-[9] bg-white pt-1 pb-3 -mx-4 px-4 border-b border-transparent [&.stuck]:border-[#e1e8ed]">
          <div className="flex gap-1 bg-[#f8fafc] border border-[#e1e8ed] rounded-xl p-1">
            {TABS.map((tab) => (
              <button
                key={tab.key}
                onClick={() => handleTabChange(tab.key)}
                className={`flex-1 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                  activeTab === tab.key
                    ? 'bg-brand-500 text-white shadow-sm'
                    : 'text-[#71767b] hover:text-[#0f1419] hover:bg-white'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Overview tab */}
        <div id="tab-content">
        {activeTab === 'overview' && (
          <OverviewTab
            data={data}
            feedback={feedback}
            sessionId={sessionId}
            peerData={peerData}
            peerLoading={peerLoading}
            currentScore={overall_score}
            currentScores={data.evaluations.length > 0 ? (() => {
              const evals = data.evaluations
              const avg = (key: 'relevance' | 'structure' | 'specificity' | 'ownership') =>
                Math.round(evals.reduce((s, e) => s + (e[key] || 0), 0) / evals.length)
              return {
                relevance: avg('relevance'),
                structure: avg('structure'),
                specificity: avg('specificity'),
                ownership: avg('ownership'),
              }
            })() : undefined}
            domain={data.config?.role}
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
          transcriptLoading ? (
            <div className="flex items-center justify-center py-16">
              <div className="w-6 h-6 rounded-full border-2 border-[#2563eb] border-t-transparent animate-spin" />
            </div>
          ) : (
            <TranscriptTab
              transcript={lazyTranscript ?? data.transcript}
              activeTranscriptIndex={activeTranscriptIndex}
              activeEntryRef={activeEntryRef}
              recordingUrl={recordingUrl}
              sessionStartedAt={sessionStartedAt}
              seekTo={seekToRef.current}
            />
          )
        )}

        {/* AI Analysis tab */}
        {activeTab === 'analysis' && (
          <div className="animate-fade-in space-y-8">
            {analysisLoading && (
              <div className="surface-card-bordered p-8 text-center space-y-4">
                <div className="w-8 h-8 rounded-full border-2 border-brand-500 border-t-transparent animate-spin mx-auto" />
                <p className="text-body text-[#536471]">{analysisProgress || 'Loading analysis...'}</p>
              </div>
            )}

            {analysisError && (
              <div className="surface-card-bordered border-red-500/30 p-6 text-center space-y-3">
                <p className="text-body text-red-600">{analysisError}</p>
                {hasRecording && (
                  <button
                    onClick={() => {
                      analysisTriggeredRef.current = false
                      fetchAnalysis()
                    }}
                    className="px-4 py-2 bg-brand-500 hover:bg-brand-600 text-white rounded-[var(--radius-md)] text-sm font-medium transition"
                  >
                    Retry Analysis
                  </button>
                )}
              </div>
            )}

            {analysis && analysis.status === 'completed' && (
              <>
                {/* ── Segment 1: Interview Replay ─────────────────────────── */}
                <section className="surface-card-bordered p-4 sm:p-6 space-y-4 relative">
                  {/* Fullscreen toggle */}
                  <button
                    onClick={() => setReplayFullscreen(true)}
                    className="absolute top-3 right-3 z-10 p-2 rounded-lg bg-white/80 hover:bg-white border border-[#e1e8ed] text-[#536471] hover:text-[#0f1419] transition-colors"
                    title="Expand replay"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5v-4m0 4h-4m4 0l-5-5" />
                    </svg>
                  </button>

                  {/* Video + Transcript side-by-side */}
                  <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-4">
                    {videoSrc && (
                      <VideoPlayer
                        src={videoSrc}
                        questionMarkers={questionMarkers}
                        onTimeUpdate={setAnalysisVideoTime}
                        onSeek={(fn) => { analysisSeekRef.current = fn }}
                      />
                    )}
                    {analysis.whisperTranscript && analysis.whisperTranscript.length > 0 && (
                      <div className="space-y-2">
                        <p className="text-caption text-[#71767b] uppercase tracking-wide font-medium">Transcript</p>
                        <div className="max-h-[340px] overflow-y-auto">
                          <ReplayTranscript
                            whisperSegments={analysis.whisperTranscript}
                            transcript={data.transcript}
                            currentTimeSec={analysisVideoTime}
                            onWordClick={(sec) => analysisSeekRef.current?.(sec)}
                          />
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Timeline */}
                  {analysis.timeline && analysis.timeline.length > 0 && (
                    <TimelineTrack
                      events={analysis.timeline}
                      totalDurationSec={
                        analysis.timeline.length > 0
                          ? Math.ceil(analysis.timeline[analysis.timeline.length - 1].endSec)
                          : 300
                      }
                      currentTimeSec={analysisVideoTime}
                      onSeek={(sec) => analysisSeekRef.current?.(sec)}
                    />
                  )}

                  {/* Key Moments */}
                  {keyMoments.length > 0 && (
                    <MomentCards
                      moments={keyMoments}
                      onSeek={(sec) => analysisSeekRef.current?.(sec)}
                    />
                  )}
                </section>

                {/* ── Segment 2: Deep Analysis ────────────────────────────── */}
                <section className="space-y-6">
                  <h3 className="text-heading text-[#0f1419]">Deep Analysis</h3>

                  {/* Score badges */}
                  {analysis.fusionSummary && (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <div className="surface-card-bordered p-4 text-center">
                        <p className="text-caption text-[#71767b]">Eye Contact</p>
                        <p className="text-heading">{analysis.fusionSummary.eyeContactScore}<span className="text-sm text-[#71767b]">/100</span></p>
                      </div>
                      <div className="surface-card-bordered p-4 text-center">
                        <p className="text-caption text-[#71767b]">Body Language</p>
                        <p className="text-heading">{analysis.fusionSummary.overallBodyLanguageScore}<span className="text-sm text-[#71767b]">/100</span></p>
                      </div>
                      <div className="surface-card-bordered p-4 text-center">
                        <p className="text-caption text-[#71767b]">Timeline Events</p>
                        <p className="text-heading">{analysis.timeline?.length || 0}</p>
                      </div>
                      <div className="surface-card-bordered p-4 text-center">
                        <p className="text-caption text-[#71767b]">Coaching Tips</p>
                        <p className="text-heading">{analysis.fusionSummary.coachingTips.length}</p>
                      </div>
                    </div>
                  )}

                  {/* Signal charts */}
                  <SignalCharts
                    prosodySegments={analysis.prosodySegments || []}
                    facialSegments={analysis.facialSegments || []}
                    currentTimeSec={analysisVideoTime}
                  />

                  {/* Coaching panel (tips only — moments are in Segment 1) */}
                  {analysis.fusionSummary && (
                    <CoachingPanel
                      fusionSummary={analysis.fusionSummary}
                      timeline={analysis.timeline || []}
                      onSeek={(sec) => analysisSeekRef.current?.(sec)}
                      hideMoments
                    />
                  )}
                </section>

                {/* ── Learning & Development ──────────────────────────────── */}
                {feedback && (
                  <LearningPlanSection feedback={feedback} />
                )}
              </>
            )}
          </div>
        )}

        {/* Fullscreen Replay Overlay */}
        {replayFullscreen && analysis && analysis.status === 'completed' && (
          <div className="fixed inset-0 z-50 bg-white overflow-y-auto">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
              {/* Close button */}
              <div className="flex items-center justify-between">
                <h2 className="text-heading text-[#0f1419]">Interview Replay</h2>
                <button
                  onClick={() => setReplayFullscreen(false)}
                  className="p-2 rounded-lg hover:bg-[#f8fafc] border border-[#e1e8ed] text-[#536471] hover:text-[#0f1419] transition-colors"
                  title="Close (Esc)"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {/* Video + Transcript side-by-side (expanded) */}
              <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-6">
                {videoSrc && (
                  <VideoPlayer
                    src={videoSrc}
                    questionMarkers={questionMarkers}
                    onTimeUpdate={setAnalysisVideoTime}
                    onSeek={(fn) => { analysisSeekRef.current = fn }}
                  />
                )}
                {analysis.whisperTranscript && analysis.whisperTranscript.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-caption text-[#71767b] uppercase tracking-wide font-medium">Transcript</p>
                    <div className="max-h-[60vh] overflow-y-auto">
                      <ReplayTranscript
                        whisperSegments={analysis.whisperTranscript}
                        transcript={data.transcript}
                        currentTimeSec={analysisVideoTime}
                        onWordClick={(sec) => analysisSeekRef.current?.(sec)}
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Timeline */}
              {analysis.timeline && analysis.timeline.length > 0 && (
                <TimelineTrack
                  events={analysis.timeline}
                  totalDurationSec={
                    analysis.timeline.length > 0
                      ? Math.ceil(analysis.timeline[analysis.timeline.length - 1].endSec)
                      : 300
                  }
                  currentTimeSec={analysisVideoTime}
                  onSeek={(sec) => analysisSeekRef.current?.(sec)}
                />
              )}

              {/* Key Moments */}
              {keyMoments.length > 0 && (
                <MomentCards
                  moments={keyMoments}
                  onSeek={(sec) => analysisSeekRef.current?.(sec)}
                />
              )}
            </div>
          </div>
        )}
        </div>{/* close #tab-content */}

        {/* CTA */}
        <section className="surface-card-bordered p-5 sm:p-6 flex flex-col sm:flex-row items-center justify-between gap-4 animate-fade-in">
          <div>
            <p className="text-subheading text-[#0f1419]">Ready for another round?</p>
            <p className="text-body text-[#71767b]">Practice makes perfect — each session sharpens your skills.</p>
          </div>
          <div className="flex gap-3 flex-wrap shrink-0">
            <button
              onClick={() => {
                localStorage.removeItem('interviewConfig')
                localStorage.removeItem('interviewActiveSession')
                router.push('/')
              }}
              className="px-6 py-2.5 bg-brand-500 hover:bg-brand-600 text-white rounded-[var(--radius-md)] font-semibold btn-glow transition text-sm"
            >
              Reattempt Interview
            </button>
            {(hasRecording || analysis) && (
              <button
                onClick={() => handleTabChange('analysis')}
                className="px-6 py-2.5 bg-[#f8fafc] hover:bg-[#eff3f4] border border-[#e1e8ed] text-[#536471] rounded-[var(--radius-md)] font-medium transition text-sm"
              >
                View AI Analysis
              </button>
            )}
          </div>
        </section>
      </main>
    </div>
  )
}
