'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter, useParams } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Clock, Calendar, Mail, Briefcase, User } from 'lucide-react'
import StateView from '@shared/ui/StateView'
import Badge from '@shared/ui/Badge'
import Button from '@shared/ui/Button'

interface CandidateDetail {
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

function scoreBadgeVariant(score: number): 'success' | 'caution' | 'danger' {
  if (score >= 70) return 'success'
  if (score >= 50) return 'caution'
  return 'danger'
}

export default function CandidateDetailPage() {
  const router = useRouter()
  const params = useParams()
  const sessionId = params.sessionId as string
  const { status: authStatus } = useSession()
  const [candidate, setCandidate] = useState<CandidateDetail | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (authStatus === 'unauthenticated') { router.push('/signin'); return }
    if (authStatus !== 'authenticated') return

    fetch('/api/hire/candidates')
      .then(r => r.json())
      .then(data => {
        const found = (data.candidates || []).find((c: CandidateDetail) => c.id === sessionId)
        setCandidate(found || null)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [authStatus, router, sessionId])

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto space-y-6">
        <Link href="/hire/candidates" className="flex items-center gap-2 text-caption text-[var(--foreground-tertiary)] hover:text-[var(--foreground-secondary)] transition-colors">
          <ArrowLeft className="w-3.5 h-3.5" /> Back to Candidates
        </Link>
        <StateView state="loading" skeletonLayout="card" skeletonCount={3} />
      </div>
    )
  }

