'use client'

import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import dynamic from 'next/dynamic'
import { useRouter, useParams } from 'next/navigation'
import { ScoreRing } from '@shared/ui/ScoreBar'
import AudioPlayer from '@feedback/components/AudioPlayer'
import { resolveRecordingWatch, type RecordingFallback } from '@feedback/lib/recordingWatchPlan'
import OverviewTab from '@feedback/components/OverviewTab'
import ScoresTab from '@feedback/components/ScoresTab'
import type { PeerData } from '@feedback/components/PeerComparison'
import type { MultimodalAnalysisData } from '@shared/types/multimodal'

// Multimodal tab pulls in Recharts + the video player. Lazy-load it so the
// default Scores tab's bundle stays small. (Rule: bundle-dynamic-imports.)
const MultimodalAnalysisTab = dynamic(
  () => import('@feedback/components/MultimodalAnalysisTab'),
  {
    ssr: false,
    loading: () => (
      <div className="surface-card-bordered p-8 text-center">
        <div className="w-6 h-6 rounded-full border-2 border-brand-500 border-t-transparent animate-spin mx-auto" />
      </div>
    ),
  }
)

// Learning tab content — same dynamic-import pattern. Only loaded when the
// user clicks into the Learning tab, keeping the default Scores tab fast.
const LearningTab = dynamic(
  () => import('@feedback/components/LearningTab'),
  {
    ssr: false,
    loading: () => (
      <div className="surface-card-bordered p-8 text-center">
        <div className="w-6 h-6 rounded-full border-2 border-brand-500 border-t-transparent animate-spin mx-auto" />
      </div>
    ),
  }
)
import type { FeedbackData, StoredInterviewData } from '@shared/types'
import { getDomainLabel } from '@interview/config/interviewConfig'
import { computeOffsetSeconds } from '@interview/utils/offsetHelpers'
import { mergeWithLocalData, readLocalInterviewData, cleanupLocalInterviewData } from '@interview/utils/mergeSessionData'
import { buildFeedbackPrintHtml } from '@interview/utils/feedbackPrintHtml'
import { drainQueuedReplayUploads, hasQueuedReplayUpload } from '@interview/utils/resumableUpload'
import { fetchWithRetry } from '@shared/fetchWithRetry'
import { fetchFeedbackSessionSummary } from '@feedback/lib/feedbackSessionFetcher'
import { bisectLastLE } from '@shared/utils'
import { PROBABILITY_COLORS } from '@interview/config/feedbackConfig'
import ShareButton from '@learn/components/feedback/ShareButton'
import PathwayPendingBanner from '@learn/components/pathway/PathwayPendingBanner'
import { usePathwayGenerationPoll } from '@learn/hooks/usePathwayGenerationPoll'
import { STORAGE_KEYS } from '@shared/storageKeys'
import JobsCountLink from '@jobs/components/JobsCountLink'
import {
  persistGenericRetakeConfig,
  planRetakeNavigation,
  retakeConfigFromStoredSession,
  type RetakeRouteResponse,
} from '@interview/utils/retakeNavigation'

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

type FeedbackTab = 'overview' | 'questions' | 'analysis' | 'learning'

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Jobs practice bridge (Wave 4.3): when this session was launched from a
 * job ([Practice for this job]), the localStorage config still carries the
 * attribution — render the way back + the evidence tick. Pure additive
 * banner; renders nothing for every non-jobs session.
 */
