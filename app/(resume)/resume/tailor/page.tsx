'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import FileDropzone from '@shared/ui/FileDropzone'
import { useAuthGate } from '@shared/providers/AuthGateProvider'
import { Check, AlertTriangle } from 'lucide-react'
import { tailoredResumeName } from '@resume/lib/resumeNames'
import { MAX_JOB_TAILORED_TEXT_CHARS } from '@shared/jobsContract'
import { clearAllInterviewStorage, JOBS_STORAGE_KEYS } from '@shared/storageKeys'

interface SavedResume {
  id: string
  name: string
  targetRole: string
}

interface TailorResult {
  tailoredResume: string
  changes: Array<{ section: string; change: string; reason: string }>
  matchScore: number
  missingKeywords: string[]
  addedKeywords: string[]
  /** Only part of the resume fit the analysis window. */
  inputTruncated?: boolean
  /** The rewrite itself was cut off — saving it would persist the loss. */
  outputTruncated?: boolean
}

type JobPostingState = 'live' | 'archived' | 'restricted' | 'snapshot-only'
type JobAssociationState =
  | 'idle'
  | 'saving'
  | 'saved'
  | 'detached'
  | 'incomplete'
  | 'oversized'
  | 'auth-required'
  | 'context-error'
  | 'lifecycle-error'
  | 'verification-error'
  | 'transient-error'
type JobContextStatus = 'loading' | 'ready' | 'terminal' | 'transient-error'
type JobAssociationDisposition = 'display' | 'unverified' | 'discard' | 'stale'

interface LoadedJobContext {
  jobId: string
  jobDescription: string
  companyName: string
  sourceJdHash: string
}

interface JobAssociationPayload {
  jobId: string
  sourceJdHash: string
  tailoredText: string
  /** Client session that originated the run; the API exact-matches it. */
  originUserId?: string
  sourceResumeId?: string
  matchScore?: number
  addedKeywords: string[]
  missingKeywords: string[]
}

interface StoredPendingAssociation {
  version: 1
  savedAt: number
  payload: JobAssociationPayload
  result: TailorResult
  resumeFileName: string
}

interface HeldTailorResult {
  payload: JobAssociationPayload
  result: TailorResult
  resumeFileName: string
}

const PENDING_ASSOCIATION_KEY = JOBS_STORAGE_KEYS.TAILOR_PENDING_ASSOCIATION
const PENDING_ASSOCIATION_TTL_MS = 10 * 60 * 1000
const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i
const JD_HASH_PATTERN = /^[a-f0-9]{64}$/
const ACCOUNT_UNAVAILABLE_MESSAGE = 'Account deletion has started or completed, so account-bound Tailor data was cleared from this page. If you did not request deletion, contact support.'

function validUserId(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) return null
  return value
}

function cappedString(value: unknown, maxLength: number, required = false): string | null {
  if (typeof value !== 'string') return null
  const capped = value.slice(0, maxLength)
  if (required && !capped.trim()) return null
  return capped
}

/** Persistence-bound artifacts are rejected, never silently amputated. */
function boundedArtifact(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) return null
  return value
}

function cappedKeywords(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value
    .slice(0, 30)
    .map((keyword) => cappedString(keyword, 60))
    .filter((keyword): keyword is string => keyword !== null && !!keyword.trim())
}

function normalizeAssociationPayload(value: unknown): JobAssociationPayload | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<JobAssociationPayload>
  if (typeof candidate.jobId !== 'string' || !OBJECT_ID_PATTERN.test(candidate.jobId)) return null
  if (typeof candidate.sourceJdHash !== 'string' || !JD_HASH_PATTERN.test(candidate.sourceJdHash)) return null
  const originUserId = validUserId(candidate.originUserId)
  if (!originUserId) return null
  const tailoredText = boundedArtifact(candidate.tailoredText, MAX_JOB_TAILORED_TEXT_CHARS)
  const addedKeywords = cappedKeywords(candidate.addedKeywords)
  const missingKeywords = cappedKeywords(candidate.missingKeywords)
  if (!tailoredText || !addedKeywords || !missingKeywords) return null
  const sourceResumeId = candidate.sourceResumeId === undefined
    ? undefined
    : cappedString(candidate.sourceResumeId, 100, true)
  if (candidate.sourceResumeId !== undefined && !sourceResumeId) return null
  const matchScore = typeof candidate.matchScore === 'number' && Number.isFinite(candidate.matchScore)
    ? Math.max(0, Math.min(100, candidate.matchScore))
    : undefined
  return {
    jobId: candidate.jobId,
    sourceJdHash: candidate.sourceJdHash,
    tailoredText,
    originUserId,
    sourceResumeId: sourceResumeId ?? undefined,
    matchScore,
    addedKeywords,
    missingKeywords,
  }
}

function normalizeTailorResult(value: unknown): TailorResult | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<TailorResult>
  const tailoredResume = boundedArtifact(candidate.tailoredResume, MAX_JOB_TAILORED_TEXT_CHARS)
  const addedKeywords = cappedKeywords(candidate.addedKeywords)
  const missingKeywords = cappedKeywords(candidate.missingKeywords)
  if (!tailoredResume || !addedKeywords || !missingKeywords || !Array.isArray(candidate.changes)) return null
  if (typeof candidate.matchScore !== 'number' || !Number.isFinite(candidate.matchScore)) return null
  const changes = candidate.changes.slice(0, 50).flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const section = cappedString(entry.section, 120)
    const change = cappedString(entry.change, 1_000)
    const reason = cappedString(entry.reason, 1_000)
    return section !== null && change !== null && reason !== null
      ? [{ section, change, reason }]
      : []
  })
  return {
    tailoredResume,
    changes,
    matchScore: Math.max(0, Math.min(100, candidate.matchScore)),
    missingKeywords,
    addedKeywords,
    inputTruncated: candidate.inputTruncated === true,
    outputTruncated: candidate.outputTruncated === true,
  }
}

function readStoredPendingAssociation(now = Date.now()): StoredPendingAssociation | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.sessionStorage.getItem(PENDING_ASSOCIATION_KEY)
    if (!raw) return null
    const candidate = JSON.parse(raw) as Partial<StoredPendingAssociation>
    const savedAt = candidate.savedAt
    const payload = normalizeAssociationPayload(candidate.payload)
    const result = normalizeTailorResult(candidate.result)
    const resumeFileName = cappedString(candidate.resumeFileName, 200)
    const validAge = typeof savedAt === 'number' && Number.isFinite(savedAt) &&
      savedAt <= now + 60_000 && now - savedAt <= PENDING_ASSOCIATION_TTL_MS
    if (candidate.version !== 1 || !validAge || !payload || !result || resumeFileName === null || payload.tailoredText !== result.tailoredResume) {
      window.sessionStorage.removeItem(PENDING_ASSOCIATION_KEY)
      return null
    }
    return { version: 1, savedAt, payload, result, resumeFileName }
  } catch {
    try { window.sessionStorage.removeItem(PENDING_ASSOCIATION_KEY) } catch { /* unavailable */ }
    return null
  }
}

