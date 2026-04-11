'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Users, CheckCircle, BarChart3, Mail, Link2, FileText, Eye } from 'lucide-react'
import StateView from '@shared/ui/StateView'
import Badge from '@shared/ui/Badge'
import Button from '@shared/ui/Button'

interface DashboardData {
  org: {
    name: string
    plan: string
    currentSeats: number
    maxSeats: number
    monthlyInterviewsUsed: number
    monthlyInterviewLimit: number
  }
  recentCandidates: Array<{
    id: string
    email: string
    name: string
    status: string
    score?: number
    role: string
    completedAt?: string
  }>
  stats: {
    totalCandidates: number
    completedInterviews: number
    avgScore: number
    pendingInvites: number
  }
}

const STAT_ICONS = [
  { icon: Users, label: 'Total Candidates', key: 'totalCandidates' as const },
  { icon: CheckCircle, label: 'Completed', key: 'completedInterviews' as const },
  { icon: BarChart3, label: 'Avg Score', key: 'avgScore' as const },
  { icon: Mail, label: 'Pending Invites', key: 'pendingInvites' as const },
]

export default function HireDashboardPage() {
  const router = useRouter()
  const { data: session, status } = useSession()
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (status === 'unauthenticated') { router.push('/signin'); return }
    if (status !== 'authenticated') return

    fetch('/api/hire/dashboard')
      .then(r => r.json())
      .then(setData)
      .catch(() => setError(true))
      .finally(() => setLoading(false))
  }, [status, router])

  if (loading) {
    return <StateView state="loading" skeletonLayout="card" skeletonCount={3} />
  }

  if (error) {
    return <StateView state="error" error="Failed to load dashboard data." onRetry={() => window.location.reload()} />
  }

  if (!data?.org) {
    return (
      <div className="max-w-lg mx-auto py-20 text-center">
        <div className="w-14 h-14 rounded-[var(--ds-radius-md)] bg-[var(--ds-primary-light)] flex items-center justify-center mx-auto mb-5">
          <Users className="w-7 h-7 text-[var(--ds-primary)]" />
        </div>
        <h1 className="text-heading text-[var(--foreground)] mb-3">Welcome to IPG Hire</h1>
        <p className="text-body text-[var(--foreground-secondary)] mb-6">
          Set up your organization to start screening candidates with AI-powered interviews.
        </p>
        <Button variant="primary" size="lg" onClick={() => router.push('/hire/settings')}>
          Create Organization
        </Button>
      </div>
    )
  }

  const usagePct = Math.min(100, Math.round((data.org.monthlyInterviewsUsed / data.org.monthlyInterviewLimit) * 100))

  return (
    <div className="max-w-6xl mx-auto space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-heading text-[var(--foreground)]">{data.org.name}</h1>
          <p className="text-body text-[var(--foreground-secondary)] mt-1">Recruiter Dashboard</p>
        </div>
        <Link href="/hire/invite">
          <Button variant="primary" size="md">Invite Candidate</Button>
        </Link>
      </div>

      {/* Stats */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {STAT_ICONS.map(stat => {
          const Icon = stat.icon
          const value = stat.key === 'avgScore'
            ? (data.stats[stat.key] || '\u2014')
            : data.stats[stat.key]
          return (
            <div key={stat.key} className="surface-card-bordered p-5 text-center">
              <div className="w-10 h-10 rounded-[var(--ds-radius-sm)] bg-[var(--ds-primary-light)] flex items-center justify-center mx-auto">
                <Icon className="w-5 h-5 text-[var(--ds-primary)]" />
              </div>
              <p className="text-heading font-bold text-[var(--foreground)] mt-3">{value}</p>
              <p className="text-caption text-[var(--foreground-tertiary)] mt-1">{stat.label}</p>
            </div>
          )
        })}
      </section>

      {/* Usage */}
      <section className="surface-card-bordered p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-subheading text-[var(--foreground-secondary)]">Interview Usage</h2>
          <span className="text-caption text-[var(--foreground-tertiary)]">
            {data.org.monthlyInterviewsUsed} / {data.org.monthlyInterviewLimit} this month
          </span>
        </div>
        <div className="h-2 bg-[var(--color-surface)] rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all bg-[var(--ds-primary)]"
            style={{ width: `${usagePct}%` }}
          />
        </div>
        <div className="flex items-center justify-between mt-2">
          <span className="text-caption text-[var(--foreground-tertiary)]">
            Seats: {data.org.currentSeats} / {data.org.maxSeats}
          </span>
          <Badge variant="primary">{data.org.plan}</Badge>
        </div>
      </section>

      {/* Recent candidates */}
      <section className="surface-card-bordered p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-subheading text-[var(--foreground-secondary)]">Recent Candidates</h2>
          <Link href="/hire/candidates" className="text-caption text-[var(--ds-primary)] hover:underline transition-colors">
            View All
          </Link>
        </div>

        {data.recentCandidates.length === 0 ? (
          <p className="text-body text-[var(--foreground-tertiary)] text-center py-6">
            No candidates yet. <Link href="/hire/invite" className="text-[var(--ds-primary)]">Send your first invite</Link>
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="text-caption text-[var(--foreground-tertiary)] uppercase tracking-wider border-b border-[var(--color-border)]">
                  <th className="pb-2 pr-4">Candidate</th>
                  <th className="pb-2 pr-4">Role</th>
                  <th className="pb-2 pr-4">Status</th>
                  <th className="pb-2 pr-4">Score</th>
                  <th className="pb-2">Date</th>
                </tr>
              </thead>
              <tbody className="text-body">
                {data.recentCandidates.map((c, i) => (
                  <tr
                    key={i}
                    className="border-b border-[var(--color-border)] last:border-0 hover:bg-[var(--color-surface)] transition-colors cursor-pointer"
                    onClick={() => c.id && router.push(`/hire/candidates/${c.id}`)}
                  >
                    <td className="py-3 pr-4">
                      <p className="text-[var(--foreground)] font-medium">{c.name || 'Unknown'}</p>
                      <p className="text-caption text-[var(--foreground-tertiary)]">{c.email}</p>
                    </td>
                    <td className="py-3 pr-4 text-[var(--foreground-secondary)] capitalize">{c.role}</td>
                    <td className="py-3 pr-4">
                      <Badge variant={
                        c.status === 'completed' ? 'success' :
                        c.status === 'in_progress' ? 'caution' :
                        'default'
                      }>
                        {c.status.replace(/_/g, ' ')}
                      </Badge>
                    </td>
                    <td className="py-3 pr-4 text-[var(--foreground-secondary)]">{c.score ?? '\u2014'}</td>
                    <td className="py-3 text-caption text-[var(--foreground-tertiary)]">
                      {c.completedAt ? new Date(c.completedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '\u2014'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Quick actions */}
      <section className="grid md:grid-cols-3 gap-4">
        {[
          { href: '/hire/invite', title: 'Send Interview Link', desc: 'Share a personalized interview link with a candidate', icon: Link2 },
          { href: '/hire/templates', title: 'Manage Templates', desc: 'Create custom interview question sets', icon: FileText },
          { href: '/hire/candidates', title: 'Review Candidates', desc: 'View detailed results and comparisons', icon: Eye },
        ].map(action => {
          const Icon = action.icon
          return (
            <Link
              key={action.href}
              href={action.href}
              className="card-interactive p-5 group"
            >
              <div className="w-10 h-10 rounded-[var(--ds-radius-sm)] bg-[var(--ds-primary-light)] flex items-center justify-center">
                <Icon className="w-5 h-5 text-[var(--ds-primary)]" />
              </div>
              <h3 className="text-subheading text-[var(--foreground)] mt-3 group-hover:text-[var(--ds-primary)] transition-colors">
                {action.title}
              </h3>
              <p className="text-caption text-[var(--foreground-tertiary)] mt-1">{action.desc}</p>
            </Link>
          )
        })}
      </section>
    </div>
  )
}
