'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { motion } from 'framer-motion'
import { Clock, RotateCcw, ArrowRight } from 'lucide-react'
import { STORAGE_KEYS } from '@shared/storageKeys'

interface RecentSession {
  _id: string
  config?: { role?: string; interviewType?: string }
  feedback?: { overall_score?: number }
  createdAt?: string
  completedAt?: string
}

function formatDate(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  const now = Date.now()
  const diff = now - d.getTime()
  const day = 24 * 60 * 60 * 1000
  if (diff < day) return 'Today'
  if (diff < 2 * day) return 'Yesterday'
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/**
 * Recent-sessions strip shown on /learn/pathway. Each row is a compact view
 * of a past completed session with an inline "Retake" button that kicks off
 * the retake flow (same as the feedback-page CTA). Closes the usability
 * loop by surfacing "things I did → thing I can try again" in one place.
 */
export default function RecentSessionsStrip() {
  const router = useRouter()
  const [sessions, setSessions] = useState<RecentSession[]>([])
  const [loading, setLoading] = useState(true)
  const [retakingId, setRetakingId] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/interviews?limit=3&status=completed')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        setSessions((data?.sessions as RecentSession[]) || [])
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  const handleRetake = async (sessionId: string) => {
    setRetakingId(sessionId)
    try {
      const res = await fetch(`/api/interviews/${sessionId}/retake`, { method: 'POST' })
      if (!res.ok) {
        setRetakingId(null)
        return
      }
      const { parentSessionId } = await res.json()
      // Fetch the full parent session so we can pre-fill the form with the
      // original JD/resume/config, not just the summary from /retake.
      try {
        const sRes = await fetch(`/api/interviews/${sessionId}?excludeTranscript=true`)
        if (sRes.ok) {
          const full = await sRes.json()
          if (full?.config) {
            localStorage.setItem(STORAGE_KEYS.INTERVIEW_CONFIG, JSON.stringify(full.config))
          }
        }
        localStorage.setItem(STORAGE_KEYS.PENDING_RETAKE_PARENT, parentSessionId || sessionId)
        localStorage.removeItem(STORAGE_KEYS.INTERVIEW_ACTIVE_SESSION)
      } catch { /* ignore */ }
      router.push(`/interview/setup?retake=${parentSessionId || sessionId}`)
    } catch {
      setRetakingId(null)
    }
  }

  if (loading) {
    return (
      <div className="surface-card-bordered p-5 animate-pulse">
        <div className="h-4 bg-[#eff3f4] rounded w-32 mb-3" />
        <div className="space-y-2">
          <div className="h-10 bg-[#eff3f4] rounded" />
          <div className="h-10 bg-[#eff3f4] rounded" />
        </div>
      </div>
    )
  }

  if (sessions.length === 0) return null

  return (
    <motion.section
      className="surface-card-bordered p-5 sm:p-6"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.15 }}
    >
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-[#0f1419]">Recent sessions</h2>
        <Link
          href="/history"
          className="text-xs text-blue-600 hover:text-blue-700 flex items-center gap-1"
        >
          View all <ArrowRight className="w-3 h-3" />
        </Link>
      </div>
      <div className="space-y-2">
        {sessions.map((s) => {
          const score = s.feedback?.overall_score
          const role = s.config?.role || 'Interview'
          const interviewType = s.config?.interviewType || ''
          return (
            <div
              key={s._id}
              className="flex items-center gap-3 p-3 rounded-xl bg-[#f8fafc] border border-[#eff3f4]"
            >
              <div className="shrink-0 w-8 h-8 rounded-lg bg-white border border-[#e1e8ed] flex items-center justify-center">
                <Clock className="w-4 h-4 text-[#71767b]" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-[#0f1419] capitalize truncate">
                  {role.replace(/_/g, ' ')}
                  {interviewType && (
                    <span className="text-[#71767b] font-normal">
                      {' · '}
                      {interviewType}
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-[#8b98a5]">
                  {formatDate(s.completedAt || s.createdAt)}
                  {score != null && (
                    <span className="ml-2">
                      Score: <span className="font-medium text-[#536471]">{score}</span>
                    </span>
                  )}
                </div>
              </div>
              <Link
                href={`/feedback/${s._id}`}
                className="shrink-0 text-xs text-[#536471] hover:text-[#0f1419] px-2 py-1 rounded transition-colors"
              >
                View
              </Link>
              <button
                type="button"
                onClick={() => handleRetake(s._id)}
                disabled={retakingId === s._id}
                className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/60 text-white text-xs font-medium transition-colors"
              >
                <RotateCcw className="w-3 h-3" />
                {retakingId === s._id ? '…' : 'Retake'}
              </button>
            </div>
          )
        })}
      </div>
    </motion.section>
  )
}
