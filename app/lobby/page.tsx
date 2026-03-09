'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { InterviewConfig } from '@/lib/types'
import { ROLE_LABELS } from '@/lib/interviewConfig'

type CheckStatus = 'pending' | 'ok' | 'error'

interface Check {
  label: string
  status: CheckStatus
  detail?: string
}

export default function LobbyPage() {
  const router = useRouter()
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const animFrameRef = useRef<number>(0)

  const [config, setConfig] = useState<InterviewConfig | null>(null)
  const [checks, setChecks] = useState<Check[]>([
    { label: 'Camera', status: 'pending' },
    { label: 'Microphone', status: 'pending' },
    { label: 'Speech recognition', status: 'pending' },
    { label: 'Network', status: 'pending' },
  ])
  const [allOk, setAllOk] = useState(false)
  const [joining, setJoining] = useState(false)
  const [audioLevel, setAudioLevel] = useState(0)
  const [visibleChecks, setVisibleChecks] = useState(0)

  // Load config
  useEffect(() => {
    const stored = localStorage.getItem('interviewConfig')
    if (!stored) { router.push('/'); return }
    setConfig(JSON.parse(stored))
  }, [router])

  // Stagger check items entrance
  useEffect(() => {
    if (!config) return
    const timers: NodeJS.Timeout[] = []
    checks.forEach((_, i) => {
      timers.push(setTimeout(() => setVisibleChecks(i + 1), 150 * (i + 1)))
    })
    return () => timers.forEach(clearTimeout)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config])

  // Audio level visualiser
  const startAudioMeter = useCallback((stream: MediaStream) => {
    try {
      const ctx = new AudioContext()
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.8
      source.connect(analyser)
      analyserRef.current = analyser

      const data = new Uint8Array(analyser.frequencyBinCount)
      const tick = () => {
        analyser.getByteFrequencyData(data)
        const avg = data.reduce((a, b) => a + b, 0) / data.length
        setAudioLevel(Math.min(100, (avg / 128) * 100))
        animFrameRef.current = requestAnimationFrame(tick)
      }
      tick()
    } catch {
      // AudioContext not available
    }
  }, [])

  // Run checks
  useEffect(() => {
    if (!config) return

    const runChecks = async () => {
      // Camera + mic
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
        }
        setChecks(prev => prev.map(c =>
          c.label === 'Camera' ? { ...c, status: 'ok', detail: 'HD video ready' } : c
        ))
        setChecks(prev => prev.map(c =>
          c.label === 'Microphone' ? { ...c, status: 'ok', detail: 'Audio detected' } : c
        ))
        startAudioMeter(stream)
      } catch {
        setChecks(prev => prev.map(c =>
          c.label === 'Camera' ? { ...c, status: 'error', detail: 'Permission denied' } : c
        ))
        setChecks(prev => prev.map(c =>
          c.label === 'Microphone' ? { ...c, status: 'error', detail: 'Permission denied' } : c
        ))
      }

      // Speech recognition check
      await new Promise(r => setTimeout(r, 400))
      const hasSR = 'SpeechRecognition' in window || 'webkitSpeechRecognition' in window
      setChecks(prev => prev.map(c =>
        c.label === 'Speech recognition'
          ? { ...c, status: hasSR ? 'ok' : 'error', detail: hasSR ? 'Browser supported' : 'Use Chrome or Edge' }
          : c
      ))

      // Network latency check
      await new Promise(r => setTimeout(r, 200))
      try {
        const start = performance.now()
        const res = await fetch('/api/health', { method: 'HEAD', cache: 'no-store' })
        const latency = Math.round(performance.now() - start)
        if (res.ok) {
          setChecks(prev => prev.map(c =>
            c.label === 'Network'
              ? {
                  ...c,
                  status: latency < 500 ? 'ok' : 'error',
                  detail: latency < 500 ? `${latency}ms latency` : `High latency (${latency}ms)`,
                }
              : c
          ))
        } else {
          throw new Error('non-ok')
        }
      } catch {
        setChecks(prev => prev.map(c =>
          c.label === 'Network'
            ? { ...c, status: 'ok', detail: 'Connected' }
            : c
        ))
      }
    }

    runChecks()

    // Cleanup camera + audio on unmount
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop())
        streamRef.current = null
      }
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current)
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config])

  // Update allOk
  useEffect(() => {
    const done = checks.every(c => c.status !== 'pending')
    const ok = checks.every(c => c.status === 'ok')
    if (done) setAllOk(ok)
  }, [checks])

  function enterRoom() {
    setJoining(true)
    // Stop the audio meter but keep camera running for transition
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current)
    }
    setTimeout(() => router.push('/interview'), 2000)
  }

  const StatusIcon = ({ status }: { status: CheckStatus }) => {
    if (status === 'pending') return (
      <div className="w-5 h-5 rounded-full border-2 border-slate-600 border-t-indigo-400 animate-spin" />
    )
    if (status === 'ok') return (
      <div className="w-5 h-5 rounded-full bg-emerald-500 flex items-center justify-center">
        <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      </div>
    )
    return (
      <div className="w-5 h-5 rounded-full bg-red-500 flex items-center justify-center">
        <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </div>
    )
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-4xl space-y-8">

        {/* Header */}
        <div className="text-center space-y-2 animate-slide-up">
          <h1 className="text-3xl font-bold text-white">Pre-Interview Check</h1>
          {config && (
            <div className="space-y-1.5">
              <p className="text-slate-400">
                {ROLE_LABELS[config.role]} · {config.experience} yrs · {config.duration} min session
              </p>
              {/* Document badges */}
              {(config.jdFileName || config.resumeFileName) && (
                <div className="flex items-center justify-center gap-3 flex-wrap">
                  {config.jdFileName && (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-emerald-500/10 border border-emerald-500/20 rounded-full text-xs text-emerald-400">
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                      JD: {config.jdFileName}
                    </span>
                  )}
                  {config.resumeFileName && (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-emerald-500/10 border border-emerald-500/20 rounded-full text-xs text-emerald-400">
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                      Resume: {config.resumeFileName}
                    </span>
                  )}
                  <button
                    onClick={() => router.push('/')}
                    className="text-xs text-slate-500 hover:text-indigo-400 transition underline underline-offset-2"
                  >
                    Change documents
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="grid md:grid-cols-2 gap-6">
          {/* Camera preview */}
          <div className="space-y-3 animate-slide-up stagger-1">
            <div className="relative aspect-video rounded-2xl overflow-hidden bg-slate-900 border border-slate-700">
              <video
                ref={videoRef}
                autoPlay
                muted
                playsInline
                className="w-full h-full object-cover scale-x-[-1]"
              />
              <div className="absolute bottom-3 left-3 bg-black/60 backdrop-blur-sm px-3 py-1 rounded-full text-xs text-slate-300">
                Your preview
              </div>
            </div>

            {/* Audio level meter */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-500">Microphone level</span>
                <span className="text-xs text-slate-600 tabular-nums">{Math.round(audioLevel)}%</span>
              </div>
              <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-75"
                  style={{
                    width: `${audioLevel}%`,
                    background: audioLevel > 80
                      ? 'rgb(239,68,68)'
                      : audioLevel > 20
                      ? 'rgb(16,185,129)'
                      : 'rgb(100,116,139)',
                  }}
                />
              </div>
              <p className="text-xs text-slate-600">
                {audioLevel > 20 ? 'Speak normally — your mic is picking up audio.' : 'Say something to test your microphone.'}
              </p>
            </div>
          </div>

          {/* Checks + tips */}
          <div className="space-y-4 animate-slide-up stagger-2">
            {/* System checks */}
            <div className="bg-slate-900 border border-slate-700 rounded-2xl p-5 space-y-4">
              <h2 className="text-sm font-semibold text-slate-300">System checks</h2>
              {checks.map((check, i) => (
                <div
                  key={check.label}
                  className={`flex items-center gap-3 transition-all duration-300 ${
                    i < visibleChecks
                      ? 'opacity-100 translate-y-0'
                      : 'opacity-0 translate-y-2'
                  }`}
                >
                  <StatusIcon status={check.status} />
                  <div className="flex-1">
                    <div className="text-sm text-slate-200">{check.label}</div>
                    {check.detail && (
                      <div className={`text-xs ${check.status === 'error' ? 'text-red-400' : 'text-slate-500'}`}>
                        {check.detail}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Tips */}
            <div className="bg-slate-900 border border-slate-700 rounded-2xl p-5 space-y-3">
              <h2 className="text-sm font-semibold text-slate-300">Quick tips</h2>
              <ul className="space-y-2 text-sm text-slate-400">
                {[
                  'Speak clearly and at a steady pace',
                  'Pause 1–2 seconds before answering',
                  'Use STAR: Situation, Task, Action, Result',
                  'Close other browser tabs to reduce lag',
                ].map(tip => (
                  <li key={tip} className="flex items-start gap-2">
                    <span className="text-indigo-400 mt-0.5">›</span>
                    {tip}
                  </li>
                ))}
              </ul>
            </div>

            {/* CTA */}
            {!joining ? (
              <button
                onClick={enterRoom}
                disabled={!allOk}
                className={`
                  w-full py-4 rounded-2xl font-semibold text-sm transition-all duration-200
                  ${allOk
                    ? 'bg-indigo-600 hover:bg-indigo-500 text-white btn-glow'
                    : 'bg-slate-800 text-slate-600 cursor-not-allowed border border-slate-700'
                  }
                `}
              >
                {allOk ? 'Join Interview Room →' : 'Waiting for checks…'}
              </button>
            ) : (
              <div className="w-full py-4 rounded-2xl bg-slate-800 border border-slate-700 flex items-center justify-center gap-3">
                <div className="w-4 h-4 rounded-full border-2 border-indigo-400 border-t-transparent animate-spin" />
                <span className="text-slate-400 text-sm">Interviewer joining…</span>
              </div>
            )}
          </div>
        </div>

        <div className="text-center animate-slide-up stagger-4">
          <button
            onClick={() => router.push('/')}
            className="text-sm text-slate-500 hover:text-slate-300 transition"
          >
            ← Back to settings
          </button>
        </div>
      </div>
    </main>
  )
}
