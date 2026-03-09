'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Avatar from '@/components/Avatar'
import VideoTile from '@/components/VideoTile'
import TranscriptPanel from '@/components/interview/TranscriptPanel'
import InterviewControls from '@/components/interview/InterviewControls'
import RecordingIndicator from '@/components/RecordingIndicator'
import { useSpeechRecognition } from '@/hooks/useSpeechRecognition'
import { useInterview } from '@/hooks/useInterview'
import { useMediaRecorder } from '@/hooks/useMediaRecorder'
import type { InterviewConfig } from '@/lib/types'
import { AVATAR_NAME, AVATAR_TITLE } from '@/lib/interviewConfig'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(s: number) {
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${m}:${sec.toString().padStart(2, '0')}`
}

// ─── Phase label map ──────────────────────────────────────────────────────────

const PHASE_LABELS: Record<string, string> = {
  INIT: 'Initializing',
  LOBBY: 'Lobby',
  CALIBRATION: 'Calibrating',
  INTERVIEW_START: 'Starting…',
  ASK_QUESTION: 'Question',
  LISTENING: '● Listening',
  PROCESSING: 'Processing…',
  FOLLOW_UP: 'Follow-up',
  WRAP_UP: 'Wrapping up',
  SCORING: 'Scoring…',
  FEEDBACK: 'Feedback',
  ENDED: 'Ended',
}

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

  // Handle recording stop: stop recorder, upload blob
  const handleRecordingStop = useCallback(async () => {
    const blob = await stopRecording()
    if (!blob) return

    // Fire-and-forget upload (don't delay redirect)
    const sessionId = interviewRef.current?.sessionId
    if (sessionId) {
      const formData = new FormData()
      formData.append('recording', blob, 'interview-recording.webm')
      formData.append('sessionId', sessionId)
      fetch('/api/recordings/upload', { method: 'POST', body: formData }).catch(() => {
        // Non-critical: recording upload failed
      })
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

  // Ref for accessing sessionId in recording callback
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
    finishInterview,
  } = interview

  // Use liveTranscript from speech recognition as override when actively listening
  const displayAnswer = isListening ? liveTranscript : liveAnswer

  // ─── Load config ───────────────────────────────────────────────────────────

  useEffect(() => {
    const stored = localStorage.getItem('interviewConfig')
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
        // Start recording automatically
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
        <div className="w-6 h-6 rounded-full border-2 border-indigo-400 border-t-transparent animate-spin" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#070b14] flex flex-col">
      {/* ── Header ── */}
      <header className="flex items-center justify-between px-5 py-3 bg-slate-900/80 backdrop-blur border-b border-slate-800 shrink-0">
        <div className="flex items-center gap-2.5">
          <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
          <span className="text-sm font-medium text-slate-300">Live Interview</span>
          <RecordingIndicator
            isRecording={isRecording}
            durationSeconds={recordingDuration}
            hasConsent={true}
          />
        </div>

        <div
          className={`font-mono font-bold tabular-nums text-lg transition-colors ${
            timeRemaining < 60 ? 'text-red-400' : 'text-white'
          }`}
        >
          {formatTime(timeRemaining)}
        </div>

        <div className="flex items-center gap-3">
          <span
            className={`text-xs px-2 py-0.5 rounded-full border ${
              phase === 'LISTENING'
                ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10'
                : 'text-slate-500 border-slate-700'
            }`}
          >
            {PHASE_LABELS[phase] ?? phase}
          </span>
        </div>
      </header>

      {/* ── Video tiles ── */}
      <div className="flex-1 flex gap-4 p-4 min-h-0">
        {/* Interviewer (avatar) */}
        <VideoTile
          label={AVATAR_NAME}
          sublabel={AVATAR_TITLE}
          isActive={isAvatarTalking}
          indicator={
            isAvatarTalking ? (
              <div className="flex items-center gap-0.5">
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className="w-1 bg-indigo-400 rounded-full wave-bar"
                    style={{ height: '10px', animationDelay: `${i * 100}ms` }}
                  />
                ))}
              </div>
            ) : null
          }
        >
          <Avatar emotion={avatarEmotion} isTalking={isAvatarTalking} isListening={isListening} />
        </VideoTile>

        {/* User camera */}
        <VideoTile
          label="You"
          isActive={isListening}
          indicator={
            isListening ? (
              <div className="flex items-center gap-1.5 bg-black/60 backdrop-blur-sm px-2.5 py-1 rounded-full">
                <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />
                <span className="text-xs text-slate-300">Recording</span>
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

      {/* ── Controls ── */}
      <InterviewControls
        muted={muted}
        onToggleMute={toggleMute}
        onEndInterview={finishInterview}
        isScoring={phase === 'SCORING'}
      />
    </div>
  )
}
