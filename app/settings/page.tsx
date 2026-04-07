'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import { PLANS } from '@shared/services/stripe'
import { ROLE_LABELS, EXPERIENCE_LABELS } from '@interview/config/interviewConfig'
import type { Role, ExperienceLevel } from '@shared/types'

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
  // Extended profile
  topSkills: string[]
  communicationStyle: string | null
  feedbackPreference: string | null
  targetCompanies: string[]
  educationLevel: string | null
  yearsInCurrentRole: number | null
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
  free: 'bg-[#eff3f4] text-[#536471]',
  pro: 'bg-blue-600 text-white',
  enterprise: 'bg-violet-600 text-white',
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
  // Extended profile fields
  const [editTopSkills, setEditTopSkills] = useState('')
  const [editCommStyle, setEditCommStyle] = useState('')
  const [editFeedbackPref, setEditFeedbackPref] = useState('')
  const [editTargetCompanies, setEditTargetCompanies] = useState('')
  const [editEducation, setEditEducation] = useState('')
  const [editYearsInRole, setEditYearsInRole] = useState('')

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
        setEditTopSkills((data.topSkills || []).join(', '))
        setEditCommStyle(data.communicationStyle || '')
        setEditFeedbackPref(data.feedbackPreference || '')
        setEditTargetCompanies((data.targetCompanies || []).join(', '))
        setEditEducation(data.educationLevel || '')
        setEditYearsInRole(data.yearsInCurrentRole != null ? String(data.yearsInCurrentRole) : '')
      })
      .catch(() => {})
  }, [status])

  if (status === 'loading' || !session?.user) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <div className="w-6 h-6 rounded-full border-2 border-[#2563eb] border-t-transparent animate-spin" />
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
      <h1 className="text-3xl font-bold text-[#0f1419] animate-fade-in">Settings</h1>

      {/* Upgrade success banner */}
      {upgraded && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-5 py-4 text-sm text-[#059669] animate-fade-in">
          🎉 Your plan has been upgraded! New limits are now active.
        </div>
      )}

      {/* Profile Card */}
      <section className="bg-white border border-[#e1e8ed] rounded-2xl p-6 animate-fade-in">
        <h2 className="text-sm font-semibold text-[#536471] uppercase tracking-widest mb-4">
          Profile
        </h2>
        <div className="flex items-center gap-4">
          {user.image ? (
            <Image
              src={user.image}
              alt="Profile"
              width={56}
              height={56}
              className="w-14 h-14 rounded-full border-2 border-[#e1e8ed]"
            />
          ) : (
            <div className="w-14 h-14 rounded-full bg-blue-600 flex items-center justify-center text-lg font-bold text-white border-2 border-[#e1e8ed]">
              {initials}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <p className="text-lg font-medium text-[#0f1419] truncate">{user.name}</p>
            <p className="text-sm text-[#536471] truncate">{user.email}</p>
            {memberSince && (
              <p className="text-xs text-[#8b98a5] mt-1">Member since {memberSince}</p>
            )}
          </div>
        </div>
      </section>

      {/* Interview Profile Card */}
      <section className="bg-white border border-[#e1e8ed] rounded-2xl p-6 animate-fade-in">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-[#536471] uppercase tracking-widest">
            Interview Profile
          </h2>
          {!profileEditing ? (
            <button
              onClick={() => setProfileEditing(true)}
              className="text-xs text-[#2563eb] hover:text-blue-700 transition-colors"
            >
              Edit
            </button>
          ) : (
            <div className="flex gap-2">
              <button
                onClick={() => setProfileEditing(false)}
                className="text-xs text-[#8b98a5] hover:text-[#536471] transition-colors"
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
                        topSkills: editTopSkills ? editTopSkills.split(',').map(s => s.trim()).filter(Boolean).slice(0, 10) : undefined,
                        communicationStyle: editCommStyle || undefined,
                        feedbackPreference: editFeedbackPref || undefined,
                        targetCompanies: editTargetCompanies ? editTargetCompanies.split(',').map(s => s.trim()).filter(Boolean).slice(0, 5) : undefined,
                        educationLevel: editEducation || undefined,
                        yearsInCurrentRole: editYearsInRole ? Number(editYearsInRole) : undefined,
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
                      topSkills: editTopSkills ? editTopSkills.split(',').map(s => s.trim()).filter(Boolean) : [],
                      communicationStyle: editCommStyle || null,
                      feedbackPreference: editFeedbackPref || null,
                      targetCompanies: editTargetCompanies ? editTargetCompanies.split(',').map(s => s.trim()).filter(Boolean) : [],
                      educationLevel: editEducation || null,
                      yearsInCurrentRole: editYearsInRole ? Number(editYearsInRole) : null,
                    } : null)
                    setProfileEditing(false)
                  } catch { /* ignore */ }
                  setProfileSaving(false)
                }}
                disabled={profileSaving}
                className="text-xs text-[#2563eb] hover:text-blue-700 font-medium transition-colors disabled:opacity-50"
              >
                {profileSaving ? 'Saving...' : 'Save'}
              </button>
            </div>
          )}
        </div>

        {!profile ? (
          <div className="flex items-center justify-center py-6">
            <div className="w-5 h-5 rounded-full border-2 border-[#2563eb] border-t-transparent animate-spin" />
          </div>
        ) : !profileEditing ? (
          <div className="space-y-3">
            {!profile.targetRole && !profile.currentTitle && !profile.interviewGoal && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-3 text-sm text-[#2563eb]">
                Complete your profile for more personalized interviews.
                <button onClick={() => setProfileEditing(true)} className="ml-2 underline hover:text-blue-700">Set up now</button>
              </div>
            )}
            {profile.targetRole && (
              <div className="flex justify-between text-sm">
                <span className="text-[#8b98a5]">Target Role</span>
                <span className="text-[#536471]">{ROLE_LABELS[profile.targetRole as Role] || profile.targetRole}</span>
              </div>
            )}
            {profile.experienceLevel && (
              <div className="flex justify-between text-sm">
                <span className="text-[#8b98a5]">Experience</span>
                <span className="text-[#536471]">{EXPERIENCE_LABELS[profile.experienceLevel as ExperienceLevel] || profile.experienceLevel}</span>
              </div>
            )}
            {profile.currentTitle && (
              <div className="flex justify-between text-sm">
                <span className="text-[#8b98a5]">Current Title</span>
                <span className="text-[#536471]">{profile.currentTitle}</span>
              </div>
            )}
            {profile.currentIndustry && (
              <div className="flex justify-between text-sm">
                <span className="text-[#8b98a5]">Industry</span>
                <span className="text-[#536471] capitalize">{profile.currentIndustry}</span>
              </div>
            )}
            {profile.targetCompanyType && (
              <div className="flex justify-between text-sm">
                <span className="text-[#8b98a5]">Target Companies</span>
                <span className="text-[#536471] capitalize">{profile.targetCompanyType === 'faang' ? 'FAANG / Big Tech' : profile.targetCompanyType}</span>
              </div>
            )}
            {profile.interviewGoal && (
              <div className="flex justify-between text-sm">
                <span className="text-[#8b98a5]">Goal</span>
                <span className="text-[#536471] capitalize">{profile.interviewGoal.replace(/_/g, ' ')}</span>
              </div>
            )}
            {profile.weakAreas?.length > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-[#8b98a5]">Focus Areas</span>
                <span className="text-[#536471]">{profile.weakAreas.map(a => a.replace(/_/g, ' ')).join(', ')}</span>
              </div>
            )}
            {profile.topSkills?.length > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-[#8b98a5]">Top Skills</span>
                <span className="text-[#536471] text-right max-w-[60%]">{profile.topSkills.join(', ')}</span>
              </div>
            )}
            {profile.educationLevel && (
              <div className="flex justify-between text-sm">
                <span className="text-[#8b98a5]">Education</span>
                <span className="text-[#536471] capitalize">{profile.educationLevel.replace(/_/g, ' ')}</span>
              </div>
            )}
            {profile.yearsInCurrentRole != null && (
              <div className="flex justify-between text-sm">
                <span className="text-[#8b98a5]">Years in Current Role</span>
                <span className="text-[#536471]">{profile.yearsInCurrentRole}</span>
              </div>
            )}
            {profile.targetCompanies?.length > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-[#8b98a5]">Target Companies</span>
                <span className="text-[#536471] text-right max-w-[60%]">{profile.targetCompanies.join(', ')}</span>
              </div>
            )}
            {profile.communicationStyle && (
              <div className="flex justify-between text-sm">
                <span className="text-[#8b98a5]">Communication Style</span>
                <span className="text-[#536471] capitalize">{profile.communicationStyle}</span>
              </div>
            )}
            {profile.feedbackPreference && (
              <div className="flex justify-between text-sm">
                <span className="text-[#8b98a5]">Feedback Preference</span>
                <span className="text-[#536471] capitalize">{profile.feedbackPreference.replace(/_/g, ' ')}</span>
              </div>
            )}
            {profile.hasResume && profile.resumeFileName && (
              <div className="flex justify-between text-sm">
                <span className="text-[#8b98a5]">Resume</span>
                <span className="text-[#536471]">{profile.resumeFileName}</span>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {/* Role */}
            <div className="space-y-1.5">
              <label className="text-xs text-[#8b98a5] uppercase tracking-wide">Target Role</label>
              <div className="grid grid-cols-4 gap-2">
                {(['frontend', 'backend', 'sdet', 'devops', 'data-science', 'pm', 'design', 'business', 'marketing', 'finance', 'sales']).map((r) => (
                  <button key={r} onClick={() => setEditTargetRole(r as Role)} className={`py-2 rounded-lg border text-xs font-medium transition-all ${editTargetRole === r ? 'border-[#2563eb] bg-blue-50 text-[#2563eb]' : 'border-[#e1e8ed] bg-[#f8fafc] text-[#536471] hover:border-[#cfd9de]'}`}>
                    {ROLE_LABELS[r as Role] || r.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                  </button>
                ))}
              </div>
            </div>
            {/* Experience */}
            <div className="space-y-1.5">
              <label className="text-xs text-[#8b98a5] uppercase tracking-wide">Experience</label>
              <div className="grid grid-cols-3 gap-2">
                {(['0-2', '3-6', '7+'] as ExperienceLevel[]).map((e) => (
                  <button key={e} onClick={() => setEditExperience(e)} className={`py-2 rounded-lg border text-xs font-medium transition-all ${editExperience === e ? 'border-[#2563eb] bg-blue-50 text-[#2563eb]' : 'border-[#e1e8ed] bg-[#f8fafc] text-[#536471] hover:border-[#cfd9de]'}`}>
                    {EXPERIENCE_LABELS[e]}
                  </button>
                ))}
              </div>
            </div>
            {/* Title */}
            <div className="space-y-1.5">
              <label className="text-xs text-[#8b98a5] uppercase tracking-wide">Current Title</label>
              <input type="text" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} maxLength={100} placeholder="e.g. Senior Software Engineer" className="w-full px-3 py-2 bg-[#f8fafc] border border-[#e1e8ed] rounded-lg text-[#0f1419] text-sm placeholder-[#8b98a5] focus:outline-none focus:ring-2 focus:ring-[#2563eb]" />
            </div>
            {/* Industry */}
            <div className="space-y-1.5">
              <label className="text-xs text-[#8b98a5] uppercase tracking-wide">Industry</label>
              <div className="grid grid-cols-5 gap-1.5">
                {['tech', 'finance', 'consulting', 'healthcare', 'retail', 'media', 'government', 'education', 'startup', 'other'].map((i) => (
                  <button key={i} onClick={() => setEditIndustry(i)} className={`py-1.5 rounded-lg border text-xs font-medium transition-all capitalize ${editIndustry === i ? 'border-[#2563eb] bg-blue-50 text-[#2563eb]' : 'border-[#e1e8ed] bg-[#f8fafc] text-[#536471] hover:border-[#cfd9de]'}`}>
                    {i}
                  </button>
                ))}
              </div>
            </div>
            {/* Company Type */}
            <div className="space-y-1.5">
              <label className="text-xs text-[#8b98a5] uppercase tracking-wide">Target Companies</label>
              <div className="grid grid-cols-3 gap-2">
                {[{v:'faang',l:'FAANG'},{v:'startup',l:'Startup'},{v:'midsize',l:'Mid-size'},{v:'consulting',l:'Consulting'},{v:'enterprise',l:'Enterprise'},{v:'any',l:'Any'}].map((c) => (
                  <button key={c.v} onClick={() => setEditCompanyType(c.v)} className={`py-2 rounded-lg border text-xs font-medium transition-all ${editCompanyType === c.v ? 'border-[#2563eb] bg-blue-50 text-[#2563eb]' : 'border-[#e1e8ed] bg-[#f8fafc] text-[#536471] hover:border-[#cfd9de]'}`}>
                    {c.l}
                  </button>
                ))}
              </div>
            </div>
            {/* Goal */}
            <div className="space-y-1.5">
              <label className="text-xs text-[#8b98a5] uppercase tracking-wide">Interview Goal</label>
              <div className="space-y-1.5">
                {[{v:'first_interview',l:'First interview'},{v:'improve_scores',l:'Improve skills'},{v:'career_switch',l:'Career switch'},{v:'promotion',l:'Promotion prep'},{v:'general_practice',l:'General practice'}].map((g) => (
                  <button key={g.v} onClick={() => setEditGoal(g.v)} className={`w-full text-left px-3 py-2 rounded-lg border text-xs font-medium transition-all ${editGoal === g.v ? 'border-[#2563eb] bg-blue-50 text-[#2563eb]' : 'border-[#e1e8ed] bg-[#f8fafc] text-[#536471] hover:border-[#cfd9de]'}`}>
                    {g.l}
                  </button>
                ))}
              </div>
            </div>
            {/* Weak Areas */}
            <div className="space-y-1.5">
              <label className="text-xs text-[#8b98a5] uppercase tracking-wide">Focus Areas (up to 3)</label>
              <div className="grid grid-cols-3 gap-1.5">
                {[{v:'star_structure',l:'STAR Structure'},{v:'specificity',l:'Specificity'},{v:'conciseness',l:'Conciseness'},{v:'confidence',l:'Confidence'},{v:'technical_depth',l:'Tech Depth'},{v:'storytelling',l:'Storytelling'}].map((w) => (
                  <button key={w.v} onClick={() => setEditWeakAreas(prev => prev.includes(w.v) ? prev.filter(a => a !== w.v) : prev.length < 3 ? [...prev, w.v] : prev)} className={`py-2 rounded-lg border text-xs font-medium transition-all ${editWeakAreas.includes(w.v) ? 'border-[#2563eb] bg-blue-50 text-[#2563eb]' : 'border-[#e1e8ed] bg-[#f8fafc] text-[#536471] hover:border-[#cfd9de]'}`}>
                    {w.l}
                  </button>
                ))}
              </div>
            </div>

            {/* Divider */}
            <div className="border-t border-[#eff3f4] pt-4">
              <p className="text-[10px] text-[#8b98a5] uppercase tracking-wider mb-3">Advanced Personalization</p>
            </div>

            {/* Top Skills */}
            <div className="space-y-1.5">
              <label className="text-xs text-[#8b98a5] uppercase tracking-wide">Top Skills (comma-separated, up to 10)</label>
              <input type="text" value={editTopSkills} onChange={(e) => setEditTopSkills(e.target.value)} maxLength={500} placeholder="e.g. Python, System Design, Leadership" className="w-full px-3 py-2 bg-[#f8fafc] border border-[#e1e8ed] rounded-lg text-[#0f1419] text-sm placeholder-[#8b98a5] focus:outline-none focus:ring-2 focus:ring-[#2563eb]" />
            </div>

            {/* Education Level */}
            <div className="space-y-1.5">
              <label className="text-xs text-[#8b98a5] uppercase tracking-wide">Education Level</label>
              <div className="grid grid-cols-3 gap-1.5">
                {[{v:'high_school',l:'High School'},{v:'bachelors',l:'Bachelors'},{v:'masters',l:'Masters'},{v:'phd',l:'PhD'},{v:'bootcamp',l:'Bootcamp'},{v:'self_taught',l:'Self-Taught'}].map((e) => (
                  <button key={e.v} onClick={() => setEditEducation(e.v)} className={`py-1.5 rounded-lg border text-xs font-medium transition-all ${editEducation === e.v ? 'border-[#2563eb] bg-blue-50 text-[#2563eb]' : 'border-[#e1e8ed] bg-[#f8fafc] text-[#536471] hover:border-[#cfd9de]'}`}>
                    {e.l}
                  </button>
                ))}
              </div>
            </div>

            {/* Years in Current Role */}
            <div className="space-y-1.5">
              <label className="text-xs text-[#8b98a5] uppercase tracking-wide">Years in Current Role</label>
              <input type="number" min={0} max={50} value={editYearsInRole} onChange={(e) => setEditYearsInRole(e.target.value)} placeholder="e.g. 3" className="w-full px-3 py-2 bg-[#f8fafc] border border-[#e1e8ed] rounded-lg text-[#0f1419] text-sm placeholder-[#8b98a5] focus:outline-none focus:ring-2 focus:ring-[#2563eb]" />
            </div>

            {/* Target Companies */}
            <div className="space-y-1.5">
              <label className="text-xs text-[#8b98a5] uppercase tracking-wide">Target Companies (comma-separated, up to 5)</label>
              <input type="text" value={editTargetCompanies} onChange={(e) => setEditTargetCompanies(e.target.value)} maxLength={300} placeholder="e.g. Google, Stripe, Airbnb" className="w-full px-3 py-2 bg-[#f8fafc] border border-[#e1e8ed] rounded-lg text-[#0f1419] text-sm placeholder-[#8b98a5] focus:outline-none focus:ring-2 focus:ring-[#2563eb]" />
            </div>

            {/* Communication Style */}
            <div className="space-y-1.5">
              <label className="text-xs text-[#8b98a5] uppercase tracking-wide">Communication Style</label>
              <div className="grid grid-cols-3 gap-2">
                {[{v:'concise',l:'Concise'},{v:'detailed',l:'Detailed'},{v:'storyteller',l:'Storyteller'}].map((s) => (
                  <button key={s.v} onClick={() => setEditCommStyle(s.v)} className={`py-2 rounded-lg border text-xs font-medium transition-all ${editCommStyle === s.v ? 'border-[#2563eb] bg-blue-50 text-[#2563eb]' : 'border-[#e1e8ed] bg-[#f8fafc] text-[#536471] hover:border-[#cfd9de]'}`}>
                    {s.l}
                  </button>
                ))}
              </div>
            </div>

            {/* Feedback Preference */}
            <div className="space-y-1.5">
              <label className="text-xs text-[#8b98a5] uppercase tracking-wide">Feedback Preference</label>
              <div className="grid grid-cols-3 gap-2">
                {[{v:'encouraging',l:'Encouraging'},{v:'balanced',l:'Balanced'},{v:'tough_love',l:'Tough Love'}].map((f) => (
                  <button key={f.v} onClick={() => setEditFeedbackPref(f.v)} className={`py-2 rounded-lg border text-xs font-medium transition-all ${editFeedbackPref === f.v ? 'border-[#2563eb] bg-blue-50 text-[#2563eb]' : 'border-[#e1e8ed] bg-[#f8fafc] text-[#536471] hover:border-[#cfd9de]'}`}>
                    {f.l}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Plan & Usage Card */}
      <section className="bg-white border border-[#e1e8ed] rounded-2xl p-6 animate-fade-in">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-sm font-semibold text-[#536471] uppercase tracking-widest">
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
            <div className="w-5 h-5 rounded-full border-2 border-[#2563eb] border-t-transparent animate-spin" />
          </div>
        ) : (
          <div className="space-y-5">
            {/* Usage bar */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-[#0f1419]">
                  {isUnlimited ? `${used} interviews completed` : `${used} of ${limit} interviews used`}
                </span>
                {remaining !== null && (
                  <span className="text-sm text-[#8b98a5]">
                    {remaining} remaining
                  </span>
                )}
              </div>
              <div className="h-3 bg-[#eff3f4] rounded-full overflow-hidden">
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
                <p className="text-xs text-[#8b98a5] mt-1.5">
                  Resets on {resetDate}
                </p>
              )}
            </div>

            {/* Plan features */}
            <div className="border-t border-[#eff3f4] pt-4">
              <p className="text-xs text-[#8b98a5] uppercase tracking-wide mb-2">
                Your plan includes
              </p>
              <ul className="space-y-1.5">
                {planConfig.features.map((f) => (
                  <li key={f} className="flex items-center gap-2 text-sm text-[#536471]">
                    <svg className="w-3.5 h-3.5 text-[#059669] flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
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
                className="block w-full py-3 rounded-xl text-center text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white transition"
              >
                View Upgrade Options →
              </Link>
            )}
          </div>
        )}
      </section>

      {/* Quick Links */}
      <section className="bg-white border border-[#e1e8ed] rounded-2xl p-6 animate-fade-in">
        <h2 className="text-sm font-semibold text-[#536471] uppercase tracking-widest mb-4">
          Quick Links
        </h2>
        <div className="grid grid-cols-5 gap-3">
          {[
            { label: 'Practice', href: '/practice', icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4' },
            { label: 'Resume', href: '/resume', icon: 'M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z' },
            { label: 'History', href: '/history', icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z' },
            { label: 'Progress', href: '/progress', icon: 'M13 7h8m0 0v8m0-8l-8 8-4-4-6 6' },
            { label: 'Pricing', href: '/pricing', icon: 'M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z' },
          ].map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="flex flex-col items-center gap-2 py-4 rounded-xl border border-[#e1e8ed] bg-[#f8fafc] text-[#536471] hover:border-[#cfd9de] hover:text-[#0f1419] transition"
            >
              <svg className="w-5 h-5 text-[#8b98a5]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
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
