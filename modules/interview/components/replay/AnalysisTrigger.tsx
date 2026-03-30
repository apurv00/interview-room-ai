'use client'

import { useState, useEffect, useCallback } from 'react'
import { Sparkles, Loader2, AlertCircle, ArrowRight } from 'lucide-react'
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

export default function AnalysisTrigger({ sessionId, onAnalysisComplete }: AnalysisTriggerProps) {
  const [status, setStatus] = useState<AnalysisStatus | 'idle'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [quota, setQuota] = useState<QuotaInfo | null>(null)

  // Fetch quota on mount
  useEffect(() => {
    fetch('/api/analysis/quota')
      .then((r) => r.json())
      .then((data) => setQuota(data))
      .catch(() => {}) // non-critical
  }, [])

  // Poll for status when processing
  useEffect(() => {
    if (status !== 'pending' && status !== 'processing') return

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/analysis/${sessionId}`)
        if (!res.ok) return
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
        }
      } catch {
        // Continue polling on fetch error
      }
    }, 3000)

    return () => clearInterval(interval)
  }, [status, sessionId, onAnalysisComplete])

  const startAnalysis = useCallback(async () => {
    setError(null)
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
        <p className="text-sm text-red-300">{error}</p>
        <button
          onClick={startAnalysis}
          className="px-4 py-2 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-300 text-sm transition-colors"
        >
          Retry Analysis
        </button>
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
