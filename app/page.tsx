'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'
import Link from 'next/link'
import FileDropzone from '@interview/components/FileDropzone'
import DomainSelector from '@interview/components/DomainSelector'
import DepthSelector from '@interview/components/DepthSelector'
import StepSection from '@shared/ui/StepSection'
import SelectionGroup from '@shared/ui/SelectionGroup'
import Button from '@shared/ui/Button'
import HowItWorksBlock from '@/shared/blocks/HowItWorks'
import StatsBlock from '@/shared/blocks/Stats'
import HeroBlock from '@/shared/blocks/Hero'
import FeaturesBlock from '@/shared/blocks/Features'
import PricingBlock from '@/shared/blocks/Pricing'
import DomainShowcaseBlock from '@/shared/blocks/DomainShowcase'
import CTABlock from '@/shared/blocks/CTA'
import ResourceLinks from '@learn/components/ResourceLinks'
import type { Role, InterviewType, ExperienceLevel, Duration, InterviewConfig } from '@shared/types'
import { EXPERIENCE_LABELS, DURATION_LABELS } from '@interview/config/interviewConfig'
import { STORAGE_KEYS } from '@shared/storageKeys'
import { getStartRedirect } from '@shared/authRedirect'

const EXPERIENCES: ExperienceLevel[] = ['0-2', '3-6', '7+']
const DURATIONS: Duration[] = [10, 20, 30]

