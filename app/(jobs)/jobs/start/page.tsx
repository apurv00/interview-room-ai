'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import Link from 'next/link'
import { clearAllInterviewStorage } from '@shared/storageKeys'
import { JOB_TARGET_QUESTION_SUMMARY } from '@jobs/config/truthfulLabels'

/**
 * /jobs/start — the attach entry + chooser + confirm bar (PRODUCT_FLOW §1
 * Stage 1, §4a). The allowlisted `?intent=upload` entry exposes the existing
 * PDF door directly; plain or unknown intents retain the full chooser.
 * Doors (founder directive 2026-07-16): saved resume / upload PDF / build one /
 * target-role question. PASTE IS NOT A PRIMARY DOOR — it is the
 * inline fallback shown only when the PDF parse fails ("if PDF upload fails
 * then paste the resume text, nothing else"). PDFs go through the stateless
 * /api/jobs/parse-pdf (text extraction only — an anon stranger's resume
 * never persists server-side; sessionStorage dies with the tab).
 * All doors converge on a review step: extracted matching skills and the
 * target role are editable before the feed is personalized. Uploads stay
 * tab-local unless a signed-in user explicitly chooses to save them.
 * The question path is marked method:'questions' so the feed never makes
 * resume-flavored claims for it.
 */

interface SkillGroup { category?: string; items?: string[] }
interface ParsedResume {
  contactInfo?: { fullName?: string }
  experience?: Array<{ title?: string }>
  skills?: SkillGroup[]
  [key: string]: unknown
}

interface ResumeParseResponse {
  resume: ParsedResume
  importedSections?: string[]
  parseConfidence?: 'no-known-loss' | 'needs-review'
  warnings?: string[]
  warning?: string
}

export interface JobsTarget {
  method: 'paste' | 'upload' | 'questions' | 'import'
  role: string
  skills: string[]
  ownerId: string | null
}

type StartDoor = 'chooser' | 'upload' | 'paste' | 'questions' | 'confirm'

function requestedStartDoor(intent: string | null): StartDoor {
  return intent === 'upload' ? 'upload' : 'chooser'
}

