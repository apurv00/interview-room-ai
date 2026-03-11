'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { PLANS } from '@/lib/services/stripe'

interface UsageData {
  plan: string
  monthlyInterviewsUsed: number
  monthlyInterviewLimit: number
  planExpiresAt: string | null
  hasStripeCustomer: boolean
  memberSince: string
  resetsAt: string
}

const PLAN_BADGE_STYLES: Record<string, string> = {
  free: 'bg-slate-700 text-slate-300',
  pro: 'bg-indigo-600 text-indigo-100',
  enterprise: 'bg-violet-600 text-violet-100',
}

export default function SettingsPage() {
  const { data: session, status } = useSession()
  const router = useRouter()
  const [usage, setUsage] = useState<UsageData | null>(null)
  const [loading, setLoading] = useState(true)
  const [upgraded, setUpgraded] = useState(false)

  useEffect(() => {
    if (status === 'unauthenticated') {
      router.push('/signin')
    }
  }, [status, router])

  // Check for ?upgraded=true query param
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('upgraded') === 'true') {
      setUpgraded(true)
      window.history.replaceState({}, '', '/settings')
    }
  }, [])

  useEffect(() => {
    if (status !== 'authenticated') return

    fetch('/api/settings/usage')
      .then((r) => r.json())
      .then(setUsage)
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [status])

  if (status === 'loading' || !session?.user) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <div className="w-6 h-6 rounded-full border-2 border-indigo-400 border-t-transparent animate-spin" />
      </main>
    )
  }

  const user = session.user
  const plan = usage?.plan || user.plan || 'free'
  const planConfig = PLANS[plan] || PLANS.free
  const used = usage?.monthlyInterviewsUsed || 0
  const limit = usage?.monthlyInterviewLimit || 999999
  const isUnlimited = limit >= 999999
  const usagePercent = isUnlimited ? 0 : Math.min(100, Math.round((used / limit) * 100))
  const remaining = isUnlimited ? null : Math.max(0, limit - used)

  const initials = (user.name || user.email || '?')
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

  const resetDate = usage?.resetsAt
    ? new Date(usage.resetsAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : null

  const memberSince = usage?.memberSince
    ? new Date(usage.memberSince).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
      })
    : null

  return (
    <main className="min-h-screen px-4 py-12 max-w-2xl mx-auto space-y-6">
      <h1 className="text-3xl font-bold text-white animate-slide-up">Settings</h1>

      {/* Upgrade success banner */}
      {upgraded && (
        <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl px-5 py-4 text-sm text-emerald-300 animate-slide-up">
          🎉 Your plan has been upgraded! New limits are now active.
        </div>
      )}

      {/* Profile Card */}
      <section className="bg-slate-900 border border-slate-700 rounded-2xl p-6 animate-slide-up stagger-1">
        <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-widest mb-4">
          Profile
        </h2>
        <div className="flex items-center gap-4">
          {user.image ? (
            <img
              src={user.image}
              alt=""
              className="w-14 h-14 rounded-full border-2 border-slate-700"
            />
          ) : (
            <div className="w-14 h-14 rounded-full bg-indigo-600 flex items-center justify-center text-lg font-bold text-white border-2 border-slate-700">
              {initials}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <p className="text-lg font-medium text-white truncate">{user.name}</p>
            <p className="text-sm text-slate-400 truncate">{user.email}</p>
            {memberSince && (
              <p className="text-xs text-slate-500 mt-1">Member since {memberSince}</p>
            )}
          </div>
        </div>
      </section>

      {/* Plan & Usage Card */}
      <section className="bg-slate-900 border border-slate-700 rounded-2xl p-6 animate-slide-up stagger-2">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-widest">
            Plan & Usage
          </h2>
          <span
            className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${PLAN_BADGE_STYLES[plan] || PLAN_BADGE_STYLES.free}`}
          >
            {planConfig.label}
          </span>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="w-5 h-5 rounded-full border-2 border-indigo-400 border-t-transparent animate-spin" />
          </div>
        ) : (
          <div className="space-y-5">
            {/* Usage bar */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-slate-300">
                  {isUnlimited ? `${used} interviews completed` : `${used} of ${limit} interviews used`}
                </span>
                {remaining !== null && (
                  <span className="text-sm text-slate-500">
                    {remaining} remaining
                  </span>
                )}
              </div>
              <div className="h-3 bg-slate-800 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{
                    width: `${usagePercent}%`,
                    background:
                      usagePercent >= 100
                        ? 'rgb(239,68,68)'
                        : usagePercent >= 80
                        ? 'rgb(245,158,11)'
                        : 'rgb(99,102,241)',
                  }}
                />
              </div>
              {resetDate && (
                <p className="text-xs text-slate-500 mt-1.5">
                  Resets on {resetDate}
                </p>
              )}
            </div>

            {/* Plan features */}
            <div className="border-t border-slate-800 pt-4">
              <p className="text-xs text-slate-500 uppercase tracking-wide mb-2">
                Your plan includes
              </p>
              <ul className="space-y-1.5">
                {planConfig.features.map((f) => (
                  <li key={f} className="flex items-center gap-2 text-sm text-slate-300">
                    <svg className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                    {f}
                  </li>
                ))}
              </ul>
            </div>

            {/* Upgrade CTA */}
            {plan === 'free' && (
              <Link
                href="/pricing"
                className="block w-full py-3 rounded-xl text-center text-sm font-medium bg-indigo-600 hover:bg-indigo-500 text-white transition"
              >
                View Upgrade Options →
              </Link>
            )}
          </div>
        )}
      </section>

      {/* Quick Links */}
      <section className="bg-slate-900 border border-slate-700 rounded-2xl p-6 animate-slide-up stagger-3">
        <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-widest mb-4">
          Quick Links
        </h2>
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: 'History', href: '/history', icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z' },
            { label: 'Progress', href: '/progress', icon: 'M13 7h8m0 0v8m0-8l-8 8-4-4-6 6' },
            { label: 'Pricing', href: '/pricing', icon: 'M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z' },
          ].map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="flex flex-col items-center gap-2 py-4 rounded-xl border border-slate-700 bg-slate-800/50 text-slate-300 hover:border-slate-600 hover:text-white transition"
            >
              <svg className="w-5 h-5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d={link.icon} />
              </svg>
              <span className="text-xs font-medium">{link.label}</span>
            </Link>
          ))}
        </div>
      </section>
    </main>
  )
}
