'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'
import Link from 'next/link'
import FileDropzone from '@/components/FileDropzone'
import type { Role, ExperienceLevel, Duration, InterviewConfig } from '@/lib/types'
import { ROLE_LABELS, EXPERIENCE_LABELS, DURATION_LABELS } from '@/lib/interviewConfig'
import { STORAGE_KEYS } from '@/lib/storageKeys'
import { getStartRedirect } from '@/lib/authRedirect'

const ROLES: Role[] = ['PM', 'SWE', 'Sales', 'MBA']
const EXPERIENCES: ExperienceLevel[] = ['0-2', '3-6', '7+']
const DURATIONS: Duration[] = [5, 10, 20]

const ROLE_ICONS: Record<Role, string> = {
  PM: '🗂',
  SWE: '💻',
  Sales: '📈',
  MBA: '🎓',
}

interface UsageInfo {
  monthlyInterviewsUsed: number
  monthlyInterviewLimit: number
  plan: string
}

export default function HomePage() {
  const router = useRouter()
  const { data: authSession, status } = useSession()
  const [role, setRole] = useState<Role | null>(null)
  const [experience, setExperience] = useState<ExperienceLevel | null>(null)
  const [duration, setDuration] = useState<Duration | null>(null)
  const [lastConfig, setLastConfig] = useState<InterviewConfig | null>(null)
  const [usage, setUsage] = useState<UsageInfo | null>(null)

  // Document upload state
  const [jdText, setJdText] = useState<string>('')
  const [jdFileName, setJdFileName] = useState<string>('')
  const [jdUploading, setJdUploading] = useState(false)
  const [resumeText, setResumeText] = useState<string>('')
  const [resumeFileName, setResumeFileName] = useState<string>('')
  const [resumeUploading, setResumeUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string>('')

  // Pre-fill from last session config
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEYS.INTERVIEW_CONFIG)
      if (stored) {
        const c: InterviewConfig = JSON.parse(stored)
        setLastConfig(c)
        setRole(c.role)
        setExperience(c.experience)
        setDuration(c.duration)
        // Restore documents if present
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

  // Fetch usage when authenticated
  useEffect(() => {
    if (status !== 'authenticated') return
    fetch('/api/settings/usage')
      .then((r) => r.json())
      .then((d) => setUsage(d))
      .catch(() => {})
  }, [status])

  const remaining = usage ? Math.max(0, usage.monthlyInterviewLimit - usage.monthlyInterviewsUsed) : null
  const atLimit = remaining !== null && remaining <= 0
  const nearLimit = remaining !== null && remaining > 0 && remaining <= 2

  const ready = role && experience && duration && !atLimit

  async function handleFileUpload(file: File, docType: 'jd' | 'resume') {
    setUploadError('')
    const setUploading = docType === 'jd' ? setJdUploading : setResumeUploading

    setUploading(true)
    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('docType', docType)

      const res = await fetch('/api/documents/upload', {
        method: 'POST',
        body: formData,
      })

      const data = await res.json()

      if (!res.ok) {
        setUploadError(data.error || 'Upload failed')
        return
      }

      if (docType === 'jd') {
        setJdText(data.text)
        setJdFileName(data.fileName)
      } else {
        setResumeText(data.text)
        setResumeFileName(data.fileName)
      }
    } catch {
      setUploadError('Failed to upload file. Please try again.')
    } finally {
      setUploading(false)
    }
  }

  function start() {
    if (!ready) return
    const redirect = getStartRedirect(status)
    if (!redirect) return // still loading

    const config: InterviewConfig = {
      role: role!,
      experience: experience!,
      duration: duration!,
      ...(jdText && { jobDescription: jdText, jdFileName }),
      ...(resumeText && { resumeText, resumeFileName }),
    }
    localStorage.setItem(STORAGE_KEYS.INTERVIEW_CONFIG, JSON.stringify(config))
    router.push(redirect)
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-4 py-12 relative overflow-hidden">
      {/* Background gradient blobs */}
      <div className="absolute top-0 left-1/4 w-96 h-96 bg-indigo-900/20 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-violet-900/15 rounded-full blur-3xl pointer-events-none" />

      <div className="relative z-10 w-full max-w-2xl space-y-10">
        {/* Usage warning banners */}
        {atLimit && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-5 py-4 text-sm text-red-300 flex items-center justify-between animate-slide-up">
            <span>
              You&apos;ve used all {usage?.monthlyInterviewLimit} interviews this month.
            </span>
            <Link href="/pricing" className="text-red-200 hover:text-white font-medium underline underline-offset-2 ml-3 whitespace-nowrap">
              Upgrade for more →
            </Link>
          </div>
        )}
        {nearLimit && (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl px-5 py-4 text-sm text-amber-300 animate-slide-up">
            You have <span className="font-semibold">{remaining}</span> interview{remaining !== 1 ? 's' : ''} left this month.
          </div>
        )}

        {/* Header */}
        <div className="text-center space-y-3 animate-slide-up">
          <div className="inline-flex items-center gap-2 px-3 py-1 bg-indigo-500/10 border border-indigo-500/20 rounded-full text-indigo-400 text-xs font-medium mb-2">
            <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" />
            AI-powered mock interview
          </div>
          {authSession?.user?.name && (
            <p className="text-indigo-400 text-sm font-medium">
              Welcome back, {authSession.user.name.split(' ')[0]}
            </p>
          )}
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-white">
            Interview Prep Guru
          </h1>
          <p className="text-slate-400 text-lg">
            {lastConfig
              ? 'Ready for another round? Your last settings are pre-filled below.'
              : 'Feels like a real HR screening call. Measured feedback on content, communication, and delivery.'}
          </p>
        </div>

        {/* Step 1: Role */}
        <section className="space-y-3 animate-slide-up stagger-1">
          <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-widest">
            1 · Select your target role
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {ROLES.map(r => (
              <button
                key={r}
                onClick={() => setRole(r)}
                className={`
                  flex flex-col items-center gap-2 py-5 rounded-xl border text-sm font-medium transition-all duration-200
                  ${role === r
                    ? 'border-indigo-500 bg-indigo-500/10 text-indigo-300 shadow-lg shadow-indigo-500/10'
                    : 'border-slate-700 bg-slate-800/50 text-slate-400 hover:border-slate-600 hover:text-slate-200 hover:bg-slate-800'
                  }
                `}
              >
                <span className="text-2xl">{ROLE_ICONS[r]}</span>
                <span>{ROLE_LABELS[r]}</span>
              </button>
            ))}
          </div>
        </section>

        {/* Step 2: Experience */}
        <section className="space-y-3 animate-slide-up stagger-2">
          <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-widest">
            2 · Experience level
          </h2>
          <div className="grid grid-cols-3 gap-3">
            {EXPERIENCES.map(e => (
              <button
                key={e}
                onClick={() => setExperience(e)}
                className={`
                  py-4 rounded-xl border text-sm font-medium transition-all duration-200
                  ${experience === e
                    ? 'border-indigo-500 bg-indigo-500/10 text-indigo-300 shadow-lg shadow-indigo-500/10'
                    : 'border-slate-700 bg-slate-800/50 text-slate-400 hover:border-slate-600 hover:text-slate-200 hover:bg-slate-800'
                  }
                `}
              >
                {EXPERIENCE_LABELS[e]}
              </button>
            ))}
          </div>
        </section>

        {/* Step 3: Duration */}
        <section className="space-y-3 animate-slide-up stagger-3">
          <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-widest">
            3 · Session length
          </h2>
          <div className="grid grid-cols-3 gap-3">
            {DURATIONS.map(d => (
              <button
                key={d}
                onClick={() => setDuration(d)}
                className={`
                  py-4 rounded-xl border text-sm font-medium transition-all duration-200
                  ${duration === d
                    ? 'border-indigo-500 bg-indigo-500/10 text-indigo-300 shadow-lg shadow-indigo-500/10'
                    : 'border-slate-700 bg-slate-800/50 text-slate-400 hover:border-slate-600 hover:text-slate-200 hover:bg-slate-800'
                  }
                `}
              >
                {DURATION_LABELS[d]}
              </button>
            ))}
          </div>
        </section>

        {/* Step 4: Upload Documents (optional) */}
        <section className="space-y-3 animate-slide-up stagger-4">
          <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-widest">
            4 · Upload documents <span className="text-slate-600">(optional)</span>
          </h2>
          <p className="text-xs text-slate-600">
            Upload a JD for role-specific questions, or a resume to personalize the interview around your experience.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FileDropzone
              label="Job Description"
              fileName={jdFileName || undefined}
              isUploading={jdUploading}
              onFileSelect={(file) => handleFileUpload(file, 'jd')}
              onRemove={() => { setJdText(''); setJdFileName('') }}
            />
            <FileDropzone
              label="Resume / CV"
              fileName={resumeFileName || undefined}
              isUploading={resumeUploading}
              onFileSelect={(file) => handleFileUpload(file, 'resume')}
              onRemove={() => { setResumeText(''); setResumeFileName('') }}
            />
          </div>
          {uploadError && (
            <p className="text-xs text-red-400">{uploadError}</p>
          )}
        </section>

        {/* CTA */}
        <div className="animate-slide-up stagger-5 flex flex-col items-center gap-3">
          <button
            onClick={start}
            disabled={!ready || status === 'loading'}
            className={`
              w-full max-w-sm py-4 rounded-2xl font-semibold text-base transition-all duration-200
              ${ready && status !== 'loading'
                ? 'bg-indigo-600 hover:bg-indigo-500 text-white btn-glow cursor-pointer'
                : 'bg-slate-800 text-slate-600 cursor-not-allowed border border-slate-700'
              }
            `}
          >
            {atLimit
              ? 'Monthly limit reached'
              : role && experience && duration
              ? 'Enter Interview Room →'
              : 'Select all options to continue'}
          </button>
          <p className="text-xs text-slate-600">
            Requires Chrome or Edge · Camera & mic access needed
          </p>
        </div>
      </div>

        {/* How It Works */}
        <section className="relative z-10 w-full max-w-2xl space-y-4 mt-20 animate-slide-up">
          <h2 className="text-2xl font-bold text-white text-center">How It Works</h2>
          <div className="grid sm:grid-cols-3 gap-4">
            {[
              { step: '1', title: 'Choose Your Role', desc: 'Pick from PM, SWE, Sales, or MBA interview tracks tailored to your career path.' },
              { step: '2', title: 'Practice with AI', desc: 'Our AI interviewer asks realistic HR screening questions in a live video call format.' },
              { step: '3', title: 'Get Instant Feedback', desc: 'Receive scored feedback on content relevance, structure, specificity, and delivery.' },
            ].map((item) => (
              <div key={item.step} className="border border-slate-800 bg-slate-900/50 rounded-xl p-5 text-center space-y-2">
                <div className="w-8 h-8 rounded-full bg-indigo-600/20 text-indigo-400 text-sm font-bold flex items-center justify-center mx-auto">
                  {item.step}
                </div>
                <h3 className="text-sm font-semibold text-white">{item.title}</h3>
                <p className="text-xs text-slate-400 leading-relaxed">{item.desc}</p>
              </div>
            ))}
          </div>
          <p className="text-center text-sm text-slate-500">
            <Link href="/pricing" className="text-indigo-400 hover:text-indigo-300 transition">
              See pricing →
            </Link>
          </p>
        </section>

        {/* Built for Real Interviews */}
        <section className="relative z-10 w-full max-w-2xl space-y-4 mt-16 mb-12 animate-slide-up">
          <h2 className="text-2xl font-bold text-white text-center">Built for Real Interview Scenarios</h2>
          <div className="grid sm:grid-cols-2 gap-4">
            {[
              { title: 'Realistic HR Screening', desc: 'Simulates a live screening call with an AI interviewer that adapts to your responses.' },
              { title: 'Role-Specific Questions', desc: 'Tailored questions for product management, software engineering, sales, and MBA roles.' },
              { title: 'Instant Scoring', desc: 'Get rated on relevance, structure, specificity, and ownership after every session.' },
              { title: 'Upload Your JD & Resume', desc: 'Personalize interview questions to match your target job description and experience.' },
            ].map((item) => (
              <div key={item.title} className="border border-slate-800 bg-slate-900/50 rounded-xl p-5 space-y-1.5">
                <h3 className="text-sm font-semibold text-white">{item.title}</h3>
                <p className="text-xs text-slate-400 leading-relaxed">{item.desc}</p>
              </div>
            ))}
          </div>
          <p className="text-center text-sm text-slate-500">
            Free to start — no credit card required.{' '}
            <Link href="/signup" className="text-indigo-400 hover:text-indigo-300 transition">
              Create your account →
            </Link>
          </p>
        </section>
    </main>
  )
}
