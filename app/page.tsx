'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'
import Link from 'next/link'
import FileDropzone from '@/components/FileDropzone'
import DomainSelector from '@/components/DomainSelector'
import DepthSelector from '@/components/DepthSelector'
import StepSection from '@shared/ui/StepSection'
import SelectionGroup from '@shared/ui/SelectionGroup'
import Button from '@shared/ui/Button'
import Badge from '@shared/ui/Badge'
import HowItWorks from '@shared/marketing/HowItWorks'
import SocialProof from '@shared/marketing/SocialProof'
import ResourceLinks from '@shared/marketing/ResourceLinks'
import type { Role, InterviewType, ExperienceLevel, Duration, InterviewConfig } from '@shared/types'
import { EXPERIENCE_LABELS, DURATION_LABELS } from '@/lib/interviewConfig'
import { STORAGE_KEYS } from '@shared/storageKeys'
import { getStartRedirect } from '@shared/authRedirect'

const EXPERIENCES: ExperienceLevel[] = ['0-2', '3-6', '7+']
const DURATIONS: Duration[] = [10, 20, 30]

function AuthenticatedHome() {
  const router = useRouter()
  const { data: authSession, status } = useSession()
  const [role, setRole] = useState<Role | null>(null)
  const [interviewType, setInterviewType] = useState<InterviewType | null>(null)
  const [experience, setExperience] = useState<ExperienceLevel | null>(null)
  const [duration, setDuration] = useState<Duration | null>(null)
  const [lastConfig, setLastConfig] = useState<InterviewConfig | null>(null)

  // Document upload state
  const [jdText, setJdText] = useState('')
  const [jdFileName, setJdFileName] = useState('')
  const [jdUploading, setJdUploading] = useState(false)
  const [resumeText, setResumeText] = useState('')
  const [resumeFileName, setResumeFileName] = useState('')
  const [resumeUploading, setResumeUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')

  // Pre-fill from last session config
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEYS.INTERVIEW_CONFIG)
      if (stored) {
        const c: InterviewConfig = JSON.parse(stored)
        setLastConfig(c)
        setRole(c.role)
        if (c.interviewType) setInterviewType(c.interviewType)
        setExperience(c.experience)
        setDuration(c.duration)
        if (c.jobDescription) {
          setJdText(c.jobDescription)
          setJdFileName(c.jdFileName || 'Job Description')
        }
        if (c.resumeText) {
          setResumeText(c.resumeText)
          setResumeFileName(c.resumeFileName || 'Resume')
        }
      }
    } catch { /* ignore */ }
  }, [])

  // Pre-fill from user profile (onboarding data)
  useEffect(() => {
    if (status !== 'authenticated' || lastConfig) return
    fetch('/api/onboarding')
      .then((r) => r.json())
      .then((profile) => {
        if (!role && profile.targetRole) setRole(profile.targetRole)
        if (!experience && profile.experienceLevel) setExperience(profile.experienceLevel)
        if (!resumeText && profile.hasResume && profile.resumeFileName) {
          setResumeFileName(profile.resumeFileName)
        }
      })
      .catch(() => {})
  }, [status, lastConfig]) // eslint-disable-line react-hooks/exhaustive-deps

  const ready = role && experience && duration

  async function handleFileUpload(file: File, docType: 'jd' | 'resume') {
    setUploadError('')
    const setUploading = docType === 'jd' ? setJdUploading : setResumeUploading
    setUploading(true)
    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('docType', docType)
      const res = await fetch('/api/documents/upload', { method: 'POST', body: formData })
      let data
      try { data = await res.json() } catch {
        setUploadError('Upload failed — server returned an unexpected response. Please try again.')
        return
      }
      if (!res.ok) { setUploadError(data.error || 'Upload failed'); return }
      if (docType === 'jd') { setJdText(data.text); setJdFileName(data.fileName) }
      else { setResumeText(data.text); setResumeFileName(data.fileName) }
    } catch { setUploadError('Failed to upload file. Please try again.') }
    finally { setUploading(false) }
  }

  function start() {
    if (!ready) return
    const redirect = getStartRedirect(status)
    if (!redirect) return
    const config: InterviewConfig = {
      role: role!,
      ...(interviewType && { interviewType }),
      experience: experience!,
      duration: duration!,
      ...(jdText && { jobDescription: jdText, jdFileName }),
      ...(resumeText && { resumeText, resumeFileName }),
    }
    localStorage.setItem(STORAGE_KEYS.INTERVIEW_CONFIG, JSON.stringify(config))
    router.push(redirect)
  }

  return (
    <main className="min-h-screen px-4 sm:px-6 py-12">
      <div className="max-w-[1100px] mx-auto space-y-section animate-fade-in">
        {/* Header */}
        <div className="text-center mb-section">
          {authSession?.user?.name && (
            <p className="text-body text-[#6b7280] mb-2">
              Welcome back, {authSession.user.name.split(' ')[0]}
            </p>
          )}
          <h1 className="text-display text-[#f0f2f5]">Set up your interview</h1>
          {lastConfig && (
            <p className="text-body text-[#6b7280] mt-2">
              Your last settings are pre-filled below.
            </p>
          )}
        </div>

        {/* Step 1: Domain */}
        <StepSection step={1} label="Interview domain" completed={!!role}>
          <DomainSelector selectedDomain={role} onSelect={(slug) => { setRole(slug); setInterviewType(null) }} />
        </StepSection>

        {/* Step 2: Interview Type */}
        <StepSection step={2} label="Interview type" completed={!!interviewType}>
          <DepthSelector selectedDomain={role} selectedDepth={interviewType} onSelect={setInterviewType} />
        </StepSection>

        {/* Steps 3 + 4: Experience & Duration side by side */}
        <div className="grid md:grid-cols-2 gap-section">
          <StepSection step={3} label="Experience level" completed={!!experience}>
            <SelectionGroup<ExperienceLevel>
              items={EXPERIENCES}
              value={experience}
              onChange={(v) => setExperience(v as ExperienceLevel)}
              getKey={(e) => e}
              layout="inline"
              renderItem={(e, selected) => (
                <div className={`py-3 px-2 text-center ${selected ? 'text-[#818cf8]' : ''}`}>
                  <span className="text-body font-medium">{EXPERIENCE_LABELS[e]}</span>
                </div>
              )}
            />
          </StepSection>

          <StepSection step={4} label="Duration" completed={!!duration}>
            <SelectionGroup<Duration>
              items={DURATIONS}
              value={duration !== null ? String(duration) : null}
              onChange={(v) => setDuration(Number(v) as Duration)}
              getKey={(d) => String(d)}
              layout="inline"
              renderItem={(d, selected) => (
                <div className={`py-3 px-2 text-center ${selected ? 'text-[#818cf8]' : ''}`}>
                  <span className="text-body font-medium">{DURATION_LABELS[d]}</span>
                </div>
              )}
            />
          </StepSection>
        </div>

        {/* Step 5: Documents */}
        <StepSection step={5} label="Documents (optional)">
          <p className="text-caption text-[#4b5563] mb-3">
            Upload a JD for role-specific questions, or a resume to personalize the interview.
          </p>
          <div className="grid sm:grid-cols-2 gap-element">
            <FileDropzone
              label="Job Description"
              fileName={jdFileName || undefined}
              isUploading={jdUploading}
              onFileSelect={(file) => handleFileUpload(file, 'jd')}
              onRemove={() => { setJdText(''); setJdFileName('') }}
              onError={setUploadError}
            />
            <FileDropzone
              label="Resume / CV"
              fileName={resumeFileName || undefined}
              isUploading={resumeUploading}
              onFileSelect={(file) => handleFileUpload(file, 'resume')}
              onRemove={() => { setResumeText(''); setResumeFileName('') }}
              onError={setUploadError}
            />
          </div>
          {uploadError && <p className="text-caption text-[#f87171] mt-2">{uploadError}</p>}
        </StepSection>

        {/* CTA */}
        <div className="flex flex-col items-center gap-3 mt-region">
          <Button
            variant="primary"
            size="lg"
            glow
            isFullWidth
            className="max-w-sm"
            disabled={!ready || status === 'loading'}
            onClick={start}
          >
            {ready ? 'Enter Interview Room \u2192' : 'Select all options to continue'}
          </Button>
          <p className="text-caption text-[#4b5563]">
            Requires Chrome or Edge &middot; Camera & mic access needed
          </p>
        </div>
      </div>

      {/* Quick access cards */}
      <div className="max-w-[1100px] mx-auto mt-section">
        <h2 className="text-heading text-[#f0f2f5] mb-4">More Tools</h2>
        <div className="grid sm:grid-cols-3 gap-element">
          <Link href="/practice" className="surface-card-bordered p-5 group hover:border-[rgba(99,102,241,0.2)] transition-all">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 rounded-xl bg-indigo-600/10 flex items-center justify-center">
                <svg className="w-5 h-5 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                </svg>
              </div>
              <h3 className="text-sm font-semibold text-[#f0f2f5] group-hover:text-[#818cf8] transition-colors">Practice Sets</h3>
            </div>
            <p className="text-caption text-[#6b7280]">Personalized practice plans based on your profile and progress.</p>
          </Link>
          <Link href="/resume" className="surface-card-bordered p-5 group hover:border-[rgba(16,185,129,0.2)] transition-all">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 rounded-xl bg-emerald-600/10 flex items-center justify-center">
                <svg className="w-5 h-5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                </svg>
              </div>
              <h3 className="text-sm font-semibold text-[#f0f2f5] group-hover:text-emerald-400 transition-colors">Resume Tools</h3>
            </div>
            <p className="text-caption text-[#6b7280]">Build, tailor, and ATS-optimize your resume with AI.</p>
          </Link>
          <Link href="/hire" className="surface-card-bordered p-5 group hover:border-[rgba(139,92,246,0.2)] transition-all">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 rounded-xl bg-violet-600/10 flex items-center justify-center">
                <svg className="w-5 h-5 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z" />
                </svg>
              </div>
              <h3 className="text-sm font-semibold text-[#f0f2f5] group-hover:text-violet-400 transition-colors">For Recruiters</h3>
            </div>
            <p className="text-caption text-[#6b7280]">Screen candidates with AI-powered interview assessments.</p>
          </Link>
        </div>
      </div>

      {/* SEO / Marketing sections */}
      <HowItWorks />
      <SocialProof />
      <ResourceLinks />
    </main>
  )
}

