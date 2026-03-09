'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { ROLE_LABELS } from '@/lib/interviewConfig'

interface SessionSummary {
  _id: string
  config: { role: string; experience: string; duration: number }
  status: string
  feedback?: { overall_score: number; pass_probability: string }
  createdAt: string
  durationActualSeconds?: number
}

const STATUS_COLORS: Record<string, string> = {
  completed: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30',
  in_progress: 'text-amber-400 bg-amber-500/10 border-amber-500/30',
  abandoned: 'text-red-400 bg-red-500/10 border-red-500/30',
  created: 'text-slate-400 bg-slate-500/10 border-slate-500/30',
}

export default function HistoryPage() {
  const router = useRouter()
  const { data: session, status: authStatus } = useSession()
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)

  useEffect(() => {
    if (authStatus === 'unauthenticated') {
      router.push('/signin')
      return
    }
    if (authStatus !== 'authenticated') return

    async function fetchSessions() {
      try {
        const res = await fetch(`/api/interviews?page=${page}&limit=10`)
        if (res.ok) {
          const data = await res.json()
          setSessions(data.sessions)
          setTotalPages(data.pagination.totalPages)
        }
      } catch {
        // Silently handle
      } finally {
        setLoading(false)
      }
    }

    fetchSessions()
  }, [authStatus, page, router])

  if (loading) {
    return (
      <div className="min-h-screen bg-[#070b14] flex items-center justify-center">
        <div className="w-6 h-6 rounded-full border-2 border-indigo-400 border-t-transparent animate-spin" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#070b14] text-white">
      <header className="px-6 py-5 border-b border-slate-800 bg-slate-900/50 backdrop-blur sticky top-0 z-20">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold">Interview History</h1>
            <p className="text-xs text-slate-400 mt-0.5">
              {sessions.length > 0 ? `${sessions.length} sessions` : 'No interviews yet'}
            </p>
          </div>
          <div className="flex gap-3">
            <button
              onClick={() => router.push('/')}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 rounded-xl text-sm font-medium transition"
            >
              New Interview
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8">
        {sessions.length === 0 ? (
          <div className="text-center py-20">
            <p className="text-slate-500 mb-4">You haven&apos;t completed any interviews yet.</p>
            <button
              onClick={() => router.push('/')}
              className="px-6 py-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl font-medium transition"
            >
              Start Your First Interview
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {sessions.map((s) => (
              <button
                key={s._id}
                onClick={() => {
                  if (s.status === 'completed') {
                    router.push(`/feedback/${s._id}`)
                  }
                }}
                className="w-full bg-slate-900 border border-slate-800 rounded-2xl p-5 flex items-center gap-4 hover:border-slate-700 transition text-left"
              >
                <div className="w-12 h-12 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center">
                  <span className="text-lg font-bold text-indigo-400">
                    {s.feedback?.overall_score || '--'}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-slate-200">
                      {ROLE_LABELS[s.config.role as keyof typeof ROLE_LABELS] || s.config.role}
                    </span>
                    <span className="text-xs text-slate-500">
                      {s.config.experience} yrs · {s.config.duration} min
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {new Date(s.createdAt).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </p>
                </div>
                <div className={`px-2.5 py-1 rounded-full border text-xs font-medium capitalize ${STATUS_COLORS[s.status] || STATUS_COLORS.created}`}>
                  {s.status.replace('_', ' ')}
                </div>
                {s.feedback?.pass_probability && (
                  <div className="text-xs text-slate-500">
                    {s.feedback.pass_probability} pass
                  </div>
                )}
              </button>
            ))}

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex justify-center gap-2 pt-4">
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-sm disabled:opacity-40"
                >
                  Previous
                </button>
                <span className="px-3 py-1.5 text-sm text-slate-400">
                  {page} of {totalPages}
                </span>
                <button
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  className="px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-sm disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  )
}
