'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { Sparkles, Loader2, AlertCircle, ArrowRight, AlertTriangle } from 'lucide-react'
import type { AnalysisStatus } from '@shared/types/multimodal'

interface AnalysisTriggerProps {
  sessionId: string
  onAnalysisComplete: () => void
}

interface QuotaInfo {
  used: number
  limit: number
  remaining: number
  plan: string
}

// If the analysis stays in 'pending' (never advances to 'processing') for
// longer than this, surface a "stuck" warning so users aren't trapped on a
// silent spinner.
const STUCK_WARNING_MS = 2 * 60 * 1000

export default function AnalysisTrigger({ sessionId, onAnalysisComplete }: AnalysisTriggerProps) {
  const [status, setStatus] = useState<AnalysisStatus | 'idle'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [quota, setQuota] = useState<QuotaInfo | null>(null)
  const [isStuck, setIsStuck] = useState(false)
  const [resetting, setResetting] = useState(false)
  const pollStartedAtRef = useRef<number | null>(null)

  const refreshQuota = useCallback(() => {
    fetch('/api/analysis/quota')
      .then((r) => r.json())
      .then((data) => setQuota(data))
      .catch(() => {}) // non-critical
  }, [])

  // Fetch quota AND any in-progress analysis on mount. The latter lets a
  // returning user resume the spinner instead of seeing "quota reached" for
  // a job that's still running in the background.
  useEffect(() => {
    refreshQuota()

    fetch(`/api/analysis/${sessionId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return
        if (data.status === 'pending' || data.status === 'processing') {
          setStatus(data.status)
        } else if (data.status === 'failed') {
          setError(data.error || 'Analysis failed')
          setStatus('failed')
        }
        // 'completed' is handled by the parent replay page, not here.
      })
      .catch(() => {}) // non-critical
  }, [sessionId, refreshQuota])

  // Poll for status when processing
  useEffect(() => {
    if (status !== 'pending' && status !== 'processing') {
      pollStartedAtRef.current = null
      setIsStuck(false)
      return
    }

    if (pollStartedAtRef.current === null) {
      pollStartedAtRef.current = Date.now()
    }

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/analysis/${sessionId}`)
        if (!res.ok) {
          // Treat repeated 404s after the start call as a stuck state — the
          // record either was never created or was deleted out from under us.
          if (
            pollStartedAtRef.current !== null &&
            Date.now() - pollStartedAtRef.current > STUCK_WARNING_MS
          ) {
            setIsStuck(true)
          }
          return
        }
        const data = await res.json()

        if (data.status === 'completed') {
          setStatus('completed')
          clearInterval(interval)
          onAnalysisComplete()
        } else if (data.status === 'failed') {
          setStatus('failed')
          setError(data.error || 'Analysis failed')
          clearInterval(interval)
        } else {
          setStatus(data.status)
          // If we've been waiting more than STUCK_WARNING_MS and the status
          // hasn't even reached 'processing', the background worker is
          // almost certainly not picking up the event.
          if (
            data.status === 'pending' &&
            pollStartedAtRef.current !== null &&
            Date.now() - pollStartedAtRef.current > STUCK_WARNING_MS
          ) {
            setIsStuck(true)
          }
        }
      } catch {
        // Continue polling on fetch error
      }
    }, 3000)

    return () => clearInterval(interval)
  }, [status, sessionId, onAnalysisComplete])

  const startAnalysis = useCallback(async () => {
    setError(null)
    setIsStuck(false)
    pollStartedAtRef.current = null
    setStatus('pending')

    try {
      const res = await fetch('/api/analysis/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })

      const data = await res.json()

      if (!res.ok) {
        setError(data.error || 'Failed to start analysis')
        setStatus('idle')
        return
      }

      if (data.status === 'completed') {
        setStatus('completed')
        onAnalysisComplete()
      } else {
        setStatus(data.status)
      }
    } catch {
      setError('Network error — please try again')
      setStatus('idle')
    }
  }, [sessionId, onAnalysisComplete])

  // Force-retry: hit the reset endpoint to clear whatever state exists
  // server-side, then immediately start a fresh analysis. Used by the
  // "stuck" warning card and as a recovery path after errors.
  const forceRetry = useCallback(async () => {
    setResetting(true)
    setError(null)
    setIsStuck(false)
    try {
      await fetch(`/api/analysis/${sessionId}/reset`, { method: 'DELETE' }).catch(() => {})
      refreshQuota()
      pollStartedAtRef.current = null
      setStatus('idle')
    } finally {
      setResetting(false)
    }
    // Defer startAnalysis to the next tick so the 'idle' state flushes first.
    setTimeout(() => startAnalysis(), 0)
  }, [sessionId, refreshQuota, startAnalysis])

  // Stuck state — pending for >2 min and never advanced. Usually means
  // the server function got killed mid-pipeline (timeout / cold start
  // miss / crash) before the DB row was updated.
  if ((status === 'pending' || status === 'processing') && isStuck) {
    return (
      <div className="flex flex-col items-center gap-4 p-8 rounded-xl bg-amber-900/20 border border-amber-500/30">
        <AlertTriangle className="w-8 h-8 text-amber-400" />
        <div className="text-center">
          <p className="text-lg font-medium text-amber-200">Analysis is taking longer than expected</p>
          <p className="text-sm text-amber-300/80 mt-1">
            The background worker hasn&apos;t reported progress in over two minutes. This usually
            means the job didn&apos;t reach the worker. You can force a fresh attempt below — your
            quota won&apos;t be charged twice for the stuck job.
          </p>
        </div>
        <button
          onClick={forceRetry}
          disabled={resetting}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 disabled:opacity-50 text-amber-200 text-sm transition-colors"
        >
          {resetting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
          Force retry
        </button>
      </div>
    )
  }

  // Processing state
  if (status === 'pending' || status === 'processing') {
    return (
      <div className="flex flex-col items-center gap-4 p-8 rounded-xl bg-gray-800/50 border border-gray-700/50">
        <Loader2 className="w-10 h-10 animate-spin text-blue-400" />
        <div className="text-center">
          <p className="text-lg font-medium text-gray-200">Analyzing your interview...</p>
          <p className="text-sm text-gray-400 mt-1">
            Processing audio, facial signals, and content — this takes about 30–90 seconds
          </p>
        </div>
        <div className="flex gap-2 text-xs text-gray-500">
          <span className={status === 'pending' ? 'text-blue-400' : 'text-gray-500'}>Queued</span>
          <span>&rarr;</span>
          <span className={status === 'processing' ? 'text-blue-400' : 'text-gray-500'}>Processing</span>
          <span>&rarr;</span>
          <span className="text-gray-500">Complete</span>
        </div>
      </div>
    )
  }

  // Error state
  if (error) {
    return (
      <div className="flex flex-col items-center gap-4 p-8 rounded-xl bg-red-900/20 border border-red-500/30">
        <AlertCircle className="w-8 h-8 text-red-400" />
        <code className="text-sm text-red-300 select-all whitespace-pre-wrap text-center max-w-xl">
          {error}
        </code>
        <div className="flex items-center gap-2">
          <button
            onClick={startAnalysis}
            className="px-4 py-2 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-300 text-sm transition-colors"
          >
            Retry Analysis
          </button>
          <button
            onClick={forceRetry}
            disabled={resetting}
            className="px-4 py-2 rounded-lg bg-red-500/10 hover:bg-red-500/20 disabled:opacity-50 text-red-300/80 text-sm transition-colors"
          >
            {resetting ? 'Resetting…' : 'Force retry'}
          </button>
        </div>
      </div>
    )
  }

  // Quota exceeded
  if (quota && quota.remaining <= 0) {
    return (
      <div className="flex flex-col items-center gap-4 p-8 rounded-xl bg-gray-800/50 border border-gray-700/50">
        <Sparkles className="w-8 h-8 text-gray-400" />
        <div className="text-center">
          <p className="text-lg font-medium text-gray-200">Analysis quota reached</p>
          <p className="text-sm text-gray-400 mt-1">
            You&apos;ve used {quota.used}/{quota.limit} analyses this month on the {quota.plan} plan
          </p>
        </div>
        <a
          href="/pricing"
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-500/20 hover:bg-blue-500/30 text-blue-300 text-sm transition-colors"
        >
          Upgrade for more <ArrowRight className="w-4 h-4" />
        </a>
      </div>
    )
  }

  // Ready to analyze
  return (
    <div className="flex flex-col items-center gap-4 p-8 rounded-xl bg-gray-800/50 border border-gray-700/50">
      <Sparkles className="w-10 h-10 text-blue-400" />
      <div className="text-center">
        <p className="text-lg font-medium text-gray-200">Multimodal Interview Analysis</p>
        <p className="text-sm text-gray-400 mt-1">
          Get detailed insights from your audio, facial expressions, and content — powered by AI
        </p>
      </div>
      <button
        onClick={startAnalysis}
        className="flex items-center gap-2 px-6 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors"
      >
        <Sparkles className="w-4 h-4" />
        Run Analysis
        {quota && (
          <span className="text-blue-200/60 text-xs">
            ({quota.remaining} remaining)
          </span>
        )}
      </button>
    </div>
  )
}
