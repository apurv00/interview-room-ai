'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
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
import { useMediaRecorder } from '@interview/hooks/useMediaRecorder'
import { useCoachingNudge } from '@interview/hooks/useCoachingNudge'
import { useFacialLandmarks } from '@interview/hooks/useFacialLandmarks'
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
import CoachOverlay from '@interview/components/interview/CoachOverlay'
import CodingLayout from '@interview/components/interview/CodingLayout'
import DesignLayout from '@interview/components/interview/DesignLayout'
import { selectProblem, type CodingProblem } from '@interview/config/codingProblems'
import { selectDesignProblem, type DesignProblem } from '@interview/config/designProblems'
import type { InterviewConfig, DesignSubmission } from '@shared/types'
import { AVATAR_NAME, getAvatarTitle } from '@interview/config/interviewConfig'
import { STORAGE_KEYS } from '@shared/storageKeys'

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

  // ── Config ──
  const [config, setConfig] = useState<InterviewConfig | null>(null)
  const [codingLanguage, setCodingLanguage] = useState<import('@shared/types').CodeLanguage>('python')
  const [currentProblem, setCurrentProblem] = useState<CodingProblem | null>(null)
  const [currentDesignProblem, setCurrentDesignProblem] = useState<DesignProblem | null>(null)
  const isCodingMode = config?.interviewType === 'coding'
  const isDesignMode = config?.interviewType === 'system-design'

  // ── Camera ──
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const screenStreamRef = useRef<MediaStream | null>(null)
  const [muted, setMuted] = useState(false)

  // Screen capture is gated to coding & system-design — those interviews
  // produce work that lives on screen (IDE / canvas) and the camera-only
  // recording can't replay it.
  const wantsScreenCapture = isCodingMode || isDesignMode

  // ── Voices loaded ──
  const [voicesReady, setVoicesReady] = useState(false)

  // ── Speech recognition ──
  const { isListening, liveTranscript, startListening, stopListening, warmUp, setExternalStream } = useSpeechRecognition()

  // ── Recording (camera track) ──
  const { isRecording, recordingDuration, startRecording, stopRecording } = useMediaRecorder()
  // ── Recording (screen track for coding / system-design) ──
  const screenRecorder = useMediaRecorder()
  // ── Recording (audio-only track — what Whisper transcribes). Kept
  //    separate from the camera webm because Groq Whisper rejects files
  //    >25MB and a multi-minute HD camera recording easily exceeds that.
  const audioRecorder = useMediaRecorder()

  // ── Facial landmarks (multimodal analysis) ──
  const isMultimodalEnabled = process.env.NEXT_PUBLIC_FEATURE_MULTIMODAL === 'true'
  const { startCapture, stopCapture, framesRef } = useFacialLandmarks()

  // Upload a recording blob via presigned R2 PUT and patch the session
  // with the resulting key. Returns true on success.
  const uploadRecordingBlob = useCallback(
    async (
      blob: Blob,
      sessionId: string,
      kind: 'camera' | 'screen' | 'audio'
    ): Promise<boolean> => {
      try {
        const presignType =
          kind === 'screen'
            ? 'screen-recording'
            : kind === 'audio'
            ? 'audio-recording'
            : 'recording'
        const presignRes = await fetch('/api/storage/presign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'upload',
            type: presignType,
            sessionId,
          }),
        })
        if (!presignRes.ok) {
          console.error('Presign request failed:', presignRes.status)
          return false
        }
        const { url, key } = await presignRes.json()

        const uploadRes = await fetch(url, {
          method: 'PUT',
          headers: { 'Content-Type': 'video/webm' },
          body: blob,
        })
        if (!uploadRes.ok) {
          console.error('R2 upload failed:', uploadRes.status)
          return false
        }

        const patchBody =
          kind === 'screen'
            ? { screenRecordingR2Key: key, screenRecordingSizeBytes: blob.size }
            : kind === 'audio'
            ? { audioRecordingR2Key: key, audioRecordingSizeBytes: blob.size }
            : { recordingR2Key: key, recordingSizeBytes: blob.size }

        await fetch(`/api/interviews/${sessionId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patchBody),
        }).catch((err) => console.error('Failed to update session with R2 key:', err))
        return true
      } catch (err) {
        console.error('Recording upload error:', err)
        return false
      }
    },
    []
  )

  // Handle recording stop
  const handleRecordingStop = useCallback(async () => {
    // Stop all three recorders in parallel — the screen recorder is a
    // no-op when no screen track was ever started; the audio recorder
    // runs for every interview.
    const [cameraBlob, screenBlob, audioBlob] = await Promise.all([
      stopRecording(),
      screenRecorder.stopRecording(),
      audioRecorder.stopRecording(),
    ])

    // Release any active screen capture tracks
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((t) => t.stop())
      screenStreamRef.current = null
    }

    // Stop facial capture and upload landmarks
    if (isMultimodalEnabled) {
      const frames = stopCapture()
      const sessionId = interviewRef.current?.sessionId
      if (frames.length > 0 && sessionId) {
        fetch('/api/recordings/landmarks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, frames }),
        }).catch((err) => console.error('Landmarks upload error:', err))
      }
    }

    const sessionId = interviewRef.current?.sessionId
    if (!sessionId) return

    // Privacy mode — opt out of video storage. The big camera webm
    // (~30–80MB per session) is dropped on the floor; only the small
    // audio-only track (needed by Whisper for the post-interview
    // transcription pipeline) and the facial-landmark JSON (already
    // client-derived and tiny) hit R2.
    const privacyMode = config?.privacyMode === true

    // Upload the camera, audio, and (optional) screen tracks in parallel
    const uploads: Promise<boolean>[] = []
    if (cameraBlob && !privacyMode) {
      uploads.push(uploadRecordingBlob(cameraBlob, sessionId, 'camera'))
    }
    if (audioBlob) uploads.push(uploadRecordingBlob(audioBlob, sessionId, 'audio'))
    if (screenBlob && !privacyMode) {
      uploads.push(uploadRecordingBlob(screenBlob, sessionId, 'screen'))
    }
    await Promise.all(uploads)
  }, [stopRecording, screenRecorder, audioRecorder, isMultimodalEnabled, stopCapture, uploadRecordingBlob, config?.privacyMode])

  // ── Interview engine ──
  const interview = useInterview({
    config,
    voicesReady,
    startListening,
    stopListening,
    warmUpListening: warmUp,
    onRecordingStop: handleRecordingStop,
    currentProblem,
    currentDesignProblem,
  })

  const interviewRef = useRef(interview)
  interviewRef.current = interview

  const {
    phase,
    questionIndex,
    currentQuestion,
    avatarEmotion,
    isAvatarTalking,
    timeRemaining,
    liveAnswer,
    coachingTip,
    finishInterview,
  } = interview

  const displayAnswer = isListening ? liveTranscript : liveAnswer
  const phaseColor = PHASE_COLORS[phase] ?? DEFAULT_PHASE_COLOR
  const isProcessing = phase === 'PROCESSING'

  // ── Live coaching nudges ──
  const isCoachMode = config?.coachMode ?? false
  const speechNudge = useCoachingNudge({ phase, liveTranscript, pollIntervalMs: isCoachMode ? 2000 : undefined })
  const facialNudge = useRealtimeFacialCoaching({
    phase,
    framesRef,
    enabled: isMultimodalEnabled,
  })
  const prosodyNudge = useRealtimeProsody({
    phase,
    liveTranscript,
    enabled: isMultimodalEnabled,
  })
  // Priority: prosody > speech-content > visual
  const coachModeState = useCoachMode({ phase, liveTranscript, enabled: isCoachMode })
  const activeNudge = prosodyNudge || speechNudge || facialNudge

  // ─── Code submission handler (coding mode) ─────────────────────────────────
  // Signals the useInterview hook to proceed from CODE_EDITING → PROCESSING
  const handleCodeSubmit = useCallback((code: string) => {
    interview.onCodeSubmit(code, codingLanguage)
  }, [interview.onCodeSubmit, codingLanguage])

  // ─── Design submission handler (system design mode) ────────────────────────
  const handleDesignSubmit = useCallback((data: DesignSubmission) => {
    interview.onDesignSubmit(data)
  }, [interview.onDesignSubmit])

  // ─── Keyboard shortcut (M to toggle mute) ──────────────────────────────────
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'm' || e.key === 'M') {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
        toggleMute()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  })

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
    const stored = localStorage.getItem(STORAGE_KEYS.INTERVIEW_CONFIG)
    if (!stored) {
      router.push('/')
      return
    }

    // Guard: if there's already a completed session for this config, don't reuse it
    const activeSession = localStorage.getItem(STORAGE_KEYS.INTERVIEW_ACTIVE_SESSION)
    if (activeSession) {
      // A previous session was in progress but user navigated back
      // Clear stale state and redirect to home for fresh setup
      localStorage.removeItem(STORAGE_KEYS.INTERVIEW_CONFIG)
      localStorage.removeItem(STORAGE_KEYS.INTERVIEW_ACTIVE_SESSION)
      router.push('/')
      return
    }

    const parsed = JSON.parse(stored)
    // Select a coding problem if in coding mode (avoid repeats across sessions)
    // IMPORTANT: Defer setConfig until problem is loaded so useInterview doesn't
    // start the standard flow before the problem is available.
    if (parsed.interviewType === 'coding') {
      // Fetch user's previously solved problem IDs
      fetch('/api/code/history')
        .then((r) => r.ok ? r.json() : { solvedProblemIds: [] })
        .then(async ({ solvedProblemIds = [] }) => {
          // Try pool first (excluding solved problems)
          let problem = selectProblem(parsed.role, parsed.experience, solvedProblemIds)

          // If pool exhausted, generate a fresh problem via AI
          if (!problem) {
            try {
              const { generateCodingProblem } = await import('@interview/services/core/codingProblemGenerator')
              problem = await generateCodingProblem(parsed.role, parsed.experience, solvedProblemIds)
            } catch {
              // Fall back to any problem from pool (allow repeats as last resort)
              problem = selectProblem(parsed.role, parsed.experience)
            }
          }

          if (problem) setCurrentProblem(problem)
          setConfig(parsed)
        })
        .catch(() => {
          // Offline fallback — just pick from pool without history
          const problem = selectProblem(parsed.role, parsed.experience)
          if (problem) setCurrentProblem(problem)
          setConfig(parsed)
        })
    } else if (parsed.interviewType === 'system-design') {
      // Fetch user's previously used design problem IDs to avoid repeats
      fetch('/api/design/history')
        .then((r) => r.ok ? r.json() : { solvedProblemIds: [] })
        .then(({ solvedProblemIds = [] }) => {
          const problem = selectDesignProblem(parsed.role, parsed.experience, solvedProblemIds)
          if (problem) setCurrentDesignProblem(problem)
          setConfig(parsed)
        })
        .catch(() => {
          // Offline fallback — pick without history
          const problem = selectDesignProblem(parsed.role, parsed.experience)
          if (problem) setCurrentDesignProblem(problem)
          setConfig(parsed)
        })
    } else {
      setConfig(parsed)
    }
  }, [router])

  // ─── Camera init + start recording (only after config is loaded) ───────────
  useEffect(() => {
    if (!config) return // Don't start camera until interview config is ready

    let cancelled = false

    async function initCapture() {
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
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
        if (isMultimodalEnabled) {
          startCapture(videoRef.current).catch(() => {})
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
      startRecording(cameraRecordingStream)

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
        audioRecorder.startRecording(audioOnlyStream)
      }

      // Coding & system-design: also capture the screen so the candidate's
      // work surface is replayable. Best-effort — if the user denies the
      // browser prompt or screen capture is unsupported (iOS Safari), we
      // continue with camera-only.
      if (wantsScreenCapture && typeof navigator.mediaDevices.getDisplayMedia === 'function') {
        try {
          const screenStream = await navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: 10 },
            audio: false,
          })
          if (cancelled) {
            screenStream.getTracks().forEach((t) => t.stop())
            return
          }
          screenStreamRef.current = screenStream

          // If the user clicks the browser "Stop sharing" button, the
          // video track ends — drop the recorder gracefully.
          screenStream.getVideoTracks().forEach((track) => {
            track.addEventListener('ended', () => {
              screenRecorder.stopRecording().catch(() => {})
              screenStreamRef.current = null
            })
          })

          // Reuse the same mixed audio so the screen track also has both
          // sides of the conversation. Falls back to silent screen track.
          const screenRecordingStream = mixedAudio
            ? new MediaStream([
                ...screenStream.getVideoTracks(),
                ...mixedAudio.getAudioTracks(),
              ])
            : new MediaStream([...screenStream.getVideoTracks()])

          screenRecorder.startRecording(screenRecordingStream)
        } catch (err) {
          // User cancelled or capture unavailable — continue with camera only.
          console.warn('Screen capture unavailable, continuing without it:', err)
        }
      }
    }

    initCapture()

    return () => {
      cancelled = true
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop())
        streamRef.current = null
      }
      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach((t) => t.stop())
        screenStreamRef.current = null
      }
      resetVoiceMixer()
      resetRecordingClock()
    }
    // Hook return objects (screenRecorder, etc.) hold stable functions but
    // are themselves a fresh reference each render — listing them would
    // re-prompt the user for screen-share on every render. Re-run only when
    // the underlying interview config or capture mode changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, wantsScreenCapture])

  // ─── Load TTS voices ──────────────────────────────────────────────────────
  useEffect(() => {
    const load = () => {
      if (window.speechSynthesis.getVoices().length) setVoicesReady(true)
    }
    load()
    window.speechSynthesis.addEventListener('voiceschanged', load)
    return () => window.speechSynthesis.removeEventListener('voiceschanged', load)
  }, [])

  // ─── Mute toggle ──────────────────────────────────────────────────────────
  function toggleMute() {
    if (!streamRef.current) return
    const willMute = !muted
    streamRef.current.getAudioTracks().forEach((t) => {
      t.enabled = !willMute
    })
    // Stop speech recognition when muting to prevent phantom input
    if (willMute) {
      stopListening()
    }
    setMuted(willMute)
  }

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
        >
          <div className="px-4 pb-1 flex flex-col gap-1.5">
            {isCoachMode && <CoachOverlay state={coachModeState} />}
            <CoachingNudge nudge={activeNudge} />
            <CoachingTip tip={coachingTip} />
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
            {isCoachMode && <CoachOverlay state={coachModeState} />}
            <CoachingNudge nudge={activeNudge} />
            <CoachingTip tip={coachingTip} />
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
        questionIndex={questionIndex}
        duration={config.duration}
        currentQuestion={currentQuestion}
        liveAnswer={displayAnswer}
      />

      {/* ── Coaching layer ── */}
      <div className="px-4 pb-1 flex flex-col gap-1.5">
        {isCoachMode && <CoachOverlay state={coachModeState} />}
        <CoachingNudge nudge={activeNudge} />
        <CoachingTip tip={coachingTip} />
      </div>
      </>
      )}

      {/* ── Controls ── */}
      <InterviewControls
        muted={muted}
        onToggleMute={toggleMute}
        onEndInterview={finishInterview}
        isScoring={phase === 'SCORING'}
        darkMode={isCodingMode || isDesignMode}
      />
    </motion.div>
  )
}