function storePendingAssociation(
  payloadValue: JobAssociationPayload,
  resultValue: TailorResult,
  resumeFileNameValue: string,
): boolean {
  if (typeof window === 'undefined') return false
  const payload = normalizeAssociationPayload(payloadValue)
  const result = normalizeTailorResult(resultValue)
  const resumeFileName = cappedString(resumeFileNameValue, 200)
  if (!payload || !result || resumeFileName === null || payload.tailoredText !== result.tailoredResume) return false
  try {
    window.sessionStorage.setItem(PENDING_ASSOCIATION_KEY, JSON.stringify({
      version: 1,
      savedAt: Date.now(),
      payload,
      result,
      resumeFileName,
    } satisfies StoredPendingAssociation))
    return true
  } catch {
    return false
  }
}

function clearStoredPendingAssociation(expected?: Pick<JobAssociationPayload, 'jobId' | 'sourceJdHash'>): void {
  if (typeof window === 'undefined') return
  try {
    if (expected) {
      const current = readStoredPendingAssociation()
      if (current && (current.payload.jobId !== expected.jobId || current.payload.sourceJdHash !== expected.sourceJdHash)) return
    }
    window.sessionStorage.removeItem(PENDING_ASSOCIATION_KEY)
  } catch { /* unavailable */ }
}

