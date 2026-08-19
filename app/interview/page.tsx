'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import Avatar from '@interview/components/Avatar'
import VideoTile from '@interview/components/VideoTile'
import TranscriptPanel from '@interview/components/interview/TranscriptPanel'
import InterviewControls from '@interview/components/interview/InterviewControls'
import RecordingIndicator from '@interview/components/RecordingIndicator'
import CoachingNudge from '@interview/components/interview/CoachingNudge'
import CoachingTip from '@interview/components/interview/CoachingTip'
import { useSpeechRecognitionAdapter as useSpeechRecognition } from '@interview/hooks/useSpeechRecognitionAdapter'
import { useInterview } from '@interview/hooks/useInterview'
import { useInterviewLifecycleEvents } from '@interview/hooks/useInterviewLifecycleEvents'
import { useMediaRecorder } from '@interview/hooks/useMediaRecorder'
import { useCoachingNudge } from '@interview/hooks/useCoachingNudge'
import { useFacialLandmarks } from '@interview/hooks/useFacialLandmarks'
import { useHireMultimodalAnalysisCapture } from '@interview/hooks/useHireMultimodalAnalysisCapture'
import { useRealtimeFacialCoaching } from '@interview/hooks/useRealtimeFacialCoaching'
import { useRealtimeProsody } from '@interview/hooks/useRealtimeProsody'
import {
  setMicStream as setVoiceMixerMic,
  getMixedAudioStream,
  resetVoiceMixer,
} from '@interview/audio/voiceMixer'
import {
  setRecordingStartedAt,
  resetRecordingClock,
} from '@interview/audio/recordingClock'
import { useCoachMode } from '@interview/hooks/useCoachMode'
import {
  isHireRuntimeInterview,
  isHireRuntimeMultimodalObservationsEnabled,
} from '@interview/config/hireRuntimeMode'
import CoachOverlay from '@interview/components/interview/CoachOverlay'
import CodingLayout from '@interview/components/interview/CodingLayout'
import DesignLayout from '@interview/components/interview/DesignLayout'
import { selectProblem, selectLeastRecentlyServed, resolveCodingTimeBudget, resolveCodingDifficulty, type CodingProblem } from '@interview/config/codingProblems'
import { selectDesignProblem, selectLeastRecentlyServedDesign, type DesignProblem } from '@interview/config/designProblems'
import type { InterviewConfig, DesignSubmission } from '@shared/types'
import { AVATAR_NAME, getAvatarTitle } from '@interview/config/interviewConfig'
import { STORAGE_KEYS } from '@shared/storageKeys'
import {
  captureReplayUploadIntent,
  drainQueuedReplayUploads,
  uploadReplayRecording,
  type ReplayUploadResult,
} from '@interview/utils/resumableUpload'
import {
  requestAccountBoundJson,
  uploadRecordingArtifact,
} from '@interview/utils/accountBoundArtifactUpload'
import { deliverHireMultimodalAnalysisCapture } from '@interview/utils/hireMultimodalAnalysisCaptureUpload'

import { formatTime } from '@shared/utils'

// ─── Phase label map ──────────────────────────────────────────────────────────

const PHASE_LABELS: Record<string, string> = {
  INIT: 'Initializing',
  LOBBY: 'Lobby',
  CALIBRATION: 'Calibrating',
  INTERVIEW_START: 'Starting',
  ASK_QUESTION: 'Question',
  LISTENING: 'Listening',
  CODE_EDITING: 'Coding',
  DESIGN_CANVAS: 'Designing',
  PROCESSING: 'Processing',
  COACHING: 'Coaching',
  FOLLOW_UP: 'Follow-up',
  WRAP_UP: 'Wrapping up',
  SCORING: 'Scoring',
  FEEDBACK: 'Feedback',
  ENDED: 'Ended',
}

const PHASE_COLORS: Record<string, { text: string; bg: string; border: string; dot: string }> = {
  LISTENING: { text: 'text-emerald-600', bg: 'bg-emerald-500/10', border: 'border-emerald-500/25', dot: 'bg-emerald-600' },
  PROCESSING: { text: 'text-amber-600', bg: 'bg-amber-500/10', border: 'border-amber-500/25', dot: 'bg-amber-600' },
  COACHING: { text: 'text-violet-600', bg: 'bg-violet-500/10', border: 'border-violet-500/25', dot: 'bg-violet-600' },
  ASK_QUESTION: { text: 'text-[#2563eb]', bg: 'bg-blue-500/10', border: 'border-blue-500/25', dot: 'bg-[#2563eb]' },
  FOLLOW_UP: { text: 'text-purple-600', bg: 'bg-purple-500/10', border: 'border-purple-500/25', dot: 'bg-purple-600' },
  WRAP_UP: { text: 'text-orange-600', bg: 'bg-orange-500/10', border: 'border-orange-500/25', dot: 'bg-orange-600' },
  SCORING: { text: 'text-cyan-600', bg: 'bg-cyan-500/10', border: 'border-cyan-500/25', dot: 'bg-cyan-600' },
  CODE_EDITING: { text: 'text-blue-600', bg: 'bg-blue-500/10', border: 'border-blue-500/25', dot: 'bg-blue-600' },
  DESIGN_CANVAS: { text: 'text-teal-600', bg: 'bg-teal-500/10', border: 'border-teal-500/25', dot: 'bg-teal-600' },
}

