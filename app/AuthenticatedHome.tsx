'use client'

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'
import Link from 'next/link'
import FileDropzone from '@interview/components/FileDropzone'
import DomainSelector from '@interview/components/DomainSelector'
import DepthSelector from '@interview/components/DepthSelector'
import SelectionGroup from '@shared/ui/SelectionGroup'
import Button from '@shared/ui/Button'
import HowItWorksBlock from '@/shared/blocks/HowItWorks'
import StatsBlock from '@/shared/blocks/Stats'
import ResourceLinks from '@learn/components/ResourceLinks'
import type { Role, InterviewType, ExperienceLevel, Duration, InterviewConfig } from '@shared/types'
import { EXPERIENCE_LABELS, DURATION_LABELS, getDomainLabel } from '@interview/config/interviewConfig'
import { deduplicatedFetch } from '@shared/cachedFetch'
import { STORAGE_KEYS } from '@shared/storageKeys'
import { getStartRedirect } from '@shared/authRedirect'

const EXPERIENCES: ExperienceLevel[] = ['0-2', '3-6', '7+']
const DURATIONS: Duration[] = [10, 20, 30]

interface SavedResumeMeta { id: string; name: string; targetRole?: string | null; updatedAt?: string | null }

export default function AuthenticatedHome() {
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

  // JD tab state: 'upload' | 'generate'
  const [jdTab, setJdTab] = useState<'upload' | 'generate'>('upload')
  const [jdCompany, setJdCompany] = useState('')
  const [jdRole, setJdRole] = useState('')
  const [jdPasteText, setJdPasteText] = useState('')

  // Returning user summary
  const [lastScore, setLastScore] = useState<number | null>(null)
  const [sessionCount, setSessionCount] = useState<number | null>(null)

  // Sticky CTA
  const ctaRef = useRef<HTMLDivElement>(null)
  const [showStickyBar, setShowStickyBar] = useState(false)

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
    deduplicatedFetch('/api/onboarding')
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
      })
      .catch(() => {})
  }, [status]) // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch returning user stats
  useEffect(() => {
    if (status !== 'authenticated') return
    deduplicatedFetch('/api/interviews?limit=1')
      .then((r) => r.json())
      .then((data) => {
        const total = data.pagination?.total || data.sessions?.length || 0
        setSessionCount(total)
        if (data.sessions?.[0]?.feedback?.overall_score) {
          setLastScore(data.sessions[0].feedback.overall_score)
        }
      })
      .catch(() => {})
  }, [status])

  // Sticky CTA — show when original CTA scrolls out of viewport
  useEffect(() => {
    const el = ctaRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => setShowStickyBar(!entry.isIntersecting),
      { threshold: 0 }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const ready = hasResume && role && experience && duration

  const ctaText = useMemo(() => {
    if (ready) return 'Enter Interview Room \u2192'
    if (!hasResume) return 'Add your resume to continue'
    if (!role) return 'Choose a domain to continue'
    if (!experience) return 'Select your experience level'
    if (!duration) return 'Pick a duration'
    return 'Select all options to continue'
  }, [hasResume, role, experience, duration, ready])

  const selectionSummary = useMemo(() => {
    const parts: string[] = []
    if (role) parts.push(getDomainLabel(role))
    if (interviewType) parts.push(interviewType.charAt(0).toUpperCase() + interviewType.slice(1))
    if (experience) parts.push(EXPERIENCE_LABELS[experience])
    if (duration) parts.push(DURATION_LABELS[duration])
    return parts.join(' · ')
  }, [role, interviewType, experience, duration])

  const handleCtaClick = useCallback(() => {
    if (ready) {
      start()
      return
    }
    // Scroll to the first incomplete section
    const target = !hasResume ? 'step-resume' : !role ? 'step-3' : !experience ? 'step-5' : !duration ? 'step-6' : null
    if (target) {
      document.getElementById(target)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [ready, hasResume, role, experience, duration]) // eslint-disable-line react-hooks/exhaustive-deps

  // Handle selecting a saved resume
  async function handleSelectSavedResume(resumeId: string) {
    try {
      const res = await fetch(`/api/resume/interview-config?id=${resumeId}`)
      if (!res.ok) return
      const data = await res.json()
      if (data.resumeText) setResumeText(data.resumeText)
      if (data.resumeName) setResumeFileName(data.resumeName)
      if (data.domain && !role) setRole(data.domain)
      if (data.experience && !experience) setExperience(data.experience as ExperienceLevel)
      if (data.targetCompany) setTargetCompany(data.targetCompany)
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
    // If user entered company+role but no JD, pass them for lobby auto-generation
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
    localStorage.setItem(STORAGE_KEYS.INTERVIEW_CONFIG, JSON.stringify(config))
    router.push(redirect)
  }

  return (
    <main className="min-h-screen px-4 sm:px-6 py-6">
      <div className="max-w-[1100px] mx-auto space-y-5 animate-fade-in">
        {/* Compact header */}
        <div className="text-center">
          <h1 className="text-heading text-[#0f1419]">
            {authSession?.user?.name
              ? sessionCount && sessionCount > 0
                ? `Welcome back, ${authSession.user.name.split(' ')[0]}`
                : `Welcome back, ${authSession.user.name.split(' ')[0]} — Set up your interview`
              : 'Set up your interview'}
          </h1>
        </div>

        {/* Returning user quick stats */}
        {sessionCount !== null && sessionCount > 0 && (
          <div className="surface-card flex items-center gap-4 p-3 rounded-xl">
            {lastScore !== null && (
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-indigo-50 flex items-center justify-center">
                  <span className="text-sm font-bold text-[#6366f1]">{lastScore}</span>
                </div>
                <span className="text-xs text-[#536471]">Last score</span>
              </div>
            )}
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-[#0f1419]">{sessionCount}</span>
              <span className="text-xs text-[#536471]">{sessionCount === 1 ? 'session' : 'sessions'} completed</span>
            </div>
            <div className="flex-1" />
            <Link href="/history" className="text-xs text-[#6366f1] hover:text-[#4f46e5] font-medium transition">
              View all &rarr;
            </Link>
          </div>
        )}

        {/* Resume + JD side by side */}
        <div className="grid sm:grid-cols-2 gap-4">
          {/* Resume card */}
          <div id="step-resume">
            <p className="text-xs font-medium text-[#536471] uppercase tracking-wide mb-2">Resume {!hasResume && <span className="text-[#f4212e]">*</span>}</p>
            {hasResume && resumeFileName ? (
              <div className="flex items-center gap-2 py-2.5 px-3 rounded-xl border-2 border-emerald-500/30 bg-emerald-500/5">
                <svg className="w-4 h-4 text-emerald-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <p className="text-xs text-emerald-600 font-medium truncate flex-1">{resumeFileName}</p>
                <button onClick={() => { setResumeText(''); setResumeFileName(''); setQuickProfileDone(false) }} className="text-xs text-[#71767b] hover:text-[#6366f1] transition">Change</button>
              </div>
            ) : showNoResumeOptions ? (
              <div className="grid grid-cols-2 gap-2 p-3 rounded-xl border border-[#e1e8ed] bg-[#f7f9f9]">
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-[#0f1419]">Quick Profile</p>
                  <input type="text" value={quickTitle} onChange={(e) => setQuickTitle(e.target.value)} placeholder="Job title (e.g. Senior SWE)" className="w-full text-xs px-2.5 py-1.5 border border-[#e1e8ed] rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-[#6366f1]" />
                  <input type="text" value={quickSkills} onChange={(e) => setQuickSkills(e.target.value)} placeholder="Skills (comma-separated)" className="w-full text-xs px-2.5 py-1.5 border border-[#e1e8ed] rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-[#6366f1]" />
                  <Button variant="secondary" size="sm" onClick={handleQuickProfile} disabled={!quickTitle.trim()}>Continue</Button>
                </div>
                <div className="flex flex-col items-center justify-center text-center p-2 rounded-xl border border-dashed border-[#e1e8ed]">
                  <p className="text-xs font-semibold text-[#0f1419] mb-1">Build a Resume</p>
                  <p className="text-[10px] text-[#71767b] mb-2">AI-powered, 5 minutes</p>
                  <Link href="/resume/wizard" target="_blank" className="text-xs text-[#6366f1] hover:underline font-medium">Open Wizard &rarr;</Link>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <FileDropzone label="Upload Resume" fileName={resumeFileName || undefined} isUploading={resumeUploading} onFileSelect={(file) => handleFileUpload(file, 'resume')} onRemove={() => { setResumeText(''); setResumeFileName('') }} onError={setUploadError} />
                {savedResumes.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {savedResumes.map((r) => (
                      <button key={r.id} onClick={() => handleSelectSavedResume(r.id)} className="text-[10px] px-2 py-1 rounded-full border border-[#e1e8ed] hover:border-[#6366f1] hover:text-[#6366f1] transition bg-white">{r.name}</button>
                    ))}
                  </div>
                )}
                <button onClick={() => setShowNoResumeOptions(true)} className="text-[10px] text-[#536471] hover:text-[#6366f1] transition underline underline-offset-2">I don&apos;t have a resume</button>
              </div>
            )}
          </div>

          {/* JD card */}
          <div>
            <p className="text-xs font-medium text-[#536471] uppercase tracking-wide mb-2">Job Description <span className="normal-case text-[10px] font-normal">(recommended)</span></p>
            {jdText ? (
              <div className="flex items-center gap-2 py-2.5 px-3 rounded-xl border-2 border-emerald-500/30 bg-emerald-500/5">
                <svg className="w-4 h-4 text-emerald-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-emerald-600 font-medium truncate">{jdFileName || 'Job Description'}</p>
                  {targetCompany && <p className="text-[10px] text-[#71767b]">{targetCompany}{targetIndustry ? ` · ${targetIndustry}` : ''}</p>}
                </div>
                <button onClick={() => { setJdText(''); setJdFileName(''); setTargetCompany(''); setTargetIndustry(''); setJdPasteText('') }} className="text-xs text-[#71767b] hover:text-[#6366f1] transition">Change</button>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex gap-1 p-0.5 rounded-lg bg-[#f7f9f9] border border-[#e1e8ed] w-fit">
                  <button onClick={() => setJdTab('upload')} className={`text-[10px] px-2.5 py-1 rounded-md transition ${jdTab === 'upload' ? 'bg-white shadow-sm text-[#0f1419] font-medium' : 'text-[#536471]'}`}>Upload / Paste</button>
                  <button onClick={() => setJdTab('generate')} className={`text-[10px] px-2.5 py-1 rounded-md transition ${jdTab === 'generate' ? 'bg-white shadow-sm text-[#0f1419] font-medium' : 'text-[#536471]'}`}>Company &amp; Role</button>
                </div>
                {jdTab === 'upload' ? (
                  <div className="space-y-2">
                    <FileDropzone label="Job Description" fileName={jdFileName || undefined} isUploading={jdUploading} onFileSelect={(file) => handleFileUpload(file, 'jd')} onRemove={() => { setJdText(''); setJdFileName(''); setTargetCompany(''); setTargetIndustry('') }} onError={setUploadError} />
                    <div className="relative">
                      <textarea value={jdPasteText} onChange={(e) => setJdPasteText(e.target.value)} placeholder="Or paste JD text here..." rows={2} className="w-full text-xs px-3 py-2 border border-[#e1e8ed] rounded-xl bg-white focus:outline-none focus:ring-1 focus:ring-[#6366f1] resize-none" />
                      {jdPasteText.trim().length > 20 && (
                        <button onClick={handleJdPaste} className="absolute bottom-2 right-2 text-[10px] px-2 py-0.5 bg-[#6366f1] text-white rounded-lg hover:bg-[#5558e6] transition">Use this JD</button>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <input type="text" value={jdCompany} onChange={(e) => setJdCompany(e.target.value)} placeholder="Company (e.g. Google)" className="w-full text-xs px-3 py-2 border border-[#e1e8ed] rounded-xl bg-white focus:outline-none focus:ring-1 focus:ring-[#6366f1]" />
                    <input type="text" value={jdRole} onChange={(e) => setJdRole(e.target.value)} placeholder="Role (e.g. Senior PM)" className="w-full text-xs px-3 py-2 border border-[#e1e8ed] rounded-xl bg-white focus:outline-none focus:ring-1 focus:ring-[#6366f1]" />
                    <p className="text-[10px] text-[#8b98a5]">JD will be auto-generated when you enter the interview room.</p>
                  </div>
                )}
                {extractingContext && <p className="text-[10px] text-[var(--foreground-muted)] animate-pulse">Detecting company...</p>}
              </div>
            )}
          </div>
        </div>
        {uploadError && <p className="text-xs text-[#f4212e] -mt-2">{uploadError}</p>}

        {/* Domain selector */}
        <div id="step-3">
          <p className="text-xs font-medium text-[#536471] uppercase tracking-wide mb-2">Interview Domain</p>
          <DomainSelector selectedDomain={role} onSelect={(slug) => { setRole(slug); setInterviewType(null) }} />
        </div>

        {/* Interview Type + Experience + Duration — 3 columns */}
        <div className="grid sm:grid-cols-3 gap-4">
          <div>
            <p className="text-xs font-medium text-[#536471] uppercase tracking-wide mb-2">Type</p>
            <DepthSelector selectedDomain={role} selectedDepth={interviewType} onSelect={setInterviewType} />
          </div>
          <div id="step-5">
            <p className="text-xs font-medium text-[#536471] uppercase tracking-wide mb-2">Experience</p>
            <SelectionGroup<ExperienceLevel>
              items={EXPERIENCES}
              value={experience}
              onChange={(v) => setExperience(v as ExperienceLevel)}
              getKey={(e) => e}
              layout="inline"
              renderItem={(e, selected) => (
                <div className={`py-2 px-1 text-center ${selected ? 'text-[#6366f1]' : ''}`}>
                  <span className="text-xs font-medium">{EXPERIENCE_LABELS[e]}</span>
                </div>
              )}
            />
          </div>
          <div id="step-6">
            <p className="text-xs font-medium text-[#536471] uppercase tracking-wide mb-2">Duration</p>
            <SelectionGroup<Duration>
              items={DURATIONS}
              value={duration !== null ? String(duration) : null}
              onChange={(v) => setDuration(Number(v) as Duration)}
              getKey={(d) => String(d)}
              layout="inline"
              renderItem={(d, selected) => (
                <div className={`py-2 px-1 text-center ${selected ? 'text-[#6366f1]' : ''}`}>
                  <span className="text-xs font-medium">{DURATION_LABELS[d]}</span>
                </div>
              )}
            />
          </div>
        </div>

        {/* CTA */}
        <div ref={ctaRef} className="flex flex-col items-center gap-2 pt-1">
          <Button variant="primary" size="lg" glow={!!ready} isFullWidth className="max-w-md" disabled={status === 'loading'} onClick={handleCtaClick}>
            {ctaText}
          </Button>
          <p className="text-xs text-[#536471] flex items-center gap-1.5">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            Chrome or Edge &middot; Camera &amp; mic needed
          </p>
        </div>
      </div>

      {/* Sticky CTA bottom bar */}
      <div
        className={`fixed bottom-0 left-0 right-0 z-30 bg-white/95 backdrop-blur border-t border-[#e1e8ed] shadow-[0_-4px_12px_rgba(0,0,0,0.06)] transition-all duration-300 ${
          showStickyBar ? 'translate-y-0 opacity-100' : 'translate-y-full opacity-0 pointer-events-none'
        }`}
      >
        <div className="max-w-[1100px] mx-auto px-4 sm:px-6 py-3 flex items-center gap-4">
          {selectionSummary && (
            <p className="text-xs text-[#536471] truncate hidden sm:block flex-1">{selectionSummary}</p>
          )}
          <div className={selectionSummary ? '' : 'flex-1'}>
            <Button variant="primary" size="md" glow={!!ready} isFullWidth={!selectionSummary} className={selectionSummary ? 'min-w-[220px]' : 'max-w-md mx-auto'} disabled={status === 'loading'} onClick={handleCtaClick}>
              {ctaText}
            </Button>
          </div>
        </div>
      </div>

      {/* SEO / Marketing sections */}
      <HowItWorksBlock />
      <StatsBlock />
      <ResourceLinks />
    </main>
  )
}
