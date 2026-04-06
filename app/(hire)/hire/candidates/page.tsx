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
        <div className="w-6 h-6 rounded-full border-2 border-[#2563eb] border-t-transparent animate-spin" />
      </div>
    )
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[#0f1419]">Candidates</h1>
        <Link
          href="/hire/invite"
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-xl font-medium transition-colors"
        >
          Invite New
        </Link>
      </div>

      {/* Filters */}
      <div className="flex gap-1 bg-white border border-[#e1e8ed] rounded-xl p-1 w-fit">
        {['all', 'created', 'in_progress', 'completed'].map(f => (
          <button
            key={f}
            onClick={() => { setStatusFilter(f); setLoading(true) }}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
              statusFilter === f ? 'bg-blue-600 text-white' : 'text-[#536471] hover:text-[#0f1419]'
            }`}
          >
            {f === 'all' ? 'All' : f.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase())}
          </button>
        ))}
      </div>

      {candidates.length === 0 ? (
        <div className="text-center py-12 bg-white border border-[#e1e8ed] rounded-2xl">
          <p className="text-[#536471]">No candidates found.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {candidates.map(c => (
            <div key={c.id} className="bg-white border border-[#e1e8ed] rounded-2xl overflow-hidden">
              {/* Summary row */}
              <button
                onClick={() => setExpandedId(expandedId === c.id ? null : c.id)}
                className="w-full flex items-center justify-between p-4 hover:bg-[#f7f9f9] transition-colors text-left"
              >
                <div className="flex items-center gap-4 min-w-0">
                  <div className="w-9 h-9 rounded-full bg-blue-600/20 flex items-center justify-center text-[#2563eb] text-sm font-bold flex-shrink-0">
                    {(c.candidateName || c.candidateEmail)?.[0]?.toUpperCase() || '?'}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-[#0f1419] truncate">
                      {c.candidateName || c.candidateEmail}
                    </p>
                    <p className="text-[11px] text-[#8b98a5]">{c.role} &middot; {c.interviewType}</p>
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  {c.overallScore !== null && (
                    <div className="text-right">
                      <p className={`text-lg font-bold ${
                        c.overallScore >= 75 ? 'text-[#059669]' : c.overallScore >= 55 ? 'text-amber-400' : 'text-red-400'
                      }`}>{c.overallScore}</p>
                      <p className="text-[10px] text-[#8b98a5]">{c.passProb} pass</p>
                    </div>
                  )}
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                    c.status === 'completed' ? 'bg-emerald-500/20 text-[#059669]' :
                    c.status === 'in_progress' ? 'bg-amber-500/20 text-amber-400' :
                    c.status === 'created' ? 'bg-blue-500/20 text-[#2563eb]' :
                    'bg-[#f7f9f9] text-[#536471]'
                  }`}>
                    {c.status.replace(/_/g, ' ')}
                  </span>
                  <svg className={`w-4 h-4 text-[#8b98a5] transition-transform ${expandedId === c.id ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              </button>

              {/* Expanded details */}
              {expandedId === c.id && (
                <div className="border-t border-[#e1e8ed] p-4 space-y-3 animate-fade-in">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                    <div>
                      <span className="text-[#8b98a5]">Email</span>
                      <p className="text-[#536471] mt-0.5">{c.candidateEmail}</p>
                    </div>
                    <div>
                      <span className="text-[#8b98a5]">Experience</span>
                      <p className="text-[#536471] mt-0.5">{c.experience} years</p>
                    </div>
                    <div>
                      <span className="text-[#8b98a5]">Date</span>
                      <p className="text-[#536471] mt-0.5">{new Date(c.createdAt).toLocaleDateString()}</p>
                    </div>
                    <div>
                      <span className="text-[#8b98a5]">Duration</span>
                      <p className="text-[#536471] mt-0.5">{c.durationSeconds ? `${Math.round(c.durationSeconds / 60)}m` : '—'}</p>
                    </div>
                  </div>

                  {c.strengths.length > 0 && (
                    <div>
                      <p className="text-[10px] text-[#8b98a5] uppercase tracking-wider mb-1">Strengths</p>
                      <ul className="space-y-1">
                        {c.strengths.map((s, i) => (
                          <li key={i} className="text-xs text-[#059669] flex items-start gap-1.5">
                            <span className="mt-0.5">+</span> {s}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {c.weaknesses.length > 0 && (
                    <div>
                      <p className="text-[10px] text-[#8b98a5] uppercase tracking-wider mb-1">Areas for Improvement</p>
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
                      <p className="text-[10px] text-[#8b98a5] uppercase tracking-wider mb-1">Red Flags</p>
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
                      <p className="text-[10px] text-[#8b98a5] uppercase tracking-wider mb-1">Recruiter Notes</p>
                      <p className="text-xs text-[#536471]">{c.recruiterNotes}</p>
                    </div>
                  )}

                  {c.status === 'completed' && (
                    <Link
                      href={`/feedback/${c.id}`}
                      className="inline-block text-xs text-[#2563eb] hover:text-[#2563eb] transition-colors"
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