function UnauthenticatedHome() {
  return (
    <main className="min-h-screen">
      {/* Hero */}
      <section className="px-4 sm:px-6 pt-20 pb-region">
        <div className="max-w-[800px] mx-auto text-center">
          <Badge variant="primary" dot>AI-Powered Interview Practice</Badge>
          <h1 className="text-display text-[#f0f2f5] mt-6">
            Practice interviews that feel real.
          </h1>
          <p className="text-display text-[#f0f2f5]">
            Get feedback that makes you better.
          </p>
          <p className="text-body text-[#6b7280] mt-4 max-w-lg mx-auto">
            Mock interviews with an AI interviewer who adapts to your domain, experience level, and career goals. Scored feedback after every session.
          </p>
          <div className="flex items-center justify-center gap-3 mt-8">
            <Link href="/signup">
              <Button variant="primary" size="lg" glow>Get Started Free</Button>
            </Link>
            <Link href="/pricing">
              <Button variant="ghost" size="md">View Pricing</Button>
            </Link>
          </div>
        </div>
      </section>

      <HowItWorks />

      {/* Domain Showcase */}
      <section className="px-4 sm:px-6 py-section">
        <div className="max-w-[1000px] mx-auto text-center">
          <h2 className="text-heading text-[#f0f2f5]">Built for Every Career Path</h2>
          <p className="text-body text-[#6b7280] mt-2">Tailored questions for 12+ career domains</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-element mt-section max-w-[600px] mx-auto">
            {[
              { icon: '💻', label: 'Software Engineering' },
              { icon: '📊', label: 'Data Science' },
              { icon: '🗂', label: 'Product Management' },
              { icon: '🎨', label: 'Design / UX' },
              { icon: '💰', label: 'Finance' },
              { icon: '📈', label: 'Marketing' },
            ].map((d) => (
              <div key={d.label} className="surface-card p-4 flex flex-col items-center gap-1.5">
                <span className="text-xl">{d.icon}</span>
                <span className="text-caption font-semibold text-[#b0b8c4]">{d.label}</span>
              </div>
            ))}
          </div>
          <Link href="/signup" className="text-caption text-[#818cf8] hover:text-[#6366f1] transition-colors mt-4 inline-block">
            See all domains &rarr;
          </Link>
        </div>
      </section>

      <SocialProof />

      {/* Tools Section */}
      <section className="px-4 sm:px-6 py-section">
        <div className="max-w-[1000px] mx-auto text-center">
          <h2 className="text-heading text-[#f0f2f5]">Complete Career Toolkit</h2>
          <p className="text-body text-[#6b7280] mt-2">Everything you need to land your next role</p>
          <div className="grid sm:grid-cols-3 gap-element mt-section">
            <Link href="/practice" className="surface-card-bordered p-6 text-left group hover:border-[rgba(99,102,241,0.2)] transition-all">
              <div className="w-12 h-12 rounded-xl bg-indigo-600/10 flex items-center justify-center mb-4">
                <svg className="w-6 h-6 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                </svg>
              </div>
              <h3 className="text-subheading text-[#f0f2f5] group-hover:text-[#818cf8] transition-colors">Practice Sets</h3>
              <p className="text-caption text-[#6b7280] mt-2">Guided practice plans personalized to your goals, with progress tracking and difficulty scaling.</p>
            </Link>
            <Link href="/resume" className="surface-card-bordered p-6 text-left group hover:border-[rgba(16,185,129,0.2)] transition-all">
              <div className="w-12 h-12 rounded-xl bg-emerald-600/10 flex items-center justify-center mb-4">
                <svg className="w-6 h-6 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                </svg>
              </div>
              <h3 className="text-subheading text-[#f0f2f5] group-hover:text-emerald-400 transition-colors">Resume Tools</h3>
              <p className="text-caption text-[#6b7280] mt-2">AI resume builder, job description tailor, and ATS compatibility checker to maximize callbacks.</p>
            </Link>
            <Link href="/hire" className="surface-card-bordered p-6 text-left group hover:border-[rgba(139,92,246,0.2)] transition-all">
              <div className="w-12 h-12 rounded-xl bg-violet-600/10 flex items-center justify-center mb-4">
                <svg className="w-6 h-6 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z" />
                </svg>
              </div>
              <h3 className="text-subheading text-[#f0f2f5] group-hover:text-violet-400 transition-colors">IPG Hire</h3>
              <p className="text-caption text-[#6b7280] mt-2">For recruiters: screen candidates with AI-powered interview assessments at scale.</p>
            </Link>
          </div>
        </div>
      </section>

      <ResourceLinks />

      {/* Pricing Preview */}
      <section className="px-4 sm:px-6 py-section">
        <div className="max-w-[1000px] mx-auto text-center">
          <h2 className="text-heading text-[#f0f2f5]">Simple Pricing</h2>
          <p className="text-body text-[#6b7280] mt-2">Start free. Upgrade when you&apos;re ready.</p>
          <div className="grid md:grid-cols-3 gap-component mt-section">
            {[
              { plan: 'Free', price: '$0', desc: '3 interviews/month', cta: 'Get Started', href: '/signup' },
              { plan: 'Pro', price: '$19', desc: 'Unlimited interviews', cta: 'Coming Soon', href: '/pricing', featured: true },
              { plan: 'Enterprise', price: 'Custom', desc: 'Team & org features', cta: 'Contact Us', href: '/pricing' },
            ].map((p) => (
              <div key={p.plan} className={`surface-card-bordered p-7 ${p.featured ? 'border-[rgba(99,102,241,0.15)]' : ''}`}>
                {p.featured && <Badge variant="primary" className="mb-3">Popular</Badge>}
                <p className="text-subheading text-[#f0f2f5]">{p.plan}</p>
                <p className="text-display text-[#f0f2f5] mt-1">{p.price}</p>
                <p className="text-caption text-[#6b7280] mt-1">{p.desc}</p>
                <Link href={p.href} className="block mt-4">
                  <Button variant={p.featured ? 'primary' : 'secondary'} size="md" isFullWidth>
                    {p.cta}
                  </Button>
                </Link>
              </div>
            ))}
          </div>
          <Link href="/pricing" className="text-caption text-[#818cf8] hover:text-[#6366f1] transition-colors mt-4 inline-block">
            Compare plans in detail &rarr;
          </Link>
        </div>
      </section>

      {/* Final CTA */}
      <section className="px-4 sm:px-6 py-region text-center">
        <h2 className="text-heading text-[#f0f2f5]">Ready to practice?</h2>
        <p className="text-body text-[#6b7280] mt-2">Free to start — no credit card required.</p>
        <Link href="/signup" className="inline-block mt-6">
          <Button variant="primary" size="lg" glow>Start Your First Interview</Button>
        </Link>
      </section>
    </main>
  )
}

export default function HomePage() {
  const { status } = useSession()

  if (status === 'loading') {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-[#4b5563]">Loading...</div>
      </main>
    )
  }

  if (status === 'authenticated') {
    return <AuthenticatedHome />
  }

  return <UnauthenticatedHome />
}