function JobsBridge({ sessionId }: { sessionId: string }) {
  const [bridge, setBridge] = useState<{ jobId: string; company?: string; evidence?: number } | null>(null)
  useEffect(() => {
    if (!sessionId) return
    // The PERSISTED session is the source of truth: useInterview clears
    // INTERVIEW_CONFIG from localStorage before navigating here, so the
    // config is already gone on the normal flow (Codex on #524).
    fetch(`/api/interviews/${sessionId}?excludeTranscript=true`)
      .then((r) => (r.ok ? r.json() : null))
      .then((session) => {
        const attr = session?.attribution
        if (attr?.source !== 'jobs' || !attr.jobId) return
        setBridge({ jobId: attr.jobId, company: session?.config?.targetCompany })
        return fetch(`/api/jobs/${attr.jobId}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => {
            if (d && d.gated === false && d.application) {
              setBridge((b) => (b ? { ...b, evidence: d.application.practiceCount, company: b.company || d.company } : b))
            }
          })
      })
      .catch(() => {})
  }, [sessionId])
  if (!bridge) return null
  return (
    <a href={`/jobs/${bridge.jobId}`} className="mt-1 inline-block text-sm text-blue-600 hover:underline">
      ← Back to {bridge.company || 'the job'}
      {typeof bridge.evidence === 'number' && (
        <span className="ml-2 text-xs text-gray-500">Evidence toward readiness on this job: {bridge.evidence}/3</span>
      )}
    </a>
  )
}

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
  const [activeTab, setActiveTab] = useState<FeedbackTab>('questions')
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
  const [hasAnalysisSource, setHasAnalysisSource] = useState(false)
  // Video for analysis tab
  const [videoSrc, setVideoSrc] = useState<string | null>(null)
  const [analysisVideoTime, setAnalysisVideoTime] = useState(0)
  const analysisSeekRef = useRef<((seconds: number) => void) | null>(null)
  const [replayFullscreen, setReplayFullscreen] = useState(false)

  // Retake flow
  const [retakeLoading, setRetakeLoading] = useState(false)
  const [retakeSetupConfig, setRetakeSetupConfig] = useState<
    ReturnType<typeof retakeConfigFromStoredSession>
  >()

  // Pathway retry banner — when the pathway empty-state CTA sends the
  // user here with `?retryPathway=1`, we fire one POST to
  // /api/learn/pathway/retry and surface the outcome inline.
  // Codex P2 on PR #398: previously the query param was set but never
  // consumed, so following the CTA appeared to do nothing.
  const [pathwayRetryStatus, setPathwayRetryStatus] = useState<
    null | { kind: 'pending' } | { kind: 'success' } | { kind: 'error'; message: string }
  >(null)
  const [pathwayPollEpoch, setPathwayPollEpoch] = useState(0)
  const pathwayRetryTriggeredRef = useRef(false)

  const pathwayPlanScheduled = useMemo(
    () =>
      feedback?.sideEffectOutcomes?.some(
        (o) => o.name === 'pathwayPlan' && o.status === 'scheduled',
      ) ?? false,
    [feedback],
  )
  const handlePathwayPollRetried = useCallback(() => {
    setPathwayPollEpoch((n) => n + 1)
  }, [])

  const { phase: pathwayPollPhase, pollExhausted: pathwayPollExhausted } =
    usePathwayGenerationPoll({
    sessionId: sessionId !== 'local' ? sessionId : null,
    enabled: pathwayPlanScheduled,
    pollEpoch: pathwayPollEpoch,
    onRefresh: async () => {
      if (!sessionId || sessionId === 'local') return
      try {
        const res = await fetch(`/api/interviews/${sessionId}?excludeTranscript=true`, {
          credentials: 'include',
        })
        if (!res.ok) return
        const json = (await res.json()) as { feedback?: FeedbackData }
        if (json.feedback) setFeedback(json.feedback)
      } catch {
        // Poll refresh is best-effort on the feedback page.
      }
    },
  })

  // ── Async enrichment watcher (2026-07-17) ───────────────────────────────
  // ideal_answers + drill_recommendations are generated OFF the request path
  // by the feedback/enrich.requested Inngest job at full quality (founder
  // ruling: teaching content never trades quality against request latency).
  // While the session's enrichmentStatus is pending/running, poll the
  // session every 4s and swap the sections in when they land. Budget 150s:
  // 'high'-effort generation on a 30-minute interview (10 weak questions)
  // can legitimately take ~2 minutes — sized for the long-interview worst
  // case, not the 10-minute happy path. Mirrors the recording watcher.
  const [enrichmentPhase, setEnrichmentPhase] = useState<'idle' | 'generating' | 'done' | 'failed'>('idle')
  const [enrichmentStatus, setEnrichmentStatus] = useState<string | null>(null)
  useEffect(() => {
    if (!sessionId || sessionId === 'local' || !feedback) return
    const hasContent =
      (feedback.ideal_answers?.length ?? 0) > 0 ||
      (feedback.drill_recommendations?.length ?? 0) > 0
    if (hasContent) {
      setEnrichmentPhase('done')
      return
    }
    // Codex P2 (#552): only watch when a job is actually active. Legacy
    // sessions (no enrichmentStatus) and terminal states must never show
    // the generating placeholder.
    if (enrichmentStatus !== 'pending' && enrichmentStatus !== 'running') {
      setEnrichmentPhase(enrichmentStatus === 'failed' ? 'failed' : 'idle')
      return
    }
    let cancelled = false
    let attempts = 0
    const MAX_ATTEMPTS = 38 // ~150s at 4s intervals
    const INTERVAL_MS = 4000
    setEnrichmentPhase('generating')
    const timer = setInterval(async () => {
      if (cancelled) return
      if (++attempts > MAX_ATTEMPTS) {
        clearInterval(timer)
        setEnrichmentPhase('failed')
        return
      }
      try {
        const res = await fetch(`/api/interviews/${sessionId}?excludeTranscript=true`, {
          credentials: 'include',
          cache: 'no-store',
        })
        if (!res.ok) return
        const json = (await res.json()) as { feedback?: FeedbackData; enrichmentStatus?: string }
        const arrived =
          (json.feedback?.ideal_answers?.length ?? 0) > 0 ||
          (json.feedback?.drill_recommendations?.length ?? 0) > 0
        if (arrived && json.feedback) {
          clearInterval(timer)
          const landed = json.feedback
          setFeedback((prev) =>
            prev
              ? { ...prev, ideal_answers: landed.ideal_answers, drill_recommendations: landed.drill_recommendations }
              : landed,
          )
          setEnrichmentPhase('done')
          return
        }
        if (json.enrichmentStatus === 'failed') {
          clearInterval(timer)
          setEnrichmentStatus('failed')
          setEnrichmentPhase('failed')
          return
        }
        if (json.enrichmentStatus === 'succeeded') {
          // Succeeded with no content = no weak questions to enrich.
          clearInterval(timer)
          setEnrichmentStatus('succeeded')
          setEnrichmentPhase('done')
          return
        }
        if (!json.enrichmentStatus) {
          // No job was ever enqueued for this session (legacy / edge path) —
          // stop immediately rather than burning the 150s budget.
          clearInterval(timer)
          setEnrichmentStatus(null)
          setEnrichmentPhase('idle')
          return
        }
      } catch {
        // Best-effort poll; next tick retries.
      }
    }, INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, feedback === null, enrichmentStatus])

  // sideEffectOutcomes.pathwayPlan stays "scheduled" on persisted feedback even after
  // the pathway job finishes; hide the inline banner once polling observes completion.
  const showPathwayPendingBanner =
    pathwayPlanScheduled && pathwayPollPhase !== 'done'

  // Parent session id for retake comparison — populated from the session
  // GET response when the current session has `parentSessionId` set.
  const [parentSessionId, setParentSessionId] = useState<string | null>(null)

  // Audio player sync state
  const [currentAudioTime, setCurrentAudioTime] = useState(0)
  const seekToRef = useRef<((s: number) => void) | null>(null)
  const activeEntryRef = useRef<HTMLDivElement>(null)
  const handleSeekExpose = useCallback((fn: (s: number) => void) => { seekToRef.current = fn }, [])

  // Dedup latch — the camera upload is fire-and-forget (see
  // app/interview/page.tsx), so up to three code paths race to fetch the
  // presign URL: initial load, the feedback poll loop, and the
  // late-landing watcher below. This ref guarantees the actual
  // /api/recordings/presign call fires at most once *in-flight* per page
  // mount; on failure it resets so the next caller can retry.
  const recordingFetchTriggeredRef = useRef(false)
  // Separate latch for the audio-only object. Its failure mode differs: a
  // missing audio object 404s forever, so this latch is NOT reset on failure
  // (retrying under the watcher would 404-loop); the AudioPlayer just keeps
  // the camera-URL fallback.
  const audioFetchTriggeredRef = useRef(false)

  // Mirror of `recordingUrl` for closure-safe reads inside long-lived
  // setInterval callbacks (the watcher useEffect below would otherwise
  // capture the initial null value forever). Updated in a tiny
  // useEffect that runs whenever recordingUrl changes. recordingUrl stays
  // the CAMERA (or legacy) URL — the audio URL lives in audioUrl and must
  // never stop the camera watcher (the ~14MB audio presign lands seconds
  // after interview end while a 157MB camera multipart can be minutes out).
  const recordingUrlRef = useRef<string | null>(null)

  // Replay facts captured from whichever session-summary GET lands first
  // (initial load, poll loop, watcher tick).
  const replayMetaRef = useRef<{ hasAudioRecording: boolean; privacyMode: boolean; completedAtMs: number | null }>({
    hasAudioRecording: false,
    privacyMode: false,
    completedAtMs: null,
  })
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [recordingDurationSeconds, setRecordingDurationSeconds] = useState<number | null>(null)
  const [recordingFallback, setRecordingFallback] = useState<RecordingFallback>('none')

  const captureReplayMeta = useCallback((raw: unknown) => {
    if (!raw || typeof raw !== 'object') return
    const summary = raw as Record<string, unknown>
    if (typeof summary.hasAudioRecording === 'boolean') {
      replayMetaRef.current.hasAudioRecording = summary.hasAudioRecording
    }
    const cfg = summary.config as { privacyMode?: boolean } | undefined
    if (summary.privacyMode === true || cfg?.privacyMode === true) {
      replayMetaRef.current.privacyMode = true
    }
    const completedAt = summary.completedAt ?? summary.createdAt
    if (typeof completedAt === 'string') {
      const ms = Date.parse(completedAt)
      if (Number.isFinite(ms)) replayMetaRef.current.completedAtMs = ms
    }
    if (typeof summary.recordingDurationSeconds === 'number' && summary.recordingDurationSeconds > 0) {
      setRecordingDurationSeconds(summary.recordingDurationSeconds)
    }
  }, [])

  const readCachedPresign = useCallback((kind: 'camera' | 'audio'): string | null => {
    // v2 per-kind cache entries carry their own expiry, derived from the
    // server's expiresInSeconds — the old fixed 10-minute constant silently
    // disagreed with the server-side presign TTL. Legacy v1 entries (un-kinded
    // key) are deliberately never read.
    const entry = getCachedJSON<{ url: string; expiresAtMs: number }>(
      `${RECORDING_URL_PREFIX}v2:${kind}:${sessionId}`,
      Number.MAX_SAFE_INTEGER,
    )
    if (!entry || typeof entry.url !== 'string') return null
    if (!Number.isFinite(entry.expiresAtMs) || Date.now() >= entry.expiresAtMs) return null
    return entry.url
  }, [sessionId])

  const fetchPresign = useCallback(async (kind: 'camera' | 'audio'): Promise<string | null> => {
    try {
      const res = await fetch(`/api/recordings/presign?sessionId=${sessionId}&kind=${kind}`)
      if (!res.ok) return null
      const presignData = (await res.json()) as { url?: string; expiresInSeconds?: number }
      if (!presignData?.url) return null
      const ttlMs = Math.max(60_000, (presignData.expiresInSeconds ?? 900) * 1000 * 0.8)
      setCachedJSON(`${RECORDING_URL_PREFIX}v2:${kind}:${sessionId}`, {
        url: presignData.url,
        expiresAtMs: Date.now() + ttlMs,
      })
      return presignData.url
    } catch {
      return null
    }
  }, [sessionId])

  const fetchRecordingUrl = useCallback(() => {
    setHasRecording(true)
    if (!recordingFetchTriggeredRef.current) {
      recordingFetchTriggeredRef.current = true
      const cached = readCachedPresign('camera')
      if (cached) {
        setRecordingUrl(cached)
        setVideoSrc(cached)
      } else {
        void fetchPresign('camera').then((url) => {
          if (url) {
            setRecordingUrl(url)
            setVideoSrc(url)
          } else {
            recordingFetchTriggeredRef.current = false
          }
        })
      }
    }
    // Audio-only object (~14MB vs ~157MB for a 30-min camera webm). Gated on
    // the session actually having one AND not being privacy-mode: privacy
    // users opted out of stored replay video, and whether they should get
    // audio replay is an open product decision — behavior is unchanged for
    // them (no player, as before).
    if (
      !audioFetchTriggeredRef.current &&
      replayMetaRef.current.hasAudioRecording &&
      !replayMetaRef.current.privacyMode
    ) {
      audioFetchTriggeredRef.current = true
      const cached = readCachedPresign('audio')
      if (cached) {
        setAudioUrl(cached)
      } else {
        void fetchPresign('audio').then((url) => {
          if (url) setAudioUrl(url)
        })
      }
    }
  }, [readCachedPresign, fetchPresign])

  // Media-error recovery for the players: a presigned URL expired mid-view
  // (30-min server TTL vs multi-hour open tabs). Mint a fresh URL and swap
  // it in; the player restores its position. Only presign-derived sources
  // call this — legacy session.recordingUrl documents never do.
  const refreshReplayUrl = useCallback(async (kind: 'camera' | 'audio'): Promise<string | null> => {
    try {
      sessionStorage.removeItem(`${RECORDING_URL_PREFIX}v2:${kind}:${sessionId}`)
    } catch { /* non-critical */ }
    const url = await fetchPresign(kind)
    if (!url) return null
    if (kind === 'camera') {
      setRecordingUrl(url)
      setVideoSrc(url)
    } else {
      setAudioUrl(url)
    }
    return url
  }, [fetchPresign, sessionId])

  // Keep recordingUrlRef in sync with recordingUrl state for the
  // watcher's closure-safe reads.
  useEffect(() => {
    recordingUrlRef.current = recordingUrl
  }, [recordingUrl])

  // ── Retry queued replay uploads ────────────────────────────────────────────
  useEffect(() => {
    void drainQueuedReplayUploads().catch((err) =>
      console.warn('Failed to drain queued replay uploads', err)
    )
  }, [])

  // ── Pathway retry trigger (?retryPathway=1) ────────────────────────────────
  // The pathway empty-state CTA in pathwayViewModel.ts sends users here
  // with this flag when a prior pathway generation failed. We invoke the
  // retry endpoint once, then strip the flag from the URL so a refresh
  // doesn't re-fire it. The retry route is rate-limited (3/min) and uses
  // its own atomic CAS, so a duplicate fire would just 409 — but stripping
  // the param keeps the UI consistent on reload.
  useEffect(() => {
    if (!sessionId || sessionId === 'local') return
    if (pathwayRetryTriggeredRef.current) return
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    if (params.get('retryPathway') !== '1') return
    pathwayRetryTriggeredRef.current = true
    setPathwayRetryStatus({ kind: 'pending' })

    // Strip the query param immediately so a manual refresh / share doesn't
    // re-trigger. `router.replace` with the cleaned URL preserves history
    // entry instead of pushing a new one.
    params.delete('retryPathway')
    const cleanQuery = params.toString()
    const cleanPath = `${window.location.pathname}${cleanQuery ? `?${cleanQuery}` : ''}`
    router.replace(cleanPath)

    fetch(`/api/learn/pathway?fromFeedback=${encodeURIComponent(sessionId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((vm) => {
        const reason = vm?.pathwayUpdate?.reason
        if (reason === 'insufficient_answers' || reason === 'no_scored_feedback') {
          setPathwayRetryStatus({
            kind: 'error',
            message:
              reason === 'insufficient_answers'
                ? 'This interview needs at least three answers before a pathway update can run.'
                : 'Generate scored feedback first — pathway retry is not available for this session.',
          })
          return null
        }
        return fetch('/api/learn/pathway/retry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        })
      })
      .then(async (res) => {
        if (!res) return
        if (res.ok) {
          setPathwayRetryStatus({ kind: 'success' })
          setPathwayPollEpoch((n) => n + 1)
          return
        }

        // Codex P2 on PR #400 — /api/learn/pathway/retry returns 409 for
        // several distinct cases:
        //
        //   In-flight (success-flavored from the user's perspective —
        //   pathway IS being worked on):
        //     "A pathway regeneration is already in flight for this session."
        //     "Another retry just claimed this session ..."
        //
        //   Hard errors (treating these as success would mislead the user):
        //     "Pathway regeneration is not retryable from status 'X' ..."
        //         (status was 'succeeded' / 'skipped' / etc — no retry will fire)
        //     "Session config is missing required fields ..."
        //     "Session has no evaluations to base a plan on."
        //
        // We discriminate on the message substring rather than reusing
        // the HTTP code so users on hard-error 409s see the actual reason
        // rather than a misleading "regeneration started".
        let message = 'Could not start pathway retry.'
        try {
          const body = await res.json()
          if (typeof body?.error === 'string') message = body.error
        } catch {
          // Non-JSON body — keep generic message.
        }
        if (res.status === 409 && /already in flight|just claimed/i.test(message)) {
          setPathwayRetryStatus({ kind: 'success' })
          setPathwayPollEpoch((n) => n + 1)
          return
        }
        setPathwayRetryStatus({ kind: 'error', message })
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Network error'
        setPathwayRetryStatus({ kind: 'error', message })
      })
  }, [sessionId, router])

  // ── Late-landing recording catcher (Shape B) ───────────────────────────────
  // Camera upload is fire-and-forget per app/interview/page.tsx — the
  // feedback page can (and does) mount before the multipart 'complete'
  // PATCHes session.recordingR2Key. Initial-load + the feedback poll
  // loop's Shape A check cover the in-flight case, but if feedback
  // arrives quickly enough that the poll loop never runs (or exits
  // before the upload lands), neither path picks the recording up.
  // This independent watcher polls /api/interviews/<id> every 3s for
  // ~45s, calling fetchRecordingUrl once hasRecording flips true. The
  // dedup ref makes it safe to overlap with the other paths.
  useEffect(() => {
    if (!sessionId || sessionId === 'local') return
    if (recordingFetchTriggeredRef.current) return
    let cancelled = false
    let attempts = 0
    // Budget + fallback message resolve from evidence (privacy flag, session
    // recency, IndexedDB queued-upload record) once the first facts land —
    // an unconditional long budget would show "still uploading…" as a lie on
    // every history revisit of old/privacy sessions, and an unconditional
    // short one re-breaks the 30-min case this exists for.
    let maxAttempts = 15
    let planResolved = false
    const INTERVAL_MS = 3000

    const resolvePlan = async () => {
      const queued = await hasQueuedReplayUpload(sessionId).catch(() => false)
      if (cancelled) return
      const plan = resolveRecordingWatch({
        privacyMode: replayMetaRef.current.privacyMode,
        completedAtMs: replayMetaRef.current.completedAtMs,
        nowMs: Date.now(),
        hasQueuedUpload: queued,
      })
      maxAttempts = plan.maxAttempts
      planResolved = true
      setRecordingFallback(plan.fallback)
      if (plan.maxAttempts === 0) stop()
    }
    let timer: ReturnType<typeof setInterval> | undefined
    const stop = () => {
      if (timer !== undefined) {
        clearInterval(timer)
        timer = undefined
      }
    }
    const tick = async () => {
      // Stop conditions: unmounted, URL successfully obtained, or budget
      // exhausted. We deliberately do NOT short-circuit on the in-flight
      // latch (`recordingFetchTriggeredRef.current`) — if a presign fetch
      // fails it resets the latch, and the watcher needs to be alive to
      // retry on the next tick. (Codex P2 + Vercel Agent #239 on PR #364.)
      if (cancelled || recordingUrlRef.current) {
        stop()
        return
      }
      if (++attempts > maxAttempts) {
        stop()
        // Exhausted with an upload that was plausibly in flight: soften to
        // the definitive-but-honest state; a slow multipart can outlive even
        // the extended budget, and a page refresh re-checks from scratch.
        if (!cancelled && !recordingUrlRef.current) {
          setRecordingFallback('none')
        }
        return
      }
      try {
        // UAT-015: routed through the shared dedup'd helper so this
        // recording-watcher GET shares its in-flight call with the
        // initial-load + poll-loop GETs mounted by the same page.
        const data = await fetchFeedbackSessionSummary(sessionId)
        captureReplayMeta(data)
        if (!planResolved) await resolvePlan()
        if (cancelled) return
        if (data?.hasRecording || data?.hasAudioRecording) {
          // No-op if another path already triggered fetch; on its eventual
          // success the next tick observes recordingUrlRef and stops.
          fetchRecordingUrl()
        }
      } catch {
        // network/abort — keep ticking
      }
    }
    timer = setInterval(tick, INTERVAL_MS)
    return () => {
      cancelled = true
      stop()
    }
  }, [sessionId, fetchRecordingUrl, captureReplayMeta])

  // ── Fullscreen replay overlay ──────────────────────────────────────────────
  useEffect(() => {
    if (!replayFullscreen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setReplayFullscreen(false) }
    window.addEventListener('keydown', onKey)
    return () => { document.body.style.overflow = prev; window.removeEventListener('keydown', onKey) }
  }, [replayFullscreen])

  useEffect(() => {
    if (activeTab !== 'analysis' && replayFullscreen) {
      setReplayFullscreen(false)
    }
  }, [activeTab, replayFullscreen])

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

      // No analysis exists — trigger if transcript/live words are available
      if (hasAnalysisSource && !analysisTriggeredRef.current) {
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
      } else if (!hasAnalysisSource) {
        setAnalysisError('No transcript source is available for analysis')
        setAnalysisLoading(false)
      } else {
        setAnalysisLoading(false)
      }
    } catch {
      setAnalysisError('Failed to load analysis')
      setAnalysisLoading(false)
    }
  }, [sessionId, hasAnalysisSource]) // eslint-disable-line react-hooks/exhaustive-deps

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

      // Polling cap: 180s (3 minutes). The inline pipeline has a 50s
      // soft timeout on the server side; if it hasn't completed by now
      // the initial attempt likely timed out. Offer a retry option
      // rather than leaving the user staring at a spinner.
      if (elapsed >= 180000) {
        clearInterval(interval)
        setAnalysisError('Analysis is taking longer than expected. Click "Retry Analysis" to try again, or refresh in a minute.')
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
    // Lazy-load transcript when the Scores tab (or Multimodal video-less
    // fallback) needs the transcript for question detail / replay.
    if ((tab === 'questions' || tab === 'analysis') && !lazyTranscript && !transcriptLoading && sessionId && sessionId !== 'local') {
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
            // UAT-015: shared helper — same in-flight cache as the
            // recording-watcher useEffect above and the poll loop
            // below, so this initial-load GET fans in cleanly with the
            // others when they all fire on mount.
            session = await fetchFeedbackSessionSummary(sessionId, { signal }) as Record<string, unknown> | null
          } catch (e) {
            if ((e as Error).name === 'AbortError') return
            // fall through to local data path
          }
        }

        if (session) {
            setRetakeSetupConfig(retakeConfigFromStoredSession(session))
            // Capture retake linkage for the comparison card. Sessions
            // created before the retake feature was added have no
            // parentSessionId, so this silently no-ops for them.
            const pId = session.parentSessionId as string | undefined
            if (pId) setParentSessionId(pId)
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
            // Trust the server-derived flag only. `d.transcript` may include
            // localStorage fallback that was never persisted to Mongo, in
            // which case auto-triggering /api/analysis/start would 400
            // because the server gate checks persisted sources only. (Codex
            // P2 on PR #332.) The server has set hasAnalysisSource on every
            // /api/interviews/[id] response since eee404b — older cached
            // responses age out within SESSION_CACHE_TTL_MS (2 min).
            setHasAnalysisSource(Boolean(session.hasAnalysisSource))

            // Fetch presigned recording URL. If hasRecording is still false
            // here, the camera upload is in flight — Shape A inside the
            // poll loop + Shape B's watcher will pick it up.
            captureReplayMeta(session)
            if (session.hasRecording || session.hasAudioRecording) {
              fetchRecordingUrl()
            } else if (session.recordingUrl) {
              setRecordingUrl(session.recordingUrl as string)
              setVideoSrc(session.recordingUrl as string)
            }
            if (session.startedAt) setSessionStartedAt(new Date(session.startedAt as string).getTime())

            fetchPeerData(d.config, signal)

            if (session.feedback) {
              setFeedback(session.feedback as FeedbackData)
              // Codex P2 (#552): the watcher must only run for sessions with
              // an ACTIVE enrichment job — legacy sessions have no
              // enrichmentStatus and would otherwise show a stuck 150s
              // placeholder for content that can never arrive.
              setEnrichmentStatus((session as { enrichmentStatus?: string }).enrichmentStatus ?? null)
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

            // Poll for pre-generated feedback before triggering our own call.
            // finishInterview fires a fire-and-forget POST /api/generate-feedback
            // that persists to session.feedback in the DB. Observed Claude
            // Sonnet latency for the feedback prompt is P50 ≈ 12 s, P95 ≈ 20 s,
            // so an 8 s window (the previous value) almost always timed out
            // and forced a redundant POST → 202 → inner-poll round trip.
            // Poll for 24 s instead so the happy-path pre-gen is served
            // directly from the DB; the 202 fallback still covers the
            // slow-tail + outright-failure cases.
            const POLL_INTERVAL_MS = 2000
            const MAX_POLLS = 12 // up to 24s — covers Claude Sonnet P95 (~20s)
            for (let poll = 0; poll < MAX_POLLS; poll++) {
              if (signal?.aborted) return
              await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
              try {
                // UAT-015: shared helper — in-flight dedup means a
                // poll cycle that overlaps the initial-load (rare but
                // possible on slow networks) collapses to one
                // request, not two.
                const pollData = await fetchFeedbackSessionSummary(sessionId, { signal })
                if (pollData) {
                  captureReplayMeta(pollData)
                  if (pollData.hasRecording || pollData.hasAudioRecording) fetchRecordingUrl()
                  if (pollData.feedback) {
                    setFeedback(pollData.feedback as FeedbackData)
                    setEnrichmentStatus((pollData as { enrichmentStatus?: string }).enrichmentStatus ?? 'pending')
                    setLoading(false)
                    if (pollData.status !== 'completed') {
                      fetchWithRetry(`/api/interviews/${sessionId}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ status: 'completed', completedAt: new Date().toISOString() }),
                      }).catch(() => {})
                    }
                    return
                  }
                }
              } catch (e) {
                if ((e as Error).name === 'AbortError') return
                // Poll failed — continue to next attempt or fall through to generate
              }
            }

            // Pre-gen didn't complete within polling window — generate ourselves
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

    // Pre-flight: if no evaluations were captured (e.g. interview ended
    // abruptly before any answer was evaluated), skip the API call and
    // show a friendly message instead of an opaque server error.
    if (!d.evaluations || d.evaluations.length === 0) {
      setFeedbackError(
        'No answers were evaluated during this interview — feedback cannot be generated. ' +
        'This can happen if the interview ended before completing any questions.'
      )
      setLoading(false)
      return
    }

    try {
      // Retry wrapper: retry up to 2 times on transient failures (network
      // errors, 5xx, non-JSON responses). Covers Claude API timeouts.
      let res: Response | null = null
      let lastError: Error | null = null
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          res = await fetch('/api/generate-feedback', {
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
          // Retry on 5xx server errors and 429 rate limit
          if ((res.status >= 500 || res.status === 429) && attempt < 2) {
            lastError = new Error(`Server error (status ${res.status})`)
            // Longer backoff for rate limiting (429) to let the window reset
            const delay = res.status === 429 ? 5000 * (attempt + 1) : 1500 * (attempt + 1)
            await new Promise(r => setTimeout(r, delay))
            continue
          }
          break
        } catch (e) {
          lastError = e instanceof Error ? e : new Error('Network error')
          if ((e as Error).name === 'AbortError') throw e
          if (attempt < 2) {
            await new Promise(r => setTimeout(r, 1500 * (attempt + 1)))
            continue
          }
        }
      }
      if (!res) throw lastError || new Error('Feedback request failed after retries')

      let fb
      try {
        fb = await res.json()
      } catch {
        throw new Error(`Feedback API returned non-JSON response (status ${res.status})`)
      }
      if (!res.ok) {
        throw new Error(fb.error || `Feedback generation failed (status ${res.status})`)
      }

      // G.6 Phase A follow-up: handle the idempotency-lock short-circuit.
      // When the server returns 202 {status: 'in_progress'} it means another
      // request is already generating feedback for this session. The
      // winner will persist to `session.feedback` — we poll for it rather
      // than applying the 50/50/50 defaults below (which would flash the
      // wrong number to the user until they refresh). Matches the
      // pattern used by the main poll loop at the top of loadData()
      // (page.tsx:421-450) — same endpoint, same success condition.
      if (res.status === 202 && fb?.status === 'in_progress' && sid && sid !== 'local') {
        const POLL_INTERVAL_MS = 2000
        const MAX_POLLS = 15 // up to 30s — covers typical Sonnet feedback latency
        let resolved = false
        for (let poll = 0; poll < MAX_POLLS; poll++) {
          if (signal?.aborted) return
          await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
          try {
            const pollRes = await fetch(
              `/api/interviews/${sid}?excludeTranscript=true`,
              { signal },
            )
            if (pollRes.ok) {
              const pollData = await pollRes.json()
              if (pollData.feedback) {
                fb = pollData.feedback
                resolved = true
                break
              }
            }
          } catch (e) {
            if ((e as Error).name === 'AbortError') return
            // continue polling — transient failure
          }
        }
        if (!resolved) {
          // 2026-04-22 — the poll loop assumes the lock-holder will
          // persist `session.feedback` (real or degraded fallback).
          // After the P0 follow-up that stops persisting the outer-catch
          // fallback (PR #313), a failing lock-holder leaves
          // `session.feedback` undefined, so the poll above always
          // exhausts its 30s budget when the primary request hit the
          // outer catch. Re-POST once: the lock-holder has long since
          // released (its `finally` block fires on error), so a fresh
          // POST either succeeds with real feedback OR hits the same
          // outer catch and returns the degraded payload directly in
          // the response — which is exactly what we need for the
          // banner + Retry UI that the single-tab flow already uses.
          //
          // If this retry also returns 202 (another concurrent attempt
          // grabbed the lock in the narrow window), fall through to the
          // original generic error rather than looping forever.
          try {
            const retryRes = await fetch('/api/generate-feedback', {
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
            if (retryRes.ok && retryRes.status !== 202) {
              fb = await retryRes.json()
              resolved = true
            }
          } catch (e) {
            if ((e as Error).name === 'AbortError') return
            // fall through to the original generic error below
          }
        }
        if (!resolved) {
          throw new Error(
            'Feedback generation is taking longer than expected — please refresh in a moment.',
          )
        }
      }

      // Apply client-side defaults if feedback is incomplete (truncated Claude response)
      // G.5: `== null` / `??` — a legit overall_score of 0 (no-answer session,
      // handled by the server's no-data early-exit) must not be stomped to 50.
      if (fb.overall_score == null) fb.overall_score = 50
      if (!fb.dimensions) {
        fb.dimensions = {
          answer_quality: { score: fb.overall_score ?? 50, strengths: [], weaknesses: [] },
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
      // Fresh generation: the route persists enrichmentStatus 'pending'
      // atomically with the feedback write (local sessions never enqueue).
      if (sessionId && sessionId !== 'local') setEnrichmentStatus('pending')

      // Persist feedback + ensure session is marked completed (recovers from stuck in_progress).
      //
      // 2026-04-22 — when `fb.degraded === true` the payload is the server's
      // outer-catch synthetic fallback (LLM threw). PR #313 stopped the
      // server from persisting that payload so it doesn't leak into the ~10
      // downstream readers that don't gate on `degraded` (dashboard
      // last-score, history badge, score-trend chart, recruiter scorecard,
      // pathway-planner LLM prompt, session-summary LLM prompt, GDPR
      // export, peer-comparison `$avg`, PDF, shareable-link). But the
      // feedback page itself PATCHes `feedback: fb` right here — which
      // re-introduces the leak via the client path. So: skip the `feedback`
      // field in the PATCH body (and the sessionStorage mirror) when the
      // payload is degraded. The `status` + `completedAt` writes stay so
      // the session isn't stranded in `in_progress` when a Claude error
      // hits (defense-in-depth against a dropped `useInterview` persist).
      if (sid && sid !== 'local') {
        const isDegradedFb = Boolean((fb as FeedbackData).degraded)
        const patchBody: Record<string, unknown> = {
          status: 'completed',
          completedAt: new Date().toISOString(),
        }
        if (!isDegradedFb) patchBody.feedback = fb
        const saved = await fetchWithRetry(`/api/interviews/${sid}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patchBody),
        })
        if (!saved) {
          setSaveWarning('Feedback generated but could not be saved. It may not appear in history.')
        }
        // Update sessionStorage cache so back-navigation doesn't re-generate.
        // Mirror the no-persist rule: do NOT write degraded payloads into
        // the cache either — back-navigation on a degraded session should
        // re-enter the generation path (either succeeds fresh or returns
        // degraded directly) rather than rehydrating a stale synthetic
        // score.
        try {
          const cacheKey = `${SESSION_CACHE_PREFIX}${sid}`
          const raw = sessionStorage.getItem(cacheKey)
          if (raw) {
            const cached = JSON.parse(raw)
            if (cached.data) {
              if (!isDegradedFb) {
                cached.data.session.feedback = fb
                if (cached.data.d) cached.data.d.feedback = fb
              }
              cached.data.session.status = 'completed'
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
      // Mirror the no-persist-on-degraded rule from generateFeedback's
      // tail: handleRetrySave can fire against a `feedback` state that was
      // set from a degraded response (user clicked Retry Save before
      // clicking Retry Feedback). Skip the feedback field in that case so
      // we don't re-introduce the leak the server-side no-persist change
      // was meant to eliminate.
      const isDegradedFb = Boolean((fb as FeedbackData).degraded)
      const patchBody: Record<string, unknown> = {
        status: 'completed',
        completedAt: new Date().toISOString(),
      }
      if (!isDegradedFb) patchBody.feedback = fb
      const saved = await fetchWithRetry(`/api/interviews/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patchBody),
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

  // Key moments — sourced from the FULL timeline (not the LLM-capped 3+3 in
  // fusionSummary.topMoments/improvementMoments). The fusion prompt artificially
  // caps to "best 3 + worst 3" but the underlying timeline carries 6–10 distinct
  // events; longer interviews surface 8+ moments. Filter to the types worth
  // showing as moment cards (strength, improvement, coaching_tip; observations
  // are too low-signal). Sort chronologically. Default severity falls back from
  // event.type when missing.
  const keyMoments = useMemo(() => {
    if (!analysis?.timeline || analysis.timeline.length === 0) return []
    const SHOWN_TYPES = new Set(['strength', 'improvement', 'coaching_tip'])
    return analysis.timeline
      .filter((e) => SHOWN_TYPES.has(e.type))
      .map((e) => {
        if (e.severity) return e
        const fallback: 'positive' | 'attention' | 'neutral' =
          e.type === 'strength' ? 'positive'
          : e.type === 'improvement' ? 'attention'
          : 'neutral'
        return { ...e, severity: fallback }
      })
      .sort((a, b) => a.startSec - b.startSec)
  }, [analysis])

  // Compute active warning from timeline events at current playback position
  const activeWarning = useMemo(() => {
    if (!analysis?.timeline) return null
    const current = analysis.timeline.find(
      (e) => analysisVideoTime >= e.startSec && analysisVideoTime <= e.endSec &&
        (e.type === 'improvement' || e.type === 'coaching_tip')
    )
    if (!current) return null
    return {
      label: current.title,
      type: (current.severity === 'attention' ? 'attention' : 'neutral') as 'attention' | 'neutral',
    }
  }, [analysis, analysisVideoTime])

  // Auto-scroll to active transcript entry (used by the Multimodal tab's
  // video-less fallback when audio is playing)
  useEffect(() => {
    if (activeEntryRef.current && activeTab === 'analysis' && !videoSrc) {
      activeEntryRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [activeTranscriptIndex, activeTab, videoSrc])

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

  // ── Cross-tab navigation handlers (must precede early returns per Rules of Hooks)
  // Q-chip click behavior is contextual to which tab the chip lives on:
  //   - From Multimodal tab: seek the video to that question's start
  //   - From Feedback / Learning tab: switch to Scores and expand the matching row
  const handleQuestionRefFromMultimodal = useCallback((qIdx: number) => {
    const marker = questionMarkers[qIdx]
    if (marker && analysisSeekRef.current) {
      analysisSeekRef.current(marker.offsetSeconds)
    }
  }, [questionMarkers])

  const handleQuestionRefToScoresTab = useCallback((qIdx: number) => {
    setActiveTab('questions')
    requestAnimationFrame(() => {
      // ScoresTab uses data-question-idx={i} on QuestionBreakdown rows.
      const row = document.querySelector(`[data-question-idx="${qIdx}"]`) as HTMLElement | null
      if (row) {
        row.scrollIntoView({ behavior: 'smooth', block: 'start' })
        // The first child button is the accordion toggle — click to expand if collapsed.
        const toggle = row.querySelector('button')
        if (toggle && toggle.getAttribute('aria-expanded') !== 'true') {
          toggle.click()
        }
      }
    })
  }, [])

  // Practice-this handler: from a Multimodal Tip card → switch to Learning,
  // scroll to drill-N. drillRowId="drill-${i}" set by LearningTab.
  const handlePracticeClick = useCallback((drillIdx: number) => {
    setActiveTab('learning')
    requestAnimationFrame(() => {
      const el = document.getElementById(`drill-${drillIdx}`)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }, [])

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

  // Tab order: Scores → Multimodal Analysis → Feedback → Learning.
  // Maps the user's emotional arc: outcome → evidence → synthesis → action.
  // Learning closes the experience (peak-end rule still satisfied — closing
  // on a constructive action surface, not on narrative).
  // Learning tab only shows when there's actual L&D content to render.
  const hasLearningContent =
    (feedback.drill_recommendations?.length ?? 0) > 0 ||
    (feedback.ideal_answers?.length ?? 0) > 0
  const TABS: { key: FeedbackTab; label: string }[] = [
    { key: 'questions', label: 'Scores' },
    ...(hasAnalysisSource || analysis ? [{ key: 'analysis' as const, label: 'Multimodal Analysis' }] : []),
    { key: 'overview', label: 'Feedback' },
    ...(hasLearningContent || enrichmentPhase === 'generating'
      ? [{ key: 'learning' as const, label: 'Learning' }]
      : []),
  ]

  const maxQuestionIndex =
    Math.max(0, (data.evaluations?.length || data.transcript?.length || 1) - 1)

  const pathwayOutcome = feedback.sideEffectOutcomes?.find((outcome) => outcome.name === 'pathwayPlan')
  const canTrackPathwayUpdate = sessionId !== 'local'
  const pathwayHref = canTrackPathwayUpdate
    ? `/learn/pathway?fromFeedback=${encodeURIComponent(sessionId)}`
    : '/learn/pathway'
  const pathwayCtaLabel =
    pathwayOutcome?.status === 'skipped'
      ? 'View current pathway'
      : pathwayOutcome?.status === 'scheduled'
        ? 'View pending pathway'
        : 'View pathway'
  const pathwayCtaDescription =
    pathwayOutcome?.status === 'skipped'
      ? 'Retake this mock to see your improvement, or continue from your current pathway.'
      : pathwayOutcome?.status === 'scheduled'
        ? 'Retake this mock to see your improvement, or open Pathway while the update catches up.'
        : 'Retake this mock to see your improvement, or head to your pathway.'

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
            {/* PDF download: builds a self-contained print HTML from the
                feedback data we already have and hands it to the browser's
                Print-to-PDF. No server round-trip, no new API route. */}
            <button
              onClick={() => {
                const html = buildFeedbackPrintHtml({
                  feedback,
                  data,
                  domainLabel: getDomainLabel(data.config.role),
                })
                const w = window.open('', '_blank')
                if (!w) {
                  alert('Pop-up blocked. Please allow pop-ups to download the PDF.')
                  return
                }
                w.document.write(html)
                w.document.close()
              }}
              className="p-2 rounded-lg hover:bg-[#f8fafc] transition text-[#536471] hover:text-[#0f1419]"
              aria-label="Download report as PDF"
              title="Download report (PDF)"
            >
              <svg className="w-4.5 h-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </button>
            <ShareButton sessionId={sessionId} />
          </div>
        </div>
      </header>

      {/* Jobs surfaces live BELOW the header: it is fixed at h-[52px] and
          cannot host variable-height content (Codex #527). Both children
          render null in the common case — the row collapses to nothing. */}
      <div className="max-w-5xl mx-auto px-4 flex flex-wrap items-center gap-x-4">
        <JobsBridge sessionId={sessionId} />
        {data?.config?.role && <JobsCountLink domain={data.config.role} variant="feedback" />}
      </div>

      {showPathwayPendingBanner && (
        <div className="max-w-5xl mx-auto px-4 mt-4">
          <PathwayPendingBanner
            action={{
              id: 'pending-feedback-inline',
              type: 'review',
              title: 'Your pathway update is in progress',
              description:
                'Your feedback is ready. We are updating your learning pathway in the background — your current plan stays visible until the update lands.',
              ctaLabel: 'View pathway',
              href: `/learn/pathway?fromFeedback=${encodeURIComponent(sessionId)}`,
              metadata: { sessionId, fromFeedback: sessionId },
            }}
            pollExhausted={pathwayPollExhausted}
            onRetried={handlePathwayPollRetried}
          />
        </div>
      )}

      {/* Pathway retry banner (?retryPathway=1 from the pathway empty-state CTA) */}
      {pathwayRetryStatus && (
        <div className="max-w-5xl mx-auto px-4 mt-4">
          {pathwayRetryStatus.kind === 'pending' && (
            <div className="bg-brand-500/10 border border-brand-500/30 rounded-[var(--radius-md)] px-5 py-3 text-sm text-brand-700 flex items-center gap-2">
              <div className="w-4 h-4 rounded-full border-2 border-brand-500 border-t-transparent animate-spin shrink-0" />
              <span>Restarting pathway generation…</span>
            </div>
          )}
          {pathwayRetryStatus.kind === 'success' && (
            <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-[var(--radius-md)] px-5 py-3 text-sm text-emerald-700 flex items-center justify-between gap-2">
              <span>Pathway regeneration started. Check the Learning section in a minute.</span>
              <button
                onClick={() => router.push('/learn/pathway')}
                className="shrink-0 px-3 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded-md text-xs font-medium transition"
              >
                Open pathway
              </button>
            </div>
          )}
          {pathwayRetryStatus.kind === 'error' && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-[var(--radius-md)] px-5 py-3 text-sm text-amber-700 flex items-center gap-2">
              <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span>Couldn’t restart pathway generation: {pathwayRetryStatus.message}</span>
            </div>
          )}
        </div>
      )}

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

      {/* Degraded-mode banner — feedback was produced by the server's
          outer-catch fallback (LLM error / timeout / schema failure)
          instead of a real Claude run. The numeric values still render
          below (so the layout doesn't change and analytics paths keep
          working) but we warn the candidate that the score is
          approximate and offer a direct retry. See the
          `FeedbackData.degraded` JSDoc in shared/types.ts. P0 fix
          2026-04-22. */}
      {feedback.degraded && (
        <div className="max-w-5xl mx-auto px-4 mt-4">
          <div
            role="alert"
            aria-live="polite"
            className="bg-amber-500/10 border border-amber-500/30 rounded-[var(--radius-md)] px-5 py-3 text-sm text-amber-600 flex items-start sm:items-center justify-between gap-3 flex-col sm:flex-row"
          >
            <div className="flex items-start sm:items-center gap-2">
              <svg className="w-4 h-4 shrink-0 mt-0.5 sm:mt-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span>
                We couldn&apos;t fully generate your feedback this time. The scores below
                are approximate — please retry for a proper analysis.
              </span>
            </div>
            <button
              onClick={handleRetry}
              className="shrink-0 px-3 py-1 bg-amber-500 hover:bg-amber-600 text-white rounded-md text-xs font-medium transition"
            >
              Retry feedback
            </button>
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
              {/* Inline "approximate" pill shown in addition to the top-level
                  degraded banner — keeps the signal attached to the score
                  itself for users who scroll past the banner. */}
              {feedback.degraded && (
                <div className="px-3 py-1 rounded-full border border-amber-500/30 bg-amber-500/10 text-amber-600 text-sm font-medium">
                  Approximate — feedback retry recommended
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Audio Player — below hero, above tabs. Hidden when the Multimodal
            tab is active AND a video is playing (VideoPlayer replaces it).
            Still shown on Multimodal when there's no video, since the
            video-less fallback renders the plain TranscriptTab + audio. */}
        {/* Guard on EITHER source (Codex P2 #555): audio-only sessions — the
            small audio object landed while the camera multipart is still in
            flight, the camera upload dropped, or the video was retention-
            deleted after 30 days with audio preserved — must still get their
            audio replay. recordingUrl alone would hide it. */}
        {(audioUrl ?? recordingUrl) && !(activeTab === 'analysis' && videoSrc) && (
          <AudioPlayer
            src={(audioUrl ?? recordingUrl) as string}
            questionMarkers={questionMarkers}
            onTimeUpdate={setCurrentAudioTime}
            onSeek={handleSeekExpose}
            knownDurationSeconds={recordingDurationSeconds}
            onRequestFreshUrl={hasRecording || audioUrl ? () => refreshReplayUrl(audioUrl ? 'audio' : 'camera') : undefined}
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

        <div id="tab-content">

        {/* Scores tab — verdict-first surface (default landing) */}
        {activeTab === 'questions' && <ScoresTab data={data} overallScore={overall_score} />}

        {/* Multimodal Analysis tab — evidence surface (sticky video + scrolling stream) */}
        {activeTab === 'analysis' && (
          <MultimodalAnalysisTab
            data={data}
            analysis={analysis}
            analysisLoading={analysisLoading}
            analysisError={analysisError}
            analysisProgress={analysisProgress}
            hasAnalysisSource={hasAnalysisSource}
            videoSrc={videoSrc}
            recordingUrl={recordingUrl}
            recordingDurationSeconds={recordingDurationSeconds}
            recordingFallback={recordingFallback}
            onRequestFreshVideoUrl={hasRecording ? () => refreshReplayUrl('camera') : undefined}
            sessionStartedAt={sessionStartedAt}
            questionMarkers={questionMarkers}
            keyMoments={keyMoments}
            activeWarning={activeWarning}
            analysisVideoTime={analysisVideoTime}
            setAnalysisVideoTime={setAnalysisVideoTime}
            onSeekRef={(fn) => { analysisSeekRef.current = fn }}
            replayFullscreen={replayFullscreen}
            setReplayFullscreen={setReplayFullscreen}
            onRetry={() => {
              analysisTriggeredRef.current = false
              fetchAnalysis()
            }}
            activeTranscriptIndex={activeTranscriptIndex}
            activeEntryRef={activeEntryRef}
            seekToAudio={seekToRef.current}
            drillRecommendations={feedback.drill_recommendations}
            onQuestionClick={handleQuestionRefFromMultimodal}
            maxQuestionIndex={maxQuestionIndex}
            onPracticeClick={handlePracticeClick}
          />
        )}

        {/* Feedback tab — synthesis surface (no longer the closing tab; Learning closes when present) */}
        {activeTab === 'overview' && (
          <OverviewTab
            data={data}
            feedback={feedback}
            sessionId={sessionId}
            peerData={peerData}
            peerLoading={peerLoading}
            currentScore={overall_score}
            currentScores={data.evaluations.length > 0 ? (() => {
              // Mirror the server (`evaluationEngine.evaluateSession`) and
              // OverviewTab evalData filters: exclude status='failed' rows
              // (50/50/50/50 client-fallback from useInterviewAPI) so the
              // ComparisonCard doesn't see inflated/skewed dimension scores
              // that the rest of the feedback page already filters out.
              const evals = data.evaluations.filter(
                (e) => (e as unknown as { status?: string }).status !== 'failed'
              )
              if (evals.length === 0) return undefined
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
            parentSessionId={parentSessionId || undefined}
            onQuestionClick={handleQuestionRefToScoresTab}
            maxQuestionIndex={maxQuestionIndex}
            // Round 5a feature #2 — Claude's narrative arc + per-Q sparkline.
            // Both are no-ops when multimodal analysis hasn't run; the
            // ConfidenceArcCard itself renders null in that case.
            confidenceProgression={analysis?.fusionSummary?.confidenceProgression}
            perQuestionConfidence={
              analysis?.prosodySegments
                ?.map((s) => s.confidenceMarker)
                .filter((m): m is 'high' | 'medium' | 'low' =>
                  m === 'high' || m === 'medium' || m === 'low'
                )
            }
          />
        )}

        {/* Learning tab — closing/action surface (drill traceability, ideal-answer comparison) */}
        {activeTab === 'learning' && (hasLearningContent ? (
          <LearningTab
            feedback={feedback}
            data={data}
            sessionId={sessionId}
            onQuestionClick={handleQuestionRefToScoresTab}
            maxQuestionIndex={maxQuestionIndex}
          />
        ) : (
          <section className="surface-card-bordered p-6 animate-fade-in" data-testid="enrichment-generating">
            <p className="text-subheading text-[#0f1419] animate-pulse">
              Preparing your ideal answers and practice drills…
            </p>
            <p className="text-body text-[#71767b] mt-1">
              We study each answer that needs work and write a strong-answer
              outline for it. This usually lands within a couple of minutes —
              you can explore your scores meanwhile; this tab updates itself.
            </p>
          </section>
        ))}

        </div>{/* close #tab-content */}

        {/* CTA — habit-loop strip */}
        <section className="surface-card-bordered p-5 sm:p-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 animate-fade-in">
          <div>
            <p className="text-subheading text-[#0f1419]">Keep the momentum going</p>
            <p className="text-body text-[#71767b]">{pathwayCtaDescription}</p>
          </div>
          <div className="flex gap-3 flex-wrap shrink-0 w-full sm:w-auto">
            <button
              type="button"
              disabled={retakeLoading || sessionId === 'local'}
              onClick={async () => {
                if (!sessionId || sessionId === 'local') return
                setRetakeLoading(true)
                try {
                  const res = await fetch(`/api/interviews/${sessionId}/retake`, { method: 'POST' })
                  if (!res.ok) {
                    setRetakeLoading(false)
                    return
                  }
                  const retakePayload = await res.json() as RetakeRouteResponse
                  const plan = planRetakeNavigation(retakePayload, sessionId)
                  if (plan.kind === 'jobs-practice') {
                    // The original signed token was consumed. Return through
                    // the job page so a fresh canonical handoff is minted;
                    // never copy the parent session's stale Jobs config.
                    try {
                      localStorage.removeItem(STORAGE_KEYS.INTERVIEW_CONFIG)
                      localStorage.removeItem(STORAGE_KEYS.INTERVIEW_ACTIVE_SESSION)
                      localStorage.removeItem(STORAGE_KEYS.PENDING_RETAKE_PARENT)
                    } catch { /* storage unavailable — URL intent still works */ }
                    router.push(plan.href)
                    return
                  }
                  // Reconstruct the parent's setup shape from its compact
                  // config plus top-level JD/resume fields before applying
                  // the Jobs-origin scrub.
                  try {
                    // This removes the old key first for Jobs-origin fallback,
                    // even when a malformed cached payload has no replacement
                    // config. No prior Jobs token/JD can survive into setup.
                    persistGenericRetakeConfig(
                      localStorage,
                      STORAGE_KEYS.INTERVIEW_CONFIG,
                      retakeSetupConfig ?? retakePayload.config,
                      retakePayload.jobsOrigin === true,
                    )
                    if (plan.kind === 'retake') {
                      localStorage.setItem(STORAGE_KEYS.PENDING_RETAKE_PARENT, plan.parentSessionId)
                    } else {
                      // Without the verified exact-JD benchmark this is a new
                      // general practice, not a comparable retake.
                      localStorage.removeItem(STORAGE_KEYS.PENDING_RETAKE_PARENT)
                    }
                    localStorage.removeItem(STORAGE_KEYS.INTERVIEW_ACTIVE_SESSION)
                  } catch { /* ignore */ }
                  router.push(plan.href)
                } catch {
                  setRetakeLoading(false)
                }
              }}
              className="px-5 py-2.5 bg-brand-500 hover:bg-brand-600 disabled:bg-brand-500/60 text-white rounded-[var(--radius-md)] font-semibold btn-glow transition text-sm"
            >
              {retakeLoading ? 'Preparing…' : 'Retake this interview'}
            </button>
            <button
              type="button"
              onClick={() => router.push(pathwayHref)}
              className="px-5 py-2.5 bg-white hover:bg-blue-50 border border-blue-500/40 text-blue-600 rounded-[var(--radius-md)] font-semibold transition text-sm"
            >
              {pathwayCtaLabel}
            </button>
            <button
              type="button"
              onClick={() => {
                localStorage.removeItem('interviewConfig')
                localStorage.removeItem('interviewActiveSession')
                router.push('/interview/setup')
              }}
              className="px-5 py-2.5 bg-[#f8fafc] hover:bg-[#eff3f4] border border-[#e1e8ed] text-[#536471] rounded-[var(--radius-md)] font-medium transition text-sm"
            >
              New interview
            </button>
            {(hasAnalysisSource || analysis) && (
              <button
                type="button"
                onClick={() => handleTabChange('analysis')}
                className="px-5 py-2.5 text-[#536471] hover:text-[#0f1419] text-sm font-medium transition"
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
