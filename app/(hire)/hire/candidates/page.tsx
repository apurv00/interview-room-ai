'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

interface Candidate {
  id: string
  candidateEmail: string
  candidateName: string
  role: string
  interviewType: string
  experience: string
  status: string
  overallScore: number | null
  passProb: string | null
  strengths: string[]
  weaknesses: string[]
  redFlags: string[]
  recruiterNotes: string
  createdAt: string
  completedAt: string | null
  durationSeconds: number | null
}

export default function CandidatesPage() {
  const router = useRouter()
  const { status: authStatus } = useSession()
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  useEffect(() => {
    if (authStatus === 'unauthenticated') { router.push('/signin'); return }
    if (authStatus !== 'authenticated') return

    const params = statusFilter !== 'all' ? `?status=${statusFilter}` : ''
    fetch(`/api/hire/candidates${params}`)
      .then(r => r.json())
      .then(data => setCandidates(data.candidates || []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [authStatus, router, statusFilter])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 rounded-full border-2 border-indigo-400 border-t-transparent animate-spin" />
      </div>
    )
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Candidates</h1>
        <Link
          href="/hire/invite"
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm rounded-xl font-medium transition-colors"
        >
          Invite New
        </Link>
      </div>

      {/* Filters */}
      <div className="flex gap-1 bg-slate-900 border border-slate-800 rounded-xl p-1 w-fit">
        {['all', 'created', 'in_progress', 'completed'].map(f => (
          <button
            key={f}
            onClick={() => { setStatusFilter(f); setLoading(true) }}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
              statusFilter === f ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {f === 'all' ? 'All' : f.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase())}
          </button>
        ))}
      </div>

      {candidates.length === 0 ? (
        <div className="text-center py-12 bg-slate-900 border border-slate-800 rounded-2xl">
          <p className="text-slate-400">No candidates found.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {candidates.map(c => (
            <div key={c.id} className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
              {/* Summary row */}
              <button
                onClick={() => setExpandedId(expandedId === c.id ? null : c.id)}
                className="w-full flex items-center justify-between p-4 hover:bg-slate-800/30 transition-colors text-left"
              >
                <div className="flex items-center gap-4 min-w-0">
                  <div className="w-9 h-9 rounded-full bg-indigo-600/20 flex items-center justify-center text-indigo-400 text-sm font-bold flex-shrink-0">
                    {(c.candidateName || c.candidateEmail)?.[0]?.toUpperCase() || '?'}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-white truncate">
                      {c.candidateName || c.candidateEmail}
                    </p>
                    <p className="text-[11px] text-slate-500">{c.role} &middot; {c.interviewType}</p>
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  {c.overallScore !== null && (
                    <div className="text-right">
                      <p className={`text-lg font-bold ${
                        c.overallScore >= 75 ? 'text-emerald-400' : c.overallScore >= 55 ? 'text-amber-400' : 'text-red-400'
                      }`}>{c.overallScore}</p>
                      <p className="text-[10px] text-slate-500">{c.passProb} pass</p>
                    </div>
                  )}
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                    c.status === 'completed' ? 'bg-emerald-500/20 text-emerald-400' :
                    c.status === 'in_progress' ? 'bg-amber-500/20 text-amber-400' :
                    c.status === 'created' ? 'bg-indigo-500/20 text-indigo-400' :
                    'bg-slate-700 text-slate-400'
                  }`}>
                    {c.status.replace(/_/g, ' ')}
                  </span>
                  <svg className={`w-4 h-4 text-slate-500 transition-transform ${expandedId === c.id ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              </button>

              {/* Expanded details */}
              {expandedId === c.id && (
                <div className="border-t border-slate-800 p-4 space-y-3 animate-fade-in">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                    <div>
                      <span className="text-slate-500">Email</span>
                      <p className="text-slate-300 mt-0.5">{c.candidateEmail}</p>
                    </div>
                    <div>
                      <span className="text-slate-500">Experience</span>
                      <p className="text-slate-300 mt-0.5">{c.experience} years</p>
                    </div>
                    <div>
                      <span className="text-slate-500">Date</span>
                      <p className="text-slate-300 mt-0.5">{new Date(c.createdAt).toLocaleDateString()}</p>
                    </div>
                    <div>
                      <span className="text-slate-500">Duration</span>
                      <p className="text-slate-300 mt-0.5">{c.durationSeconds ? `${Math.round(c.durationSeconds / 60)}m` : '—'}</p>
                    </div>
                  </div>

                  {c.strengths.length > 0 && (
                    <div>
                      <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Strengths</p>
                      <ul className="space-y-1">
                        {c.strengths.map((s, i) => (
                          <li key={i} className="text-xs text-emerald-400 flex items-start gap-1.5">
                            <span className="mt-0.5">+</span> {s}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {c.weaknesses.length > 0 && (
                    <div>
                      <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Areas for Improvement</p>
                      <ul className="space-y-1">
                        {c.weaknesses.map((w, i) => (
                          <li key={i} className="text-xs text-amber-400 flex items-start gap-1.5">
                            <span className="mt-0.5">-</span> {w}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {c.redFlags.length > 0 && (
                    <div>
                      <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Red Flags</p>
                      <div className="flex flex-wrap gap-1.5">
                        {c.redFlags.map((f, i) => (
                          <span key={i} className="px-2 py-0.5 bg-red-500/10 border border-red-500/20 rounded text-[10px] text-red-400">
                            {f}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {c.recruiterNotes && (
                    <div>
                      <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Recruiter Notes</p>
                      <p className="text-xs text-slate-400">{c.recruiterNotes}</p>
                    </div>
                  )}

                  {c.status === 'completed' && (
                    <Link
                      href={`/feedback/${c.id}`}
                      className="inline-block text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
                    >
                      View Full Report →
                    </Link>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
