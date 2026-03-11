'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import Avatar from '@/components/Avatar'
import VideoTile from '@/components/VideoTile'
import TranscriptPanel from '@/components/interview/TranscriptPanel'
import InterviewControls from '@/components/interview/InterviewControls'
import RecordingIndicator from '@/components/RecordingIndicator'
import CoachingNudge from '@/components/interview/CoachingNudge'
import CoachingTip from '@/components/interview/CoachingTip'
import { useSpeechRecognition } from '@/hooks/useSpeechRecognition'
import { useInterview } from '@/hooks/useInterview'
import { useMediaRecorder } from '@/hooks/useMediaRecorder'
import { useCoachingNudge } from '@/hooks/useCoachingNudge'
import type { InterviewConfig } from '@/lib/types'
import { AVATAR_NAME, AVATAR_TITLE } from '@/lib/interviewConfig'
import { STORAGE_KEYS } from '@/lib/storageKeys'

import { formatTime } from '@/lib/utils'

// ─── Phase label map ──────────────────────────────────────────────────────────

const PHASE_LABELS: Record<string, string> = {
  INIT: 'Initializing',
  LOBBY: 'Lobby',
  CALIBRATION: 'Calibrating',
  INTERVIEW_START: 'Starting',
  ASK_QUESTION: 'Question',
  LISTENING: 'Listening',
  PROCESSING: 'Processing',
  COACHING: 'Coaching',
  FOLLOW_UP: 'Follow-up',
  WRAP_UP: 'Wrapping up',
  SCORING: 'Scoring',
  FEEDBACK: 'Feedback',
  ENDED: 'Ended',
}