const DEFAULT_PHASE_COLOR = { text: 'text-[#71767b]', bg: 'bg-[#f8fafc]', border: 'border-[#e1e8ed]', dot: 'bg-[#71767b]' }

// ─── Component ────────────────────────────────────────────────────────────────

export default function InterviewPage() {
  const router = useRouter()
  const { data: authSession, status: authStatus } = useSession()

  // ── Config ──
  const [config, setConfig] = useState<InterviewConfig | null>(null)
  const [jobsHandoffToken, setJobsHandoffToken] = useState<string | undefined>()
  const [codingLanguage, setCodingLanguage] = useState<import('@shared/types').CodeLanguage>('python')
  const [currentProblem, setCurrentProblem] = useState<CodingProblem | null>(null)
  const [currentDesignProblem, setCurrentDesignProblem] = useState<DesignProblem | null>(null)
  const isCodingMode = config?.interviewType === 'coding'
  const isDesignMode = config?.interviewType === 'system-design'
  const isHireInterview = isHireRuntimeInterview(config)

  // ── Camera ──
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)

  const cameraVideoConstraints: MediaTrackConstraints = {
    width: { ideal: 1280, max: 1280 },
    height: { ideal: 720, max: 720 },
    frameRate: { ideal: 24, max: 24 },
  }

  const cameraRecorderOptions: MediaRecorderOptions = {
    videoBitsPerSecond: 700_000,
    audioBitsPerSecond: 64_000,
  }

  const audioRecorderOptions: MediaRecorderOptions = {
    audioBitsPerSecond: 64_000,
  }

  // ── Voices loaded ──
  const [voicesReady, setVoicesReady] = useState(false)

  // ── Speech recognition ──
  const { isListening, liveTranscript, finalTranscript, interimTranscript, startListening, stopListening, warmUp, setExternalStream, setOnInterrupt, setSuppressInterrupt, getAndClearInterruptAccum } = useSpeechRecognition()

  // ── Recording (camera track) ──
  const { isRecording, recordingDuration, startRecording, stopRecording, getDurationSeconds } = useMediaRecorder()
  // ── Recording (audio-only track — what Whisper transcribes). Kept
  //    separate from the camera webm because Groq Whisper rejects files
  //    >25MB and a multi-minute HD camera recording easily exceeds that.
  const audioRecorder = useMediaRecorder()

  useEffect(() => {
    if (!authSession?.user?.id) return
    void drainQueuedReplayUploads().catch((err) =>
      console.warn('Failed to drain queued replay uploads', err)
    )
  }, [authSession?.user?.id])

  // ── Facial landmarks (multimodal analysis) ──
  const isMultimodalEnabled = process.env.NEXT_PUBLIC_FEATURE_MULTIMODAL === 'true'
  const isB2cMultimodalEnabled = isMultimodalEnabled && !isHireInterview
  const isHireNativeMultimodalEnabled =
    isHireRuntimeMultimodalObservationsEnabled(config)
  const {
    startCapture: startB2cFacialCapture,
    stopCapture: stopB2cFacialCapture,
    framesRef,
  } = useFacialLandmarks()
  const {
    startCapture: startHireMultimodalAnalysisCapture,
    stopCapture: stopHireMultimodalAnalysisCapture,
  } = useHireMultimodalAnalysisCapture()

  // Handle recording stop
  const handleRecordingStop = useCallback(async () => {
    // Capture before recorder shutdown: Blob materialization is asynchronous,
    // so account cleanup during stopRecording must invalidate the later upload.
    const originUserId = authSession?.user?.id
    const replayUploadIntent = captureReplayUploadIntent(originUserId)

    // Stop the camera + audio recorders in parallel (audio runs for every
    // interview; camera unless privacy mode).
    const [cameraBlob, audioBlob] = await Promise.all([
      stopRecording(),
      audioRecorder.stopRecording(),
    ])

    // Recorder-truth span (camera and audio recorders start back-to-back, so
    // either recorder's clock serves both files). Persisted so replay players
    // can size their scrubbers without the EOF duration probe, which used to
    // cost a full file download per player mount. Rounded to 0.1s; values <1s
    // are noise (recorder never really started) and the schema floor is 1.
    const rawDurationSeconds =
      getDurationSeconds() ?? audioRecorder.getDurationSeconds()
    const recordingDurationSeconds =
      rawDurationSeconds !== null && rawDurationSeconds >= 1
        ? Math.round(rawDurationSeconds * 10) / 10
        : null

    const criticalUploads: Promise<unknown>[] = []

    // Consumer interviews keep their existing landmark artifact path. Hire
    // captures a separate, full landmark stream for its control-owned review
    // analysis; neither path starts live coaching for a Hire assessment.
    if (isB2cMultimodalEnabled) {
      const frames = stopB2cFacialCapture()
      const sessionId = interviewRef.current?.sessionId
      if (frames.length > 0 && sessionId && originUserId) {
        criticalUploads.push(
          requestAccountBoundJson(
            '/api/recordings/landmarks',
            { sessionId, frames },
            replayUploadIntent,
            originUserId,
          ).then((res) => {
            if (res && !res.ok) throw new Error(`Landmarks upload failed: ${res.status}`)
          }),
        )
      }
    } else if (isHireNativeMultimodalEnabled) {
      const frames = stopHireMultimodalAnalysisCapture()
      const sessionId = interviewRef.current?.sessionId
      if (sessionId && originUserId) {
        criticalUploads.push(
          deliverHireMultimodalAnalysisCapture({
            sessionId,
            frames,
            intent: replayUploadIntent,
            originUserId,
          }),
        )
      }
    }

    const sessionId = interviewRef.current?.sessionId
    if (!sessionId || !originUserId) return

    // Consumer privacy mode opts out of video storage. A Hire assessment's
    // current consent contract is recorded interview review, so its camera
    // artifact must not be suppressed by a stale/direct room privacy flag.
    // This narrow exception preserves B2C privacy-mode behavior unchanged.
    const privacyMode = !isHireInterview && config?.privacyMode === true

    // Persist the duration up front, independent of which uploads succeed —
    // privacy-mode sessions (audio-only) and dropped camera uploads still get
    // a scrubber-accurate value. Fire-and-forget: the multipart 'complete'
    // handler re-persists it server-side as the fallback for queued drains.
    if (recordingDurationSeconds !== null) {
      void requestAccountBoundJson(
        `/api/interviews/${sessionId}`,
        { recordingDurationSeconds },
        replayUploadIntent,
        originUserId,
        { method: 'PATCH', keepalive: true },
      ).catch(() => {})
    }

    // Upload audio/landmarks as small analysis artifacts. The camera
    // recording is replay-only and must not block feedback or analysis.
    const replayUploads: Promise<ReplayUploadResult>[] = []
    if (cameraBlob && !privacyMode) {
      replayUploads.push(
        uploadReplayRecording(
          sessionId,
          'camera',
          cameraBlob,
          recordingDurationSeconds ?? undefined,
          replayUploadIntent,
        )
      )
    }
    if (audioBlob) {
      criticalUploads.push(
        uploadRecordingArtifact(
          audioBlob,
          sessionId,
          'audio',
          replayUploadIntent,
          originUserId,
        ),
      )
    }

    if (replayUploads.length > 0) {
      Promise.allSettled(replayUploads).then((results) => {
        const rejected = results.filter((r) => r.status === 'rejected').length
        const fulfilled = results.filter((r): r is PromiseFulfilledResult<ReplayUploadResult> => r.status === 'fulfilled')
        const queued = fulfilled.filter((r) => r.value.status === 'queued').length
        const dropped = fulfilled.filter((r) => r.value.status === 'dropped').length
        const uploaded = fulfilled.filter((r) => r.value.status === 'uploaded').length

        if (queued > 0) {
          console.info('Replay recording upload queued for retry', { queued, uploaded, total: results.length })
        }
        if (dropped + rejected > 0) {
          console.warn('Replay recording upload completed with unrecoverable failures', {
            dropped,
            rejected,
            uploaded,
            queued,
            total: results.length,
          })
        }
      })
    }

    if (criticalUploads.length > 0) {
      await Promise.race([
        Promise.allSettled(criticalUploads),
        new Promise<void>((resolve) => setTimeout(resolve, 8_000)),
      ])
    }
  }, [
    stopRecording,
    audioRecorder,
    getDurationSeconds,
    isB2cMultimodalEnabled,
    isHireNativeMultimodalEnabled,
    stopB2cFacialCapture,
    stopHireMultimodalAnalysisCapture,
    isHireInterview,
    config?.privacyMode,
    authSession?.user?.id,
  ])

  // Feedback #1: live coaching is chosen in the lobby and frozen for the session
  // (no in-room toggle). The lobby passes the choice via the room URL (?lc=0 when
  // off) — a storage-independent channel, so it can't be lost to a failed
  // localStorage write. Read it client-side (effect → state) to stay SSR-safe;
  // default on (absent param / non-lobby entry).
  const [urlCoachingOff, setUrlCoachingOff] = useState(false)
  useEffect(() => {
    try {
      setUrlCoachingOff(new URLSearchParams(window.location.search).get('lc') === '0')
    } catch { /* URL unavailable — default on */ }
  }, [])
  const liveCoachingEnabled = !isHireInterview && !urlCoachingOff

  // ── Interview engine ──
  const interview = useInterview({
    config,
    jobsHandoffToken,
    voicesReady,
    startListening,
    stopListening,
    // Forward the live transcript so the inactivity safety-net timer can
    // correctly detect whether speech is growing during the turn. Without
    // this, the timer's growth-check always failed and fired at the 30s
    // mark regardless of active speech (PR #293 production logs).
    liveTranscript,
    warmUpListening: warmUp,
    setOnInterrupt,
    setSuppressInterrupt,
    getAndClearInterruptAccum,
    onRecordingStop: handleRecordingStop,
    currentProblem,
    currentDesignProblem,
    liveCoachingEnabled,
  })

  const interviewRef = useRef(interview)
  interviewRef.current = interview

  const {
    phase,
    questionIndex,
    mainQuestionNumber,
    questionDisplay,
    currentQuestion,
    avatarEmotion,
    isAvatarTalking,
    timeRemaining,
    answerSecondsLeft,
    liveAnswer,
    coachingTip,
    finishInterview,
    // Destructured so the useCallback deps at ~L286/L291 can reference
    // stable function identities directly, instead of
    // `interview.onCodeSubmit` which the exhaustive-deps rule rightly
    // flags as a property access on a changing object.
    onCodeSubmit: interviewOnCodeSubmit,
    onDesignSubmit: interviewOnDesignSubmit,
  } = interview

  // Merged live text (interim+final) — used by the coding/design layouts as before.
  const displayAnswer = isListening ? liveTranscript : liveAnswer
  // Split views for the main TranscriptPanel so it renders finalized text solid and the live
  // interim tail dimmed. While listening: finalized vs interim from the STT hook. When not
  // listening (PROCESSING etc.): the committed answer is all "final", no interim tail.
  const displayAnswerFinal = isListening ? finalTranscript : liveAnswer
  const displayAnswerInterim = isListening ? interimTranscript : ''
  const phaseColor = PHASE_COLORS[phase] ?? DEFAULT_PHASE_COLOR
  const isProcessing = phase === 'PROCESSING'

  // ── Lifecycle analytics ──
  // Observes useInterview's exposed phase + sessionId from the outside
  // so useInterview.ts (HOT PATH) stays untouched. See the hook's
  // header for single-fire semantics.
  const { markAbandoned } = useInterviewLifecycleEvents({
    phase,
    sessionId: interview.sessionId,
    config,
    questionIndex,
    mainQuestionNumber,
    timeRemaining,
  })

  // ── Live coaching nudges ──
  const isCoachMode = !isHireInterview && (config?.coachMode ?? false)
  const speechNudge = useCoachingNudge({ phase, liveTranscript, pollIntervalMs: isCoachMode ? 2000 : undefined })
  const facialNudge = useRealtimeFacialCoaching({
    phase,
    framesRef,
    enabled: isMultimodalEnabled && !isHireInterview,
  })
  const prosodyNudge = useRealtimeProsody({
    phase,
    liveTranscript,
    enabled: isMultimodalEnabled && !isHireInterview,
  })
  // Priority: prosody > speech-content > visual. Gated by the master switch —
  // when coaching is off, the hooks still run (cheap) but nothing reaches the
  // screen. This never affects the post-interview score (display-only).
  const coachModeState = useCoachMode({ phase, liveTranscript, enabled: isCoachMode })
  const activeNudge = liveCoachingEnabled ? (prosodyNudge || speechNudge || facialNudge) : null
  // STAR coach overlay also obeys the master switch ("silence everything").
  const showCoachOverlay = liveCoachingEnabled && isCoachMode

  // ─── Code submission handler (coding mode) ─────────────────────────────────
  // Signals the useInterview hook to proceed from CODE_EDITING → PROCESSING
  const handleCodeSubmit = useCallback((code: string) => {
    interviewOnCodeSubmit(code, codingLanguage)
  }, [interviewOnCodeSubmit, codingLanguage])

  // ─── Design submission handler (system design mode) ────────────────────────
  const handleDesignSubmit = useCallback((data: DesignSubmission) => {
    interviewOnDesignSubmit(data)
  }, [interviewOnDesignSubmit])

  // ─── Prevent accidental navigation away during active interview ────────────
  useEffect(() => {
    const isActive = phase !== 'INIT' && phase !== 'ENDED' && phase !== 'SCORING' && phase !== 'FEEDBACK'
    if (!isActive) return

    // Warn on tab close / refresh
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }

    // Push a dummy history entry so back button doesn't leave the page
    window.history.pushState(null, '', window.location.href)
    const handlePopState = () => {
      // Push again to stay on the page
      window.history.pushState(null, '', window.location.href)
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    window.addEventListener('popstate', handlePopState)

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
      window.removeEventListener('popstate', handlePopState)
    }
  }, [phase])

  // ─── Load config (with session guard) ──────────────────────────────────────
  useEffect(() => {
    // Wait for auth to resolve so this effect runs ONCE with the user id
    // known. On hard loads it used to run first with id=undefined and again
    // on resolution — each run independently picked (and now ledgers) a
    // problem, recording a phantom never-shown row and double-spending the
    // AI generator. /interview is auth-gated in middleware, so 'loading'
    // always transitions promptly.
    if (authStatus === 'loading') return
    // UAT-022: missing / cross-user / stale config previously bounced the
    // user to `/` (the marketing homepage), which made bookmarked
    // /interview links look broken. Redirect to the setup wizard instead
    // so the user can recover.
    const stored = localStorage.getItem(STORAGE_KEYS.INTERVIEW_CONFIG)
    if (!stored) {
      router.push('/interview/setup')
      return
    }

    // Guard: reject config owned by a different user (prevents cross-user data leakage)
    try {
      const raw = JSON.parse(stored)
      if (raw._ownerId && authSession?.user?.id && raw._ownerId !== authSession.user.id) {
        localStorage.removeItem(STORAGE_KEYS.INTERVIEW_CONFIG)
        router.push('/interview/setup')
        return
      }
    } catch { /* malformed JSON — fall through to normal parsing below */ }

    // Guard: if there's already a completed session for this config, don't reuse it
    const activeSession = localStorage.getItem(STORAGE_KEYS.INTERVIEW_ACTIVE_SESSION)
    if (activeSession) {
      // A previous session was in progress but user navigated back.
      // Clear stale state and route to setup with a recoverable flag so
      // the wizard can show a "your previous session ended" hint.
      localStorage.removeItem(STORAGE_KEYS.INTERVIEW_CONFIG)
      localStorage.removeItem(STORAGE_KEYS.INTERVIEW_ACTIVE_SESSION)
      router.push('/interview/setup?recover=stale-session')
      return
    }

    // The Jobs handoff signature is transport-only. Keep it separate from
    // InterviewConfig so runtime/model requests cannot inherit it.
    const storedConfig = JSON.parse(stored) as InterviewConfig & { jobsHandoffToken?: string }
    const { jobsHandoffToken: storedJobsHandoffToken, ...parsed } = storedConfig
    setJobsHandoffToken(storedJobsHandoffToken)
    // Record the served problem in the server-side ServedProblem ledger at
    // selection time (fire-and-forget — recording must never block interview
    // start). AI problems are also recorded server-side inside the generate
    // routes; the ledger upsert is idempotent so the double record is harmless.
    // Recording at selection (not session create) is deliberate: a candidate
    // who saw the problem and bailed in the lobby has still seen it.
    const recordServed = (
      kind: 'coding' | 'system-design',
      problem: { id: string; title: string; difficulty?: string },
    ) => {
      fetch('/api/problems/served', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // keepalive: the browser cancels normal fetches on unload — a candidate
        // who closes the tab right after seeing the problem would otherwise
        // leave no static-pick ledger record (Codex P2 on PR #485). The body is
        // far under the 64KB keepalive cap.
        keepalive: true,
        body: JSON.stringify({
          kind,
          problemId: problem.id,
          title: problem.title,
          domain: parsed.role,
          difficulty: problem.difficulty,
          source: problem.id.startsWith('ai-') ? 'ai' : 'static',
        }),
      }).catch(() => {})
    }
    // Select a coding problem if in coding mode (avoid repeats across sessions)
    // IMPORTANT: Defer setConfig until problem is loaded so useInterview doesn't
    // start the standard flow before the problem is available.
    if (parsed.interviewType === 'coding') {
      // Size the problem to the coding time actually available (candidate feedback
      // 2026-06-16: a "10-min" problem was unsolvable in 25). Difficulty is the
      // easier of what experience warrants and what the budget allows; the budget
      // becomes expectedTimeMinutes so the UI shows an honest, finishable target.
      // The coding flow presents ONE problem (see the useInterview coding branch),
      // so the whole usable time is that single problem's budget — do NOT divide by
      // getCodingQuestionCount (multi-problem isn't wired into the interview loop, and
      // dividing made 'hard' unreachable + the badge wrong for 30-min slots).
      const codingBudget = resolveCodingTimeBudget(parsed.duration, 1)
      const codingDifficulty = resolveCodingDifficulty(parsed.experience, codingBudget)
      const DIFF_RANK = { easy: 0, medium: 1, hard: 2 } as const
      // selectProblem falls back to ADJACENT (harder) difficulties when the target
      // pool is exhausted. Stamp the short budget ONLY when the problem isn't harder
      // than the calibrated target — otherwise we'd label a medium problem as a
      // 6-min task and re-create the mismatch this fixes. A harder fallback keeps its
      // own (honest, longer) expectedTimeMinutes. (Codex P2 on PR #456.)
      const withBudget = (p: CodingProblem | null): CodingProblem | null => {
        if (!p) return p
        if (DIFF_RANK[p.difficulty] > DIFF_RANK[codingDifficulty]) return p
        return { ...p, expectedTimeMinutes: codingBudget }
      }
      const isOverScoped = (p: CodingProblem | null): boolean =>
        !!p && DIFF_RANK[p.difficulty] > DIFF_RANK[codingDifficulty]

      // Fetch user's previously solved problem IDs
      fetch('/api/code/history')
        .then((r) => r.ok ? r.json() : { solvedProblemIds: [] })
        .then(async ({ solvedProblemIds = [] }) => {
          // Try pool first (excluding solved problems), at the calibrated difficulty
          let problem = selectProblem(parsed.role, parsed.experience, solvedProblemIds, codingDifficulty)

          // Prefer an AI-generated problem (role + resume aware) when we can
          // personalize to the candidate's resume, OR when the static pool has
          // no NATIVE problem for this role — otherwise selectProblem borrows a
          // generic puzzle (the QA gap where ml-engineer/data-analyst both got
          // Two Sum). The server route keeps modelRouter (and its mongoose+
          // ioredis deps) out of the client bundle; on failure we keep the
          // static result so problem-load never blocks.
          const nativeStatic = !!problem?.applicableDomains?.includes(parsed.role)
          // Also generate when the static pick is HARDER than the calibrated target
          // (the pool fell back to an adjacent difficulty) — the AI problem is sized
          // to the budget, so the short slot gets a right-scoped problem. Codex P2.
          if (parsed.resumeText || !nativeStatic || isOverScoped(problem)) {
            try {
              const res = await fetch('/api/code/generate-problem', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  domain: parsed.role,
                  experience: parsed.experience,
                  solvedProblemIds,
                  resumeText: parsed.resumeText,
                  difficulty: codingDifficulty,
                  budgetMinutes: codingBudget,
                }),
              })
              if (res.ok) {
                const data = (await res.json()) as { problem: typeof problem }
                if (data.problem) problem = data.problem
              }
            } catch {
              // network blip / route 500 → keep the static result below
            }
          }
          if (!problem) {
            // Last resort (pool exhausted for this user AND AI failed): repeat
            // the problem seen longest ago — deterministic, instead of a
            // silent uniform-random repeat.
            problem = selectLeastRecentlyServed(parsed.role, parsed.experience, solvedProblemIds, codingDifficulty)
          }

          if (problem) {
            recordServed('coding', problem)
            setCurrentProblem(withBudget(problem))
          }
          setConfig(parsed)
        })
        .catch(async () => {
          // History fetch failed (network / server hiccup). The generate route
          // unions its own server-side ledger, so try it before falling back to
          // an exclusion-blind static pick; when truly offline the fetch fails
          // fast and we land on the static pool as before.
          let problem: CodingProblem | null = null
          try {
            const res = await fetch('/api/code/generate-problem', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                domain: parsed.role,
                experience: parsed.experience,
                solvedProblemIds: [],
                resumeText: parsed.resumeText,
                difficulty: codingDifficulty,
                budgetMinutes: codingBudget,
              }),
            })
            if (res.ok) {
              const data = (await res.json()) as { problem: CodingProblem | null }
              problem = data.problem
            }
          } catch {
            // offline — fall through to the static pick
          }
          if (!problem) problem = selectProblem(parsed.role, parsed.experience, [], codingDifficulty)
          if (problem) {
            recordServed('coding', problem)
            setCurrentProblem(withBudget(problem))
          }
          setConfig(parsed)
        })
    } else if (parsed.interviewType === 'system-design') {
      // Fetch user's previously used design problem IDs to avoid repeats
      fetch('/api/design/history')
        .then((r) => r.ok ? r.json() : { solvedProblemIds: [] })
        .then(async ({ solvedProblemIds = [] }) => {
          let problem = selectDesignProblem(parsed.role, parsed.experience, solvedProblemIds)

          // Same rule as coding: personalize to the resume, or replace a
          // borrowed generic problem for roles the static pool doesn't cover
          // (ml-engineer, data-analyst, devops, mobile…). The static pool only
          // tags backend/frontend/sdet/data-science, so every other role used to
          // get a generic web design (URL Shortener). On failure, keep static.
          const nativeStatic = !!problem?.applicableDomains?.includes(parsed.role)
          if (parsed.resumeText || !nativeStatic) {
            try {
              const res = await fetch('/api/design/generate-problem', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  domain: parsed.role,
                  experience: parsed.experience,
                  solvedProblemIds,
                  resumeText: parsed.resumeText,
                }),
              })
              if (res.ok) {
                const data = (await res.json()) as { problem: typeof problem }
                if (data.problem) problem = data.problem
              }
            } catch {
              // network blip / route 500 → keep the static result
            }
          }
          if (!problem) {
            // Last resort (pool exhausted for this user AND AI failed): repeat
            // the problem seen longest ago — deterministic, and no longer drops
            // the exclusion list the way the old bare re-select did.
            problem = selectLeastRecentlyServedDesign(parsed.role, parsed.experience, solvedProblemIds)
          }
          if (problem) {
            recordServed('system-design', problem)
            setCurrentDesignProblem(problem)
          }
          setConfig(parsed)
        })
        .catch(async () => {
          // History fetch failed (network / server hiccup). The generate route
          // unions its own server-side ledger, so try it before falling back to
          // an exclusion-blind static pick; when truly offline the fetch fails
          // fast and we land on the static pool as before.
          let problem: DesignProblem | null = null
          try {
            const res = await fetch('/api/design/generate-problem', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                domain: parsed.role,
                experience: parsed.experience,
                solvedProblemIds: [],
                resumeText: parsed.resumeText,
              }),
            })
            if (res.ok) {
              const data = (await res.json()) as { problem: DesignProblem | null }
              problem = data.problem
            }
          } catch {
            // offline — fall through to the static pick
          }
          if (!problem) problem = selectDesignProblem(parsed.role, parsed.experience)
          if (problem) {
            recordServed('system-design', problem)
            setCurrentDesignProblem(problem)
          }
          setConfig(parsed)
        })
    } else {
      setConfig(parsed)
    }
    // authStatus in deps: the 'loading' bail above returns early, and the
    // status flip to authenticated/unauthenticated triggers the single real run.
  }, [router, authSession?.user?.id, authStatus])

  // ─── Camera init + start recording (only after config is loaded) ───────────
  useEffect(() => {
    if (!config) return // Don't start camera until interview config is ready

    let cancelled = false

    async function initCapture() {
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: cameraVideoConstraints,
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        })
      } catch (err) {
        console.error(err)
        return
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }

      streamRef.current = stream
      // Share the audio stream with speech recognition to avoid redundant getUserMedia
      setExternalStream(stream)
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        // Start facial landmark capture if multimodal is enabled
        if (isB2cMultimodalEnabled) {
          startB2cFacialCapture(videoRef.current).catch(() => {})
        } else if (isHireNativeMultimodalEnabled) {
          startHireMultimodalAnalysisCapture(videoRef.current).catch(() => {})
        }
      }

      // Build the recording stream with the AI voice mixed in.
      // The mixer combines the candidate's mic with any tapped TTS
      // <audio> elements so the saved webm contains both sides.
      // Falls back to the raw camera+mic stream if Web Audio API is
      // unavailable.
      setVoiceMixerMic(stream)
      const mixedAudio = getMixedAudioStream()
      const cameraRecordingStream = mixedAudio
        ? new MediaStream([
            ...stream.getVideoTracks(),
            ...mixedAudio.getAudioTracks(),
          ])
        : stream

      // Mark t=0 of the audio timeline right before we kick off the
      // recorder. useDeepgramRecognition uses this to convert its
      // per-turn word timestamps into recording-relative offsets so
      // the multimodal analysis pipeline can skip Whisper entirely.
      setRecordingStartedAt(Date.now())
      startRecording(cameraRecordingStream, cameraRecorderOptions)

      // Audio-only recording for Whisper transcription. Groq Whisper
      // rejects files >25MB, and a 5+ minute HD camera webm blows past
      // that limit. An audio-only webm for the same duration is ~1–2MB.
      // We feed it the same mixed audio (candidate mic + AI voice) so
      // the transcript contains both sides of the conversation. If the
      // mixer isn't available, fall back to the raw mic tracks.
      const audioTracks = mixedAudio
        ? mixedAudio.getAudioTracks()
        : stream.getAudioTracks()
      if (audioTracks.length > 0) {
        const audioOnlyStream = new MediaStream(audioTracks)
        audioRecorder.startRecording(audioOnlyStream, audioRecorderOptions)
      }
    }

    initCapture()

    return () => {
      cancelled = true
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop())
        streamRef.current = null
      }
      resetVoiceMixer()
      resetRecordingClock()
    }
    // Hook return objects hold stable functions but are themselves a fresh
    // reference each render — listing them would re-prompt for camera on every
    // render. Re-run only when the underlying interview config changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config])

  // ─── Load TTS voices ──────────────────────────────────────────────────────
  useEffect(() => {
    const load = () => {
      if (window.speechSynthesis.getVoices().length) setVoicesReady(true)
    }
    load()
    window.speechSynthesis.addEventListener('voiceschanged', load)
    return () => window.speechSynthesis.removeEventListener('voiceschanged', load)
  }, [])

  // ─── Loading state ─────────────────────────────────────────────────────────
  if (!config) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <motion.div
          className="flex flex-col items-center gap-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5 }}
        >
          <div className="w-8 h-8 rounded-full border-2 border-[#2563eb] border-t-transparent animate-spin" />
          <p className="text-sm text-[#71767b]">Loading interview...</p>
        </motion.div>
      </div>
    )
  }

  return (
    <motion.div
      className={`min-h-screen flex flex-col ${isCodingMode || isDesignMode ? 'bg-[#1a1b26]' : 'bg-white'}`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5, ease: 'easeOut' }}
    >
      {/* ── Header ── */}
      <header className={`flex items-center justify-between px-5 h-[52px] shrink-0 ${isCodingMode || isDesignMode ? 'bg-[#1e1f2e] border-b border-gray-700/50' : 'bg-white border-b border-[#e1e8ed]'}`}>
        <div className="flex items-center gap-3">
          {/* Live dot */}
          <div className="flex items-center gap-2">
            <motion.span
              className="w-2 h-2 rounded-full bg-red-500"
              animate={{ opacity: [1, 0.4, 1] }}
              transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
            />
            <span className={`text-sm font-medium ${isCodingMode || isDesignMode ? 'text-gray-400' : 'text-[#536471]'}`}>Live</span>
          </div>
          {/* Separator */}
          <div className={`w-px h-4 ${isCodingMode || isDesignMode ? 'bg-gray-700' : 'bg-[#e1e8ed]'}`} />
          <RecordingIndicator
            isRecording={isRecording}
            durationSeconds={recordingDuration}
            hasConsent={true}
          />
        </div>

        {/* Timer — centered */}
        <motion.div
          className="font-mono font-bold tabular-nums text-lg"
          animate={{
            color: timeRemaining < 60 ? '#f4212e' : timeRemaining < 120 ? '#d97706' : isCodingMode || isDesignMode ? '#e2e8f0' : '#0f1419',
          }}
          transition={{ duration: 0.5 }}
        >
          {formatTime(timeRemaining)}
        </motion.div>

        {/* Phase badge */}
        <AnimatePresence mode="wait">
          <motion.div
            key={phase}
            initial={{ opacity: 0, y: -4, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.95 }}
            transition={{ duration: 0.2 }}
            className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border ${phaseColor.text} ${phaseColor.bg} ${phaseColor.border}`}
          >
            {phase === 'LISTENING' && (
              <motion.span
                className={`w-1.5 h-1.5 rounded-full ${phaseColor.dot}`}
                animate={{ scale: [1, 1.4, 1], opacity: [0.6, 1, 0.6] }}
                transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
              />
            )}
            {phase === 'PROCESSING' && (
              <div className="w-3 h-3 rounded-full border border-amber-600 border-t-transparent animate-spin" />
            )}
            <span className="font-medium">{PHASE_LABELS[phase] ?? phase}</span>
          </motion.div>
        </AnimatePresence>
      </header>

      {/* ── Coding mode layout ── */}
      {isCodingMode ? (
        <CodingLayout
          avatarEmotion={avatarEmotion}
          isAvatarTalking={isAvatarTalking}
          isListening={isListening}
          isProcessing={isProcessing}
          transcriptWordCount={liveTranscript.split(/\s+/).filter(Boolean).length}
          problem={currentProblem}
          phase={phase}
          language={codingLanguage}
          onLanguageChange={setCodingLanguage}
          onCodeSubmit={handleCodeSubmit}
          sessionId={interview.sessionId ?? undefined}
          currentQuestion={currentQuestion}
          liveAnswer={displayAnswer}
          answerSecondsLeft={answerSecondsLeft}
        >
          <div className="px-4 pb-1 flex flex-col gap-1.5">
            {showCoachOverlay && <CoachOverlay state={coachModeState} />}
            <CoachingNudge nudge={activeNudge} />
            <CoachingTip tip={coachingTip} coachMode={isCoachMode} />
          </div>
        </CodingLayout>
      ) : isDesignMode ? (
        <DesignLayout
          avatarEmotion={avatarEmotion}
          isAvatarTalking={isAvatarTalking}
          isListening={isListening}
          isProcessing={isProcessing}
          transcriptWordCount={liveTranscript.split(/\s+/).filter(Boolean).length}
          problem={currentDesignProblem}
          phase={phase}
          questionIndex={questionIndex}
          onDesignSubmit={handleDesignSubmit}
          currentQuestion={currentQuestion}
          liveAnswer={displayAnswer}
        >
          <div className="px-4 pb-1 flex flex-col gap-1.5">
            {showCoachOverlay && <CoachOverlay state={coachModeState} />}
            <CoachingNudge nudge={activeNudge} />
            <CoachingTip tip={coachingTip} coachMode={isCoachMode} />
          </div>
        </DesignLayout>
      ) : (
      <>
      {/* ── Video tiles ── */}
      <div className="flex-1 flex gap-3 p-3 sm:p-4 min-h-0">
        {/* Interviewer (avatar) */}
        <VideoTile
          label={AVATAR_NAME}
          sublabel={getAvatarTitle(config?.interviewType)}
          isActive={isAvatarTalking}
          indicator={
            isAvatarTalking ? (
              <div className="flex items-center gap-1 bg-black/50 backdrop-blur-sm px-2.5 py-1 rounded-full">
                <div className="flex items-end gap-[2px] h-3">
                  {[0, 1, 2].map((i) => (
                    <motion.div
                      key={i}
                      className="w-[2.5px] bg-[#2563eb] rounded-full origin-bottom"
                      animate={{ scaleY: [0.3, 1, 0.3] }}
                      transition={{ duration: 0.5, repeat: Infinity, delay: i * 0.1, ease: 'easeInOut' }}
                      style={{ height: '10px' }}
                    />
                  ))}
                </div>
                <span className="text-[10px] text-[#2563eb] font-medium ml-1">AI</span>
              </div>
            ) : null
          }
        >
          <Avatar
            emotion={avatarEmotion}
            isTalking={isAvatarTalking}
            isListening={isListening}
            isProcessing={isProcessing}
            transcriptWordCount={liveTranscript.split(/\s+/).filter(Boolean).length}
          />
        </VideoTile>

        {/* User camera */}
        <VideoTile
          label="You"
          isActive={isListening}
          indicator={
            isListening ? (
              <div className="flex items-center gap-1.5 bg-black/50 backdrop-blur-sm px-2.5 py-1 rounded-full">
                <motion.span
                  className="w-1.5 h-1.5 rounded-full bg-red-400"
                  animate={{ opacity: [1, 0.4, 1] }}
                  transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
                />
                <span className="text-[10px] text-[#536471] font-medium">REC</span>
              </div>
            ) : null
          }
        >
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className="w-full h-full object-cover"
            style={{ transform: 'scaleX(-1)' }}
          />
        </VideoTile>
      </div>

      {/* ── Transcript panel ── */}
      <TranscriptPanel
        phase={phase}
        questionDisplay={questionDisplay}
        duration={config.duration}
        currentQuestion={currentQuestion}
        liveAnswer={displayAnswerFinal}
        liveAnswerInterim={displayAnswerInterim}
      />

      {/* ── Coaching layer ── */}
      <div className="px-4 pb-1 flex flex-col gap-1.5">
        {showCoachOverlay && <CoachOverlay state={coachModeState} />}
        <CoachingNudge nudge={activeNudge} />
        <CoachingTip tip={coachingTip} coachMode={isCoachMode} />
      </div>
      </>
      )}

      {/* ── Controls ── */}
      <InterviewControls
        // G.7: the End button explicitly tags the session as candidate-ended,
        // distinct from time_up or a normal closing-line exit.
        onEndInterview={() => {
          // markAbandoned() must run BEFORE finishInterview so the
          // abandon-fired ref is set before the SCORING → FEEDBACK
          // transition tempts the lifecycle observer into firing
          // interview_completed.
          markAbandoned()
          finishInterview('user_ended')
        }}
        isScoring={phase === 'SCORING'}
        darkMode={isCodingMode || isDesignMode}
      />
    </motion.div>
  )
}