export default function TailorPage() {
  const router = useRouter()
  const { data: session, status: authStatus } = useSession()
  const sessionUserId = validUserId((session?.user as { id?: unknown } | undefined)?.id)
  const { requireAuth } = useAuthGate()
  const isAnonymous = authStatus !== 'authenticated'
  const [savedResumes, setSavedResumes] = useState<SavedResume[]>([])
  const [resumeText, setResumeText] = useState('')
  const [resumeSource, setResumeSource] = useState<'upload' | 'saved' | 'paste'>('upload')
  const [resumeFileName, setResumeFileName] = useState('')
  const [jobDescription, setJobDescription] = useState('')
  const [companyName, setCompanyName] = useState('')
  const [jobPostingState, setJobPostingState] = useState<JobPostingState | null>(null)
  const [jobTailorAllowed, setJobTailorAllowed] = useState<boolean | null>(null)
  const [jobContextStatus, setJobContextStatus] = useState<JobContextStatus>('loading')
  const [jobContextRetry, setJobContextRetry] = useState(0)
  const [loadedJobContext, setLoadedJobContext] = useState<LoadedJobContext | null>(null)
  const [jobAssociation, setJobAssociation] = useState<JobAssociationState>('idle')
  const [pendingAssociation, setPendingAssociation] = useState<JobAssociationPayload | null>(null)
  const [tailoring, setTailoring] = useState(false)
  const [result, setResult] = useState<TailorResult | null>(null)
  const [resultResumeFileName, setResultResumeFileName] = useState('')
  const [resultOriginUserId, setResultOriginUserId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [accountUnavailable, setAccountUnavailable] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [savingCopy, setSavingCopy] = useState(false)
  /** Controlled value for the saved-resume dropdown. The old uncontrolled
   *  defaultValue meant that after "Remove", re-selecting the SAME resume
   *  fired no change event — the dropdown looked selected but did nothing. */
  const [selectedId, setSelectedId] = useState('')
  const [loadedSavedResumeId, setLoadedSavedResumeId] = useState('')
  // Jobs hand-off (Wave 4.5, package 11): ?jobId= prefills the JD from the
  // posting and the tailored result persists on the application row.
  const searchParams = useSearchParams()
  const jobId = searchParams?.get('jobId') ?? null
  const jobContextSessionKey = authStatus === 'authenticated'
    ? `user:${sessionUserId ?? 'unknown'}`
    : authStatus
  const activeJobIdRef = useRef<string | null>(jobId)
  const jobFetchRequestRef = useRef(0)
  const tailorRequestRef = useRef(0)
  const associationRequestRef = useRef(0)
  const pendingRecoveryAttemptRef = useRef<string | null>(null)
  const savedResumeRequestRef = useRef(0)
  const savedResumeAbortRef = useRef<AbortController | null>(null)
  const savedResumeListRequestRef = useRef(0)
  const savedResumeListAbortRef = useRef<AbortController | null>(null)
  const uploadRequestRef = useRef(0)
  const uploadAbortRef = useRef<AbortController | null>(null)
  const saveCopyRequestRef = useRef(0)
  const heldResultRef = useRef<HeldTailorResult | null>(null)
  const accountUnavailableRef = useRef(false)
  const selectedResumeIdRef = useRef('')
  const sessionUserIdRef = useRef<string | null>(sessionUserId)
  const previousSessionUserIdRef = useRef<string | null>(sessionUserId)
  activeJobIdRef.current = jobId
  sessionUserIdRef.current = sessionUserId
  const resolvedIdentityChanged = !!previousSessionUserIdRef.current &&
    previousSessionUserIdRef.current !== sessionUserId

  const scrubAccountBoundState = useCallback((message: string, terminalAccountUnavailable = false) => {
    // ACCOUNT_UNAVAILABLE is an authoritative deletion fence. Once observed,
    // this mounted page must never become interactive again: a later session,
    // query-param transition, or stale async completion cannot revive private
    // Tailor data or start another document upload.
    if (accountUnavailableRef.current) return
    if (terminalAccountUnavailable) {
      accountUnavailableRef.current = true
      setAccountUnavailable(true)
    }
    clearAllInterviewStorage()
    clearStoredPendingAssociation()
    jobFetchRequestRef.current += 1
    tailorRequestRef.current += 1
    associationRequestRef.current += 1
    savedResumeRequestRef.current += 1
    savedResumeAbortRef.current?.abort()
    savedResumeAbortRef.current = null
    savedResumeListRequestRef.current += 1
    savedResumeListAbortRef.current?.abort()
    savedResumeListAbortRef.current = null
    uploadRequestRef.current += 1
    uploadAbortRef.current?.abort()
    uploadAbortRef.current = null
    saveCopyRequestRef.current += 1
    heldResultRef.current = null
    selectedResumeIdRef.current = ''
    pendingRecoveryAttemptRef.current = null
    setSavedResumes([])
    setSelectedId('')
    setLoadedSavedResumeId('')
    setResumeText('')
    setResumeFileName('')
    setResumeSource('upload')
    setUploading(false)
    setTailoring(false)
    setSavingCopy(false)
    setResult(null)
    setResultResumeFileName('')
    setResultOriginUserId(null)
    setPendingAssociation(null)
    setJobAssociation('idle')
    setLoadedJobContext(null)
    setJobDescription('')
    setCompanyName('')
    setJobPostingState(null)
    setJobTailorAllowed(false)
    setJobContextStatus('terminal')
    setError(terminalAccountUnavailable ? ACCOUNT_UNAVAILABLE_MESSAGE : message)
  }, [])

  const enterAccountUnavailableState = useCallback(() => {
    scrubAccountBoundState(ACCOUNT_UNAVAILABLE_MESSAGE, true)
  }, [scrubAccountBoundState])

  useEffect(() => {
    if (accountUnavailableRef.current) return
    const requestId = ++jobFetchRequestRef.current
    const controller = new AbortController()
    // A query-param transition is a new provenance boundary. Invalidate every
    // in-flight result and clear values derived from the previous posting.
    tailorRequestRef.current += 1
    associationRequestRef.current += 1
    setTailoring(false)
    setResult(null)
    setResultResumeFileName('')
    setResultOriginUserId(null)
    heldResultRef.current = null
    saveCopyRequestRef.current += 1
    setSavingCopy(false)
    setError('')
    setJobDescription('')
    setCompanyName('')
    setJobPostingState(null)
    setLoadedJobContext(null)
    setPendingAssociation(null)
    setJobAssociation('idle')
    pendingRecoveryAttemptRef.current = null
    setJobTailorAllowed(jobId ? null : false)
    setJobContextStatus(jobId ? 'loading' : 'terminal')
    if (!jobId) return () => controller.abort()

    fetch(`/api/jobs/${jobId}`, { signal: controller.signal })
      .then(async (response) => {
        if (response.status === 404) return { kind: 'terminal' as const }
        if (response.status === 401) {
          const body = await response.json().catch(() => null) as { code?: unknown } | null
          if (body?.code === 'ACCOUNT_UNAVAILABLE') {
            return { kind: 'account-unavailable' as const }
          }
        }
        if (!response.ok) return { kind: 'transient-error' as const }
        try {
          const data = await response.json()
          if (!data || typeof data !== 'object' || typeof data.gated !== 'boolean') {
            return { kind: 'transient-error' as const }
          }
          // A shell while the client has an authenticated continuation means
          // the server has not observed the refreshed session yet. Keep the
          // continuation retryable; it is not an authoritative policy denial.
          if (data.gated === true) return { kind: 'transient-error' as const }
          if (!data.capabilities || typeof data.capabilities.tailor !== 'boolean' ||
            !['live', 'archived', 'restricted', 'snapshot-only'].includes(data.postingState)) {
            return { kind: 'transient-error' as const }
          }
          return { kind: 'detail' as const, data }
        } catch {
          return { kind: 'transient-error' as const }
        }
      })
      .then((resolution) => {
        if (controller.signal.aborted || requestId !== jobFetchRequestRef.current || activeJobIdRef.current !== jobId) return
        if (resolution.kind === 'account-unavailable') {
          enterAccountUnavailableState()
          return
        }
        if (resolution.kind === 'transient-error') {
          setJobTailorAllowed(false)
          setJobContextStatus('transient-error')
          setJobAssociation('detached')
          return
        }
        if (resolution.kind === 'terminal') {
          setJobTailorAllowed(false)
          setJobContextStatus('terminal')
          setJobAssociation('detached')
          return
        }
        const d = resolution.data
        if (d.gated === false) {
          const nextJd = typeof d.jd === 'string' ? d.jd : ''
          const nextCompany = typeof d.company === 'string' ? d.company : ''
          const sourceJdHash = typeof d.tailorInputHash === 'string' && /^[a-f0-9]{64}$/.test(d.tailorInputHash)
            ? d.tailorInputHash
            : ''
          setJobDescription(nextJd)
          setCompanyName(nextCompany)
          if (['live', 'archived', 'restricted', 'snapshot-only'].includes(d.postingState)) {
            setJobPostingState(d.postingState as JobPostingState)
          }
          const allowed = d.capabilities?.tailor === true && !!nextJd.trim() && !!sourceJdHash
          setJobTailorAllowed(allowed)
          setJobContextStatus(allowed ? 'ready' : 'terminal')
          if (allowed) {
            setLoadedJobContext({ jobId, jobDescription: nextJd, companyName: nextCompany, sourceJdHash })
          } else {
            setJobAssociation('detached')
          }
          return
        }
        setJobTailorAllowed(false)
        setJobContextStatus('terminal')
        setJobAssociation('detached')
      })
      .catch(() => {
        if (controller.signal.aborted || requestId !== jobFetchRequestRef.current) return
        setJobTailorAllowed(false)
        setJobContextStatus('transient-error')
        setJobAssociation('detached')
      })
    return () => controller.abort()
  }, [enterAccountUnavailableState, jobId, jobContextRetry, jobContextSessionKey])
  useEffect(() => () => {
    savedResumeAbortRef.current?.abort()
    savedResumeListAbortRef.current?.abort()
    uploadAbortRef.current?.abort()
  }, [])

  useEffect(() => {
    if (accountUnavailableRef.current) return
    const stored = readStoredPendingAssociation()
    if (stored && stored.payload.jobId !== jobId) clearStoredPendingAssociation()
  }, [jobId])

  useEffect(() => {
    if (accountUnavailableRef.current) return
    const previousUserId = previousSessionUserIdRef.current
    const authenticatedIdentityChanged = !!previousUserId && previousUserId !== sessionUserId
    previousSessionUserIdRef.current = sessionUserId

    savedResumeListRequestRef.current += 1
    savedResumeListAbortRef.current?.abort()
    savedResumeListAbortRef.current = null
    savedResumeRequestRef.current += 1
    savedResumeAbortRef.current?.abort()
    savedResumeAbortRef.current = null
    selectedResumeIdRef.current = ''
    setSavedResumes([])

    if (authenticatedIdentityChanged) {
      clearStoredPendingAssociation()
      uploadRequestRef.current += 1
      uploadAbortRef.current?.abort()
      uploadAbortRef.current = null
      tailorRequestRef.current += 1
      associationRequestRef.current += 1
      saveCopyRequestRef.current += 1
      heldResultRef.current = null
      setSelectedId('')
      setLoadedSavedResumeId('')
      setResumeText('')
      setResumeFileName('')
      setResumeSource('upload')
      setUploading(false)
      setTailoring(false)
      setSavingCopy(false)
      setResult(null)
      setResultResumeFileName('')
      setResultOriginUserId(null)
      setPendingAssociation(null)
      setJobAssociation('idle')
      setError('')
    }

    if (authStatus !== 'authenticated' || !sessionUserId) return
    const controller = new AbortController()
    savedResumeListAbortRef.current = controller
    const requestId = savedResumeListRequestRef.current
    fetch('/api/resume/save', {
      headers: { 'x-origin-user-id': sessionUserId },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (response.status === 401) {
          const unavailable = await response.json().catch(() => null) as { code?: unknown } | null
          return unavailable?.code === 'ACCOUNT_UNAVAILABLE'
            ? { kind: 'account-unavailable' as const }
            : { kind: 'ignored' as const }
        }
        if (response.status === 409) {
          const conflict = await response.json().catch(() => null) as { code?: unknown } | null
          return conflict?.code === 'SESSION_CHANGED'
            ? { kind: 'session-changed' as const }
            : { kind: 'ignored' as const }
        }
        if (!response.ok) return { kind: 'ignored' as const }
        return { kind: 'data' as const, data: await response.json() }
      })
      .then((resolution) => {
        if (controller.signal.aborted || requestId !== savedResumeListRequestRef.current || sessionUserIdRef.current !== sessionUserId) return
        if (resolution.kind === 'session-changed') {
          scrubAccountBoundState('Your sign-in account changed while saved resumes were loading. Sign in again before continuing.')
          return
        }
        if (resolution.kind === 'account-unavailable') {
          enterAccountUnavailableState()
          return
        }
        if (resolution.kind === 'data') {
          setSavedResumes(Array.isArray(resolution.data?.resumes) ? resolution.data.resumes : [])
        }
      })
      .catch(() => {})
    return () => controller.abort()
  }, [authStatus, enterAccountUnavailableState, scrubAccountBoundState, sessionUserId])

  async function handleSelectSaved(id: string) {
    if (accountUnavailableRef.current) return
    const resume = savedResumes.find(r => r.id === id)
    if (!resume) return
    const resumeUserId = sessionUserId
    if (authStatus !== 'authenticated' || !resumeUserId) {
      setError('We could not verify your sign-in account. Sign in again before loading this resume.')
      return
    }
    savedResumeRequestRef.current += 1
    savedResumeAbortRef.current?.abort()
    const controller = new AbortController()
    savedResumeAbortRef.current = controller
    const requestId = savedResumeRequestRef.current
    selectedResumeIdRef.current = id
    setLoadedSavedResumeId('')
    setResumeText('')
    setResumeFileName('')
    setResumeSource('saved')
    setError('')
    try {
      const res = await fetch(`/api/resume/save?id=${id}`, {
        headers: { 'x-origin-user-id': resumeUserId },
        signal: controller.signal,
      })
      if (controller.signal.aborted || requestId !== savedResumeRequestRef.current || selectedResumeIdRef.current !== id || resumeUserId !== sessionUserIdRef.current) return
      if (res.status === 401) {
        const unavailable = await res.json().catch(() => null) as { code?: unknown } | null
        if (controller.signal.aborted || requestId !== savedResumeRequestRef.current || selectedResumeIdRef.current !== id || resumeUserId !== sessionUserIdRef.current) return
        if (unavailable?.code === 'ACCOUNT_UNAVAILABLE') {
          enterAccountUnavailableState()
          return
        }
      }
      if (res.status === 409) {
        const conflict = await res.json().catch(() => null) as { code?: unknown } | null
        if (controller.signal.aborted || requestId !== savedResumeRequestRef.current || selectedResumeIdRef.current !== id || resumeUserId !== sessionUserIdRef.current) return
        if (conflict?.code === 'SESSION_CHANGED') {
          scrubAccountBoundState('Your sign-in account changed while this resume was loading. Sign in again before continuing.')
          return
        }
      }
      if (!res.ok) {
        // Stale dropdown (deleted in another tab) used to no-op silently.
        setError('That resume could not be loaded — it may have been deleted. Pick another or refresh.')
        setSelectedId('')
        selectedResumeIdRef.current = ''
        return
      }
      const data = await res.json()
      if (controller.signal.aborted || requestId !== savedResumeRequestRef.current || selectedResumeIdRef.current !== id || resumeUserId !== sessionUserIdRef.current) return
      if (data.fullText) {
        setResumeText(data.fullText)
        setResumeFileName(resume.name)
        setResumeSource('saved')
        setLoadedSavedResumeId(id)
      } else {
        setError('That resume has no text to tailor yet — open it in the builder and add content first.')
        setSelectedId('')
        selectedResumeIdRef.current = ''
      }
    } catch {
      if (controller.signal.aborted || requestId !== savedResumeRequestRef.current || selectedResumeIdRef.current !== id || resumeUserId !== sessionUserIdRef.current) return
      setError('Could not load that resume. Please try again.')
      setSelectedId('')
      selectedResumeIdRef.current = ''
    } finally {
      if (savedResumeAbortRef.current === controller) savedResumeAbortRef.current = null
    }
  }

  async function handleUpload(file: File) {
    if (accountUnavailableRef.current) return
    if (isAnonymous) { requireAuth('parse_resume'); return }
    const uploadUserId = sessionUserId
    if (!uploadUserId) {
      setError('We could not verify your sign-in account. Sign in again before uploading this resume.')
      return
    }
    savedResumeRequestRef.current += 1
    savedResumeAbortRef.current?.abort()
    savedResumeAbortRef.current = null
    selectedResumeIdRef.current = ''
    setLoadedSavedResumeId('')
    setSelectedId('')
    uploadRequestRef.current += 1
    uploadAbortRef.current?.abort()
    const controller = new AbortController()
    uploadAbortRef.current = controller
    const requestId = uploadRequestRef.current
    setUploading(true)
    setError('')
    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('docType', 'resume')
      const res = await fetch('/api/documents/upload', {
        method: 'POST',
        headers: { 'x-origin-user-id': uploadUserId },
        body: formData,
        signal: controller.signal,
      })
      const data = await res.json()
      if (controller.signal.aborted || requestId !== uploadRequestRef.current || uploadUserId !== sessionUserIdRef.current) return
      if (res.status === 409 && data?.code === 'SESSION_CHANGED') {
        scrubAccountBoundState('Your sign-in account changed before the upload completed. Sign in again, then upload the resume again.')
        return
      }
      if (res.status === 401 && data?.code === 'ACCOUNT_UNAVAILABLE') {
        enterAccountUnavailableState()
        return
      }
      if (res.ok) {
        setResumeText(data.text)
        setResumeFileName(data.fileName)
        setResumeSource('upload')
      } else setError(data.error || 'Upload failed')
    } catch {
      if (!controller.signal.aborted && requestId === uploadRequestRef.current && uploadUserId === sessionUserIdRef.current) {
        setError('Upload failed')
      }
    } finally {
      if (uploadAbortRef.current === controller) uploadAbortRef.current = null
      if (requestId === uploadRequestRef.current) setUploading(false)
    }
  }

  const persistJobAssociation = useCallback(async (payload: JobAssociationPayload) => {
    if (accountUnavailableRef.current) return 'stale' satisfies JobAssociationDisposition
    if (!payload.originUserId || payload.originUserId !== sessionUserIdRef.current) {
      scrubAccountBoundState('This result belongs to a different sign-in session. Sign in again, then rerun Tailor.')
      return 'discard' satisfies JobAssociationDisposition
    }
    const requestId = ++associationRequestRef.current
    setPendingAssociation(payload)
    setJobAssociation('saving')
    try {
      const association = await fetch(`/api/jobs/${payload.jobId}/tailored`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceJdHash: payload.sourceJdHash,
          tailoredText: payload.tailoredText,
          originUserId: payload.originUserId,
          sourceResumeId: payload.sourceResumeId,
          matchScore: payload.matchScore,
          addedKeywords: payload.addedKeywords,
          missingKeywords: payload.missingKeywords,
        }),
      })
      if (requestId !== associationRequestRef.current || activeJobIdRef.current !== payload.jobId) {
        return 'stale' satisfies JobAssociationDisposition
      }
      const responseBody = association.ok
        ? null
        : await association.json().catch(() => null) as { code?: unknown; identityVerified?: unknown } | null
      if (requestId !== associationRequestRef.current || activeJobIdRef.current !== payload.jobId) {
        return 'stale' satisfies JobAssociationDisposition
      }
      if (association.status === 409 && responseBody?.code === 'SESSION_CHANGED') {
        scrubAccountBoundState('Your sign-in account changed while Tailor was running. Sign in again, then rerun Tailor for this job.')
        return 'discard' satisfies JobAssociationDisposition
      }
      if (association.status === 401 && responseBody?.code === 'ACCOUNT_UNAVAILABLE') {
        enterAccountUnavailableState()
        return 'discard' satisfies JobAssociationDisposition
      }
      if (association.ok) {
        clearStoredPendingAssociation(payload)
        setPendingAssociation(null)
        setJobAssociation('saved')
      } else if (association.status === 401) {
        setJobAssociation('auth-required')
        return 'unverified' satisfies JobAssociationDisposition
      } else if (association.status === 503 &&
        responseBody?.code === 'ATTACHMENT_TEMPORARY' &&
        responseBody.identityVerified === true) {
        setJobAssociation('transient-error')
      } else if (association.status === 413 &&
        responseBody?.code === 'TAILORED_TEXT_TOO_LARGE' &&
        responseBody.identityVerified === true) {
        clearStoredPendingAssociation(payload)
        setPendingAssociation(null)
        setJobAssociation('oversized')
      } else if (
        (association.status === 400 && responseBody?.code === 'SOURCE_JD_HASH_REQUIRED') ||
        (association.status === 404 && responseBody?.code === 'JOB_NOT_FOUND') ||
        (association.status === 409 && ['JOB_DESCRIPTION_CHANGED', 'JOB_CONTEXT_UNAVAILABLE'].includes(String(responseBody?.code)))
      ) {
        clearStoredPendingAssociation(payload)
        setPendingAssociation(null)
        setJobAssociation('lifecycle-error')
      } else {
        setJobAssociation('verification-error')
        return 'unverified' satisfies JobAssociationDisposition
      }
      return 'display' satisfies JobAssociationDisposition
    } catch {
      if (requestId === associationRequestRef.current && activeJobIdRef.current === payload.jobId) {
        setJobAssociation('verification-error')
        return 'unverified' satisfies JobAssociationDisposition
      }
      return 'stale' satisfies JobAssociationDisposition
    }
  }, [enterAccountUnavailableState, scrubAccountBoundState])

  const revealHeldTailorResult = useCallback((payload: JobAssociationPayload) => {
    if (accountUnavailableRef.current) return false
    const held = heldResultRef.current
    if (!held ||
      held.payload.jobId !== payload.jobId ||
      held.payload.sourceJdHash !== payload.sourceJdHash ||
      held.payload.originUserId !== payload.originUserId ||
      payload.originUserId !== sessionUserIdRef.current ||
      activeJobIdRef.current !== payload.jobId) return false
    heldResultRef.current = null
    setResult(held.result)
    setResultResumeFileName(held.resumeFileName)
    setResultOriginUserId(payload.originUserId ?? null)
    return true
  }, [])

  useEffect(() => {
    if (accountUnavailableRef.current) return
    if (authStatus === 'loading' || jobContextStatus === 'loading') return
    const stored = readStoredPendingAssociation()
    if (!stored) return
    if (authStatus !== 'authenticated' || !sessionUserId) {
      setPendingAssociation(null)
      setResult(null)
      setResultResumeFileName('')
      setResultOriginUserId(null)
      heldResultRef.current = null
      setJobAssociation('idle')
      return
    }
    if (stored.payload.originUserId !== sessionUserId) {
      clearStoredPendingAssociation()
      setPendingAssociation(null)
      setResult(null)
      setResultResumeFileName('')
      setResultOriginUserId(null)
      heldResultRef.current = null
      setJobAssociation('idle')
      return
    }
    if (stored.payload.jobId !== jobId) {
      clearStoredPendingAssociation()
      return
    }
    const recoveryId = `${stored.savedAt}:${stored.payload.jobId}:${stored.payload.sourceJdHash}`
    if (jobContextStatus === 'transient-error') {
      if (pendingRecoveryAttemptRef.current === `${recoveryId}:context`) return
      pendingRecoveryAttemptRef.current = `${recoveryId}:context`
      heldResultRef.current = {
        payload: stored.payload,
        result: stored.result,
        resumeFileName: stored.resumeFileName,
      }
      setResult(null)
      setResultResumeFileName('')
      setResultOriginUserId(null)
      setPendingAssociation(stored.payload)
      setJobAssociation('context-error')
      return
    }
    if (!loadedJobContext || jobTailorAllowed !== true ||
      loadedJobContext.jobId !== stored.payload.jobId ||
      loadedJobContext.sourceJdHash !== stored.payload.sourceJdHash) {
      clearStoredPendingAssociation(stored.payload)
      heldResultRef.current = null
      return
    }
    if (pendingRecoveryAttemptRef.current === recoveryId) return
    pendingRecoveryAttemptRef.current = recoveryId
    setPendingAssociation(stored.payload)
    heldResultRef.current = {
      payload: stored.payload,
      result: stored.result,
      resumeFileName: stored.resumeFileName,
    }
    void (async () => {
      const disposition = await persistJobAssociation(stored.payload)
      if (disposition !== 'display' ||
        stored.payload.originUserId !== sessionUserIdRef.current ||
        activeJobIdRef.current !== stored.payload.jobId) return
      revealHeldTailorResult(stored.payload)
    })()
  }, [authStatus, jobId, jobTailorAllowed, jobContextStatus, loadedJobContext, persistJobAssociation, revealHeldTailorResult, sessionUserId])

  async function handleTailor() {
    if (accountUnavailableRef.current) return
    if (!resumeText || !jobDescription) {
      setError('Both resume and job description are required')
      return
    }
    setError('')
    setTailoring(true)
    setPendingAssociation(null)
    setJobAssociation('idle')
    heldResultRef.current = null
    setResultOriginUserId(null)
    const requestId = ++tailorRequestRef.current
    const resumeSnapshot = {
      text: resumeText,
      sourceResumeId: resumeSource === 'saved' && selectedId && loadedSavedResumeId === selectedId
        ? selectedId
        : undefined,
      fileName: resumeFileName,
    }
    const originUserId = authStatus === 'authenticated' ? sessionUserId ?? undefined : undefined
    const associationContext = loadedJobContext &&
      jobId === loadedJobContext.jobId &&
      jobTailorAllowed === true &&
      jobDescription === loadedJobContext.jobDescription &&
      companyName === loadedJobContext.companyName
      ? loadedJobContext
      : null
    try {
      const res = await fetch('/api/resume/tailor', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(originUserId ? { 'x-origin-user-id': originUserId } : {}),
        },
        body: JSON.stringify({
          resumeText: resumeSnapshot.text,
          jobDescription,
          companyName: companyName || undefined,
          originUserId,
        }),
      })
      const data = await res.json()
      if (requestId !== tailorRequestRef.current || activeJobIdRef.current !== jobId) return
      if (res.status === 409 && data?.code === 'SESSION_CHANGED') {
        scrubAccountBoundState('Your sign-in account changed before tailoring completed. Sign in again, then rerun Tailor.')
        return
      }
      if (res.status === 401 && data?.code === 'ACCOUNT_UNAVAILABLE') {
        enterAccountUnavailableState()
        return
      }
      if (res.ok) {
        if (originUserId && originUserId !== sessionUserIdRef.current) {
          scrubAccountBoundState('Your sign-in account changed while Tailor was running. Sign in again, then rerun Tailor.')
          return
        }
        // Persist only the exact tracked-job input captured when this run
        // started. Edited prefills and query-param transitions remain useful
        // general Tailor runs but never create a false job association.
        const rawTailoredArtifact = data.tailoredResume ?? data.tailoredText
        const tailoredArtifact = boundedArtifact(rawTailoredArtifact, MAX_JOB_TAILORED_TEXT_CHARS)
        const artifactTooLarge = typeof rawTailoredArtifact === 'string' &&
          rawTailoredArtifact.length > MAX_JOB_TAILORED_TEXT_CHARS
        if (associationContext && !data.inputTruncated && !data.outputTruncated && tailoredArtifact) {
          const associationPayload: JobAssociationPayload = {
            jobId: associationContext.jobId,
            sourceJdHash: associationContext.sourceJdHash,
            tailoredText: tailoredArtifact,
            originUserId,
            sourceResumeId: resumeSnapshot.sourceResumeId,
            matchScore: data.matchScore,
            addedKeywords: data.addedKeywords ?? [],
            missingKeywords: data.missingKeywords ?? [],
          }
          if (originUserId) {
            heldResultRef.current = {
              payload: associationPayload,
              result: data,
              resumeFileName: resumeSnapshot.fileName,
            }
            const disposition = await persistJobAssociation(associationPayload)
            if (disposition !== 'display' ||
              requestId !== tailorRequestRef.current ||
              originUserId !== sessionUserIdRef.current ||
              activeJobIdRef.current !== jobId) return
            revealHeldTailorResult(associationPayload)
            return
          } else {
            setPendingAssociation(associationPayload)
            setJobAssociation('auth-required')
          }
        } else if (associationContext && artifactTooLarge) {
          setJobAssociation('oversized')
        } else if (jobId && (data.inputTruncated || data.outputTruncated || (associationContext && !tailoredArtifact))) {
          setJobAssociation('incomplete')
        } else if (jobId) {
          setJobAssociation('detached')
        }
        setResult(data)
        setResultResumeFileName(resumeSnapshot.fileName)
        setResultOriginUserId(originUserId ?? null)
      } else if (res.status === 429 && data.code === 'ANON_DAILY_LIMIT') {
        // Anonymous user hit the daily IP cap — soft-prompt them to sign in
        setError('Daily limit reached. Sign in for unlimited tailoring.')
        requireAuth('tailor_resume')
      } else {
        setError(data.error || 'Tailoring failed')
      }
    } catch {
      if (requestId === tailorRequestRef.current && activeJobIdRef.current === jobId) {
        setError('Network error')
      }
    }
    finally {
      if (requestId === tailorRequestRef.current) setTailoring(false)
    }
  }

  async function handleSaveAsCopy() {
    if (accountUnavailableRef.current) return
    if (!result) return
    if (isAnonymous) { requireAuth('save_resume'); return }
    const saveOriginUserId = resultOriginUserId
    if (!saveOriginUserId) {
      setError('Run Tailor again while signed in before saving this result as a resume.')
      return
    }
    if (saveOriginUserId !== sessionUserIdRef.current) {
      scrubAccountBoundState('This result belongs to a different sign-in session. Sign in again, then rerun Tailor before saving it.')
      return
    }
    const requestId = ++saveCopyRequestRef.current
    const resultSnapshot = result
    setSavingCopy(true)
    setError('')
    try {
      // Save the COMPLETE tailored text as fullText and let the builder
      // structure it on open. Parsing here and spreading a PARTIAL result made
      // saveResume regenerate fullText from that partial structure, silently
      // dropping any section the parser couldn't model (the whole tailored
      // rewrite could vanish). With no structured fields posted, saveResume
      // keeps the tailored text verbatim; opening the copy runs the builder's
      // partial-tolerant parse-on-open, which warns before it can lose anything.
      const res = await fetch('/api/resume/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Strip-before-append: re-tailoring a tailored resume was stacking
          // "(Tailored) (Tailored)" onto the name (founder catch 2026-07-16).
          name: tailoredResumeName(resultResumeFileName || resumeFileName, companyName),
          targetRole: '',
          targetCompany: companyName || '',
          fullText: resultSnapshot.tailoredResume,
          originUserId: saveOriginUserId,
          // matchScore is JD-match, NOT ATS compatibility — storing it as
          // atsScore made the dashboard "ATS: N" badge lie. The badge now
          // only shows scores from a real ATS check.
        }),
      })
      const data = await res.json()
      if (requestId !== saveCopyRequestRef.current || saveOriginUserId !== sessionUserIdRef.current) return
      if (res.status === 409 && data?.code === 'SESSION_CHANGED') {
        scrubAccountBoundState('Your sign-in account changed before this resume could be saved. Sign in again, then rerun Tailor.')
        return
      }
      if (res.status === 401 && data?.code === 'ACCOUNT_UNAVAILABLE') {
        enterAccountUnavailableState()
        return
      }
      if (res.ok) {
        router.push(`/resume/builder?id=${data.id}`)
      } else if (data.code === 'RESUME_LIMIT') {
        setError('Resume limit reached (max 3). Delete an existing resume from the Resume Builder page, then try saving again.')
      } else {
        setError(data.error || 'Failed to save')
      }
    } catch {
      if (requestId === saveCopyRequestRef.current && saveOriginUserId === sessionUserIdRef.current) {
        setError('Save failed')
      }
    } finally {
      if (requestId === saveCopyRequestRef.current) setSavingCopy(false)
    }
  }

  async function retryHeldAttachment() {
    if (accountUnavailableRef.current) return
    const held = heldResultRef.current
    if (!held || !pendingAssociation ||
      held.payload.jobId !== pendingAssociation.jobId ||
      held.payload.sourceJdHash !== pendingAssociation.sourceJdHash) return
    const disposition = await persistJobAssociation(pendingAssociation)
    if (disposition === 'display') revealHeldTailorResult(pendingAssociation)
  }

  function handleSignInToAttach() {
    if (accountUnavailableRef.current) return
    if (!pendingAssociation) return
    const held = heldResultRef.current
    const pendingResult = result ?? held?.result
    const pendingFileName = result ? resultResumeFileName : held?.resumeFileName ?? ''
    if (!pendingResult) return
    const stored = storePendingAssociation(pendingAssociation, pendingResult, pendingFileName)
    if (!stored) {
      setError('We couldn’t safely preserve this result for sign-in. Sign in separately, then return and rerun Tailor.')
      return
    }
    // A 401 is authoritative even if useSession still has a cached
    // authenticated snapshot. Route through the dedicated OAuth screen; its
    // provider buttons explicitly sign out before starting sign-in.
    if (authStatus === 'authenticated') {
      const callbackUrl = `/resume/tailor?jobId=${encodeURIComponent(pendingAssociation.jobId)}`
      router.push(`/signin?callbackUrl=${encodeURIComponent(callbackUrl)}`)
    } else {
      requireAuth('save_resume')
    }
  }

  const trackedPrefillUnchanged = !!loadedJobContext &&
    loadedJobContext.jobId === jobId &&
    loadedJobContext.jobDescription === jobDescription &&
    loadedJobContext.companyName === companyName

  if (accountUnavailable) {
    return (
      <div className="max-w-4xl mx-auto space-y-6">
        <h1 className="text-2xl font-bold text-slate-900">Tailor Resume for Job</h1>
        <div
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          {ACCOUNT_UNAVAILABLE_MESSAGE}
        </div>
      </div>
    )
  }

  if (resolvedIdentityChanged) {
    return (
      <div className="max-w-4xl mx-auto">
        <div role="status" className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
          Verifying the active account…
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-slate-900">Tailor Resume for Job</h1>
      <p className="text-sm text-slate-500">
        Upload your resume and paste a job description. AI will tailor your resume to highlight the most relevant experience.
      </p>
      {jobId && jobTailorAllowed !== null && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
          {jobContextStatus === 'transient-error' ? (
            <span>
              We couldn&apos;t verify the saved job context right now.{' '}
              <button
                type="button"
                onClick={() => setJobContextRetry((attempt) => attempt + 1)}
                className="font-medium text-blue-600 hover:underline"
              >
                Retry job details
              </button>
              .
            </span>
          ) : jobTailorAllowed && trackedPrefillUnchanged ? (
            <span>
              Using {jobPostingState === 'archived' ? 'the retained archived description' : 'the job description'}
              {companyName ? ` for ${companyName}` : ''}
              {jobPostingState === 'archived' ? ' · posting no longer active' : ''}.
            </span>
          ) : jobTailorAllowed ? (
            <span>
              You edited the saved job context. This run will stay general and won&apos;t be attached to the tracked job.
            </span>
          ) : (
            <span>
              The saved description is unavailable or can no longer be verified. You can continue as a general tailoring run, but it won&apos;t be attached to this tracked job.
            </span>
          )}{' '}
          <Link href={`/jobs/${jobId}`} className="font-medium text-blue-600 hover:underline">Back to saved details</Link>
        </div>
      )}

      {!result ? (
        <div className="space-y-6">
          {pendingAssociation && ['saving', 'context-error', 'verification-error', 'auth-required'].includes(jobAssociation) && (
            <div
              role="status"
              aria-atomic="true"
              className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800"
            >
              <p>
                {jobAssociation === 'saving'
                  ? 'Verifying the active account before showing the Tailor result…'
                  : jobAssociation === 'context-error'
                    ? 'We couldn’t reverify the saved job context yet. The saved Tailor result remains hidden.'
                    : jobAssociation === 'auth-required'
                      ? 'Your session expired. The Tailor result remains hidden until you sign in and its originating account is verified.'
                      : 'We couldn’t verify the active account, so the Tailor result remains hidden.'}
              </p>
              {jobAssociation === 'context-error' && (
                <button
                  type="button"
                  onClick={() => setJobContextRetry((attempt) => attempt + 1)}
                  className="mt-2 font-medium text-blue-700 hover:underline"
                >
                  Retry job verification
                </button>
              )}
              {jobAssociation === 'verification-error' && (
                <button
                  type="button"
                  onClick={retryHeldAttachment}
                  className="mt-2 font-medium text-blue-700 hover:underline"
                >
                  Retry attachment
                </button>
              )}
              {jobAssociation === 'auth-required' && (
                <button
                  type="button"
                  onClick={handleSignInToAttach}
                  className="mt-2 font-medium text-blue-700 hover:underline"
                >
                  Sign in to attach
                </button>
              )}
            </div>
          )}
          <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3">
            <h2 className="text-sm font-semibold text-slate-500">Your Resume</h2>

            {savedResumes.length > 0 && (
              <div>
                <label className="text-[10px] text-slate-500 uppercase tracking-wider">From Saved Resumes</label>
                <select
                  value={selectedId}
                  onChange={e => {
                    const nextId = e.target.value
                    setSelectedId(nextId)
                    selectedResumeIdRef.current = nextId
                    if (nextId) {
                      void handleSelectSaved(nextId)
                    } else {
                      savedResumeRequestRef.current += 1
                      savedResumeAbortRef.current?.abort()
                      savedResumeAbortRef.current = null
                      setLoadedSavedResumeId('')
                      if (resumeSource === 'saved') {
                        setResumeText('')
                        setResumeFileName('')
                      }
                    }
                  }}
                  className="w-full mt-1 px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                >
                  <option value="">Choose a saved resume...</option>
                  {savedResumes.map(r => (
                    <option key={r.id} value={r.id}>{r.name}{r.targetRole ? ` — ${r.targetRole}` : ''}</option>
                  ))}
                </select>
              </div>
            )}

            {savedResumes.length > 0 && <div className="text-center text-[10px] text-slate-400">or</div>}

            {/* Chip only for a LOADED source (upload/saved). The anonymous paste
                box stays an editable textarea — it used to flip to a chip after
                the first character, trapping 1 char and locking out editing. */}
            {resumeText && resumeSource !== 'paste' ? (
              <div className="flex items-center justify-between bg-emerald-500/5 border border-emerald-500/15 rounded-xl px-4 py-3">
                <div className="flex items-center gap-2">
                  <Check className="w-4 h-4 text-[#059669]" strokeWidth={2} />
                  <span className="text-sm text-[#059669]">{resumeFileName || 'Resume loaded'}</span>
                  <span className="text-[10px] text-slate-500">({resumeSource === 'saved' ? 'saved' : 'uploaded'})</span>
                </div>
                <button onClick={() => {
                  savedResumeRequestRef.current += 1
                  savedResumeAbortRef.current?.abort()
                  savedResumeAbortRef.current = null
                  selectedResumeIdRef.current = ''
                  setResumeText('')
                  setResumeFileName('')
                  setSelectedId('')
                  setLoadedSavedResumeId('')
                }} className="text-xs text-slate-500 hover:text-slate-500">
                  Remove
                </button>
              </div>
            ) : (
              <>
                {!isAnonymous && (
                  <FileDropzone label="Upload Resume" isUploading={uploading} onFileSelect={handleUpload} onRemove={() => {}} onError={setError} />
                )}
                {isAnonymous && (
                  <div className="space-y-2">
                    <label className="text-[10px] text-slate-500 uppercase tracking-wider">Paste your resume text</label>
                    <textarea
                      aria-label="Resume text"
                      value={resumeSource === 'paste' ? resumeText : ''}
                      onChange={e => {
                        savedResumeRequestRef.current += 1
                        savedResumeAbortRef.current?.abort()
                        savedResumeAbortRef.current = null
                        selectedResumeIdRef.current = ''
                        setSelectedId('')
                        setLoadedSavedResumeId('')
                        setResumeText(e.target.value)
                        setResumeSource('paste')
                        setResumeFileName(e.target.value ? 'Pasted resume' : '')
                      }}
                      placeholder="Paste your resume here. To upload a PDF or DOCX, sign in."
                      rows={8}
                      className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-y"
                    />
                    <p className="text-[10px] text-slate-400">
                      <button type="button" onClick={() => requireAuth('parse_resume')} className="text-blue-600 hover:underline">Sign in</button>
                      {' '}to upload a PDF or DOCX instead.
                    </p>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3">
            <h2 className="text-sm font-semibold text-slate-500">Job Description</h2>
            <input
              aria-label="Company name"
              type="text"
              value={companyName}
              onChange={e => setCompanyName(e.target.value)}
              placeholder="Company name (optional)"
              className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
            <textarea
              aria-label="Job description"
              value={jobDescription}
              onChange={e => setJobDescription(e.target.value)}
              placeholder="Paste the job description here..."
              rows={8}
              className="w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-y"
            />
          </div>

          {error && <p role="alert" className="text-xs text-red-400">{error}</p>}

          <button
            onClick={handleTailor}
            disabled={tailoring || !resumeText || !jobDescription}
            className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-medium transition-colors disabled:opacity-50"
          >
            {tailoring ? (
              <span className="flex items-center justify-center gap-2">
                <span
                  aria-hidden="true"
                  className="w-4 h-4 rounded-full border-2 border-white/40 border-t-white animate-spin"
                />
                Tailoring resume… this can take ~15s
              </span>
            ) : (
              'Tailor My Resume'
            )}
          </button>
        </div>
      ) : (
        <div className="space-y-6 animate-fade-in">
          {jobId && jobAssociation !== 'idle' && (
            <div
              role="status"
              aria-atomic="true"
              className={`rounded-xl border px-4 py-3 text-xs ${jobAssociation === 'saved' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-amber-200 bg-amber-50 text-amber-800'}`}
            >
              <p>
                {jobAssociation === 'saving'
                  ? 'Attaching this version to the tracked job…'
                  : jobAssociation === 'saved'
                    ? 'Attached to this tracked job.'
                    : jobAssociation === 'auth-required'
                      ? 'Your tailored resume is ready, but your session expired before it could be attached.'
                      : jobAssociation === 'context-error'
                        ? 'Your tailored resume is ready, but we couldn’t reverify the saved job context yet.'
                      : jobAssociation === 'lifecycle-error'
                        ? 'Your tailored resume is ready, but it wasn’t attached because the saved job description or posting lifecycle changed.'
                        : jobAssociation === 'transient-error'
                          ? 'Your tailored resume is ready, but a temporary service error prevented attachment.'
                          : jobAssociation === 'incomplete'
                            ? 'Your tailored resume is ready, but an incomplete result cannot be attached to the tracked job.'
                            : jobAssociation === 'oversized'
                              ? 'Your tailored resume is ready, but it exceeds the tracked-job attachment limit. You can copy or save it, or shorten it and rerun Tailor.'
                            : 'This is a general tailoring result and is not attached to the tracked job.'}
              </p>
              {jobAssociation === 'transient-error' && pendingAssociation && (
                <button
                  type="button"
                  onClick={() => persistJobAssociation(pendingAssociation)}
                  className="mt-2 font-medium text-blue-700 hover:underline"
                >
                  Retry attachment
                </button>
              )}
              {jobAssociation === 'context-error' && pendingAssociation && (
                <button
                  type="button"
                  onClick={() => setJobContextRetry((attempt) => attempt + 1)}
                  className="mt-2 font-medium text-blue-700 hover:underline"
                >
                  Retry job verification
                </button>
              )}
              {jobAssociation === 'auth-required' && (
                <button
                  type="button"
                  onClick={handleSignInToAttach}
                  className="mt-2 font-medium text-blue-700 hover:underline"
                >
                  Sign in to attach
                </button>
              )}
            </div>
          )}
          {error && (
            <div role="alert" className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" strokeWidth={2} />
              <p className="text-xs text-red-400">{error}</p>
            </div>
          )}
          {(result.inputTruncated || result.outputTruncated) && (
            <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" strokeWidth={2} />
              <p className="text-xs text-amber-600">
                {result.outputTruncated
                  ? 'The tailored rewrite was cut off before completing — saving it would lose the tail of your resume. Try again, or shorten the resume/job description.'
                  : 'Your resume was longer than the analysis window — only the first part was tailored. The untouched tail is NOT included in the result below.'}
              </p>
            </div>
          )}
          <div className="bg-white border border-slate-200 rounded-2xl p-6 text-center">
            <p className="text-sm text-slate-500 mb-2">Job Match Score</p>
            <p className={`text-4xl font-bold ${result.matchScore >= 80 ? 'text-[#059669]' : result.matchScore >= 60 ? 'text-amber-400' : 'text-red-400'}`}>
              {result.matchScore}%
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            {result.addedKeywords.length > 0 && (
              <div className="bg-white border border-slate-200 rounded-2xl p-5">
                <h3 className="text-xs font-semibold text-[#059669] uppercase tracking-wider mb-2">Keywords Added</h3>
                <div className="flex flex-wrap gap-1.5">
                  {result.addedKeywords.map((k, i) => (
                    <span key={i} className="px-2 py-0.5 bg-emerald-500/10 border border-emerald-500/20 rounded text-[10px] text-[#059669]">{k}</span>
                  ))}
                </div>
              </div>
            )}
            {result.missingKeywords.length > 0 && (
              <div className="bg-white border border-slate-200 rounded-2xl p-5">
                <h3 className="text-xs font-semibold text-amber-400 uppercase tracking-wider mb-2">Still Missing</h3>
                <div className="flex flex-wrap gap-1.5">
                  {result.missingKeywords.map((k, i) => (
                    <span key={i} className="px-2 py-0.5 bg-amber-500/10 border border-amber-500/20 rounded text-[10px] text-amber-400">{k}</span>
                  ))}
                </div>
              </div>
            )}
          </div>

          {result.changes.length > 0 && (
            <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3">
              <h3 className="text-sm font-semibold text-slate-500">Changes Made</h3>
              {result.changes.map((c, i) => (
                <div key={i} className="border-l-2 border-emerald-500/30 pl-3 py-1">
                  <p className="text-xs font-medium text-slate-500">{c.section}</p>
                  <p className="text-[11px] text-slate-500 mt-0.5">{c.change}</p>
                  <p className="text-[10px] text-slate-500 mt-0.5">{c.reason}</p>
                </div>
              ))}
            </div>
          )}

          <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-500">Tailored Resume</h3>
              <div className="flex gap-2">
                <button
                  onClick={() => navigator.clipboard.writeText(result.tailoredResume)}
                  className="px-3 py-1.5 bg-emerald-600/10 border border-emerald-500/20 text-[#059669] text-[10px] rounded-lg font-medium hover:bg-emerald-600/20 transition-colors"
                >
                  Copy
                </button>
                {/* inputTruncated blocks too: for a 15k–50k-char resume the
                    model only saw the first slice, so tailoredResume OMITS the
                    unprocessed tail — saving it would silently drop that tail
                    (Codex P2). Copy stays enabled for manual splicing. */}
                <button
                  onClick={handleSaveAsCopy}
                  disabled={savingCopy || result.outputTruncated || result.inputTruncated}
                  title={result.outputTruncated
                    ? 'The rewrite was cut off — saving would persist an incomplete resume.'
                    : result.inputTruncated
                      ? 'Only the first part of your resume was tailored — saving would drop the rest. Use Copy and merge manually, or shorten the resume.'
                      : undefined}
                  className="px-3 py-1.5 bg-blue-600/10 border border-blue-500/20 text-blue-600 text-[10px] rounded-lg font-medium hover:bg-blue-600/20 transition-colors disabled:opacity-50"
                >
                  {savingCopy ? 'Parsing & Saving...' : 'Save as New Resume'}
                </button>
              </div>
            </div>
            <pre className="whitespace-pre-wrap text-xs text-slate-500 bg-slate-50 rounded-xl p-4 max-h-96 overflow-y-auto">
              {result.tailoredResume}
            </pre>
          </div>

          <button onClick={() => {
            associationRequestRef.current += 1
            saveCopyRequestRef.current += 1
            clearStoredPendingAssociation(pendingAssociation ?? undefined)
            heldResultRef.current = null
            setPendingAssociation(null)
            setJobAssociation('idle')
            setResult(null)
            setResultResumeFileName('')
            setResultOriginUserId(null)
            setSavingCopy(false)
          }} className="text-sm text-blue-600 hover:text-blue-500 transition-colors">
            Start Over
          </button>
        </div>
      )}
    </div>
  )
}