interface SavedResumeMeta { id: string; name: string; targetRole?: string | null; updatedAt?: string | null }

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
  const [highlightStep, setHighlightStep] = useState<number | null>(null)

  // Company/industry context (extracted from JD or entered manually)
  const [targetCompany, setTargetCompany] = useState('')
  const [targetIndustry, setTargetIndustry] = useState('')
  const [extractingContext, setExtractingContext] = useState(false)

  // Resume requirement state
  const [savedResumes, setSavedResumes] = useState<SavedResumeMeta[]>([])
  const [showNoResumeOptions, setShowNoResumeOptions] = useState(false)
  const [quickTitle, setQuickTitle] = useState('')
  const [quickSkills, setQuickSkills] = useState('')
  const [quickProfileDone, setQuickProfileDone] = useState(false)
  const [profileLoaded, setProfileLoaded] = useState(false)

  // JD tab state: 'upload' | 'generate'
  const [jdTab, setJdTab] = useState<'upload' | 'generate'>('upload')
  const [jdCompany, setJdCompany] = useState('')
  const [jdRole, setJdRole] = useState('')
  const [jdGenerating, setJdGenerating] = useState(false)
  const [jdPasteText, setJdPasteText] = useState('')

  const hasResume = !!(resumeText || quickProfileDone)

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
        if (c.targetCompany) setTargetCompany(c.targetCompany)
        if (c.targetIndustry) setTargetIndustry(c.targetIndustry)
      }
    } catch { /* ignore */ }
  }, [])

  // Pre-fill from user profile (onboarding data)
  useEffect(() => {
    if (status !== 'authenticated') return
    fetch('/api/onboarding')
      .then((r) => r.json())
      .then((profile) => {
        if (!lastConfig) {
          if (!role && profile.targetRole) setRole(profile.targetRole)
          if (!experience && profile.experienceLevel) setExperience(profile.experienceLevel)
        }
        // Always load resume and saved resumes from profile
        if (!resumeText && profile.hasResume) {
          if (profile.resumeText) setResumeText(profile.resumeText)
          if (profile.resumeFileName) setResumeFileName(profile.resumeFileName)
        }
        if (profile.savedResumes?.length) setSavedResumes(profile.savedResumes)
        if (profile.currentTitle) setQuickTitle(profile.currentTitle)
        if (profile.topSkills?.length) setQuickSkills(profile.topSkills.join(', '))
        setProfileLoaded(true)
      })
      .catch(() => setProfileLoaded(true))
  }, [status]) // eslint-disable-line react-hooks/exhaustive-deps

  const ready = hasResume && role && experience && duration

  const ctaText = useMemo(() => {
    if (ready) return 'Enter Interview Room \u2192'
    if (!hasResume) return 'Add your resume to continue'
    if (!role) return 'Choose a domain to continue'
    if (!experience) return 'Select your experience level'
    if (!duration) return 'Pick a duration'
    return 'Select all options to continue'
  }, [hasResume, role, experience, duration, ready])

  const handleCtaClick = useCallback(() => {
    if (ready) {
      start()
      return
    }
    // Highlight the first incomplete required step
    const step = !hasResume ? 1 : !role ? 2 : !experience ? 4 : !duration ? 5 : null
    if (step) {
      setHighlightStep(step)
      document.getElementById(`step-${step}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setTimeout(() => setHighlightStep(null), 2000)
    }
  }, [ready, hasResume, role, experience, duration]) // eslint-disable-line react-hooks/exhaustive-deps

  // Handle selecting a saved resume
  async function handleSelectSavedResume(resumeId: string) {
    try {
      const res = await fetch(`/api/resume/interview-config?resumeId=${resumeId}`)
      if (!res.ok) return
      const data = await res.json()
      if (data.resumeText) setResumeText(data.resumeText)
      if (data.resumeName) setResumeFileName(data.resumeName)
      if (data.domain && !role) setRole(data.domain)
      if (data.experience && !experience) setExperience(data.experience)
      setShowNoResumeOptions(false)
    } catch { /* ignore */ }
  }

  // Handle quick profile submission (no resume escape hatch)
  function handleQuickProfile() {
    if (!quickTitle.trim()) return
    const exp = experience || '3-6'
    const synthetic = `Current Title: ${quickTitle.trim()}\nExperience: ${exp} years\nSkills: ${quickSkills.trim() || 'General professional skills'}`
    setResumeText(synthetic)
    setResumeFileName('Quick Profile')
    setQuickProfileDone(true)
    setShowNoResumeOptions(false)
    if (!experience) setExperience(exp as ExperienceLevel)
    // Save to profile
    fetch('/api/onboarding', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        currentTitle: quickTitle.trim(),
        experienceLevel: exp,
        topSkills: quickSkills.split(',').map(s => s.trim()).filter(Boolean).slice(0, 10),
        complete: true,
      }),
    }).catch(() => {})
  }

  // Handle JD generation from company + role
  async function handleGenerateJD() {
    if (!jdCompany.trim() || !jdRole.trim()) return
    setJdGenerating(true)
    try {
      const res = await fetch('/api/jd/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company: jdCompany.trim(),
          role: jdRole.trim(),
          resumeText: resumeText || undefined,
        }),
      })
      if (!res.ok) { setUploadError('Failed to generate JD. Try again or skip.'); return }
      const data = await res.json()
      if (data.jobDescription) {
        setJdText(data.jobDescription)
        setJdFileName(`Generated: ${jdRole} at ${jdCompany}`)
        if (data.company) setTargetCompany(data.company)
        if (data.industry) setTargetIndustry(data.industry)
      }
    } catch { setUploadError('Failed to generate JD. Try again or skip.') }
    finally { setJdGenerating(false) }
  }

  // Handle JD paste
  function handleJdPaste() {
    if (!jdPasteText.trim()) return
    setJdText(jdPasteText.trim())
    setJdFileName('Pasted JD')
    // Extract company context
    setExtractingContext(true)
    fetch('/api/extract-company-context', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jdText: jdPasteText.trim() }),
    })
      .then(r => r.json())
      .then(ctx => {
        if (ctx.company) setTargetCompany(ctx.company)
        if (ctx.industry) setTargetIndustry(ctx.industry)
      })
      .catch(() => {})
      .finally(() => setExtractingContext(false))
  }

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
      if (docType === 'jd') {
        setJdText(data.text); setJdFileName(data.fileName)
        if (data.text) {
          setExtractingContext(true)
          fetch('/api/extract-company-context', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jdText: data.text }),
          })
            .then(r => r.json())
            .then(ctx => {
              if (ctx.company) setTargetCompany(ctx.company)
              if (ctx.industry) setTargetIndustry(ctx.industry)
            })
            .catch(() => {})
            .finally(() => setExtractingContext(false))
        }
      } else {
        setResumeText(data.text); setResumeFileName(data.fileName)
        setShowNoResumeOptions(false)
        // Auto-extract profile from resume and save
        fetch('/api/onboarding/extract', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ resumeText: data.text }),
        })
          .then(r => r.json())
          .then(extracted => {
            if (extracted.inferredRole && !role) setRole(extracted.inferredRole)
            if (extracted.experienceLevel && !experience) setExperience(extracted.experienceLevel)
            // Save to profile
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
      ...(targetCompany && { targetCompany }),
      ...(targetIndustry && { targetIndustry }),
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
            <p className="text-body text-[#71767b] mb-2">
              Welcome back, {authSession.user.name.split(' ')[0]}
            </p>
          )}
          <h1 className="text-display text-[#0f1419]">Set up your interview</h1>
          {lastConfig && (
            <p className="text-body text-[#71767b] mt-2">
              Your last settings are pre-filled below.
            </p>
          )}
        </div>

        {/* Step 1: Resume (REQUIRED) */}
        <StepSection step={1} label="Your resume" completed={hasResume} highlight={highlightStep === 1}>
          {hasResume && resumeFileName ? (
            /* Compact badge when resume is loaded */
            <div className="flex items-center gap-3 py-3 px-4 rounded-xl border-2 border-emerald-500/30 bg-emerald-500/5">
              <svg className="w-5 h-5 text-emerald-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-emerald-600 font-medium truncate">{resumeFileName}</p>
                <p className="text-xs text-[#71767b]">Resume loaded</p>
              </div>
              <button
                onClick={() => { setResumeText(''); setResumeFileName(''); setQuickProfileDone(false) }}
                className="text-xs text-[#71767b] hover:text-[#6366f1] transition shrink-0"
              >
                Change
              </button>
            </div>
          ) : (
            /* Full resume input section */
            <div className="space-y-3">
              <p className="text-caption text-[var(--foreground-muted)]">
                Upload your resume for a personalized 5-dimension interview with targeted probing.
              </p>
              <FileDropzone
                label="Upload Resume (PDF, DOCX, TXT)"
                fileName={resumeFileName || undefined}
                isUploading={resumeUploading}
                onFileSelect={(file) => handleFileUpload(file, 'resume')}
                onRemove={() => { setResumeText(''); setResumeFileName('') }}
                onError={setUploadError}
              />

              {/* Saved resumes selector */}
              {savedResumes.length > 0 && (
                <div>
                  <p className="text-caption text-[var(--foreground-muted)] mb-1.5">Or select a saved resume:</p>
                  <div className="flex flex-wrap gap-2">
                    {savedResumes.map((r) => (
                      <button
                        key={r.id}
                        onClick={() => handleSelectSavedResume(r.id)}
                        className="text-xs px-3 py-1.5 rounded-full border border-[#e1e8ed] hover:border-[#6366f1] hover:text-[#6366f1] transition bg-white"
                      >
                        {r.name}{r.targetRole ? ` (${r.targetRole})` : ''}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* No resume options */}
              {!showNoResumeOptions ? (
                <button
                  onClick={() => setShowNoResumeOptions(true)}
                  className="text-xs text-[#536471] hover:text-[#6366f1] transition underline underline-offset-2"
                >
                  I don&apos;t have a resume
                </button>
              ) : (
                <div className="grid sm:grid-cols-2 gap-3 p-4 rounded-xl border border-[#e1e8ed] bg-[#f7f9f9]">
                  {/* Quick Profile */}
                  <div className="space-y-2.5">
                    <p className="text-xs font-semibold text-[#0f1419]">Quick Profile</p>
                    <p className="text-xs text-[#71767b]">Start now with basic info (4-dimension scoring)</p>
                    <input
                      type="text"
                      value={quickTitle}
                      onChange={(e) => setQuickTitle(e.target.value)}
                      placeholder="Current job title (e.g. Senior SWE)"
                      className="w-full text-xs px-3 py-2 border border-[#e1e8ed] rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-[#6366f1]"
                    />
                    <SelectionGroup<ExperienceLevel>
                      items={EXPERIENCES}
                      value={experience}
                      onChange={(v) => setExperience(v as ExperienceLevel)}
                      getKey={(e) => e}
                      layout="inline"
                      renderItem={(e, selected) => (
                        <div className={`py-1.5 px-1 text-center text-xs ${selected ? 'text-[#6366f1]' : ''}`}>
                          {EXPERIENCE_LABELS[e]}
                        </div>
                      )}
                    />
                    <input
                      type="text"
                      value={quickSkills}
                      onChange={(e) => setQuickSkills(e.target.value)}
                      placeholder="Top skills (comma-separated)"
                      className="w-full text-xs px-3 py-2 border border-[#e1e8ed] rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-[#6366f1]"
                    />
                    <Button variant="secondary" size="sm" onClick={handleQuickProfile} disabled={!quickTitle.trim()}>
                      Continue with quick profile
                    </Button>
                  </div>

                  {/* Build a Resume CTA */}
                  <div className="space-y-2.5 flex flex-col items-center justify-center text-center p-4 rounded-xl border border-dashed border-[#e1e8ed]">
                    <svg className="w-8 h-8 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                    </svg>
                    <p className="text-xs font-semibold text-[#0f1419]">Build a Resume</p>
                    <p className="text-xs text-[#71767b]">Create one with AI in minutes, then come back for a full 5-dimension interview.</p>
                    <Link href="/resume/wizard" target="_blank" className="text-xs text-[#6366f1] hover:underline font-medium">
                      Open Resume Wizard &rarr;
                    </Link>
                  </div>
                </div>
              )}
            </div>
          )}
          {uploadError && <p className="text-caption text-[#f4212e] mt-2">{uploadError}</p>}
        </StepSection>

        {/* Step 2: Job Context (encouraged, not required) */}
        <StepSection step={2} label="Job context (recommended)" completed={!!jdText}>
          {jdText ? (
            /* JD loaded badge */
            <div className="flex items-center gap-3 py-3 px-4 rounded-xl border-2 border-emerald-500/30 bg-emerald-500/5">
              <svg className="w-5 h-5 text-emerald-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-emerald-600 font-medium truncate">{jdFileName || 'Job Description'}</p>
                {(targetCompany || targetIndustry) && (
                  <p className="text-xs text-[#71767b]">{targetCompany}{targetCompany && targetIndustry ? ' · ' : ''}{targetIndustry}</p>
                )}
              </div>
              <button
                onClick={() => { setJdText(''); setJdFileName(''); setTargetCompany(''); setTargetIndustry(''); setJdPasteText('') }}
                className="text-xs text-[#71767b] hover:text-[#6366f1] transition shrink-0"
              >
                Change
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-caption text-[var(--foreground-muted)]">
                Add a job description for role-specific questions, JD gap analysis, and 5th scoring dimension (JD alignment).
              </p>

              {/* Tab switcher */}
              <div className="flex gap-1 p-0.5 rounded-lg bg-[#f7f9f9] border border-[#e1e8ed] w-fit">
                <button
                  onClick={() => setJdTab('upload')}
                  className={`text-xs px-3 py-1.5 rounded-md transition ${jdTab === 'upload' ? 'bg-white shadow-sm text-[#0f1419] font-medium' : 'text-[#536471] hover:text-[#0f1419]'}`}
                >
                  Upload / Paste JD
                </button>
                <button
                  onClick={() => setJdTab('generate')}
                  className={`text-xs px-3 py-1.5 rounded-md transition ${jdTab === 'generate' ? 'bg-white shadow-sm text-[#0f1419] font-medium' : 'text-[#536471] hover:text-[#0f1419]'}`}
                >
                  Company &amp; Role
                </button>
              </div>

              {jdTab === 'upload' ? (
                <div className="space-y-3">
                  <FileDropzone
                    label="Job Description"
                    fileName={jdFileName || undefined}
                    isUploading={jdUploading}
                    onFileSelect={(file) => handleFileUpload(file, 'jd')}
                    onRemove={() => { setJdText(''); setJdFileName(''); setTargetCompany(''); setTargetIndustry('') }}
                    onError={setUploadError}
                  />
                  <div className="relative">
                    <textarea
                      value={jdPasteText}
                      onChange={(e) => setJdPasteText(e.target.value)}
                      placeholder="Or paste the job description text here..."
                      rows={3}
                      className="w-full text-xs px-3 py-2.5 border border-[#e1e8ed] rounded-xl bg-white focus:outline-none focus:ring-1 focus:ring-[#6366f1] resize-none"
                    />
                    {jdPasteText.trim().length > 20 && (
                      <button
                        onClick={handleJdPaste}
                        className="absolute bottom-2 right-2 text-xs px-2.5 py-1 bg-[#6366f1] text-white rounded-lg hover:bg-[#5558e6] transition"
                      >
                        Use this JD
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="grid sm:grid-cols-2 gap-2">
                    <input
                      type="text"
                      value={jdCompany}
                      onChange={(e) => setJdCompany(e.target.value)}
                      placeholder="Company name (e.g. Google)"
                      className="text-xs px-3 py-2.5 border border-[#e1e8ed] rounded-xl bg-white focus:outline-none focus:ring-1 focus:ring-[#6366f1]"
                    />
                    <input
                      type="text"
                      value={jdRole}
                      onChange={(e) => setJdRole(e.target.value)}
                      placeholder="Role title (e.g. Senior PM)"
                      className="text-xs px-3 py-2.5 border border-[#e1e8ed] rounded-xl bg-white focus:outline-none focus:ring-1 focus:ring-[#6366f1]"
                    />
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleGenerateJD}
                    disabled={!jdCompany.trim() || !jdRole.trim() || jdGenerating}
                    isLoading={jdGenerating}
                  >
                    {jdGenerating ? 'Generating...' : 'Generate Sample JD'}
                  </Button>
                  <p className="text-xs text-[#8b98a5]">
                    AI will create a realistic job description to tailor your interview questions.
                  </p>
                </div>
              )}

              {/* Detected company/industry context */}
              {extractingContext && (
                <p className="text-caption text-[var(--foreground-muted)] animate-pulse">Detecting company context...</p>
              )}
            </div>
          )}
        </StepSection>

        {/* Step 3: Domain */}
        <StepSection step={3} label="Interview domain" completed={!!role} highlight={highlightStep === 2}>
          <DomainSelector selectedDomain={role} onSelect={(slug) => {
            setRole(slug)
            setInterviewType(null)
            setTimeout(() => {
              document.getElementById('step-4')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
            }, 100)
          }} />
        </StepSection>

        {/* Step 4: Interview Type */}
        <StepSection step={4} label="Interview type" completed={!!interviewType}>
          <DepthSelector selectedDomain={role} selectedDepth={interviewType} onSelect={setInterviewType} />
        </StepSection>

        {/* Steps 5 + 6: Experience & Duration side by side */}
        <div className="grid md:grid-cols-2 gap-section">
          <StepSection step={5} label="Experience level" completed={!!experience} highlight={highlightStep === 4}>
            <SelectionGroup<ExperienceLevel>
              items={EXPERIENCES}
              value={experience}
              onChange={(v) => setExperience(v as ExperienceLevel)}
              getKey={(e) => e}
              layout="inline"
              renderItem={(e, selected) => (
                <div className={`py-3 px-2 text-center ${selected ? 'text-[#6366f1]' : ''}`}>
                  <span className="text-body font-medium">{EXPERIENCE_LABELS[e]}</span>
                </div>
              )}
            />
          </StepSection>

          <StepSection step={6} label="Duration" completed={!!duration} highlight={highlightStep === 5}>
            <SelectionGroup<Duration>
              items={DURATIONS}
              value={duration !== null ? String(duration) : null}
              onChange={(v) => setDuration(Number(v) as Duration)}
              getKey={(d) => String(d)}
              layout="inline"
              renderItem={(d, selected) => (
                <div className={`py-3 px-2 text-center ${selected ? 'text-[#6366f1]' : ''}`}>
                  <span className="text-body font-medium">{DURATION_LABELS[d]}</span>
                </div>
              )}
            />
          </StepSection>
        </div>

        {/* CTA */}
        <div className="flex flex-col items-center gap-3 mt-region">
          <Button
            variant="primary"
            size="lg"
            glow={!!ready}
            isFullWidth
            className="max-w-sm"
            disabled={status === 'loading'}
            onClick={handleCtaClick}
          >
            {ctaText}
          </Button>
          <p className="text-caption text-[var(--foreground-muted)]">
            Requires Chrome or Edge &middot; Camera & mic access needed
          </p>
        </div>
      </div>

      {/* SEO / Marketing sections */}
      <HowItWorksBlock />
      <StatsBlock />

      {/* Quick access cards */}
      <section className="px-4 sm:px-6 py-section">
        <div className="max-w-[1100px] mx-auto text-center">
          <h2 className="text-heading text-[#0f1419] mb-2">More Tools</h2>
          <p className="text-body text-[#71767b] mb-section">Explore more ways to prepare for your next opportunity</p>
          <div className="grid sm:grid-cols-3 gap-4 stagger-children">
            <Link href="/learn/practice" className="card-interactive p-5 text-left group">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-10 h-10 rounded-xl bg-indigo-50 flex items-center justify-center group-hover:bg-indigo-100 transition-colors">
                  <svg className="w-5 h-5 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                  </svg>
                </div>
                <h3 className="text-sm font-semibold text-[#0f1419] group-hover:text-[#6366f1] transition-colors">Practice Sets</h3>
              </div>
              <p className="text-caption text-[#71767b]">Personalized practice plans based on your profile and progress.</p>
            </Link>
            <Link href="/resume" className="card-interactive p-5 text-left group">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-10 h-10 rounded-xl bg-emerald-50 flex items-center justify-center group-hover:bg-emerald-100 transition-colors">
                  <svg className="w-5 h-5 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                  </svg>
                </div>
                <h3 className="text-sm font-semibold text-[#0f1419] group-hover:text-emerald-500 transition-colors">Resume Tools</h3>
              </div>
              <p className="text-caption text-[#71767b]">Build, tailor, and ATS-optimize your resume with AI.</p>
            </Link>
            <Link href="/hire" className="card-interactive p-5 text-left group">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-10 h-10 rounded-xl bg-violet-50 flex items-center justify-center group-hover:bg-violet-100 transition-colors">
                  <svg className="w-5 h-5 text-violet-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z" />
                  </svg>
                </div>
                <h3 className="text-sm font-semibold text-[#0f1419] group-hover:text-violet-500 transition-colors">For Recruiters</h3>
              </div>
              <p className="text-caption text-[#71767b]">Screen candidates with AI-powered interview assessments.</p>
            </Link>
          </div>
        </div>
      </section>

      <ResourceLinks />
    </main>
  )
}

function UnauthenticatedHome() {
  return (
    <main className="min-h-screen">
      <HeroBlock />
      <HowItWorksBlock />
      <DomainShowcaseBlock />
      <StatsBlock />
      <FeaturesBlock />
      <ResourceLinks />
      <PricingBlock />
      <CTABlock />
    </main>
  )
}

export default function HomePage() {
  const { status } = useSession()

  if (status === 'loading') {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-[#8b98a5]">Loading...</div>
      </main>
    )
  }

  if (status === 'authenticated') {
    return <AuthenticatedHome />
  }

  return <UnauthenticatedHome />
}
