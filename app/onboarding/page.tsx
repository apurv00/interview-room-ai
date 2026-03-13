'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { motion, AnimatePresence } from 'framer-motion'
import FileDropzone from '@interview/components/FileDropzone'
import { EXPERIENCE_LABELS } from '@interview/config/interviewConfig'
import type { ExperienceLevel } from '@shared/types'

interface DomainOption {
  slug: string
  label: string
  shortLabel?: string
  icon?: string
  description?: string
  color?: string
}

const EXPERIENCES: ExperienceLevel[] = ['0-2', '3-6', '7+']

const INDUSTRIES = [
  { value: 'tech', label: 'Tech' },
  { value: 'finance', label: 'Finance' },
  { value: 'consulting', label: 'Consulting' },
  { value: 'healthcare', label: 'Healthcare' },
  { value: 'retail', label: 'Retail' },
  { value: 'media', label: 'Media' },
  { value: 'government', label: 'Government' },
  { value: 'education', label: 'Education' },
  { value: 'startup', label: 'Startup' },
  { value: 'other', label: 'Other' },
] as const

const COMPANY_TYPES = [
  { value: 'faang', label: 'FAANG / Big Tech' },
  { value: 'startup', label: 'Startup' },
  { value: 'midsize', label: 'Mid-size' },
  { value: 'consulting', label: 'Consulting' },
  { value: 'enterprise', label: 'Enterprise' },
  { value: 'any', label: 'No preference' },
] as const

const GOALS = [
  { value: 'first_interview', label: 'Preparing for my first interview', desc: 'Build confidence with structured practice' },
  { value: 'improve_scores', label: 'Improving my interview skills', desc: 'Sharpen answers with targeted feedback' },
  { value: 'career_switch', label: 'Switching careers', desc: 'Practice framing transferable skills' },
  { value: 'promotion', label: 'Preparing for a promotion', desc: 'Level up your narrative for senior roles' },
  { value: 'general_practice', label: 'General practice', desc: 'Stay sharp for any opportunity' },
] as const

const WEAK_AREAS = [
  { value: 'star_structure', label: 'STAR Structure' },
  { value: 'specificity', label: 'Being Specific' },
  { value: 'conciseness', label: 'Being Concise' },
  { value: 'confidence', label: 'Sounding Confident' },
  { value: 'technical_depth', label: 'Technical Depth' },
  { value: 'storytelling', label: 'Storytelling' },
] as const

interface ExtractedProfile {
  currentTitle: string | null
  currentIndustry: string | null
  experienceLevel: string | null
  inferredRole: string | null
  isCareerSwitcher: boolean
  switchingFrom: string | null
}

