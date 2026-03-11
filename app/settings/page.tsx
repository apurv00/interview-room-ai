'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { PLANS } from '@/lib/services/stripe'
import { ROLE_LABELS, EXPERIENCE_LABELS } from '@/lib/interviewConfig'
import type { Role, ExperienceLevel } from '@/lib/types'

interface OnboardingProfile {
  targetRole: string | null
  experienceLevel: string | null
  currentTitle: string | null
  currentIndustry: string | null
  isCareerSwitcher: boolean
  switchingFrom: string | null
  targetCompanyType: string | null
  interviewGoal: string | null
  weakAreas: string[]
  hasResume: boolean
  resumeFileName: string | null
}

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
  const [profile, setProfile] = useState<OnboardingProfile | null>(null)
  const [profileEditing, setProfileEditing] = useState(false)
  const [profileSaving, setProfileSaving] = useState(false)
  // Editable profile fields
  const [editTargetRole, setEditTargetRole] = useState<Role | null>(null)
  const [editExperience, setEditExperience] = useState<ExperienceLevel | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editIndustry, setEditIndustry] = useState('')
  const [editCompanyType, setEditCompanyType] = useState('')
  const [editGoal, setEditGoal] = useState('')
  const [editWeakAreas, setEditWeakAreas] = useState<string[]>([])

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

    fetch('/api/onboarding')
      .then((r) => r.json())
      .then((data: OnboardingProfile) => {
        setProfile(data)
        setEditTargetRole((data.targetRole as Role) || null)
        setEditExperience((data.experienceLevel as ExperienceLevel) || null)
        setEditTitle(data.currentTitle || '')
        setEditIndustry(data.currentIndustry || '')
        setEditCompanyType(data.targetCompanyType || '')
        setEditGoal(data.interviewGoal || '')
        setEditWeakAreas(data.weakAreas || [])
      })
      .catch(() => {})
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

      {/* Interview Profile Card */}
      <section className="bg-slate-900 border border-slate-700 rounded-2xl p-6 animate-slide-up stagger-2">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-widest">
            Interview Profile
          </h2>
          {!profileEditing ? (
            <button
              onClick={() => setProfileEditing(true)}
              className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
            >
              Edit
            </button>
          ) : (
            <div className="flex gap-2">
              <button
                onClick={() => setProfileEditing(false)}
                className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  setProfileSaving(true)
                  try {
                    await fetch('/api/onboarding', {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        targetRole: editTargetRole || undefined,
                        experienceLevel: editExperience || undefined,
                        currentTitle: editTitle || undefined,
                        currentIndustry: editIndustry || undefined,
                        targetCompanyType: editCompanyType || undefined,
                        interviewGoal: editGoal || undefined,
                        weakAreas: editWeakAreas.length > 0 ? editWeakAreas : undefined,
                      }),
                    })
                    setProfile((prev) => prev ? {
                      ...prev,
                      targetRole: editTargetRole,
                      experienceLevel: editExperience,
                      currentTitle: editTitle || null,
                      currentIndustry: editIndustry || null,
                      targetCompanyType: editCompanyType || null,
                      interviewGoal: editGoal || null,
                      weakAreas: editWeakAreas,
                    } : null)
                    setProfileEditing(false)
                  } catch { /* ignore */ }
                  setProfileSaving(false)
                }}
                disabled={profileSaving}
                className="text-xs text-indigo-400 hover:text-indigo-300 font-medium transition-colors disabled:opacity-50"
              >
                {profileSaving ? 'Saving...' : 'Save'}
              </button>
            </div>
          )}
        </div>

        {!profile ? (
          <div className="flex items-center justify-center py-6">
            <div className="w-5 h-5 rounded-full border-2 border-indigo-400 border-t-transparent animate-spin" />
          </div>
        ) : !profileEditing ? (
          <div className="space-y-3">
            {!profile.targetRole && !profile.currentTitle && !profile.interviewGoal && (
              <div className="bg-indigo-500/10 border border-indigo-500/20 rounded-lg px-4 py-3 text-sm text-indigo-300">
                Complete your profile for more personalized interviews.
                <button onClick={() => setProfileEditing(true)} className="ml-2 underline hover:text-indigo-200">Set up now</button>
              </div>
            )}
            {profile.targetRole && (
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">Target Role</span>
                <span className="text-slate-300">{ROLE_LABELS[profile.targetRole as Role] || profile.targetRole}</span>
              </div>
            )}
            {profile.experienceLevel && (
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">Experience</span>
                <span className="text-slate-300">{EXPERIENCE_LABELS[profile.experienceLevel as ExperienceLevel] || profile.experienceLevel}</span>
              </div>
            )}
            {profile.currentTitle && (
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">Current Title</span>
                <span className="text-slate-300">{profile.currentTitle}</span>
              </div>
            )}
            {profile.currentIndustry && (
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">Industry</span>
                <span className="text-slate-300 capitalize">{profile.currentIndustry}</span>
              </div>
            )}
            {profile.targetCompanyType && (
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">Target Companies</span>
                <span className="text-slate-300 capitalize">{profile.targetCompanyType === 'faang' ? 'FAANG / Big Tech' : profile.targetCompanyType}</span>
              </div>
            )}
            {profile.interviewGoal && (
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">Goal</span>
                <span className="text-slate-300 capitalize">{profile.interviewGoal.replace(/_/g, ' ')}</span>
              </div>
            )}
            {profile.weakAreas?.length > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">Focus Areas</span>
                <span className="text-slate-300">{profile.weakAreas.map(a => a.replace(/_/g, ' ')).join(', ')}</span>
              </div>
            )}
            {profile.hasResume && profile.resumeFileName && (
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">Resume</span>
                <span className="text-slate-300">{profile.resumeFileName}</span>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {/* Role */}
            <div className="space-y-1.5">
              <label className="text-xs text-slate-500 uppercase tracking-wide">Target Role</label>
              <div className="grid grid-cols-4 gap-2">
                {(['PM', 'SWE', 'Sales', 'MBA'] as Role[]).map((r) => (
                  <button key={r} onClick={() => setEditTargetRole(r)} className={`py-2 rounded-lg border text-xs font-medium transition-all ${editTargetRole === r ? 'border-indigo-500 bg-indigo-500/10 text-indigo-300' : 'border-slate-700 bg-slate-800/50 text-slate-400 hover:border-slate-600'}`}>
                    {ROLE_LABELS[r]}
                  </button>
                ))}
              </div>
            </div>
            {/* Experience */}
            <div className="space-y-1.5">
              <label className="text-xs text-slate-500 uppercase tracking-wide">Experience</label>
              <div className="grid grid-cols-3 gap-2">
                {(['0-2', '3-6', '7+'] as ExperienceLevel[]).map((e) => (
                  <button key={e} onClick={() => setEditExperience(e)} className={`py-2 rounded-lg border text-xs font-medium transition-all ${editExperience === e ? 'border-indigo-500 bg-indigo-500/10 text-indigo-300' : 'border-slate-700 bg-slate-800/50 text-slate-400 hover:border-slate-600'}`}>
                    {EXPERIENCE_LABELS[e]}
                  </button>
                ))}
              </div>
            </div>
            {/* Title */}
            <div className="space-y-1.5">
              <label className="text-xs text-slate-500 uppercase tracking-wide">Current Title</label>
              <input type="text" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} maxLength={100} placeholder="e.g. Senior Software Engineer" className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>
            {/* Industry */}
            <div className="space-y-1.5">
              <label className="text-xs text-slate-500 uppercase tracking-wide">Industry</label>
              <div className="grid grid-cols-5 gap-1.5">
                {['tech', 'finance', 'consulting', 'healthcare', 'retail', 'media', 'government', 'education', 'startup', 'other'].map((i) => (
                  <button key={i} onClick={() => setEditIndustry(i)} className={`py-1.5 rounded-lg border text-xs font-medium transition-all capitalize ${editIndustry === i ? 'border-indigo-500 bg-indigo-500/10 text-indigo-300' : 'border-slate-700 bg-slate-800/50 text-slate-400 hover:border-slate-600'}`}>
                    {i}
                  </button>
                ))}
              </div>
            </div>
            {/* Company Type */}
            <div className="space-y-1.5">
              <label className="text-xs text-slate-500 uppercase tracking-wide">Target Companies</label>
              <div className="grid grid-cols-3 gap-2">
                {[{v:'faang',l:'FAANG'},{v:'startup',l:'Startup'},{v:'midsize',l:'Mid-size'},{v:'consulting',l:'Consulting'},{v:'enterprise',l:'Enterprise'},{v:'any',l:'Any'}].map((c) => (
                  <button key={c.v} onClick={() => setEditCompanyType(c.v)} className={`py-2 rounded-lg border text-xs font-medium transition-all ${editCompanyType === c.v ? 'border-indigo-500 bg-indigo-500/10 text-indigo-300' : 'border-slate-700 bg-slate-800/50 text-slate-400 hover:border-slate-600'}`}>
                    {c.l}
                  </button>
                ))}
              </div>
            </div>
            {/* Goal */}
            <div className="space-y-1.5">
              <label className="text-xs text-slate-500 uppercase tracking-wide">Interview Goal</label>
              <div className="space-y-1.5">
                {[{v:'first_interview',l:'First interview'},{v:'improve_scores',l:'Improve skills'},{v:'career_switch',l:'Career switch'},{v:'promotion',l:'Promotion prep'},{v:'general_practice',l:'General practice'}].map((g) => (
                  <button key={g.v} onClick={() => setEditGoal(g.v)} className={`w-full text-left px-3 py-2 rounded-lg border text-xs font-medium transition-all ${editGoal === g.v ? 'border-indigo-500 bg-indigo-500/10 text-indigo-300' : 'border-slate-700 bg-slate-800/50 text-slate-400 hover:border-slate-600'}`}>
                    {g.l}
                  </button>
                ))}
              </div>
            </div>
            {/* Weak Areas */}
            <div className="space-y-1.5">
              <label className="text-xs text-slate-500 uppercase tracking-wide">Focus Areas (up to 3)</label>
              <div className="grid grid-cols-3 gap-1.5">
                {[{v:'star_structure',l:'STAR Structure'},{v:'specificity',l:'Specificity'},{v:'conciseness',l:'Conciseness'},{v:'confidence',l:'Confidence'},{v:'technical_depth',l:'Tech Depth'},{v:'storytelling',l:'Storytelling'}].map((w) => (
                  <button key={w.v} onClick={() => setEditWeakAreas(prev => prev.includes(w.v) ? prev.filter(a => a !== w.v) : prev.length < 3 ? [...prev, w.v] : prev)} className={`py-2 rounded-lg border text-xs font-medium transition-all ${editWeakAreas.includes(w.v) ? 'border-indigo-500 bg-indigo-500/10 text-indigo-300' : 'border-slate-700 bg-slate-800/50 text-slate-400 hover:border-slate-600'}`}>
                    {w.l}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Plan & Usage Card */}
      <section className="bg-slate-900 border border-slate-700 rounded-2xl p-6 animate-slide-up stagger-3">
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
      <section className="bg-slate-900 border border-slate-700 rounded-2xl p-6 animate-slide-up stagger-4">
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
