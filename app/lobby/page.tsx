'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import type { InterviewConfig } from '@shared/types'
import { getDomainLabel } from '@interview/config/interviewConfig'
import { STORAGE_KEYS } from '@shared/storageKeys'
import { COMPANY_PROFILES } from '@interview/config/companyProfiles'
import PrepChecklist from '@interview/components/PrepChecklist'

type CheckStatus = 'pending' | 'ok' | 'error'

interface Check {
  label: string
  status: CheckStatus
  detail?: string
}

// ─── Icons ────────────────────────────────────────────────────────────────────

function CheckIcon() {
  return (
    <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  )
}

function XIcon() {
  return (
    <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  )
}

function DocIcon() {
  return (
    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  )
}

// ─── Stagger animation config ─────────────────────────────────────────────────

const containerVariants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.08, delayChildren: 0.1 },
  },
}

const itemVariants = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: 'easeOut' } },
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function LobbyPage() {
  const router = useRouter()
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const animFrameRef = useRef<number>(0)

  const [config, setConfig] = useState<InterviewConfig | null>(null)
  const [lobbyCompany, setLobbyCompany] = useState('')
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [checks, setChecks] = useState<Check[]>([
    { label: 'Camera', status: 'pending' },
    { label: 'Microphone', status: 'pending' },
    { label: 'Speech recognition', status: 'pending' },
    { label: 'Network', status: 'pending' },
  ])
  const [allOk, setAllOk] = useState(false)
  const [joining, setJoining] = useState(false)
  const [audioLevel, setAudioLevel] = useState(0)
  const [joinCountdown, setJoinCountdown] = useState(0)

  // Load config
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEYS.INTERVIEW_CONFIG)
    if (!stored) { router.push('/'); return }
    setConfig(JSON.parse(stored))
  }, [router])

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
      // Fire warm-up ping immediately (absorbs serverless cold start while user grants permissions)
      fetch('/api/health', { method: 'HEAD', cache: 'no-store' }).catch(() => {})

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
        streamRef.current = stream
        if (videoRef.current) videoRef.current.srcObject = stream
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

      await new Promise(r => setTimeout(r, 400))
      const hasSR = 'SpeechRecognition' in window || 'webkitSpeechRecognition' in window
      setChecks(prev => prev.map(c =>
        c.label === 'Speech recognition'
          ? { ...c, status: hasSR ? 'ok' : 'error', detail: hasSR ? 'Browser supported' : 'Use Chrome or Edge' }
          : c
      ))

      await new Promise(r => setTimeout(r, 200))
      // Network check — run twice: first to warm up serverless function, second for real measurement
      try {
        // Warm-up ping (absorbs cold start, result ignored)
        await fetch('/api/health', { method: 'HEAD', cache: 'no-store' }).catch(() => {})

        const start = performance.now()
        const res = await fetch('/api/health', { method: 'HEAD', cache: 'no-store' })
        const latency = Math.round(performance.now() - start)
        if (res.ok) {
          setChecks(prev => prev.map(c =>
            c.label === 'Network'
              ? { ...c, status: latency < 1500 ? 'ok' : 'error', detail: latency < 1500 ? `${latency}ms latency` : `High latency (${latency}ms)` }
              : c
          ))
        } else {
          setChecks(prev => prev.map(c =>
            c.label === 'Network' ? { ...c, status: 'error', detail: 'Server returned an error' } : c
          ))
        }
      } catch {
        setChecks(prev => prev.map(c =>
          c.label === 'Network' ? { ...c, status: 'error', detail: 'Could not reach server' } : c
        ))
      }
    }

    runChecks()

    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop())
        streamRef.current = null
      }
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config])

  // Update allOk
  useEffect(() => {
    const done = checks.every(c => c.status !== 'pending')
    const ok = checks.every(c => c.status === 'ok')
    if (done) setAllOk(ok)
  }, [checks])

  // Joining countdown
  useEffect(() => {
    if (!joining) return
    setJoinCountdown(3)
    const interval = setInterval(() => {
      setJoinCountdown(prev => {
        if (prev <= 1) {
          clearInterval(interval)
          router.push('/interview')
          return 0
        }
        return prev - 1
      })
    }, 700)
    return () => clearInterval(interval)
  }, [joining, router])

  function enterRoom() {
    // Save optional company context to config before entering
    if (lobbyCompany.trim() && config) {
      const updated = { ...config, targetCompany: lobbyCompany.trim() }
      setConfig(updated)
      localStorage.setItem(STORAGE_KEYS.INTERVIEW_CONFIG, JSON.stringify(updated))
    }
    setJoining(true)
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
  }

  const StatusIcon = ({ status }: { status: CheckStatus }) => {
    if (status === 'pending') return (
      <div className="w-5 h-5 rounded-full border-2 border-[#e1e8ed] border-t-[#6366f1] animate-spin" />
    )
    if (status === 'ok') return (
      <motion.div
        className="w-5 h-5 rounded-full bg-emerald-500 flex items-center justify-center"
        initial={{ scale: 0 }}
        animate={{ scale: 1 }}
        transition={{ type: 'spring', stiffness: 500, damping: 25 }}
      >
        <CheckIcon />
      </motion.div>
    )
    return (
      <motion.div
        className="w-5 h-5 rounded-full bg-red-500 flex items-center justify-center"
        initial={{ scale: 0 }}
        animate={{ scale: 1 }}
        transition={{ type: 'spring', stiffness: 500, damping: 25 }}
      >
        <XIcon />
      </motion.div>
    )
  }

  // Audio level meter color
  const meterColor = audioLevel > 80
    ? 'rgb(239,68,68)'
    : audioLevel > 20
    ? 'rgb(16,185,129)'
    : 'rgb(100,116,139)'

  return (
    <main className="min-h-screen flex items-center justify-center px-3 sm:px-4 py-8 sm:py-12">
      <motion.div
        className="w-full max-w-4xl space-y-8"
        variants={containerVariants}
        initial="hidden"
        animate="show"
      >
        {/* Header */}
        <motion.div className="text-center space-y-2" variants={itemVariants}>
          <h1 className="text-2xl sm:text-3xl font-bold text-[#0f1419]">Pre-Interview Check</h1>
          {config && (
            <div className="space-y-2">
              <p className="text-[#536471]">
                {getDomainLabel(config.role)}
                {config.interviewType && config.interviewType !== 'screening' && ` · ${config.interviewType.split('-').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}`}
                {' '}· {config.experience} yrs · {config.duration} min session
              </p>

              {/* Document badges */}
              {(config.jdFileName || config.resumeFileName) && (
                <div className="flex items-center justify-center gap-2.5 flex-wrap">
                  {config.jdFileName && (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-xs text-emerald-600">
                      <DocIcon />
                      JD: {config.jdFileName}
                    </span>
                  )}
                  {config.resumeFileName && (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-xs text-emerald-600">
                      <DocIcon />
                      Resume: {config.resumeFileName}
                    </span>
                  )}
                  <button
                    onClick={() => router.push('/')}
                    className="text-xs text-[#71767b] hover:text-[#6366f1] transition underline underline-offset-2"
                  >
                    Change
                  </button>
                </div>
              )}
            </div>
          )}
        </motion.div>

        <div className="grid md:grid-cols-2 gap-5">
          {/* Camera preview */}
          <motion.div className="space-y-3" variants={itemVariants}>
            <div className="relative aspect-video rounded-2xl overflow-hidden bg-[#f7f9f9] border border-[#e1e8ed]">
              <video
                ref={videoRef}
                autoPlay
                muted
                playsInline
                className="w-full h-full object-cover scale-x-[-1]"
              />
              <div className="absolute bottom-3 left-3 bg-white/80 backdrop-blur-md px-3 py-1.5 rounded-lg border border-[#e1e8ed] text-xs text-[#536471] font-medium">
                Camera preview
              </div>

              {/* Joining overlay */}
              <AnimatePresence>
                {joining && (
                  <motion.div
                    className="absolute inset-0 bg-white/80 backdrop-blur-sm flex flex-col items-center justify-center gap-3"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                  >
                    <motion.div
                      className="text-4xl font-bold text-[#0f1419]"
                      key={joinCountdown}
                      initial={{ scale: 0.5, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      exit={{ scale: 1.5, opacity: 0 }}
                      transition={{ duration: 0.3 }}
                    >
                      {joinCountdown || ''}
                    </motion.div>
                    <p className="text-sm text-[#536471]">Joining interview room...</p>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Audio level meter */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs text-[#71767b] font-medium">Microphone level</span>
                <span className="text-xs text-[#8b98a5] tabular-nums font-mono">{Math.round(audioLevel)}%</span>
              </div>
              <div className="h-1.5 bg-[#eff3f4] rounded-full overflow-hidden">
                <motion.div
                  className="h-full rounded-full"
                  animate={{ width: `${audioLevel}%`, backgroundColor: meterColor }}
                  transition={{ duration: 0.075, ease: 'linear' }}
                />
              </div>
              <p className="text-xs text-[#8b98a5]">
                {audioLevel > 20 ? 'Mic is picking up audio — you\'re good to go.' : 'Say something to test your microphone.'}
              </p>
            </div>
          </motion.div>

          {/* Checks + tips */}
          <motion.div className="space-y-4" variants={itemVariants}>
            {/* System checks */}
            <div className="bg-white backdrop-blur-sm border border-[#e1e8ed] rounded-2xl p-5 space-y-4">
              <h2 className="text-sm font-semibold text-[#0f1419]">System checks</h2>
              {checks.map((check) => (
                <div key={check.label} className="flex items-center gap-3">
                  <StatusIcon status={check.status} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-[#0f1419]">{check.label}</div>
                    <AnimatePresence>
                      {check.detail && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          className={`text-xs ${check.status === 'error' ? 'text-[#f4212e]' : 'text-[#71767b]'}`}
                        >
                          {check.detail}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </div>
              ))}
            </div>

            {/* Interview Prep Checklist */}
            {config && (
              <PrepChecklist
                domainSlug={config.role}
                domainLabel={getDomainLabel(config.role)}
                duration={config.duration}
              />
            )}

            {/* Optional company input with autocomplete (when no JD-extracted company) */}
            {config && !config.targetCompany && (
              <div className="bg-white border border-[#e1e8ed] rounded-2xl p-4">
                <label className="text-xs font-medium text-[#536471] block mb-1.5">
                  Preparing for a specific company? (optional)
                </label>
                <div className="relative">
                  <input
                    type="text"
                    value={lobbyCompany}
                    onChange={(e) => { setLobbyCompany(e.target.value); setShowSuggestions(true) }}
                    onFocus={() => setShowSuggestions(true)}
                    onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                    placeholder="e.g. Google, Stripe, McKinsey..."
                    className="w-full text-sm px-3 py-2 border border-[#e1e8ed] rounded-xl bg-[#f7f9f9] focus:outline-none focus:ring-2 focus:ring-[#6366f1]/30 focus:border-[#6366f1] transition-colors placeholder:text-[#8b98a5]"
                  />
                  {showSuggestions && lobbyCompany.length >= 1 && (
                    (() => {
                      const filtered = COMPANY_PROFILES.filter(p =>
                        p.name.toLowerCase().includes(lobbyCompany.toLowerCase()) ||
                        p.aliases.some(a => a.toLowerCase().includes(lobbyCompany.toLowerCase()))
                      ).slice(0, 5)
                      if (filtered.length === 0 || (filtered.length === 1 && filtered[0].name.toLowerCase() === lobbyCompany.toLowerCase())) return null
                      return (
                        <div className="absolute z-10 w-full mt-1 bg-white border border-[#e1e8ed] rounded-xl shadow-lg overflow-hidden">
                          {filtered.map(p => (
                            <button
                              key={p.name}
                              type="button"
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => { setLobbyCompany(p.name); setShowSuggestions(false) }}
                              className="w-full text-left px-3 py-2 text-sm hover:bg-[#f7f9f9] transition-colors flex items-center justify-between"
                            >
                              <span className="font-medium text-[#0f1419]">{p.name}</span>
                              <span className="text-xs text-[#8b98a5]">{p.industry}</span>
                            </button>
                          ))}
                        </div>
                      )
                    })()
                  )}
                </div>
              </div>
            )}

            {/* CTA */}
            <AnimatePresence mode="wait">
              {!joining ? (
                <motion.button
                  key="join-btn"
                  onClick={enterRoom}
                  disabled={!allOk}
                  whileHover={allOk ? { scale: 1.01 } : {}}
                  whileTap={allOk ? { scale: 0.99 } : {}}
                  className={`
                    w-full py-4 rounded-2xl font-semibold text-sm transition-colors
                    ${allOk
                      ? 'bg-[#6366f1] hover:bg-indigo-500 text-white btn-glow'
                      : 'bg-[#f7f9f9] text-[#8b98a5] cursor-not-allowed border border-[#e1e8ed]'
                    }
                  `}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                >
                  {allOk ? 'Join Interview Room' : 'Waiting for checks...'}
                </motion.button>
              ) : (
                <motion.div
                  key="joining-state"
                  className="w-full py-4 rounded-2xl bg-[#6366f1]/10 border border-[#6366f1]/20 flex items-center justify-center gap-3"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                >
                  <div className="w-4 h-4 rounded-full border-2 border-[#6366f1] border-t-transparent animate-spin" />
                  <span className="text-[#6366f1] text-sm font-medium">Interviewer joining...</span>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        </div>

        <motion.div className="text-center" variants={itemVariants}>
          <button
            onClick={() => router.push('/')}
            className="text-sm text-[#71767b] hover:text-[#0f1419] transition inline-flex items-center gap-1.5"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            Back to settings
          </button>
        </motion.div>
      </motion.div>
    </main>
  )
}