function flatSkills(resume: ParsedResume): string[] {
  const out: string[] = []
  for (const g of resume.skills ?? []) for (const s of g.items ?? []) if (s?.trim()) out.push(s.trim())
  const seen = new Set<string>()
  return out.filter((skill) => {
    const key = skill.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 20)
}

function parseMatchingSkills(value: string): { skills?: string[]; error?: string } {
  const raw = value.split(/[\n,]/).map((skill) => skill.trim()).filter(Boolean)
  if (raw.some((skill) => skill.length > 40)) {
    return { error: 'Keep each matching skill to 40 characters or fewer.' }
  }
  const seen = new Set<string>()
  const skills = raw.filter((skill) => {
    const key = skill.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  if (skills.length > 20) return { error: 'Keep matching skills to 20 or fewer.' }
  return { skills }
}

const IMPORTED_SECTION_LABELS: Record<string, string> = {
  contactInfo: 'contact details',
  summary: 'summary',
  experience: 'work experience',
  education: 'education',
  skills: 'skills',
  projects: 'projects',
  certifications: 'certifications',
  customSections: 'custom sections',
}

function importedSectionLabel(section: string): string {
  return IMPORTED_SECTION_LABELS[section] ?? section.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
}

function track(name: string, props: Record<string, unknown>) {
  fetch('/api/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, props }),
    keepalive: true,
  }).catch(() => {})
}

async function isAccountUnavailableResponse(response: Response): Promise<boolean> {
  if (response.status !== 401) return false
  const body = await response.json().catch(() => null) as { code?: unknown } | null
  return body?.code === 'ACCOUNT_UNAVAILABLE'
}

export default function JobsStartPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const initialDoor = requestedStartDoor(searchParams.get('intent'))
  const { data: session, status: authStatus } = useSession()
  const currentUserId = (session?.user as { id?: string } | undefined)?.id ?? null
  const liveIdentityRef = useRef({ status: authStatus, userId: currentUserId })
  liveIdentityRef.current = { status: authStatus, userId: currentUserId }
  const settledIdentityRef = useRef<{ initialized: boolean; userId: string | null }>({ initialized: false, userId: null })
  const fileRef = useRef<HTMLInputElement>(null)
  const reviewHeadingRef = useRef<HTMLHeadingElement>(null)
  const mountedRef = useRef(true)
  const terminalRef = useRef(false)
  const requestGenerationRef = useRef(0)
  const submittingRef = useRef(false)
  const [door, setDoor] = useState<StartDoor>(initialDoor)
  const [method, setMethod] = useState<JobsTarget['method']>('paste')
  const [pasteText, setPasteText] = useState('')
  const [busy, setBusy] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // confirm-bar state
  const [skillsText, setSkillsText] = useState('')
  const [role, setRole] = useState('')
  const [detectedRole, setDetectedRole] = useState('')
  const [importedSections, setImportedSections] = useState<string[]>([])
  const [parseWarnings, setParseWarnings] = useState<string[]>([])
  const [persistenceChoice, setPersistenceChoice] = useState<'session' | 'save'>('session')
  const [originUserId, setOriginUserId] = useState<string | null>(null)
  // The full parse result + original text are held in memory until the user
  // explicitly chooses whether to save them. The original text remains the
  // authoritative fullText; corrected structured skills drive matching.
  const [parsedResume, setParsedResume] = useState<ParsedResume | null>(null)
  const [rawText, setRawText] = useState('')
  const [importDoor, setImportDoor] = useState<{
    ownerId: string
    base: { id: string; name: string; targetRole: string; latestRole?: string; skills: string[] }
  } | null>(null)
  const [accountUnavailable, setAccountUnavailable] = useState(false)
  const reviewIdentityMismatch = door === 'confirm' && originUserId !== null && (
    authStatus !== 'authenticated' || currentUserId !== originUserId
  )

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      requestGenerationRef.current += 1
    }
  }, [])

  useEffect(() => {
    if (authStatus === 'loading') return
    const observed = settledIdentityRef.current
    if (!observed.initialized) {
      settledIdentityRef.current = { initialized: true, userId: currentUserId }
      return
    }
    if (observed.userId === currentUserId) return

    settledIdentityRef.current = { initialized: true, userId: currentUserId }
    requestGenerationRef.current += 1
    // Account deletion is terminal only for the identity that produced the
    // response. A different signed-in account must get a clean onboarding
    // state instead of inheriting the prior account's terminal fence.
    terminalRef.current = false
    setAccountUnavailable(false)
    submittingRef.current = false
    if (fileRef.current) fileRef.current.value = ''
    setDoor('chooser')
    setMethod('paste')
    setPasteText('')
    setBusy(false)
    setSubmitting(false)
    setSkillsText('')
    setRole('')
    setDetectedRole('')
    setImportedSections([])
    setParseWarnings([])
    setPersistenceChoice('session')
    setOriginUserId(null)
    setParsedResume(null)
    setRawText('')
    setImportDoor(null)
    setError('Your sign-in changed, so the previous resume review was cleared.')
    try {
      sessionStorage.removeItem('JOBS_TARGET')
      sessionStorage.removeItem('JOBS_CAP_NOTICE')
    } catch { /* private mode */ }
  }, [authStatus, currentUserId])

  // Auth can resolve after the stateless parse finishes. Bind the review to
  // the first authenticated identity we actually observe; never replace it
  // after an account switch.
  useEffect(() => {
    if (parsedResume && !originUserId && authStatus === 'authenticated' && currentUserId) {
      setOriginUserId(currentUserId)
    }
  }, [authStatus, currentUserId, originUserId, parsedResume])

  const scrubAccountBoundState = useCallback(() => {
    terminalRef.current = true
    requestGenerationRef.current += 1
    clearAllInterviewStorage()
    if (!mountedRef.current) return
    if (fileRef.current) fileRef.current.value = ''
    setDoor('chooser')
    setMethod('paste')
    setPasteText('')
    setBusy(false)
    setSubmitting(false)
    setError(null)
    setSkillsText('')
    setRole('')
    setDetectedRole('')
    setImportedSections([])
    setParseWarnings([])
    setPersistenceChoice('session')
    setOriginUserId(null)
    setParsedResume(null)
    setRawText('')
    setImportDoor(null)
    setAccountUnavailable(true)
  }, [])

  // Account-scoped import door. Identity and request-generation checks prevent
  // a delayed user-A response from rendering after the tab becomes user B.
  useEffect(() => {
    if (authStatus === 'loading') return
    let cancelled = false
    const requestUserId = currentUserId
    const generation = requestGenerationRef.current
    setImportDoor(null)
    fetch('/api/jobs/base-resume')
      .then(async (response) => {
        if (
          cancelled ||
          liveIdentityRef.current.userId !== requestUserId
        ) return null
        if (await isAccountUnavailableResponse(response)) {
          scrubAccountBoundState()
          return null
        }
        if (generation !== requestGenerationRef.current) return null
        return response.ok ? response.json() : null
      })
      .then((data) => {
        if (
          !cancelled &&
          !terminalRef.current &&
          requestUserId &&
          generation === requestGenerationRef.current &&
          liveIdentityRef.current.userId === requestUserId &&
          data?.base
        ) {
          setImportDoor({ ownerId: requestUserId, base: data.base })
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [authStatus, currentUserId, scrubAccountBoundState])

  useEffect(() => {
    if (door === 'confirm') reviewHeadingRef.current?.focus()
  }, [door])

  /** Returns false on failure so the UPLOAD path can drop the user on the
   *  paste fallback — with paste gone as a primary door, leaving them on
   *  the chooser with a "paste instead" error is a dead end (Codex #540). */
  async function parseAndConfirm(
    text: string,
    m: JobsTarget['method'],
    existingGeneration?: number,
    extractionWarnings: string[] = [],
  ): Promise<boolean> {
    if (terminalRef.current) return false
    const generation = existingGeneration ?? ++requestGenerationRef.current
    const requestUserId = currentUserId
    setBusy(true)
    setError(null)
    setMethod(m)
    track('jobs.resume_attach_started', { method: m })
    try {
      const res = await fetch('/api/resume/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      if (terminalRef.current || generation !== requestGenerationRef.current) return false
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? 'Could not read that resume — try pasting the text instead.')
        return false
      }
      const data = (await res.json()) as ResumeParseResponse
      if (terminalRef.current || generation !== requestGenerationRef.current) return false
      const { resume } = data
      setParsedResume(resume)
      setRawText(text)
      setSkillsText(flatSkills(resume).join(', '))
      setImportedSections(data.importedSections ?? [])
      const parserWarnings = data.warnings?.length ? data.warnings : (data.warning ? [data.warning] : [])
      setParseWarnings([...extractionWarnings, ...parserWarnings])
      setPersistenceChoice('session')
      setOriginUserId(requestUserId)
      const detected = resume.experience?.[0]?.title ?? ''
      setDetectedRole(detected)
      setRole(detected)
      setDoor('confirm')
      return true
    } catch {
      if (!terminalRef.current && generation === requestGenerationRef.current) {
        setError('Something went wrong reading the resume. Paste the text instead?')
      }
      return false
    } finally {
      if (!terminalRef.current && generation === requestGenerationRef.current) setBusy(false)
    }
  }

  async function onFile(f: File | undefined) {
    if (!f || terminalRef.current) return
    if (fileRef.current) fileRef.current.value = ''
    const generation = ++requestGenerationRef.current
    if (f.type !== 'application/pdf' && !/\.pdf$/i.test(f.name)) {
      setError('Upload a PDF — or paste your resume text below.')
      setDoor('paste')
      return
    }
    if (f.size > 10 * 1024 * 1024) {
      setError('That PDF is larger than 10MB. Paste the resume text instead.')
      setDoor('paste')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const fd = new FormData()
      // The original filename commonly contains the candidate's real name and
      // is unnecessary for this PDF-only route.
      fd.append('file', f, 'resume.pdf')
      const res = await fetch('/api/jobs/parse-pdf', { method: 'POST', body: fd })
      const data = await res.json().catch(() => ({}))
      if (terminalRef.current || generation !== requestGenerationRef.current) return
      if (!res.ok || !data.text) {
        // Founder directive: PDF failure falls back to PASTE, nothing else.
        setError(data.error ?? 'Could not read that PDF — paste your resume text instead.')
        setDoor('paste')
        return
      }
      // Structured-parse failure after a good PDF extract is STILL a failed
      // upload — same fallback: paste, nothing else (Codex #540).
      const extractionWarnings = Array.isArray(data.extractionWarnings)
        ? data.extractionWarnings.filter((warning: unknown): warning is string => typeof warning === 'string')
        : []
      const ok = await parseAndConfirm(data.text, 'upload', generation, extractionWarnings)
      if (!terminalRef.current && generation === requestGenerationRef.current && !ok) setDoor('paste')
    } catch {
      if (!terminalRef.current && generation === requestGenerationRef.current) {
        setError('Could not read that PDF — paste your resume text instead.')
        setDoor('paste')
      }
    } finally {
      if (!terminalRef.current && generation === requestGenerationRef.current) setBusy(false)
    }
  }

  async function confirmTarget() {
    if (terminalRef.current || submittingRef.current) return
    const liveIdentity = liveIdentityRef.current
    if (liveIdentity.status === 'loading') {
      setError('Wait for your sign-in status to finish loading before continuing.')
      return
    }
    if (
      (originUserId !== null || method === 'import') &&
      (
        liveIdentity.status !== 'authenticated' ||
        !originUserId ||
        liveIdentity.userId !== originUserId
      )
    ) {
      setError('Your sign-in changed. Review the resume again before continuing.')
      return
    }
    const generation = requestGenerationRef.current
    const trimmedRole = role.trim()
    if (!trimmedRole) {
      setError('Add the role you are targeting before continuing.')
      return
    }
    if (trimmedRole.length > 80) {
      setError('Keep the target role to 80 characters or fewer.')
      return
    }
    const parsedSkills = parseMatchingSkills(skillsText)
    if (!parsedSkills.skills) {
      setError(parsedSkills.error ?? 'Review the matching skills before continuing.')
      return
    }
    const skills = parsedSkills.skills
    submittingRef.current = true
    setSubmitting(true)
    setError(null)
    // City is deliberately NOT part of the target (founder directive
    // 2026-07-16): typed cities hard-collapsed the pool via alias-mismatched
    // location keys ('Bangalore' matched zero rows keyed 'bengaluru').
    const targetOwnerId = liveIdentity.status === 'authenticated' ? liveIdentity.userId : null
    const target: JobsTarget = { method, role: trimmedRole, skills, ownerId: targetOwnerId }
    try {
      const canPersistParsedResume = parseWarnings.length === 0
      const shouldSave = (
        (method === 'paste' || method === 'upload') &&
        persistenceChoice === 'save' &&
        authStatus === 'authenticated' &&
        canPersistParsedResume
      )
      let persisted = false
      if (shouldSave) {
        if (!parsedResume || authStatus !== 'authenticated' || !originUserId || currentUserId !== originUserId) {
          setError('Your sign-in changed before saving. Choose “Use for this tab only” or sign in again.')
          return
        }
        const response = await fetch('/api/jobs/base-resume', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-origin-user-id': originUserId,
          },
          body: JSON.stringify({
            // Matching-skill edits are intentionally feed-only. Persist the
            // parser's canonical skill groups unchanged so onboarding cannot
            // flatten categories or make structured data contradict fullText.
            resume: parsedResume,
            targetRole: trimmedRole,
            fullText: rawText,
          }),
        })
        const result = await response.json().catch(() => null) as { saved?: boolean; reason?: string; error?: string; code?: string } | null
        if (
          generation !== requestGenerationRef.current ||
          liveIdentityRef.current.status !== 'authenticated' ||
          liveIdentityRef.current.userId !== originUserId
        ) {
          setError('Your sign-in changed before saving. Review the upload again before continuing.')
          return
        }
        if (response.status === 401 && result?.code === 'ACCOUNT_UNAVAILABLE') {
          scrubAccountBoundState()
          return
        }
        if (!response.ok) {
          if (response.status === 401 || (response.status === 409 && result?.code === 'ACCOUNT_CHANGED')) {
            setError('Your sign-in changed before saving. Choose “Use for this tab only” or sign in again.')
          } else {
            setError(result?.error ?? 'The resume could not be saved. Retry, or choose “Use for this tab only”.')
          }
          return
        }
        if (result?.saved === false && result.reason === 'cap') {
          setPersistenceChoice('session')
          setError('My Resumes is full, so this upload was not saved. Continue with “Use for this tab only,” or free a resume slot and retry.')
          return
        } else if (result?.saved !== true) {
          setError('The resume could not be saved. Retry, or choose “Use for this tab only”.')
          return
        } else {
          persisted = true
        }
      }

      if (terminalRef.current || generation !== requestGenerationRef.current) return
      try {
        sessionStorage.setItem('JOBS_TARGET', JSON.stringify(target))
      } catch { /* private mode — the feed just stays Tier-A */ }
      track('jobs.resume_attach_completed', {
        method,
        skillCount: skills.length,
        persistenceRequested: shouldSave,
        persisted,
      })
      track('jobs.target_role_confirmed', { edited: trimmedRole !== detectedRole.trim() })
      router.push('/jobs')
    } catch {
      if (!terminalRef.current && generation === requestGenerationRef.current) {
        setError('The resume could not be saved. Retry, or choose “Use for this tab only”.')
      }
    } finally {
      submittingRef.current = false
      if (!terminalRef.current && generation === requestGenerationRef.current) setSubmitting(false)
    }
  }

  function importBase() {
    const scopedBase = importDoor?.ownerId === currentUserId ? importDoor.base : null
    if (!scopedBase || busy || terminalRef.current) return
    setMethod('import')
    setSkillsText(scopedBase.skills.join(', '))
    setImportedSections([])
    setParseWarnings([])
    setPersistenceChoice('session')
    setParsedResume(null)
    setRawText('')
    setOriginUserId(currentUserId)
    // Saved TARGET (future intent) wins when present; else prefill from the
    // resume's latest experience title — editable, same as the upload path
    // (founder 2026-07-19: the saved-resume door left the role box empty).
    // trim(): a whitespace-only saved target must not beat the experience
    // title on truthiness (Codex #557 — the save path preserves targets
    // as typed).
    const prefill = scopedBase.targetRole?.trim() || scopedBase.latestRole || ''
    setDetectedRole(prefill)
    setRole(prefill)
    track('jobs.resume_attach_started', { method: 'import' })
    setDoor('confirm')
  }

  if (accountUnavailable) {
    return (
      <main className="mx-auto max-w-xl px-4 py-16">
        <div role="status" aria-live="polite">
          <h1 className="font-medium">Your account is unavailable.</h1>
          <p className="mt-1 text-sm text-slate-500">
            Account deletion has started or completed, so resume-derived targeting was cleared from this page.
          </p>
          <p className="mt-1 text-sm text-slate-500">If you did not request deletion, contact support.</p>
        </div>
        <Link href="/jobs" className="mt-3 inline-block text-sm text-blue-600 hover:underline">← Browse public jobs</Link>
      </main>
    )
  }

  return (
    <main className="mx-auto max-w-xl px-4 py-10">
      <Link href="/jobs" className="text-sm text-slate-500 hover:underline">← Jobs</Link>
      <h1 className="mt-3 text-2xl font-semibold">
        {door === 'upload'
          ? 'Upload your resume'
          : 'Personalize Best match'}
      </h1>
      <input
        ref={fileRef}
        type="file"
        accept=".pdf,application/pdf"
        className="hidden"
        onChange={(e) => onFile(e.target.files?.[0])}
      />

      {door === 'chooser' && (
        <div className="mt-6 space-y-3">
          {importDoor?.ownerId === currentUserId && (
            <button disabled={busy} onClick={importBase} className="block w-full rounded-2xl border border-blue-300 p-4 text-left shadow-sm hover:border-blue-500 bg-white disabled:opacity-60">
              <span className="font-medium">Use my saved resume</span>
              <span className="mt-0.5 block text-sm text-slate-500">{importDoor.base.name}</span>
            </button>
          )}
          <button disabled={busy} onClick={() => fileRef.current?.click()} className="block w-full rounded-2xl border border-slate-200 p-4 text-left shadow-sm hover:border-blue-400 bg-white disabled:opacity-60">
            <span className="font-medium">{busy ? 'Reading your PDF…' : 'Upload your resume (PDF)'}</span>
            <span className="mt-0.5 block text-sm text-slate-500">The one you already send to recruiters.</span>
          </button>
          <Link href="/resume/builder?return=/jobs/start" className="block w-full rounded-2xl border border-slate-200 p-4 text-left shadow-sm hover:border-blue-400 bg-white">
            <span className="font-medium">No resume yet? Build one</span>
            <span className="mt-0.5 block text-sm text-slate-500">Create a resume, then return to set your target role.</span>
          </Link>
          <button disabled={busy} onClick={() => { setMethod('questions'); setDoor('questions') }} className="block w-full rounded-2xl border border-slate-200 p-4 text-left shadow-sm hover:border-blue-400 bg-white disabled:opacity-60">
            <span className="font-medium">Just tell us your target role</span>
            <span className="mt-0.5 block text-sm text-slate-500">{JOB_TARGET_QUESTION_SUMMARY}</span>
          </button>
        </div>
      )}

      {door === 'upload' && (
        <div className="mt-6">
          <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-6 text-center">
            <p className="font-medium">Choose your current resume</p>
            <p id="jobs-resume-upload-help" className="mt-1 text-sm text-slate-500">
              PDF, up to 10 MB. It is used for matching in this tab and is not saved unless you choose to save it after review.
            </p>
            <button
              type="button"
              disabled={busy}
              aria-describedby="jobs-resume-upload-help"
              onClick={() => fileRef.current?.click()}
              className="mt-4 min-h-11 rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
            >
              <span aria-live="polite">{busy ? 'Reading your resume…' : 'Choose PDF'}</span>
            </button>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => setDoor('chooser')}
            className="mt-4 text-sm text-blue-600 hover:underline disabled:opacity-60"
          >
            Use a saved resume or another option
          </button>
        </div>
      )}

      {door === 'paste' && (
        <div className="mt-6">
          {/* Paste is the PDF-failure fallback, never a primary door
              (founder directive 2026-07-16). The error above says why
              the user landed here. */}
          {error && <p role="alert" className="mb-3 text-sm text-amber-700">{error}</p>}
          <textarea
            aria-label="Resume text"
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            maxLength={100_000}
            rows={12}
            placeholder="Paste your full resume text here…"
            className="w-full rounded-2xl border border-slate-200 p-3 text-sm shadow-sm bg-white text-slate-900 placeholder-slate-400"
          />
          {pasteText.trim().length < 50 && <p className="mt-1 text-xs text-slate-500">Paste at least 50 characters so the parser has enough resume context.</p>}
          <div className="mt-3 flex gap-3">
            <button
              disabled={busy || pasteText.trim().length < 50}
              onClick={() => parseAndConfirm(pasteText, 'paste')}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? 'Reading your resume…' : 'Continue'}
            </button>
            <button disabled={busy} onClick={() => { setError(null); setDoor('chooser') }} className="rounded-lg border border-slate-200 px-4 py-2 text-sm bg-white text-slate-900 hover:bg-slate-50 disabled:opacity-60">Back</button>
          </div>
        </div>
      )}

      {door === 'questions' && (
        <div className="mt-6 space-y-4">
          <label className="block">
            <span className="text-sm font-medium">What role are you looking for?</span>
            <input maxLength={80} value={role} onChange={(e) => setRole(e.target.value)} placeholder="e.g. Backend Engineer, Sales Executive" className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm bg-white text-slate-900 placeholder-slate-400" />
          </label>
          <div className="flex gap-3">
            <button disabled={!role.trim()} onClick={confirmTarget} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
              Show my jobs
            </button>
            <button onClick={() => setDoor('chooser')} className="rounded-lg border border-slate-200 px-4 py-2 text-sm bg-white text-slate-900 hover:bg-slate-50">Back</button>
          </div>
        </div>
      )}

      {door === 'confirm' && reviewIdentityMismatch && (
        <div role="status" aria-live="polite" className="mt-6 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
          Refreshing this review for the current sign-in…
        </div>
      )}

      {door === 'confirm' && !reviewIdentityMismatch && (
        <div className="mt-6">
          <h2 ref={reviewHeadingRef} tabIndex={-1} className="text-lg font-medium outline-none">Review job matching</h2>
          <p className="mt-1 text-sm text-slate-500">These role and skill edits affect job matching only; they do not rewrite the uploaded resume.</p>
          {(method === 'paste' || method === 'upload') && (
            <div role="status" aria-live="polite" className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <p className="font-medium">AI-extracted — review required.</p>
              {importedSections.length > 0 && <p className="mt-1">Imported sections: {importedSections.map(importedSectionLabel).join(', ')}.</p>}
              {parseWarnings.length > 0 ? (
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {parseWarnings.map((warning) => <li key={warning}>{warning}</li>)}
                </ul>
              ) : (
                <p className="mt-1">No parser truncation or recovery warning was reported.</p>
              )}
            </div>
          )}
          <label className="mt-5 block">
            <span className="text-sm font-medium">Skills used for job matching</span>
            <span className="ml-2 text-xs text-slate-500">(comma separated, up to 20)</span>
            <textarea
              aria-label="Skills used for job matching"
              value={skillsText}
              onChange={(event) => setSkillsText(event.target.value)}
              disabled={submitting}
              rows={3}
              placeholder="e.g. Roadmapping, SQL, Customer research"
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm bg-white text-slate-900 placeholder-slate-400"
            />
          </label>
          <label className="mt-5 block">
            <span className="text-sm font-medium">Role you&apos;re targeting</span>
            <span className="ml-2 text-xs text-slate-500">(your resume is your past — this is where you&apos;re headed)</span>
            <input disabled={submitting} maxLength={80} value={role} onChange={(e) => setRole(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm bg-white text-slate-900 placeholder-slate-400 disabled:opacity-60" />
          </label>
          {(method === 'paste' || method === 'upload') && (
            authStatus === 'authenticated' && parseWarnings.length === 0 ? (
              <fieldset className="mt-5 space-y-2">
                <legend className="text-sm font-medium">What should happen to this upload?</legend>
              <label className="flex items-start gap-2 rounded-lg border border-slate-200 p-3 text-sm">
                <input disabled={submitting} type="radio" name="resume-persistence" value="session" checked={persistenceChoice === 'session'} onChange={() => setPersistenceChoice('session')} />
                  <span><strong>Use for this tab only.</strong> Sort jobs with the role and skills above; nothing is added to My Resumes. Signing out or switching accounts clears this target.</span>
                </label>
                <label className="flex items-start gap-2 rounded-lg border border-slate-200 p-3 text-sm">
                  <input disabled={submitting} type="radio" name="resume-persistence" value="save" checked={persistenceChoice === 'save'} onChange={() => setPersistenceChoice('save')} />
                  <span><strong>Save upload to My Resumes.</strong> Store the original text and AI-extracted sections in your account. If a Base Resume for this target role exists, it will be updated; review all resume fields later in Builder.</span>
                </label>
              </fieldset>
            ) : parseWarnings.length > 0 ? (
              <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                <p>This extraction may be incomplete, so it cannot be saved from this screen. You can still use it for matching in this tab.</p>
                <Link href="/resume/builder?return=/jobs/start" className="mt-2 inline-block font-medium underline">
                  Open Builder to upload or paste the original again
                </Link>
              </div>
            ) : (
              <p className="mt-5 rounded-lg border border-slate-200 p-3 text-sm text-slate-600">
                This upload is used for this tab only and is not added to My Resumes. Signing in or switching accounts clears this target.
              </p>
            )
          )}
          {method === 'import' && <p className="mt-5 text-sm text-slate-600">This resume is already saved in My Resumes.</p>}
          <button disabled={submitting || !role.trim()} onClick={confirmTarget} className="mt-5 rounded-lg bg-blue-600 px-5 py-2.5 font-medium text-white hover:bg-blue-700 disabled:opacity-50">
            {submitting
              ? persistenceChoice === 'save' && authStatus === 'authenticated' ? 'Saving…' : 'Opening jobs…'
              : persistenceChoice === 'save' && authStatus === 'authenticated' && parseWarnings.length === 0 && (method === 'paste' || method === 'upload')
                ? 'Save resume & show jobs'
                : 'Show my jobs →'}
          </button>
        </div>
      )}

      {/* The paste door renders the error inline as its lead-in. */}
      {error && door !== 'paste' && <p role="alert" className="mt-4 text-sm text-red-600">{error}</p>}
    </main>
  )
}