export default function OnboardingPage() {
  const router = useRouter()
  const { data: session, status } = useSession()
  const [step, setStep] = useState(1)
  const [direction, setDirection] = useState(1) // 1 = forward, -1 = back
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // Step 1: Resume
  const [resumeUploading, setResumeUploading] = useState(false)
  const [resumeFileName, setResumeFileName] = useState('')
  const [resumeText, setResumeText] = useState('')
  const [resumeR2Key, setResumeR2Key] = useState('')
  const [extracting, setExtracting] = useState(false)
  const [uploadError, setUploadError] = useState('')

  // Step 2: Profile
  const [targetRole, setTargetRole] = useState<string | null>(null)
  const [experienceLevel, setExperienceLevel] = useState<ExperienceLevel | null>(null)
  const [currentTitle, setCurrentTitle] = useState('')
  const [currentIndustry, setCurrentIndustry] = useState('')
  const [isCareerSwitcher, setIsCareerSwitcher] = useState(false)
  const [switchingFrom, setSwitchingFrom] = useState('')

  // Domains (fetched from API)
  const [domains, setDomains] = useState<DomainOption[]>([])

  // Step 3: Goals
  const [targetCompanyType, setTargetCompanyType] = useState('')
  const [interviewGoal, setInterviewGoal] = useState('')
  const [weakAreas, setWeakAreas] = useState<string[]>([])

  // Redirect if already completed onboarding
  useEffect(() => {
    if (status === 'authenticated' && session?.user?.onboardingCompleted) {
      router.replace('/')
    }
  }, [status, session, router])

  // Load existing profile data
  useEffect(() => {
    if (status !== 'authenticated') return
    fetch('/api/onboarding')
      .then((r) => r.json())
      .then((data) => {
        if (data.targetRole) setTargetRole(data.targetRole)
        if (data.experienceLevel) setExperienceLevel(data.experienceLevel)
        if (data.currentTitle) setCurrentTitle(data.currentTitle)
        if (data.currentIndustry) setCurrentIndustry(data.currentIndustry)
        if (data.isCareerSwitcher) setIsCareerSwitcher(data.isCareerSwitcher)
        if (data.switchingFrom) setSwitchingFrom(data.switchingFrom)
        if (data.targetCompanyType) setTargetCompanyType(data.targetCompanyType)
        if (data.interviewGoal) setInterviewGoal(data.interviewGoal)
        if (data.weakAreas?.length) setWeakAreas(data.weakAreas)
        if (data.resumeFileName) setResumeFileName(data.resumeFileName)
        if (data.hasResume) setResumeText('(previously uploaded)')
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [status])

  // Fetch domains on mount
  useEffect(() => {
    fetch('/api/domains')
      .then((r) => r.json())
      .then((data: DomainOption[]) => setDomains(data))
      .catch(() => {})
  }, [])

  const goForward = useCallback(() => {
    setDirection(1)
    setStep((s) => Math.min(s + 1, 3))
  }, [])

  const goBack = useCallback(() => {
    setDirection(-1)
    setStep((s) => Math.max(s - 1, 1))
  }, [])

  async function saveStep(fields: Record<string, unknown>, advance = true) {
    setSaving(true)
    try {
      await fetch('/api/onboarding', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      })
    } catch { /* continue anyway */ }
    setSaving(false)
    if (advance) goForward()
  }

  async function handleResumeUpload(file: File) {
    setUploadError('')
    setResumeUploading(true)

    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('docType', 'resume')

      const res = await fetch('/api/documents/upload', {
        method: 'POST',
        body: formData,
      })

      let data
      try {
        data = await res.json()
      } catch {
        setUploadError('Upload failed. Please try again.')
        setResumeUploading(false)
        return
      }

      if (!res.ok) {
        setUploadError(data.error || 'Upload failed')
        setResumeUploading(false)
        return
      }

      setResumeText(data.text)
      setResumeFileName(data.fileName)
      if (data.r2Key) setResumeR2Key(data.r2Key)
      setResumeUploading(false)

      // Extract profile from resume
      setExtracting(true)
      try {
        const extractRes = await fetch('/api/onboarding/extract', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ resumeText: data.text }),
        })
        const extracted: ExtractedProfile = await extractRes.json()

        if (extracted.currentTitle) setCurrentTitle(extracted.currentTitle)
        if (extracted.currentIndustry) setCurrentIndustry(extracted.currentIndustry)
        if (extracted.experienceLevel) setExperienceLevel(extracted.experienceLevel as ExperienceLevel)
        if (extracted.inferredRole) setTargetRole(extracted.inferredRole)
        if (extracted.isCareerSwitcher) setIsCareerSwitcher(true)
        if (extracted.switchingFrom) setSwitchingFrom(extracted.switchingFrom)
      } catch { /* extraction failed — user can fill manually */ }
      setExtracting(false)
    } catch {
      setUploadError('Failed to upload. Please try again.')
      setResumeUploading(false)
    }
  }

  async function handleComplete() {
    setSaving(true)
    try {
      await fetch('/api/onboarding', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetCompanyType: targetCompanyType || undefined,
          interviewGoal: interviewGoal || undefined,
          weakAreas: weakAreas.length > 0 ? weakAreas : undefined,
          complete: true,
        }),
      })
    } catch { /* continue */ }
    setSaving(false)
    router.push('/')
  }

  function toggleWeakArea(area: string) {
    setWeakAreas((prev) =>
      prev.includes(area)
        ? prev.filter((a) => a !== area)
        : prev.length < 3
        ? [...prev, area]
        : prev
    )
  }

  if (status === 'loading' || loading) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <div className="w-6 h-6 rounded-full border-2 border-indigo-400 border-t-transparent animate-spin" />
      </main>
    )
  }

  if (status === 'unauthenticated') {
    router.replace('/signin')
    return null
  }

  const slideVariants = {
    enter: (d: number) => ({ x: d > 0 ? 80 : -80, opacity: 0 }),
    center: { x: 0, opacity: 1 },
    exit: (d: number) => ({ x: d > 0 ? -80 : 80, opacity: 0 }),
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        {/* Progress bar */}
        <div className="flex gap-2 mb-8">
          {[1, 2, 3].map((s) => (
            <div
              key={s}
              className={`h-1 flex-1 rounded-full transition-colors duration-300 ${
                s < step ? 'bg-indigo-600' : s === step ? 'bg-indigo-500' : 'bg-slate-700'
              }`}
            />
          ))}
        </div>

        {/* Back button */}
        {step > 1 && (
          <button
            onClick={goBack}
            className="mb-4 flex items-center gap-1 text-sm text-slate-400 hover:text-slate-200 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            Back
          </button>
        )}

        <AnimatePresence mode="wait" custom={direction}>
          {step === 1 && (
            <motion.div
              key="step1"
              custom={direction}
              variants={slideVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.25, ease: 'easeInOut' }}
              className="space-y-6"
            >
              <div>
                <h1 className="text-2xl font-bold text-white mb-2">Upload your resume</h1>
                <p className="text-slate-400 text-sm">
                  We&apos;ll auto-fill your profile from it — saving you time.
                </p>
              </div>

              <FileDropzone
                label="Resume / CV"
                fileName={resumeFileName || undefined}
                isUploading={resumeUploading}
                onFileSelect={handleResumeUpload}
                onRemove={() => { setResumeText(''); setResumeFileName(''); setResumeR2Key('') }}
                onError={setUploadError}
              />
              {uploadError && <p className="text-xs text-red-400">{uploadError}</p>}

              {extracting && (
                <div className="flex items-center gap-3 text-sm text-indigo-400">
                  <div className="w-4 h-4 rounded-full border-2 border-indigo-400 border-t-transparent animate-spin" />
                  Analyzing your resume...
                </div>
              )}

              {resumeText && !extracting && !resumeUploading && (
                <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl px-4 py-3 text-sm text-emerald-300">
                  Resume uploaded! We&apos;ve pre-filled your profile on the next step.
                </div>
              )}

              <div className="flex flex-col items-center gap-3 pt-2">
                <button
                  onClick={() => {
                    if (resumeText) {
                      saveStep({
                        resumeText: resumeText === '(previously uploaded)' ? undefined : resumeText,
                        resumeFileName: resumeFileName || undefined,
                        resumeR2Key: resumeR2Key || undefined,
                      })
                    } else {
                      goForward()
                    }
                  }}
                  disabled={resumeUploading || extracting || saving}
                  className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl font-medium transition-colors disabled:opacity-50"
                >
                  {saving ? 'Saving...' : 'Continue'}
                </button>
                <button
                  onClick={goForward}
                  className="text-sm text-slate-500 hover:text-slate-300 transition-colors"
                >
                  I don&apos;t have a resume — skip
                </button>
              </div>
            </motion.div>
          )}

          {step === 2 && (
            <motion.div
              key="step2"
              custom={direction}
              variants={slideVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.25, ease: 'easeInOut' }}
              className="space-y-6"
            >
              <div>
                <h1 className="text-2xl font-bold text-white mb-2">
                  {resumeText ? 'Confirm your profile' : 'Tell us about yourself'}
                </h1>
                <p className="text-slate-400 text-sm">
                  {resumeText
                    ? 'We extracted these details — feel free to adjust anything.'
                    : 'This helps us personalize your interview experience.'}
                </p>
              </div>

              {/* Target Role */}
              <div className="space-y-2">
                <label className="text-xs font-semibold text-slate-500 uppercase tracking-widest">
                  Target role
                </label>
                <div className="grid grid-cols-3 gap-2 max-h-64 overflow-y-auto pr-1">
                  {domains.map((d) => (
                    <button
                      key={d.slug}
                      onClick={() => setTargetRole(d.slug)}
                      className={`flex flex-col items-center gap-1.5 py-3 rounded-xl border text-xs font-medium transition-all duration-200 ${
                        targetRole === d.slug
                          ? 'border-indigo-500 bg-indigo-500/10 text-indigo-300'
                          : 'border-slate-700 bg-slate-800/50 text-slate-400 hover:border-slate-600'
                      }`}
                    >
                      {d.icon && <span className="text-lg">{d.icon}</span>}
                      <span>{d.shortLabel || d.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Experience */}
              <div className="space-y-2">
                <label className="text-xs font-semibold text-slate-500 uppercase tracking-widest">
                  Experience level
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {EXPERIENCES.map((e) => (
                    <button
                      key={e}
                      onClick={() => setExperienceLevel(e)}
                      className={`py-3 rounded-xl border text-xs font-medium transition-all duration-200 ${
                        experienceLevel === e
                          ? 'border-indigo-500 bg-indigo-500/10 text-indigo-300'
                          : 'border-slate-700 bg-slate-800/50 text-slate-400 hover:border-slate-600'
                      }`}
                    >
                      {EXPERIENCE_LABELS[e]}
                    </button>
                  ))}
                </div>
              </div>

              {/* Current Title */}
              <div className="space-y-2">
                <label className="text-xs font-semibold text-slate-500 uppercase tracking-widest">
                  Current title
                </label>
                <input
                  type="text"
                  value={currentTitle}
                  onChange={(e) => setCurrentTitle(e.target.value)}
                  maxLength={100}
                  placeholder="e.g. Senior Software Engineer"
                  className="w-full px-4 py-3 bg-slate-800 border border-slate-700 rounded-xl text-white text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                />
              </div>

              {/* Industry */}
              <div className="space-y-2">
                <label className="text-xs font-semibold text-slate-500 uppercase tracking-widest">
                  Industry
                </label>
                <div className="grid grid-cols-5 gap-2">
                  {INDUSTRIES.map((i) => (
                    <button
                      key={i.value}
                      onClick={() => setCurrentIndustry(i.value)}
                      className={`py-2 rounded-lg border text-xs font-medium transition-all duration-200 ${
                        currentIndustry === i.value
                          ? 'border-indigo-500 bg-indigo-500/10 text-indigo-300'
                          : 'border-slate-700 bg-slate-800/50 text-slate-400 hover:border-slate-600'
                      }`}
                    >
                      {i.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Career Switcher */}
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isCareerSwitcher}
                  onChange={(e) => setIsCareerSwitcher(e.target.checked)}
                  className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-indigo-500 focus:ring-indigo-500"
                />
                <span className="text-sm text-slate-300">I&apos;m switching careers</span>
              </label>

              {isCareerSwitcher && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden"
                >
                  <input
                    type="text"
                    value={switchingFrom}
                    onChange={(e) => setSwitchingFrom(e.target.value)}
                    maxLength={100}
                    placeholder="Switching from... (e.g. Engineering)"
                    className="w-full px-4 py-3 bg-slate-800 border border-slate-700 rounded-xl text-white text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                  />
                </motion.div>
              )}

              <div className="flex flex-col items-center gap-3 pt-2">
                <button
                  onClick={() => saveStep({
                    targetRole: targetRole || undefined,
                    experienceLevel: experienceLevel || undefined,
                    currentTitle: currentTitle || undefined,
                    currentIndustry: currentIndustry || undefined,
                    isCareerSwitcher,
                    switchingFrom: isCareerSwitcher ? switchingFrom || undefined : undefined,
                  })}
                  disabled={saving}
                  className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl font-medium transition-colors disabled:opacity-50"
                >
                  {saving ? 'Saving...' : 'Continue'}
                </button>
                <button
                  onClick={goForward}
                  className="text-sm text-slate-500 hover:text-slate-300 transition-colors"
                >
                  Skip for now
                </button>
              </div>
            </motion.div>
          )}

          {step === 3 && (
            <motion.div
              key="step3"
              custom={direction}
              variants={slideVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.25, ease: 'easeInOut' }}
              className="space-y-6"
            >
              <div>
                <h1 className="text-2xl font-bold text-white mb-2">What are your goals?</h1>
                <p className="text-slate-400 text-sm">
                  This helps us tailor feedback to what matters most to you.
                </p>
              </div>

              {/* Target Company Type */}
              <div className="space-y-2">
                <label className="text-xs font-semibold text-slate-500 uppercase tracking-widest">
                  Target company type
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {COMPANY_TYPES.map((c) => (
                    <button
                      key={c.value}
                      onClick={() => setTargetCompanyType(c.value)}
                      className={`py-3 rounded-xl border text-xs font-medium transition-all duration-200 ${
                        targetCompanyType === c.value
                          ? 'border-indigo-500 bg-indigo-500/10 text-indigo-300'
                          : 'border-slate-700 bg-slate-800/50 text-slate-400 hover:border-slate-600'
                      }`}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Interview Goal */}
              <div className="space-y-2">
                <label className="text-xs font-semibold text-slate-500 uppercase tracking-widest">
                  Interview goal
                </label>
                <div className="space-y-2">
                  {GOALS.map((g) => (
                    <button
                      key={g.value}
                      onClick={() => setInterviewGoal(g.value)}
                      className={`w-full text-left px-4 py-3 rounded-xl border transition-all duration-200 ${
                        interviewGoal === g.value
                          ? 'border-indigo-500 bg-indigo-500/10'
                          : 'border-slate-700 bg-slate-800/50 hover:border-slate-600'
                      }`}
                    >
                      <span className={`text-sm font-medium ${interviewGoal === g.value ? 'text-indigo-300' : 'text-slate-300'}`}>
                        {g.label}
                      </span>
                      <p className="text-xs text-slate-500 mt-0.5">{g.desc}</p>
                    </button>
                  ))}
                </div>
              </div>

              {/* Weak Areas */}
              <div className="space-y-2">
                <label className="text-xs font-semibold text-slate-500 uppercase tracking-widest">
                  Areas to improve <span className="text-slate-600">(pick up to 3)</span>
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {WEAK_AREAS.map((w) => (
                    <button
                      key={w.value}
                      onClick={() => toggleWeakArea(w.value)}
                      className={`py-2.5 rounded-lg border text-xs font-medium transition-all duration-200 ${
                        weakAreas.includes(w.value)
                          ? 'border-indigo-500 bg-indigo-500/10 text-indigo-300'
                          : 'border-slate-700 bg-slate-800/50 text-slate-400 hover:border-slate-600'
                      }`}
                    >
                      {w.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-col items-center gap-3 pt-2">
                <button
                  onClick={handleComplete}
                  disabled={saving}
                  className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl font-semibold transition-colors disabled:opacity-50"
                >
                  {saving ? 'Setting up...' : 'Start Practicing →'}
                </button>
                <button
                  onClick={async () => {
                    setSaving(true)
                    await fetch('/api/onboarding', {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ complete: true }),
                    }).catch(() => {})
                    setSaving(false)
                    router.push('/')
                  }}
                  className="text-sm text-slate-500 hover:text-slate-300 transition-colors"
                >
                  Skip for now
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </main>
  )
}