  if (!candidate) {
    return (
      <div className="max-w-3xl mx-auto space-y-6">
        <Link href="/hire/candidates" className="flex items-center gap-2 text-caption text-[var(--foreground-tertiary)] hover:text-[var(--foreground-secondary)] transition-colors">
          <ArrowLeft className="w-3.5 h-3.5" /> Back to Candidates
        </Link>
        <StateView state="error" error="Candidate not found." onRetry={() => router.push('/hire/candidates')} />
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      {/* Back nav */}
      <Link href="/hire/candidates" className="flex items-center gap-2 text-caption text-[var(--foreground-tertiary)] hover:text-[var(--foreground-secondary)] transition-colors">
        <ArrowLeft className="w-3.5 h-3.5" /> Back to Candidates
      </Link>

      {/* Header */}
      <div className="flex items-start gap-4">
        <div className="w-14 h-14 rounded-full bg-[var(--ds-primary-light)] flex items-center justify-center text-[var(--ds-primary)] text-xl font-bold flex-shrink-0">
          {(candidate.candidateName || candidate.candidateEmail)?.[0]?.toUpperCase() || '?'}
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-heading text-[var(--foreground)]">
            {candidate.candidateName || candidate.candidateEmail}
          </h1>
          <div className="flex flex-wrap items-center gap-2 mt-2">
            <Badge variant={
              candidate.status === 'completed' ? 'success' :
              candidate.status === 'in_progress' ? 'caution' :
              candidate.status === 'created' ? 'primary' :
              'default'
            }>
              {candidate.status.replace(/_/g, ' ')}
            </Badge>
            <Badge variant="default">{candidate.role}</Badge>
            <Badge variant="default">{candidate.interviewType}</Badge>
            {candidate.overallScore !== null && (
              <Badge variant={scoreBadgeVariant(candidate.overallScore)}>
                Score: {candidate.overallScore}
              </Badge>
            )}
            {candidate.passProb && (
              <Badge variant="default">{candidate.passProb} pass</Badge>
            )}
          </div>
        </div>
      </div>

      {/* Metadata grid */}
      <section className="surface-card-bordered p-5">
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <div className="flex items-start gap-3">
            <Mail className="w-4 h-4 text-[var(--foreground-tertiary)] mt-0.5" />
            <div>
              <p className="step-label">Email</p>
              <p className="text-body text-[var(--foreground-secondary)] mt-0.5">{candidate.candidateEmail}</p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <Briefcase className="w-4 h-4 text-[var(--foreground-tertiary)] mt-0.5" />
            <div>
              <p className="step-label">Experience</p>
              <p className="text-body text-[var(--foreground-secondary)] mt-0.5">{candidate.experience} years</p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <Calendar className="w-4 h-4 text-[var(--foreground-tertiary)] mt-0.5" />
            <div>
              <p className="step-label">Invited</p>
              <p className="text-body text-[var(--foreground-secondary)] mt-0.5">
                {new Date(candidate.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              </p>
            </div>
          </div>
          {candidate.completedAt && (
            <div className="flex items-start gap-3">
              <Calendar className="w-4 h-4 text-[var(--foreground-tertiary)] mt-0.5" />
              <div>
                <p className="step-label">Completed</p>
                <p className="text-body text-[var(--foreground-secondary)] mt-0.5">
                  {new Date(candidate.completedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                </p>
              </div>
            </div>
          )}
          {candidate.durationSeconds && (
            <div className="flex items-start gap-3">
              <Clock className="w-4 h-4 text-[var(--foreground-tertiary)] mt-0.5" />
              <div>
                <p className="step-label">Duration</p>
                <p className="text-body text-[var(--foreground-secondary)] mt-0.5">{Math.round(candidate.durationSeconds / 60)} min</p>
              </div>
            </div>
          )}
          <div className="flex items-start gap-3">
            <User className="w-4 h-4 text-[var(--foreground-tertiary)] mt-0.5" />
            <div>
              <p className="step-label">Interview Type</p>
              <p className="text-body text-[var(--foreground-secondary)] mt-0.5 capitalize">{candidate.interviewType}</p>
            </div>
          </div>
        </div>
      </section>

      {/* Assessment */}
      {(candidate.strengths.length > 0 || candidate.weaknesses.length > 0 || candidate.redFlags.length > 0) && (
        <section className="space-y-4">
          <h2 className="text-subheading text-[var(--foreground)]">Assessment</h2>

          <div className="grid md:grid-cols-2 gap-4">
            {candidate.strengths.length > 0 && (
              <div className="surface-card-bordered p-5">
                <p className="step-label mb-2">Strengths</p>
                <ul className="space-y-1.5">
                  {candidate.strengths.map((s, i) => (
                    <li key={i} className="text-caption text-emerald-600 flex items-start gap-1.5">
                      <span className="mt-0.5">&#10003;</span> {s}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {candidate.weaknesses.length > 0 && (
              <div className="surface-card-bordered p-5">
                <p className="step-label mb-2">Areas for Improvement</p>
                <ul className="space-y-1.5">
                  {candidate.weaknesses.map((w, i) => (
                    <li key={i} className="text-caption text-amber-600 flex items-start gap-1.5">
                      <span className="mt-0.5">&#9651;</span> {w}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {candidate.redFlags.length > 0 && (
            <div className="surface-card-bordered p-5">
              <p className="step-label mb-2">Red Flags</p>
              <div className="flex flex-wrap gap-1.5">
                {candidate.redFlags.map((f, i) => (
                  <Badge key={i} variant="danger">{f}</Badge>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {/* Recruiter notes */}
      {candidate.recruiterNotes && (
        <section className="surface-card-bordered p-5">
          <p className="step-label mb-2">Recruiter Notes</p>
          <p className="text-body text-[var(--foreground-secondary)] leading-relaxed">{candidate.recruiterNotes}</p>
        </section>
      )}

      {/* Actions */}
      <div className="flex gap-3">
        {candidate.status === 'completed' && (
          <Link href={`/hire/scorecard/${candidate.id}`}>
            <Button variant="primary" size="md">View Full Scorecard</Button>
          </Link>
        )}
        <Link href="/hire/candidates">
          <Button variant="secondary" size="md">Back to List</Button>
        </Link>
      </div>
    </div>
  )
}
