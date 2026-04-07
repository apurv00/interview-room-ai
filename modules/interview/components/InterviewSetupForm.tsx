'use client'

/**
 * InterviewSetupForm — progressive 4-step interview setup screen.
 *
 * Used by /interview/setup. Produces the exact same `InterviewConfig` as the
 * flat homepage form (app/AuthenticatedHome.tsx), so downstream lobby/AI code
 * is unchanged. Preserves all production behaviors: resume requirement with
 * saved-resume + quick-profile escape hatches, JD context extraction, JD
 * auto-generation from company+role, onboarding pre-fill, session-scoped
 * localStorage, cross-user leakage scrub.
 *
 * Steps:
 *   0 — Domain + Resume
 *   1 — Experience + Context (JD upload/paste OR company+role)
 *   2 — Interview Type + Duration
 *   3 — Review & Start
 */

import { useState, useEffect, useMemo, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'
import Link from 'next/link'
import {
  ArrowRight,
  ArrowLeft,
  Check,
  CheckCircle2,
  Edit3,
  Sparkles,
  Building2,
  Briefcase,
  Video,
} from 'lucide-react'
import FileDropzone from '@interview/components/FileDropzone'
import DomainSelector from '@interview/components/DomainSelector'
import DepthSelector from '@interview/components/DepthSelector'
import SelectionGroup from '@shared/ui/SelectionGroup'
import Button from '@shared/ui/Button'
import type {
  Role,
  InterviewType,
  ExperienceLevel,
  Duration,
  InterviewConfig,
} from '@shared/types'
import {
  EXPERIENCE_LABELS,
  getDurationLabel,
  getDomainLabel,
} from '@interview/config/interviewConfig'
import { deduplicatedFetch } from '@shared/cachedFetch'
import { STORAGE_KEYS } from '@shared/storageKeys'
import { useAuthGate } from '@shared/providers/AuthGateProvider'

const EXPERIENCES: ExperienceLevel[] = ['0-2', '3-6', '7+']
const DURATIONS: Duration[] = [10, 20, 30]
const TOTAL_STEPS = 4

interface SavedResumeMeta {
  id: string
  name: string
  targetRole?: string | null
  updatedAt?: string | null
}

export default function InterviewSetupForm() {
  const router = useRouter()
  const { data: authSession, status } = useSession()
  const { requireAuth } = useAuthGate()

  // ─── Step state ────────────────────────────────────────────────────────
  const [step, setStep] = useState(0)

  // ─── Interview config state (mirrors AuthenticatedHome) ────────────────
  const [role, setRole] = useState<Role | null>(null)
  const [interviewType, setInterviewType] = useState<InterviewType | null>(null)
  const [experience, setExperience] = useState<ExperienceLevel | null>(null)
  const [duration, setDuration] = useState<Duration | null>(20)
  const [lastConfig, setLastConfig] = useState<InterviewConfig | null>(null)

  // Resume state
  const [resumeText, setResumeText] = useState('')
  const [resumeFileName, setResumeFileName] = useState('')
  const [resumeUploading, setResumeUploading] = useState(false)
  const [savedResumes, setSavedResumes] = useState<SavedResumeMeta[]>([])
  const [showNoResumeOptions, setShowNoResumeOptions] = useState(false)
  const [quickTitle, setQuickTitle] = useState('')
  const [quickSkills, setQuickSkills] = useState('')
  const [quickProfileDone, setQuickProfileDone] = useState(false)

  // JD / context state
  const [jdText, setJdText] = useState('')
  const [jdFileName, setJdFileName] = useState('')
  const [jdUploading, setJdUploading] = useState(false)
  const [jdTab, setJdTab] = useState<'upload' | 'generate'>('upload')
  const [jdCompany, setJdCompany] = useState('')
  const [jdRole, setJdRole] = useState('')
  const [jdPasteText, setJdPasteText] = useState('')
  const [targetCompany, setTargetCompany] = useState('')
  const [targetIndustry, setTargetIndustry] = useState('')
  const [extractingContext, setExtractingContext] = useState(false)

  const [uploadError, setUploadError] = useState('')

  const hasResume = !!(resumeText || quickProfileDone)

  // ─── Pre-fill from last session (scoped to user) ───────────────────────
  useEffect(() => {
    if (status !== 'authenticated' || !authSession?.user?.id) return
    try {
      const userId = authSession.user.id
      const stored = localStorage.getItem(`${STORAGE_KEYS.INTERVIEW_CONFIG}:${userId}`)
      const legacy = !stored ? localStorage.getItem(STORAGE_KEYS.INTERVIEW_CONFIG) : null
      const configStr = stored || legacy
      if (!configStr) return
      const c: InterviewConfig = JSON.parse(configStr)
      setLastConfig(c)
      setRole(c.role)
      if (c.interviewType) setInterviewType(c.interviewType)
      setExperience(c.experience)
      setDuration(c.duration)
      if (c.resumeText) {
        setResumeText(c.resumeText)
        setResumeFileName(c.resumeFileName || 'Resume')
      }
      // Scrub JD/company/industry — these are per-session, not persistent.
      const {
        jobDescription,
        jdFileName: _jf,
        targetCompany: _tc,
        targetIndustry: _ti,
        ...cleanConfig
      } = c
      if (jobDescription || _tc || _ti) {
        const cleanStr = JSON.stringify(cleanConfig)
        localStorage.setItem(`${STORAGE_KEYS.INTERVIEW_CONFIG}:${userId}`, cleanStr)
        localStorage.setItem(STORAGE_KEYS.INTERVIEW_CONFIG, cleanStr)
      }
      if (legacy && !stored) {
        const cleanStr = JSON.stringify(cleanConfig)
        localStorage.setItem(`${STORAGE_KEYS.INTERVIEW_CONFIG}:${userId}`, cleanStr)
        localStorage.removeItem(STORAGE_KEYS.INTERVIEW_CONFIG)
      }
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, authSession?.user?.id])

  // ─── Pre-fill from onboarding profile ──────────────────────────────────
  useEffect(() => {
    if (status !== 'authenticated') return
    deduplicatedFetch('/api/onboarding')
      .then((r) => r.json())
      .then((profile) => {
        if (!lastConfig) {
          if (!role && profile.targetRole) setRole(profile.targetRole)
          if (!experience && profile.experienceLevel) setExperience(profile.experienceLevel)
        }
        if (!resumeText && profile.hasResume) {
          if (profile.resumeText) setResumeText(profile.resumeText)
          if (profile.resumeFileName) setResumeFileName(profile.resumeFileName)
        }
        if (profile.savedResumes?.length) setSavedResumes(profile.savedResumes)
        if (profile.currentTitle) setQuickTitle(profile.currentTitle)
        if (profile.topSkills?.length) setQuickSkills(profile.topSkills.join(', '))
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])

  // ─── Derived values ────────────────────────────────────────────────────
  const progress = ((step + 1) / TOTAL_STEPS) * 100

  const canGoNext = useMemo(() => {
    if (step === 0) return !!(role && hasResume)
    if (step === 1) {
      if (!experience) return false
      // General domain requires concrete company/role (or a JD that implies them)
      if (role === 'general') {
        const hasContext =
          !!jdText ||
          (jdCompany.trim().length > 0 && jdRole.trim().length > 0) ||
          (targetCompany.trim().length > 0)
        return hasContext
      }
      return true
    }
    if (step === 2) return !!(interviewType && duration)
    return true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, role, hasResume, experience, jdText, jdCompany, jdRole, targetCompany, interviewType, duration])

  const ready = hasResume && role && experience && duration && interviewType

  const handleNext = useCallback(() => {
    if (!canGoNext) return
    if (step < TOTAL_STEPS - 1) setStep(step + 1)
  }, [canGoNext, step])

  const handlePrev = useCallback(() => {
    if (step > 0) setStep(step - 1)
  }, [step])

  // ─── Handlers (resume, JD, start) ──────────────────────────────────────
  const handleSelectSavedResume = useCallback(async (resumeId: string) => {
    try {
      const res = await fetch(`/api/resume/interview-config?id=${resumeId}`)
      if (!res.ok) return
      const data = await res.json()
      if (data.resumeText) setResumeText(data.resumeText)
      if (data.resumeName) setResumeFileName(data.resumeName)
      if (data.domain && !role) setRole(data.domain)
      if (data.experience && !experience) setExperience(data.experience as ExperienceLevel)
      setShowNoResumeOptions(false)
    } catch {
      /* ignore */
    }
  }, [role, experience])

  const handleQuickProfile = useCallback(() => {
    if (!quickTitle.trim()) return
    const exp = experience || '3-6'
    const synthetic = `Current Title: ${quickTitle.trim()}\nExperience: ${exp} years\nSkills: ${
      quickSkills.trim() || 'General professional skills'
    }`
    setResumeText(synthetic)
    setResumeFileName('Quick Profile')
    setQuickProfileDone(true)
    setShowNoResumeOptions(false)
    if (!experience) setExperience(exp as ExperienceLevel)
    fetch('/api/onboarding', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        currentTitle: quickTitle.trim(),
        experienceLevel: exp,
        topSkills: quickSkills.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 10),
        complete: true,
      }),
    }).catch(() => {})
  }, [quickTitle, quickSkills, experience])

  const handleJdPaste = useCallback(() => {
    if (!jdPasteText.trim()) return
    setJdText(jdPasteText.trim())
    setJdFileName('Pasted JD')
    setExtractingContext(true)
    fetch('/api/extract-company-context', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jdText: jdPasteText.trim() }),
    })
      .then((r) => r.json())
      .then((ctx) => {
        if (ctx.company) setTargetCompany(ctx.company)
        if (ctx.industry) setTargetIndustry(ctx.industry)
      })
      .catch(() => {})
      .finally(() => setExtractingContext(false))
  }, [jdPasteText])

  const handleFileUpload = useCallback(
    async (file: File, docType: 'jd' | 'resume') => {
      setUploadError('')
      const setUploading = docType === 'jd' ? setJdUploading : setResumeUploading
      setUploading(true)
      try {
        const formData = new FormData()
        formData.append('file', file)
        formData.append('docType', docType)
        const res = await fetch('/api/documents/upload', { method: 'POST', body: formData })
        let data
        try {
          data = await res.json()
        } catch {
          setUploadError('Upload failed — server returned an unexpected response.')
          return
        }
        if (!res.ok) {
          setUploadError(data.error || 'Upload failed')
          return
        }
        if (docType === 'jd') {
          setJdText(data.text)
          setJdFileName(data.fileName)
          if (data.text) {
            setExtractingContext(true)
            fetch('/api/extract-company-context', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ jdText: data.text }),
            })
              .then((r) => r.json())
              .then((ctx) => {
                if (ctx.company) setTargetCompany(ctx.company)
                if (ctx.industry) setTargetIndustry(ctx.industry)
              })
              .catch(() => {})
              .finally(() => setExtractingContext(false))
          }
        } else {
          setResumeText(data.text)
          setResumeFileName(data.fileName)
          setShowNoResumeOptions(false)
          fetch('/api/onboarding/extract', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ resumeText: data.text }),
          })
            .then((r) => r.json())
            .then((extracted) => {
              if (extracted.inferredRole && !role) setRole(extracted.inferredRole)
              if (extracted.experienceLevel && !experience)
                setExperience(extracted.experienceLevel)
              fetch('/api/onboarding', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  resumeText: data.text,
                  resumeFileName: data.fileName,
                  ...(extracted.currentTitle && { currentTitle: extracted.currentTitle }),
                  ...(extracted.currentIndustry && { currentIndustry: extracted.currentIndustry }),
                  ...(extracted.experienceLevel && { experienceLevel: extracted.experienceLevel }),
                  complete: true,
                }),
              }).catch(() => {})
            })
            .catch(() => {})
        }
      } catch {
        setUploadError('Failed to upload file. Please try again.')
      } finally {
        setUploading(false)
      }
    },
    [role, experience]
  )

  const start = useCallback(() => {
    if (!ready) return
    if (status === 'loading') return
    const effectiveCompany = targetCompany || jdCompany.trim()
    const config: InterviewConfig = {
      role: role!,
      ...(interviewType && { interviewType }),
      experience: experience!,
      duration: duration!,
      ...(jdText && { jobDescription: jdText, jdFileName }),
      ...(resumeText && { resumeText, resumeFileName }),
      ...(effectiveCompany && { targetCompany: effectiveCompany }),
      ...(targetIndustry && { targetIndustry }),
    }
    // Always persist the config so it survives an OAuth round-trip.
    const userId = authSession?.user?.id
    try {
      localStorage.setItem(STORAGE_KEYS.INTERVIEW_CONFIG, JSON.stringify(config))
      if (userId) {
        localStorage.setItem(
          `${STORAGE_KEYS.INTERVIEW_CONFIG}:${userId}`,
          JSON.stringify(config)
        )
      }
    } catch { /* quota */ }

    if (status !== 'authenticated') {
      // Anonymous: open the auth modal. After OAuth, the user lands back
      // here and can click Start again — config is already in localStorage.
      requireAuth('start_interview')
      return
    }
    router.push('/lobby')
  }, [
    ready,
    status,
    role,
    interviewType,
    experience,
    duration,
    jdText,
    jdFileName,
    jdCompany,
    resumeText,
    resumeFileName,
    targetCompany,
    targetIndustry,
    authSession?.user?.id,
    router,
    requireAuth,
  ])

  // JSX rendered in chunk 2.
  return <InterviewSetupFormView
    step={step}
    progress={progress}
    canGoNext={canGoNext}
    ready={!!ready}
    onNext={handleNext}
    onPrev={handlePrev}
    onStart={start}
    // Step 0
    role={role}
    setRole={(slug) => { setRole(slug); setInterviewType(null) }}
    hasResume={hasResume}
    resumeFileName={resumeFileName}
    resumeUploading={resumeUploading}
    savedResumes={savedResumes}
    showNoResumeOptions={showNoResumeOptions}
    setShowNoResumeOptions={setShowNoResumeOptions}
    quickTitle={quickTitle}
    setQuickTitle={setQuickTitle}
    quickSkills={quickSkills}
    setQuickSkills={setQuickSkills}
    onQuickProfile={handleQuickProfile}
    onResumeFile={(f) => handleFileUpload(f, 'resume')}
    onResumeRemove={() => { setResumeText(''); setResumeFileName(''); setQuickProfileDone(false) }}
    onSelectSavedResume={handleSelectSavedResume}
    onUploadError={setUploadError}
    // Step 1
    experience={experience}
    setExperience={setExperience}
    jdTab={jdTab}
    setJdTab={setJdTab}
    jdText={jdText}
    jdFileName={jdFileName}
    jdUploading={jdUploading}
    jdPasteText={jdPasteText}
    setJdPasteText={setJdPasteText}
    onJdPaste={handleJdPaste}
    onJdFile={(f) => handleFileUpload(f, 'jd')}
    onJdRemove={() => { setJdText(''); setJdFileName(''); setTargetCompany(''); setTargetIndustry('') }}
    jdCompany={jdCompany}
    setJdCompany={(v) => { setJdCompany(v); setTargetCompany(v) }}
    jdRole={jdRole}
    setJdRole={setJdRole}
    targetCompany={targetCompany}
    targetIndustry={targetIndustry}
    extractingContext={extractingContext}
    // Step 2
    interviewType={interviewType}
    setInterviewType={setInterviewType}
    duration={duration}
    setDuration={setDuration}
    // Step 3
    onJumpToStep={setStep}
    uploadError={uploadError}
  />
}

