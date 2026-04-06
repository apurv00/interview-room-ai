'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

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

export default function HireDashboardPage() {
  const router = useRouter()
  const { data: session, status } = useSession()
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (status === 'unauthenticated') { router.push('/signin'); return }
    if (status !== 'authenticated') return

    fetch('/api/hire/dashboard')
      .then(r => r.json())
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [status, router])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 rounded-full border-2 border-[#2563eb] border-t-transparent animate-spin" />
      </div>
    )
  }

  if (!data?.org) {
    return (
      <div className="max-w-lg mx-auto py-20 text-center">
        <div className="w-16 h-16 rounded-2xl bg-blue-600/10 flex items-center justify-center mx-auto mb-6">
          <svg className="w-8 h-8 text-[#2563eb]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 13.255A23.193 23.193 0 0112 15c-3.183 0-6.22-.64-9-1.745M16 6V4a2 2 0 00-2-2h-4a2 2 0 00-2 2v2m4 6h.01M5 20h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
        </div>
        <h1 className="text-2xl font-bold text-[#0f1419] mb-3">Welcome to IPG Hire</h1>
        <p className="text-[#536471] text-sm mb-6">
          Set up your organization to start screening candidates with AI-powered interviews.
        </p>
        <Link
          href="/hire/settings"
          className="inline-block px-6 py-3 bg-blue-600 hover:bg-blue-500 text-white rounded-xl font-medium transition-colors"
        >
          Create Organization
        </Link>
      </div>
    )
  }

  const usagePct = Math.min(100, Math.round((data.org.monthlyInterviewsUsed / data.org.monthlyInterviewLimit) * 100))

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#0f1419]">{data.org.name}</h1>
          <p className="text-sm text-[#536471] mt-1">Recruiter Dashboard</p>
        </div>
        <Link
          href="/hire/invite"
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-xl font-medium transition-colors"
        >
          Invite Candidate
        </Link>
      </div>

      {/* Stats */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Total Candidates', value: data.stats.totalCandidates, icon: '👥' },
          { label: 'Completed Interviews', value: data.stats.completedInterviews, icon: '✅' },
          { label: 'Avg Score', value: data.stats.avgScore || '—', icon: '📊' },
          { label: 'Pending Invites', value: data.stats.pendingInvites, icon: '📧' },
        ].map(stat => (
          <div key={stat.label} className="bg-white border border-[#e1e8ed] rounded-2xl p-5 text-center">
            <span className="text-2xl">{stat.icon}</span>
            <p className="text-2xl font-bold text-[#0f1419] mt-2">{stat.value}</p>
            <p className="text-[10px] text-[#8b98a5] mt-1">{stat.label}</p>
          </div>
        ))}
      </section>

      {/* Usage */}
      <section className="bg-white border border-[#e1e8ed] rounded-2xl p-5">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-[#536471]">Interview Usage</h2>
          <span className="text-xs text-[#8b98a5]">
            {data.org.monthlyInterviewsUsed} / {data.org.monthlyInterviewLimit} this month
          </span>
        </div>
        <div className="h-2 bg-[#f7f9f9] rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all bg-blue-500"
            style={{ width: `${usagePct}%` }}
          />
        </div>
        <div className="flex items-center justify-between mt-2">
          <span className="text-xs text-[#8b98a5]">
            Seats: {data.org.currentSeats} / {data.org.maxSeats}
          </span>
          <span className="text-xs text-[#8b98a5] capitalize">Plan: {data.org.plan}</span>
        </div>
      </section>

      {/* Recent candidates */}
      <section className="bg-white border border-[#e1e8ed] rounded-2xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-[#536471]">Recent Candidates</h2>
          <Link href="/hire/candidates" className="text-xs text-[#2563eb] hover:text-[#2563eb] transition-colors">
            View All
          </Link>
        </div>

        {data.recentCandidates.length === 0 ? (
          <p className="text-sm text-[#8b98a5] text-center py-6">
            No candidates yet. <Link href="/hire/invite" className="text-[#2563eb]">Send your first invite</Link>
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="text-[10px] text-[#8b98a5] uppercase tracking-wider border-b border-[#e1e8ed]">
                  <th className="pb-2 pr-4">Candidate</th>
                  <th className="pb-2 pr-4">Role</th>
                  <th className="pb-2 pr-4">Status</th>
                  <th className="pb-2 pr-4">Score</th>
                  <th className="pb-2">Date</th>
                </tr>
              </thead>
              <tbody className="text-sm">
                {data.recentCandidates.map((c, i) => (
                  <tr key={i} className="border-b border-[#eff3f4] last:border-0">
                    <td className="py-3 pr-4">
                      <p className="text-[#0f1419] font-medium">{c.name || 'Unknown'}</p>
                      <p className="text-[11px] text-[#8b98a5]">{c.email}</p>
                    </td>
                    <td className="py-3 pr-4 text-[#536471] capitalize">{c.role}</td>
                    <td className="py-3 pr-4">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                        c.status === 'completed' ? 'bg-emerald-500/20 text-[#059669]' :
                        c.status === 'in_progress' ? 'bg-amber-500/20 text-amber-400' :
                        'bg-[#f7f9f9] text-[#536471]'
                      }`}>
                        {c.status.replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className="py-3 pr-4 text-[#536471]">{c.score ?? '—'}</td>
                    <td className="py-3 text-[#8b98a5] text-xs">
                      {c.completedAt ? new Date(c.completedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}
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
          { href: '/hire/invite', title: 'Send Interview Link', desc: 'Share a personalized interview link with a candidate', icon: '🔗' },
          { href: '/hire/templates', title: 'Manage Templates', desc: 'Create custom interview question sets', icon: '📝' },
          { href: '/hire/candidates', title: 'Review Candidates', desc: 'View detailed results and comparisons', icon: '👀' },
        ].map(action => (
          <Link
            key={action.href}
            href={action.href}
            className="bg-white border border-[#e1e8ed] rounded-2xl p-5 hover:border-[#e1e8ed] transition-all group"
          >
            <span className="text-2xl">{action.icon}</span>
            <h3 className="text-sm font-semibold text-[#0f1419] mt-3 group-hover:text-[#2563eb] transition-colors">
              {action.title}
            </h3>
            <p className="text-xs text-[#8b98a5] mt-1">{action.desc}</p>
          </Link>
        ))}
      </section>
    </div>
  )
}