const PHASE_COLORS: Record<string, { text: string; bg: string; border: string; dot: string }> = {
  LISTENING: { text: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/25', dot: 'bg-emerald-400' },
  PROCESSING: { text: 'text-amber-400', bg: 'bg-amber-500/10', border: 'border-amber-500/25', dot: 'bg-amber-400' },
  COACHING: { text: 'text-violet-400', bg: 'bg-violet-500/10', border: 'border-violet-500/25', dot: 'bg-violet-400' },
  ASK_QUESTION: { text: 'text-indigo-400', bg: 'bg-indigo-500/10', border: 'border-indigo-500/25', dot: 'bg-indigo-400' },
  FOLLOW_UP: { text: 'text-purple-400', bg: 'bg-purple-500/10', border: 'border-purple-500/25', dot: 'bg-purple-400' },
  WRAP_UP: { text: 'text-orange-400', bg: 'bg-orange-500/10', border: 'border-orange-500/25', dot: 'bg-orange-400' },
  SCORING: { text: 'text-cyan-400', bg: 'bg-cyan-500/10', border: 'border-cyan-500/25', dot: 'bg-cyan-400' },
}

const DEFAULT_PHASE_COLOR = { text: 'text-slate-400', bg: 'bg-slate-500/10', border: 'border-slate-600/30', dot: 'bg-slate-500' }

// ─── Component ────────────────────────────────────────────────────────────────

export default function InterviewPage() {
  const router = useRouter()

  // ── Config ──
  const [config, setConfig] = useState<InterviewConfig | null>(null)

  // ── Camera ──
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [muted, setMuted] = useState(false)

  // ── Voices loaded ──
  const [voicesReady, setVoicesReady] = useState(false)

  // ── Speech recognition ──
  const { isListening, liveTranscript, startListening, stopListening } = useSpeechRecognition()

  // ── Recording ──
  const { isRecording, recordingDuration, startRecording, stopRecording } = useMediaRecorder()

  // Handle recording stop
  const handleRecordingStop = useCallback(async () => {
    const blob = await stopRecording()
    if (!blob) return

    const sessionId = interviewRef.current?.sessionId
    if (sessionId) {
      const formData = new FormData()
      formData.append('recording', blob, 'interview-recording.webm')
      formData.append('sessionId', sessionId)
      fetch('/api/recordings/upload', { method: 'POST', body: formData })
        .then(async (res) => {
          if (!res.ok) {
            const body = await res.json().catch(() => ({}))
            console.error('Recording upload failed:', res.status, body)
          }
        })
        .catch((err) => console.error('Recording upload network error:', err))
    }
  }, [stopRecording])

  // ── Interview engine ──
  const interview = useInterview({
    config,
    voicesReady,
    startListening,
    stopListening,
    onRecordingStop: handleRecordingStop,
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

  // ── Live coaching nudges (Issue 3-A: extracted to useCoachingNudge hook) ──
  const activeNudge = useCoachingNudge({ phase, liveTranscript })

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

  // ─── Load config ───────────────────────────────────────────────────────────
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEYS.INTERVIEW_CONFIG)
    if (!stored) {
      router.push('/')
      return
    }
    setConfig(JSON.parse(stored))
  }, [router])

  // ─── Camera init + start recording ─────────────────────────────────────────
  useEffect(() => {
    navigator.mediaDevices
      .getUserMedia({ video: true, audio: true })
      .then((stream) => {
        streamRef.current = stream
        if (videoRef.current) videoRef.current.srcObject = stream
        startRecording(stream)
      })
      .catch(console.error)
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop())
        streamRef.current = null
      }
    }
  }, [startRecording])

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
    streamRef.current.getAudioTracks().forEach((t) => {
      t.enabled = !t.enabled
    })
    setMuted((m) => !m)
  }

  // ─── Loading state ─────────────────────────────────────────────────────────
  if (!config) {
    return (
      <div className="min-h-screen bg-[#070b14] flex items-center justify-center">
        <motion.div
          className="flex flex-col items-center gap-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5 }}
        >
          <div className="w-8 h-8 rounded-full border-2 border-indigo-400 border-t-transparent animate-spin" />
          <p className="text-sm text-slate-500">Loading interview...</p>
        </motion.div>
      </div>
    )
  }

  return (
    <motion.div
      className="min-h-screen bg-[#070b14] flex flex-col"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5, ease: 'easeOut' }}
    >
      {/* ── Header ── */}
      <header className="flex items-center justify-between px-5 py-3 bg-slate-900/60 backdrop-blur-md border-b border-slate-800/50 shrink-0">
        <div className="flex items-center gap-3">
          {/* Live dot */}
          <div className="flex items-center gap-2">
            <motion.span
              className="w-2 h-2 rounded-full bg-red-500"
              animate={{ opacity: [1, 0.4, 1] }}
              transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
            />
            <span className="text-sm font-medium text-slate-300">Live</span>
          </div>
          {/* Separator */}
          <div className="w-px h-4 bg-slate-700/60" />
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
            color: timeRemaining < 60 ? '#f87171' : timeRemaining < 120 ? '#fbbf24' : '#e2e8f0',
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
              <div className="w-3 h-3 rounded-full border border-amber-400 border-t-transparent animate-spin" />
            )}
            <span className="font-medium">{PHASE_LABELS[phase] ?? phase}</span>
          </motion.div>
        </AnimatePresence>
      </header>

      {/* ── Video tiles ── */}
      <div className="flex-1 flex gap-3 p-3 sm:p-4 min-h-0">
        {/* Interviewer (avatar) */}
        <VideoTile
          label={AVATAR_NAME}
          sublabel={AVATAR_TITLE}
          isActive={isAvatarTalking}
          indicator={
            isAvatarTalking ? (
              <div className="flex items-center gap-1 bg-black/50 backdrop-blur-sm px-2.5 py-1 rounded-full">
                <div className="flex items-end gap-[2px] h-3">
                  {[0, 1, 2].map((i) => (
                    <motion.div
                      key={i}
                      className="w-[2.5px] bg-indigo-400 rounded-full origin-bottom"
                      animate={{ scaleY: [0.3, 1, 0.3] }}
                      transition={{ duration: 0.5, repeat: Infinity, delay: i * 0.1, ease: 'easeInOut' }}
                      style={{ height: '10px' }}
                    />
                  ))}
                </div>
                <span className="text-[10px] text-indigo-300 font-medium ml-1">AI</span>
              </div>
            ) : null
          }
        >
          <Avatar
            emotion={avatarEmotion}
            isTalking={isAvatarTalking}
            isListening={isListening}
            isProcessing={isProcessing}
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
                <span className="text-[10px] text-slate-300 font-medium">REC</span>
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
        <CoachingNudge nudge={activeNudge} />
        <CoachingTip tip={coachingTip} />
      </div>

      {/* ── Controls ── */}
      <InterviewControls
        muted={muted}
        onToggleMute={toggleMute}
        onEndInterview={finishInterview}
        isScoring={phase === 'SCORING'}
      />
    </motion.div>
  )
}