// ─── View component ────────────────────────────────────────────────────
interface ViewProps {
  step: number
  progress: number
  canGoNext: boolean
  ready: boolean
  onNext: () => void
  onPrev: () => void
  onStart: () => void
  // Step 0
  role: Role | null
  setRole: (slug: string) => void
  hasResume: boolean
  resumeFileName: string
  resumeUploading: boolean
  savedResumes: SavedResumeMeta[]
  showNoResumeOptions: boolean
  setShowNoResumeOptions: (v: boolean) => void
  quickTitle: string
  setQuickTitle: (v: string) => void
  quickSkills: string
  setQuickSkills: (v: string) => void
  onQuickProfile: () => void
  onResumeFile: (f: File) => void
  onResumeRemove: () => void
  onSelectSavedResume: (id: string) => void
  onUploadError: (msg: string) => void
  // Step 1
  experience: ExperienceLevel | null
  setExperience: (v: ExperienceLevel) => void
  jdTab: 'upload' | 'generate'
  setJdTab: (v: 'upload' | 'generate') => void
  jdText: string
  jdFileName: string
  jdUploading: boolean
  jdPasteText: string
  setJdPasteText: (v: string) => void
  onJdPaste: () => void
  onJdFile: (f: File) => void
  onJdRemove: () => void
  jdCompany: string
  setJdCompany: (v: string) => void
  jdRole: string
  setJdRole: (v: string) => void
  targetCompany: string
  targetIndustry: string
  extractingContext: boolean
  // Step 2
  interviewType: InterviewType | null
  setInterviewType: (v: InterviewType) => void
  duration: Duration | null
  setDuration: (v: Duration) => void
  // Step 3
  onJumpToStep: (n: number) => void
  uploadError: string
}

