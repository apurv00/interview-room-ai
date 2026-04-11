'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ChevronDown } from 'lucide-react'
import StateView from '@shared/ui/StateView'
import Badge from '@shared/ui/Badge'
import Button from '@shared/ui/Button'
import SelectionGroup from '@shared/ui/SelectionGroup'

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

const STATUS_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'created', label: 'Created' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'completed', label: 'Completed' },
]

function scoreBadgeVariant(score: number): 'success' | 'caution' | 'danger' {
  if (score >= 70) return 'success'
  if (score >= 50) return 'caution'
  return 'danger'
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

    setLoading(true)
    const params = statusFilter !== 'all' ? `?status=${statusFilter}` : ''
    fetch(`/api/hire/candidates${params}`)
      .then(r => r.json())
      .then(data => setCandidates(data.candidates || []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [authStatus, router, statusFilter])

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-heading text-[var(--foreground)]">Candidates</h1>
        </div>
        <StateView state="loading" skeletonLayout="list" skeletonCount={5} />
      </div>
    )
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-heading text-[var(--foreground)]">Candidates</h1>
        <Link href="/hire/invite">
          <Button variant="primary" size="md">Invite New</Button>
        </Link>
      </div>

      {/* Filters */}
      <SelectionGroup
        items={STATUS_FILTERS}
        value={statusFilter}
        onChange={setStatusFilter}
        getKey={(item) => item.key}
        layout="inline"
        renderItem={(item, selected) => (
          <span className={`block px-3 py-2 text-caption font-medium ${selected ? '' : ''}`}>
            {item.label}
          </span>
        )}
      />

      {candidates.length === 0 ? (
        <StateView
          state="empty"
          title="No candidates found"
          description={statusFilter !== 'all' ? 'Try a different filter.' : 'Send your first invite to get started.'}
          action={{ label: 'Send Invite', onClick: () => router.push('/hire/invite') }}
        />
      ) : (
        <div className="space-y-3">
          {candidates.map(c => (
            <div key={c.id} className="surface-card-bordered overflow-hidden">
              {/* Summary row */}
              <button
                onClick={() => setExpandedId(expandedId === c.id ? null : c.id)}
                className="w-full flex items-center justify-between p-4 hover:bg-[var(--color-surface)] transition-colors text-left"
              >
                <div className="flex items-center gap-4 min-w-0">
                  <div className="w-9 h-9 rounded-full bg-[var(--ds-primary-light)] flex items-center justify-center text-[var(--ds-primary)] text-sm font-bold flex-shrink-0">
                    {(c.candidateName || c.candidateEmail)?.[0]?.toUpperCase() || '?'}
                  </div>
                  <div className="min-w-0">
                    <p className="text-body font-medium text-[var(--foreground)] truncate">
                      {c.candidateName || c.candidateEmail}
                    </p>
                    <p className="text-caption text-[var(--foreground-tertiary)]">{c.role} &middot; {c.interviewType}</p>
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  {c.overallScore !== null && (
                    <div className="text-right">
                      <Badge variant={scoreBadgeVariant(c.overallScore)}>{c.overallScore}</Badge>
                      {c.passProb && (
                        <p className="text-micro text-[var(--foreground-tertiary)] mt-0.5">{c.passProb} pass</p>
                      )}
                    </div>
                  )}
                  <Badge variant={
                    c.status === 'completed' ? 'success' :
                    c.status === 'in_progress' ? 'caution' :
                    c.status === 'created' ? 'primary' :
                    'default'
                  }>
                    {c.status.replace(/_/g, ' ')}
                  </Badge>
                  <ChevronDown className={`w-4 h-4 text-[var(--foreground-tertiary)] transition-transform ${expandedId === c.id ? 'rotate-180' : ''}`} />
                </div>
              </button>

              {/* Expanded details */}
              {expandedId === c.id && (
                <div className="border-t border-[var(--color-border)] p-4 space-y-3">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-caption">
                    <div>
                      <span className="text-[var(--foreground-tertiary)]">Email</span>
                      <p className="text-[var(--foreground-secondary)] mt-0.5">{c.candidateEmail}</p>
                    </div>
                    <div>
                      <span className="text-[var(--foreground-tertiary)]">Experience</span>
                      <p className="text-[var(--foreground-secondary)] mt-0.5">{c.experience} years</p>
                    </div>
                    <div>
                      <span className="text-[var(--foreground-tertiary)]">Date</span>
                      <p className="text-[var(--foreground-secondary)] mt-0.5">{new Date(c.createdAt).toLocaleDateString()}</p>
                    </div>
                    <div>
                      <span className="text-[var(--foreground-tertiary)]">Duration</span>
                      <p className="text-[var(--foreground-secondary)] mt-0.5">{c.durationSeconds ? `${Math.round(c.durationSeconds / 60)}m` : '\u2014'}</p>
                    </div>
                  </div>

                  {c.strengths.length > 0 && (
                    <div>
                      <p className="step-label mb-1">Strengths</p>
                      <ul className="space-y-1">
                        {c.strengths.map((s, i) => (
                          <li key={i} className="text-caption text-emerald-600 flex items-start gap-1.5">
                            <span className="mt-0.5">&#10003;</span> {s}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {c.weaknesses.length > 0 && (
                    <div>
                      <p className="step-label mb-1">Areas for Improvement</p>
                      <ul className="space-y-1">
                        {c.weaknesses.map((w, i) => (
                          <li key={i} className="text-caption text-amber-600 flex items-start gap-1.5">
                            <span className="mt-0.5">&#9651;</span> {w}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {c.redFlags.length > 0 && (
                    <div>
                      <p className="step-label mb-1">Red Flags</p>
                      <div className="flex flex-wrap gap-1.5">
                        {c.redFlags.map((f, i) => (
                          <Badge key={i} variant="danger">{f}</Badge>
                        ))}
                      </div>
                    </div>
                  )}

                  {c.recruiterNotes && (
                    <div>
                      <p className="step-label mb-1">Recruiter Notes</p>
                      <p className="text-caption text-[var(--foreground-secondary)]">{c.recruiterNotes}</p>
                    </div>
                  )}

                  <div className="flex gap-3 pt-1">
                    {c.status === 'completed' && (
                      <Link href={`/hire/scorecard/${c.id}`}>
                        <Button variant="primary" size="sm">View Scorecard</Button>
                      </Link>
                    )}
                    <Link href={`/hire/candidates/${c.id}`}>
                      <Button variant="secondary" size="sm">Full Details</Button>
                    </Link>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
