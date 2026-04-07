'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { getDomainLabel } from '@interview/config/interviewConfig'
import Badge from '@shared/ui/Badge'
import StateView from '@shared/ui/StateView'
import Button from '@shared/ui/Button'
import SignedOutEmptyState from '@shared/ui/SignedOutEmptyState'

interface SessionSummary {
  _id: string
  config: { role: string; experience: string; duration: number }
  status: string
  feedback?: { overall_score: number; pass_probability: string }
  createdAt: string
  durationActualSeconds?: number
  hasRecording?: boolean
}

const STATUS_BADGE_VARIANT: Record<string, 'success' | 'caution' | 'danger' | 'default'> = {
  completed: 'success',
  in_progress: 'caution',
  abandoned: 'danger',
  created: 'default',
}

export default function HistoryPage() {
  const router = useRouter()
  const { status: authStatus } = useSession()
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)

  useEffect(() => {
    if (authStatus !== 'authenticated') {
      setLoading(false)
      return
    }

    async function fetchSessions() {
      setError(null)
      try {
        const res = await fetch(`/api/interviews?page=${page}&limit=10`)
        if (res.ok) {
          const data = await res.json()
          setSessions(data.sessions)
          setTotalPages(data.pagination.totalPages)
        } else {
          setError('Failed to load interview history. Please try again.')
        }
      } catch {
        setError('Network error. Please check your connection and try again.')
      } finally {
        setLoading(false)
      }
    }

    fetchSessions()
  }, [authStatus, page])

  if (authStatus === 'unauthenticated') {
    return (
      <main className="min-h-screen bg-white">
        <SignedOutEmptyState
          reason="view_history"
          headline="See your past interviews here"
          description="Once you sign in and run an interview, your sessions and feedback show up on this page."
        />
      </main>
    )
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="w-6 h-6 rounded-full border-2 border-[#2563eb] border-t-transparent animate-spin" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-white text-[#0f1419] animate-fade-in">
      <header className="px-6 py-5 border-b border-[#e1e8ed] bg-white/90 backdrop-blur-xl sticky top-[52px] z-20">
        <div className="max-w-[800px] mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-heading">Interview History</h1>
            <p className="text-caption text-[#71767b] mt-0.5">
              {sessions.length > 0 ? `${sessions.length} sessions` : 'No interviews yet'}
            </p>
          </div>
          <div className="flex gap-3">
            <Button variant="primary" size="md" onClick={() => router.push('/')}>
              New Interview
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-[800px] mx-auto px-4 py-8">
        {error ? (
          <StateView
            state="error"
            error={error}
            onRetry={() => { setLoading(true); setError(null); setPage(1) }}
          />
        ) : sessions.length === 0 ? (
          <StateView
            state="empty"
            icon={
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            }
            title="No interviews yet"
            description="Start your first mock interview and get AI-powered feedback."
            action={{ label: 'Start Your First Interview', onClick: () => router.push('/') }}
          />
        ) : (
          <div className="space-y-3">
            {sessions.map((s) => (
              <button
                key={s._id}
                onClick={() => {
                  if (s.status === 'in_progress') {
                    router.push(`/interview?sessionId=${s._id}`)
                  } else {
                    router.push(`/feedback/${s._id}`)
                  }
                }}
                className="w-full bg-white border border-[#e1e8ed] rounded-2xl p-5 flex items-center gap-4 hover:border-[#cfd9de] hover:bg-[#f8fafc] transition text-left cursor-pointer"
              >
                {/* Score badge */}
                <div className="w-11 h-11 rounded-[10px] bg-blue-50 flex items-center justify-center flex-shrink-0">
                  <span className="text-lg font-bold text-[#2563eb]">
                    {s.feedback?.overall_score || '--'}
                  </span>
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-[#0f1419]">
                      {getDomainLabel(s.config.role)}
                    </span>
                    <Badge variant={STATUS_BADGE_VARIANT[s.status] || 'default'}>
                      {s.status.replace('_', ' ')}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-xs text-[#536471]">
                      {s.config.experience} yrs · {s.config.duration} min
                    </span>
                    <span className="text-xs text-[#71767b]">·</span>
                    <span className="text-xs text-[#536471] font-medium">
                      {new Date(s.createdAt).toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                    {s.feedback?.pass_probability && (
                      <>
                        <span className="text-xs text-[#71767b]">·</span>
                        <span className="text-xs text-[#536471]">
                          {s.feedback.pass_probability} pass
                        </span>
                      </>
                    )}
                    {s.hasRecording && s.status === 'completed' && (
                      <>
                        <span className="text-xs text-[#71767b]">·</span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            router.push(`/replay/${s._id}`)
                          }}
                          className="text-xs text-brand-500 hover:underline"
                        >
                          Replay
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* Chevron */}
                <svg className="w-4 h-4 text-[#71767b] flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
              </button>
            ))}

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex justify-center items-center gap-2 pt-4">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                >
                  Previous
                </Button>
                <span className="px-3 py-1.5 text-sm text-[#536471]">
                  {page} of {totalPages}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                >
                  Next
                </Button>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  )
}