function InterviewSetupFormView(p: ViewProps) {
  const stepHints = [
    'Pick your target domain and add a resume so we can tailor questions.',
    'Tell us your experience level and (optionally) the company and role.',
    'Choose the round type and how long you want to practice.',
    'Review everything and enter the interview room.',
  ]
  const stepTitles = [
    'Start with your domain and resume',
    'Add your experience and context',
    'Pick the round type',
    'Ready when you are',
  ]

  const ctaHint = (() => {
    if (p.step === 0) {
      if (!p.role) return 'Select a domain to continue'
      if (!p.hasResume) return 'Add a resume to continue'
      return 'Looking good — continue'
    }
    if (p.step === 1) {
      if (!p.experience) return 'Select your experience level'
      if (p.role === 'general' && !p.canGoNext)
        return 'Company & role are required for General'
      return 'Optional: add JD or company for tailored questions'
    }
    if (p.step === 2) {
      if (!p.interviewType) return 'Pick an interview type'
      return 'Almost there'
    }
    return p.ready ? 'All set — enter the interview room' : 'Complete earlier steps'
  })()

  return (
    <div className="min-h-[calc(100vh-4rem)] flex flex-col bg-slate-50">
      {/* Thin progress bar beneath the site nav */}
      <div className="w-full h-1 bg-slate-200">
        <div
          className="h-full bg-blue-600 transition-all duration-500 ease-out"
          style={{ width: `${p.progress}%` }}
        />
      </div>

      {/* Inline step header — back + step counter */}
      <div className="w-full px-4 sm:px-6 py-3 flex items-center justify-between max-w-[1100px] mx-auto w-full">
        <button
          onClick={p.onPrev}
          disabled={p.step === 0}
          className={`text-xs font-medium flex items-center gap-1.5 transition-colors ${
            p.step === 0
              ? 'text-slate-300 cursor-not-allowed'
              : 'text-slate-500 hover:text-slate-800'
          }`}
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Back
        </button>
        <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">
          Step {p.step + 1} of {TOTAL_STEPS}
        </div>
        <Link href="/" className="text-xs font-medium text-slate-400 hover:text-slate-700 transition-colors">
          Exit
        </Link>
      </div>

      <main className="flex-1 flex flex-col items-center px-4 sm:px-6 pb-32 pt-2">
        <div className="w-full max-w-[1100px] animate-fade-in">
          <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 mb-1.5 leading-tight">
            {stepTitles[p.step]}
          </h1>
          <p className="text-sm text-slate-500 mb-7">{stepHints[p.step]}</p>

          {/* ── Step 0: Domain + Resume ───────────────────────────────── */}
          {p.step === 0 && (
            <div className="space-y-7">
              <section>
                <h3 className="text-[11px] font-semibold text-slate-400 uppercase tracking-[0.12em] mb-2.5">
                  Interview Domain <span className="text-red-500">*</span>
                </h3>
                <DomainSelector selectedDomain={p.role} onSelect={p.setRole} />
              </section>

              <section>
                <h3 className="text-[11px] font-semibold text-slate-400 uppercase tracking-[0.12em] mb-2.5">
                  Resume <span className="text-red-500">*</span>
                </h3>
                {p.hasResume && p.resumeFileName ? (
                  <div className="flex items-center gap-3 py-3 px-4 rounded-xl border border-blue-200 bg-blue-50">
                    <CheckCircle2 className="w-5 h-5 text-blue-600 shrink-0" />
                    <p className="text-sm text-slate-800 font-medium truncate flex-1">
                      {p.resumeFileName}
                    </p>
                    <button
                      onClick={p.onResumeRemove}
                      className="text-xs font-medium text-slate-500 hover:text-blue-600 transition-colors"
                    >
                      Change
                    </button>
                  </div>
                ) : p.showNoResumeOptions ? (
                  <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-4">
                    <div>
                      <p className="text-xs font-semibold text-slate-900 mb-2">Quick Profile</p>
                      <div className="space-y-2">
                        <input
                          type="text"
                          value={p.quickTitle}
                          onChange={(e) => p.setQuickTitle(e.target.value)}
                          placeholder="Current title (e.g. Senior Engineer)"
                          className="w-full text-sm px-3 py-2 border border-slate-200 rounded-lg bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 transition-all"
                        />
                        <input
                          type="text"
                          value={p.quickSkills}
                          onChange={(e) => p.setQuickSkills(e.target.value)}
                          placeholder="Top skills (comma separated)"
                          className="w-full text-sm px-3 py-2 border border-slate-200 rounded-lg bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 transition-all"
                        />
                        <div className="flex items-center justify-between gap-2">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={p.onQuickProfile}
                            disabled={!p.quickTitle.trim()}
                          >
                            Continue with quick profile
                          </Button>
                          <Link
                            href="/resume/wizard"
                            target="_blank"
                            className="text-xs text-blue-600 hover:text-blue-700 font-medium"
                          >
                            Build a resume →
                          </Link>
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={() => p.setShowNoResumeOptions(false)}
                      className="text-xs text-slate-400 hover:text-slate-600 transition-colors"
                    >
                      ← Back to upload
                    </button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <FileDropzone
                      label="Upload Resume"
                      fileName={p.resumeFileName || undefined}
                      isUploading={p.resumeUploading}
                      onFileSelect={p.onResumeFile}
                      onRemove={p.onResumeRemove}
                      onError={p.onUploadError}
                    />
                    {p.savedResumes.length > 0 && (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[11px] text-slate-400 font-medium">
                          Or use a saved resume:
                        </span>
                        {p.savedResumes.map((r) => (
                          <button
                            key={r.id}
                            onClick={() => p.onSelectSavedResume(r.id)}
                            className="text-[11px] px-2.5 py-1 rounded-full border border-slate-200 bg-white hover:border-blue-500 hover:text-blue-600 transition-colors"
                          >
                            {r.name}
                          </button>
                        ))}
                      </div>
                    )}
                    <button
                      onClick={() => p.setShowNoResumeOptions(true)}
                      className="text-xs text-slate-500 hover:text-blue-600 transition-colors underline underline-offset-2"
                    >
                      I don&apos;t have a resume
                    </button>
                  </div>
                )}
                {p.uploadError && (
                  <p className="mt-2 text-xs text-red-500">{p.uploadError}</p>
                )}
              </section>
            </div>
          )}

          {/* ── Step 1: Experience + Context ──────────────────────────── */}
          {p.step === 1 && (
            <div className="space-y-7">
              <section>
                <h3 className="text-[11px] font-semibold text-slate-400 uppercase tracking-[0.12em] mb-2.5">
                  Experience Level <span className="text-red-500">*</span>
                </h3>
                <SelectionGroup<ExperienceLevel>
                  items={EXPERIENCES}
                  value={p.experience}
                  onChange={(v) => p.setExperience(v as ExperienceLevel)}
                  getKey={(e) => e}
                  layout="inline"
                  renderItem={(e, selected) => (
                    <div className={`py-3 px-2 text-center ${selected ? 'text-blue-600' : ''}`}>
                      <span className="text-sm font-semibold">{EXPERIENCE_LABELS[e]}</span>
                    </div>
                  )}
                />
              </section>

              <section>
                <h3 className="text-[11px] font-semibold text-slate-400 uppercase tracking-[0.12em] mb-2.5">
                  Context{' '}
                  {p.role === 'general' ? (
                    <span className="text-red-500">*</span>
                  ) : (
                    <span className="normal-case text-[10px] font-normal text-slate-400">
                      (optional but recommended)
                    </span>
                  )}
                </h3>

                {p.jdText ? (
                  <div className="flex items-center gap-3 py-3 px-4 rounded-xl border border-blue-200 bg-blue-50">
                    <CheckCircle2 className="w-5 h-5 text-blue-600 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-slate-800 font-medium truncate">
                        {p.jdFileName || 'Job Description'}
                      </p>
                      {p.targetCompany && (
                        <p className="text-xs text-slate-500">
                          {p.targetCompany}
                          {p.targetIndustry ? ` · ${p.targetIndustry}` : ''}
                        </p>
                      )}
                    </div>
                    <button
                      onClick={p.onJdRemove}
                      className="text-xs font-medium text-slate-500 hover:text-blue-600 transition-colors"
                    >
                      Change
                    </button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="bg-white border border-slate-200 rounded-2xl p-1.5 flex w-full">
                      <button
                        onClick={() => p.setJdTab('upload')}
                        className={`flex-1 py-2 text-xs font-semibold rounded-xl transition-all ${
                          p.jdTab === 'upload'
                            ? 'bg-slate-900 text-white shadow-sm'
                            : 'text-slate-500 hover:text-slate-700'
                        }`}
                      >
                        Job Description
                      </button>
                      <button
                        onClick={() => p.setJdTab('generate')}
                        className={`flex-1 py-2 text-xs font-semibold rounded-xl transition-all ${
                          p.jdTab === 'generate'
                            ? 'bg-slate-900 text-white shadow-sm'
                            : 'text-slate-500 hover:text-slate-700'
                        }`}
                      >
                        Company &amp; Role
                      </button>
                    </div>

                    {p.jdTab === 'upload' ? (
                      <div className="space-y-2">
                        <FileDropzone
                          label="Upload Job Description"
                          fileName={p.jdFileName || undefined}
                          isUploading={p.jdUploading}
                          onFileSelect={p.onJdFile}
                          onRemove={p.onJdRemove}
                          onError={p.onUploadError}
                        />
                        <div className="relative">
                          <textarea
                            value={p.jdPasteText}
                            onChange={(e) => p.setJdPasteText(e.target.value)}
                            placeholder="…or paste the JD text here"
                            rows={3}
                            className="w-full text-sm px-3 py-2.5 border border-slate-200 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 transition-all resize-none placeholder:text-slate-400"
                          />
                          {p.jdPasteText.trim().length > 20 && (
                            <button
                              onClick={p.onJdPaste}
                              className="absolute bottom-2 right-2 text-[11px] px-2.5 py-1 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                            >
                              Use this JD
                            </button>
                          )}
                        </div>
                        {p.extractingContext && (
                          <p className="text-xs text-slate-400 animate-pulse flex items-center gap-1.5">
                            <Sparkles className="w-3 h-3" /> Detecting company and role…
                          </p>
                        )}
                      </div>
                    ) : (
                      <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3">
                        <div className="relative">
                          <Building2 className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                          <input
                            type="text"
                            value={p.jdCompany}
                            onChange={(e) => p.setJdCompany(e.target.value)}
                            placeholder="Company (e.g. Google, Stripe)"
                            className="w-full bg-slate-50 border border-slate-200 rounded-xl py-2.5 pl-10 pr-4 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 transition-all placeholder:text-slate-400"
                          />
                        </div>
                        <div className="relative">
                          <Briefcase className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                          <input
                            type="text"
                            value={p.jdRole}
                            onChange={(e) => p.setJdRole(e.target.value)}
                            placeholder="Role (e.g. Senior Engineer)"
                            className="w-full bg-slate-50 border border-slate-200 rounded-xl py-2.5 pl-10 pr-4 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 transition-all placeholder:text-slate-400"
                          />
                        </div>
                        <p className="text-[11px] text-slate-400">
                          We&apos;ll generate a tailored JD when you enter the interview room.
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </section>
            </div>
          )}

          {/* ── Step 2: Interview Type + Duration ─────────────────────── */}
          {p.step === 2 && (
            <div className="space-y-7">
              <section>
                <h3 className="text-[11px] font-semibold text-slate-400 uppercase tracking-[0.12em] mb-2.5">
                  Interview Type <span className="text-red-500">*</span>
                </h3>
                <DepthSelector
                  selectedDomain={p.role}
                  selectedDepth={p.interviewType}
                  onSelect={p.setInterviewType}
                />
              </section>
              <section>
                <h3 className="text-[11px] font-semibold text-slate-400 uppercase tracking-[0.12em] mb-2.5">
                  Duration <span className="text-red-500">*</span>
                </h3>
                <SelectionGroup<Duration>
                  items={DURATIONS}
                  value={p.duration !== null ? String(p.duration) : null}
                  onChange={(v) => p.setDuration(Number(v) as Duration)}
                  getKey={(d) => String(d)}
                  layout="inline"
                  renderItem={(d, selected) => (
                    <div className={`py-3 px-2 text-center ${selected ? 'text-blue-600' : ''}`}>
                      <span className="text-sm font-semibold">{getDurationLabel(d)}</span>
                    </div>
                  )}
                />
              </section>
            </div>
          )}

          {/* ── Step 3: Review & Start ────────────────────────────────── */}
          {p.step === 3 && (
            <div className="space-y-4">
              <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
                <div className="flex items-center justify-between mb-4 pb-3 border-b border-slate-100">
                  <h3 className="text-sm font-semibold text-slate-900">Interview Summary</h3>
                  <button
                    onClick={() => p.onJumpToStep(0)}
                    className="text-xs font-medium text-blue-600 hover:text-blue-700 flex items-center gap-1 transition-colors"
                  >
                    <Edit3 className="w-3 h-3" /> Edit
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-x-6 gap-y-3">
                  <SummaryItem label="Domain" value={p.role ? getDomainLabel(p.role) : '—'} />
                  <SummaryItem
                    label="Experience"
                    value={p.experience ? EXPERIENCE_LABELS[p.experience] : '—'}
                  />
                  <SummaryItem label="Type" value={p.interviewType || '—'} />
                  <SummaryItem
                    label="Duration"
                    value={p.duration ? getDurationLabel(p.duration) : '—'}
                  />
                  {(p.targetCompany || p.jdCompany) && (
                    <SummaryItem label="Company" value={p.targetCompany || p.jdCompany} />
                  )}
                  {p.jdRole && <SummaryItem label="Role" value={p.jdRole} />}
                  {(p.jdText || p.jdFileName) && (
                    <SummaryItem
                      label="Job Description"
                      value={p.jdFileName || 'Pasted'}
                    />
                  )}
                </div>
              </div>

              <div className="bg-blue-50 border border-blue-100 rounded-2xl p-4 text-center">
                <p className="text-sm text-blue-700 font-medium flex items-center justify-center gap-1.5">
                  <Video className="w-4 h-4" />
                  Camera &amp; microphone will be requested in the lobby
                </p>
                <p className="text-xs text-blue-500 mt-1">
                  Works best in Chrome or Edge
                </p>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Sticky bottom CTA bar */}
      <div
        className="fixed bottom-0 left-0 right-0 z-30 bg-white/95 backdrop-blur border-t border-slate-200 shadow-[0_-4px_12px_rgba(0,0,0,0.06)]"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="max-w-[1100px] mx-auto px-4 sm:px-6 py-3 flex items-center gap-4">
          <p className="text-xs text-slate-500 flex-1 truncate">{ctaHint}</p>
          {p.step < TOTAL_STEPS - 1 ? (
            <Button
              variant="primary"
              size="md"
              glow={p.canGoNext}
              disabled={!p.canGoNext}
              onClick={p.onNext}
            >
              Continue
              <ArrowRight className="w-4 h-4 ml-1.5" />
            </Button>
          ) : (
            <Button
              variant="primary"
              size="md"
              glow={p.ready}
              disabled={!p.ready}
              onClick={p.onStart}
            >
              Enter Interview Room
              <ArrowRight className="w-4 h-4 ml-1.5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">
        {label}
      </div>
      <div className="text-sm font-semibold text-slate-800 truncate">{value}</div>
    </div>
  )
}

// Silence unused-import warning — Check is used by DomainSelector indirectly
// but we also keep it here in case we add a selected-state checkmark later.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _Check = Check
