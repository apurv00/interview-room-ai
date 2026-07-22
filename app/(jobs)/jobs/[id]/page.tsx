'use client'

import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { clearAllInterviewStorage, STORAGE_KEYS } from '@shared/storageKeys'
import { INTERVIEW_TARGET_COMPANY_MAX_CHARS } from '@shared/interviewContract'
import { buildPrepPlan } from '@jobs/config/prepPlan'
import {
  interviewDateLabel,
  practiceProgressLabel,
} from '@jobs/config/truthfulLabels'
import InterviewDateControls, { type InterviewDateRequest } from '@jobs/components/InterviewDateControls'
import AuthGateModal from '@shared/ui/AuthGateModal'
import { retakeParentFromSearch } from '@interview/utils/retakeNavigation'

/**
 * /jobs/[id] — public SHELL, authed BODY (founder ruling P-2, 2026-07-14).
 * The API enforces the split server-side; this page renders whatever
 * projection it was given. Anon = title/company/tier + a blurred stand-in
 * over the sign-in gate. Authed = JD, tier-honest apply ladder (native
 * same-origin POST to a new tab), Save, and a low-key "view full posting" GET
 * link so Apply clicks aren't polluted by read intent.
 */

interface ApplyOption { optionId: string; url: string; tier: string; viaSite?: string }
interface ApplyReturnArm extends ApplyOption { clickedAt: number }
type ExperienceLevel = '0-2' | '3-6' | '7+'
type DetailStatus =
  | 'loading'
  | 'ready'
  | 'missing'
  | 'gone'
  | 'server-error'
  | 'offline'
  | 'account-unavailable'
type BrokenLinkDisposition = 'pending-verification' | 'crowd-demoted' | 'machine-demoted'
interface XrayReq { id: string; category: string; requirement: string; importance: 'must-have' | 'nice-to-have' }
interface Xray { role: string; inferredDomain?: string; keyThemes: string[]; requirements: XrayReq[]; retryable?: boolean }
interface Detail {
  id: string
  title: string
  company: string
  locations: string[]
  isRemote: boolean
  domain?: string
  postedAt?: string
  salaryText?: string
  applyTier?: string
  gated: boolean
  postingState?: 'live' | 'archived' | 'restricted' | 'snapshot-only'
  capabilities?: {
    apply: boolean
    viewSource: boolean
    xray: boolean
    tailor: boolean
    practice: boolean
    atsCheck: boolean
  }
  practiceRole?: string
  practiceHandoffToken?: string
  practiceExperience?: ExperienceLevel
  practiceBlocker?: 'experience-required'
  jd?: string
  applyOptions?: ApplyOption[]
  /** Coarse server projection; governance counts/timestamps stay private. */
  allApplyOptionsDemoted?: boolean
  flags?: { staffing: boolean; shortJd: boolean; repost: boolean }
  application?: {
    applicationId: string
    status: string
    practiceCount: number
    interviewDate?: string
    interviewDateConfidence?: 'exact' | 'week' | 'unknown'
    interviewDatePreference?: 'this-week' | 'next-week' | 'unknown'
    tailoredResume?: { createdAt: string; current: boolean }
    appliedWith?: { wasTailored: boolean }
    ats: { state: 'none' | 'pending' | 'done'; score?: number; missingKeywords?: string[] }
  } | null
}

const APPLY_OPTION_ID_RE = /^ao2_[A-Za-z0-9_-]{43}$/
const EXPERIENCE_LEVELS = new Set<ExperienceLevel>(['0-2', '3-6', '7+'])
const POSTING_STATES = new Set<NonNullable<Detail['postingState']>>([
  'live',
  'archived',
  'restricted',
  'snapshot-only',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function isDetailProjection(value: unknown, expectedId: string): value is Detail {
  if (!isRecord(value)) return false
  if (
    value.id !== expectedId ||
    typeof value.title !== 'string' ||
    typeof value.company !== 'string' ||
    !Array.isArray(value.locations) ||
    !value.locations.every((location) => typeof location === 'string') ||
    typeof value.isRemote !== 'boolean' ||
    typeof value.gated !== 'boolean' ||
    !isOptionalString(value.domain) ||
    !isOptionalString(value.postedAt) ||
    !isOptionalString(value.salaryText) ||
    !isOptionalString(value.applyTier) ||
    !isOptionalString(value.jd) ||
    (value.postingState !== undefined && !POSTING_STATES.has(value.postingState as NonNullable<Detail['postingState']>)) ||
    (value.allApplyOptionsDemoted !== undefined && typeof value.allApplyOptionsDemoted !== 'boolean') ||
    (value.practiceRole !== undefined && (typeof value.practiceRole !== 'string' || !value.practiceRole)) ||
    (value.practiceHandoffToken !== undefined && (typeof value.practiceHandoffToken !== 'string' || !value.practiceHandoffToken)) ||
    (value.practiceExperience !== undefined && !EXPERIENCE_LEVELS.has(value.practiceExperience as ExperienceLevel)) ||
    (value.practiceBlocker !== undefined && value.practiceBlocker !== 'experience-required')
  ) return false

  // The authenticated body drives mutation authority. Missing fields must
  // never be interpreted as "not tracked" or "no apply options" because a
  // partial/wrong cache response could then expose actions for another state.
  if (!value.gated && (
    value.postingState === undefined ||
    value.capabilities === undefined ||
    value.applyOptions === undefined ||
    value.application === undefined ||
    value.allApplyOptionsDemoted === undefined ||
    value.flags === undefined
  )) return false

  if (value.capabilities !== undefined) {
    const capabilities = value.capabilities
    if (!isRecord(capabilities)) return false
    const capabilityKeys: Array<keyof NonNullable<Detail['capabilities']>> = [
      'apply',
      'viewSource',
      'xray',
      'tailor',
      'practice',
      'atsCheck',
    ]
    if (!capabilityKeys.every((key) => typeof capabilities[key] === 'boolean')) return false
  }

  if (value.applyOptions !== undefined) {
    if (!Array.isArray(value.applyOptions)) return false
    for (const option of value.applyOptions) {
      if (
        !isRecord(option) ||
        typeof option.optionId !== 'string' ||
        !APPLY_OPTION_ID_RE.test(option.optionId) ||
        typeof option.url !== 'string' ||
        !option.url ||
        typeof option.tier !== 'string' ||
        !option.tier ||
        (option.viaSite !== undefined && typeof option.viaSite !== 'string')
      ) return false
    }
  }

  if (value.flags !== undefined) {
    if (
      !isRecord(value.flags) ||
      typeof value.flags.staffing !== 'boolean' ||
      typeof value.flags.shortJd !== 'boolean' ||
      typeof value.flags.repost !== 'boolean'
    ) return false
  }

  if (value.application !== undefined && value.application !== null) {
    const application = value.application
    if (
      !isRecord(application) ||
      typeof application.applicationId !== 'string' ||
      !application.applicationId ||
      typeof application.status !== 'string' ||
      !application.status ||
      typeof application.practiceCount !== 'number' ||
      !Number.isInteger(application.practiceCount) ||
      application.practiceCount < 0 ||
      !isOptionalString(application.interviewDate) ||
      (
        application.interviewDateConfidence !== undefined &&
        !['exact', 'week', 'unknown'].includes(String(application.interviewDateConfidence))
      ) ||
      (
        application.interviewDatePreference !== undefined &&
        !['this-week', 'next-week', 'unknown'].includes(String(application.interviewDatePreference))
      )
    ) return false

    if (application.tailoredResume !== undefined) {
      if (
        !isRecord(application.tailoredResume) ||
        typeof application.tailoredResume.createdAt !== 'string' ||
        typeof application.tailoredResume.current !== 'boolean'
      ) return false
    }
    if (application.appliedWith !== undefined) {
      if (!isRecord(application.appliedWith) || typeof application.appliedWith.wasTailored !== 'boolean') return false
    }
    if (!isRecord(application.ats)) return false
    if (
      !['none', 'pending', 'done'].includes(String(application.ats.state)) ||
      (application.ats.score !== undefined && (
        typeof application.ats.score !== 'number' ||
        !Number.isFinite(application.ats.score)
      )) ||
      (application.ats.missingKeywords !== undefined && (
        !Array.isArray(application.ats.missingKeywords) ||
        !application.ats.missingKeywords.every((keyword) => typeof keyword === 'string')
      ))
    ) return false
  }

  return true
}

function detailFailureStatus(status: number): Extract<DetailStatus, 'missing' | 'gone' | 'server-error'> {
  if (status === 404) return 'missing'
  if (status === 410) return 'gone'
  return 'server-error'
}

const TIER_SUBTITLE: Record<string, (co: string, via?: string) => string> = {
  'direct-ats': (co) => `Opens ${co}'s application form`,
  employer: (co) => `Opens ${co}'s careers site`,
  'aggregator-deep': (_co, via) => `Opens on ${via ?? 'a job board'} — you may need a free account`,
  'platform-funnel': (_co, via) => `Opens on ${via ?? 'the source platform'}`,
  'aggregator-redirect': (_co, via) => `Via ${via ?? 'the source'} — this link redirects`,
}

// A lost X-ray response can precede the server's eventual parse/CAS. Poll
// across ~31 seconds of scheduled backoff so that result can still unlock
// Practice; successful X-ray responses keep the normal bounded read retries.
const LOST_XRAY_READINESS_DELAYS_MS = [0, 250, 750, 2_000, 4_000, 8_000, 8_000, 8_000] as const
const NORMAL_READINESS_DELAYS_MS = [0, 250, 500] as const
const APPLIED_HISTORY_STATUSES = new Set([
  'applied',
  'interview_scheduled',
  'offer',
  'rejected',
  'ghosted',
  'withdrawn',
])
const ACTIVE_TAB_REVALIDATION_MS = 4 * 60_000

function applyRedirectHref(
  jobId: string,
  optionId: string,
  intent: 'apply' | 'view',
): string {
  return `/api/jobs/${encodeURIComponent(jobId)}/open?optionId=${encodeURIComponent(optionId)}&intent=${intent}`
}

async function isAccountUnavailableResponse(response: Response): Promise<boolean> {
  if (response.status !== 401) return false
  const body = await response.json().catch(() => null) as { code?: unknown } | null
  return body?.code === 'ACCOUNT_UNAVAILABLE'
}

function parseApplyReturnArm(raw: string | null): ApplyReturnArm | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    if (
      !value || typeof value !== 'object' ||
      typeof value.clickedAt !== 'number' || !Number.isFinite(value.clickedAt) || value.clickedAt <= 0 ||
      typeof value.optionId !== 'string' || !APPLY_OPTION_ID_RE.test(value.optionId) ||
      typeof value.url !== 'string' || !value.url ||
      typeof value.tier !== 'string' || !value.tier
    ) return null
    return {
      clickedAt: value.clickedAt,
      optionId: value.optionId,
      url: value.url,
      tier: value.tier,
      viaSite: typeof value.viaSite === 'string' ? value.viaSite : undefined,
    }
  } catch {
    return null
  }
}

export default function JobDetailPage({ params }: { params: { id: string } }) {
  const router = useRouter()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [status, setStatus] = useState<DetailStatus>('loading')
  const [detailAttempt, setDetailAttempt] = useState(0)
  const [gate, setGate] = useState<null | 'view_job_detail' | 'save_job'>(null)
  const [saveBusy, setSaveBusy] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [applyError, setApplyError] = useState<string | null>(null)
  const [xray, setXray] = useState<Xray | null>(null)
  const [xrayState, setXrayState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const [xrayAttempt, setXrayAttempt] = useState(0)
  const [atsBusy, setAtsBusy] = useState(false)
  const [atsHint, setAtsHint] = useState<string | null>(null)
  const [sheet, setSheet] = useState<null | { kind: 'normal' | 'quick'; clicked: ApplyOption; elapsedMs: number }>(null)
  const [inference, setInference] = useState<'idle' | 'asking'>('idle')
  const [practiceEmail, setPracticeEmail] = useState<'idle' | 'requested' | 'email-off' | 'unavailable'>('idle')
  const [practiceStart, setPracticeStart] = useState<'idle' | 'loading' | 'error'>('idle')
  const [sheetDone, setSheetDone] = useState<string | null>(null)
  const [retakeParentId, setRetakeParentId] = useState<string | null>(null)
  const xrayFetchedFor = useRef<string | null>(null)
  const pendingPollFor = useRef<string | null>(null)
  const practiceStartInFlight = useRef(false)
  const saveInFlight = useRef(false)
  const practiceReadyRef = useRef(false)
  const jobViewedFor = useRef<string | null>(null)
  const accountUnavailableRef = useRef(false)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const unavailableRef = useRef<HTMLElement>(null)
  const sheetDialogRef = useRef<HTMLDivElement>(null)
  const sheetInvokerRef = useRef<HTMLElement | null>(null)

  const scrubAccountBoundState = useCallback(() => {
    accountUnavailableRef.current = true
    xrayFetchedFor.current = null
    pendingPollFor.current = null
    practiceStartInFlight.current = false
    saveInFlight.current = false
    sheetInvokerRef.current = null
    // A Jobs Practice handoff stores the canonical JD, signed handoff token,
    // attribution, and retake pointer in interview storage. Account deletion
    // is terminal for the whole account, so leaving any scoped/unscoped copy
    // behind could let the lobby reuse private data after this page scrubs.
    clearAllInterviewStorage()
    try { localStorage.removeItem(`JOBS_RETURN_${params.id}`) } catch { /* unavailable */ }
    setDetail(null)
    setStatus('account-unavailable')
    setGate(null)
    setSaveBusy(false)
    setSaveError(null)
    setApplyError(null)
    setXray(null)
    setXrayState('idle')
    setAtsBusy(false)
    setAtsHint(null)
    setSheet(null)
    setInference('idle')
    setPracticeEmail('idle')
    setPracticeStart('idle')
    setSheetDone(null)
  }, [params.id])

  useEffect(() => {
    try {
      setRetakeParentId(retakeParentFromSearch(window.location.search) ?? null)
    } catch {
      setRetakeParentId(null)
    }
  }, [params.id])

  useEffect(() => {
    if (accountUnavailableRef.current) return
    let cancelled = false
    setDetail(null)
    setStatus('loading')
    setSaveError(null)
    void (async () => {
      let response: Response
      try {
        response = await fetch(`/api/jobs/${params.id}`, { cache: 'no-store' })
      } catch {
        if (!cancelled && !accountUnavailableRef.current) setStatus('offline')
        return
      }
      if (cancelled) return
      if (!response.ok) {
        if (await isAccountUnavailableResponse(response)) {
          if (!cancelled) scrubAccountBoundState()
          return
        }
        if (cancelled || accountUnavailableRef.current) return
        setStatus(detailFailureStatus(response.status))
        return
      }
      let nextDetail: unknown
      try {
        nextDetail = await response.json()
      } catch {
        if (!cancelled && !accountUnavailableRef.current) setStatus('server-error')
        return
      }
      if (cancelled || accountUnavailableRef.current) return
      if (!isDetailProjection(nextDetail, params.id)) {
        setStatus('server-error')
        return
      }
      setDetail(nextDetail)
      setStatus('ready')
    })()
    return () => { cancelled = true }
  }, [detailAttempt, params.id, scrubAccountBoundState])

  useEffect(() => {
    if (jobViewedFor.current === params.id) return
    jobViewedFor.current = params.id
    fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'jobs.job_viewed', jobPostingId: params.id, props: {} }),
      keepalive: true,
    }).catch(() => {})
  }, [params.id])

  // X-ray loads progressively AFTER the body — the first view on a posting
  // pays a lazy LLM parse (seconds); cached thereafter. Authed only (P-2).
  // Fetch ONCE per posting: ATS polling replaces `detail` every tick, and an
  // effect keyed on the whole object re-fired the parse while the first one
  // was still uncached — concurrent LLM calls for one JD (Codex on #521).
  practiceReadyRef.current = !!(
    detail &&
    !detail.gated &&
    typeof detail.jd === 'string' &&
    detail.jd.trim().length > 0 &&
    detail.practiceRole &&
    detail.practiceHandoffToken &&
    detail.practiceExperience
  )

  const restoreReturnSheetFocus = useCallback(() => {
    const invoker = sheetInvokerRef.current
    if (!invoker) {
      const fallback = titleRef.current ?? unavailableRef.current
      fallback?.focus()
      return
    }
    if (invoker.isConnected) invoker.focus()
    else (titleRef.current ?? unavailableRef.current)?.focus()
    // Invalidation sets the replacement projection in the same React batch.
    // Re-check after commit: the invoker may have been connected above but
    // removed moments later when Apply disappears.
    window.setTimeout(() => {
      if (!invoker.isConnected) (titleRef.current ?? unavailableRef.current)?.focus()
    }, 0)
  }, [])

  const closeReturnSheet = useCallback(() => {
    setSheet(null)
    restoreReturnSheetFocus()
  }, [restoreReturnSheetFocus])

  // A check queued in another tab / before a refresh arrives as state
  // 'pending' with no local poll loop — poll until it settles or times out
  // (Codex on #521), once per posting.
  useEffect(() => {
    if (detail?.gated !== false || detail.application?.ats.state !== 'pending') return
    if (detail.capabilities?.atsCheck === false) return
    if (pendingPollFor.current === params.id) return
    pendingPollFor.current = params.id
    let cancelled = false
    ;(async () => {
      for (let i = 0; i < 5 && !cancelled; i++) {
        await new Promise((r) => setTimeout(r, 12_000))
        if (cancelled) return
        if (!(await refetchDetail())) return
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, params.id])
  const loadedDetailId = detail?.id
  const detailIsGated = detail?.gated
  const detailCanXray = detail?.gated === false && (detail.capabilities?.xray ?? true)
  const detailPostingState = detail?.gated === false
    ? (detail.postingState ?? 'live')
    : 'live'
  useEffect(() => {
    // A posting can be restricted while this tab is open. Remove any
    // previously fetched JD-derived evidence and let a later reopen fetch a
    // fresh server-authorized projection instead of rendering stale X-ray UI.
    if (detailIsGated === false && !detailCanXray) {
      xrayFetchedFor.current = null
      setXray(null)
      setXrayState('idle')
    }
  }, [detailCanXray, detailIsGated])
  useEffect(() => {
    if (loadedDetailId !== params.id || detailIsGated !== false || !detailCanXray) return
    if (xrayFetchedFor.current === params.id) return
    xrayFetchedFor.current = params.id
    setXrayState('loading')
    let cancelled = false
    const needsPracticeReconciliation = !practiceReadyRef.current

    async function reconcilePracticeReadiness(pollUntilReady: boolean) {
      // The X-ray request can finish server-side even when its response is
      // lost before its parse/CAS settles. Only that uncertain transport path
      // polls successful-but-not-ready projections; an ordinary successful
      // X-ray gets one authoritative read so unsupported roles do not churn.
      const delays = pollUntilReady
        ? LOST_XRAY_READINESS_DELAYS_MS
        : NORMAL_READINESS_DELAYS_MS
      for (const delay of delays) {
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
        if (cancelled) return
        try {
          const response = await fetch(`/api/jobs/${params.id}`, { cache: 'no-store' })
          if (!response.ok) {
            if (await isAccountUnavailableResponse(response)) {
              if (!cancelled) scrubAccountBoundState()
              return
            }
            continue
          }
          const reconciled: unknown = await response.json()
          if (!isDetailProjection(reconciled, params.id)) continue
          if (!cancelled && !accountUnavailableRef.current) setDetail(reconciled)
          const isReady = !!(
            typeof reconciled.jd === 'string' &&
            reconciled.jd.trim().length > 0 &&
            reconciled.practiceRole &&
            reconciled.practiceHandoffToken &&
            reconciled.practiceExperience
          )
          if (!pollUntilReady || isReady) return
        } catch { /* bounded retry */ }
      }
    }

    ;(async () => {
      let xrayCompletionUncertain = false
      try {
        let response: Response
        try {
          response = await fetch(`/api/jobs/${params.id}/xray`)
        } catch (error) {
          xrayCompletionUncertain = true
          throw error
        }
        if (!response.ok) {
          if (await isAccountUnavailableResponse(response)) {
            if (!cancelled) scrubAccountBoundState()
            return
          }
          // Gateways and server timeouts can answer before (or after) the
          // origin finishes its parse/CAS. Auth/not-found responses are
          // definitive and must not create background polling traffic.
          if (response.status === 408 || response.status >= 500) {
            xrayCompletionUncertain = true
          }
          throw new Error(String(response.status))
        }
        let nextXray: Xray
        try {
          nextXray = await response.json() as Xray
        } catch (error) {
          xrayCompletionUncertain = true
          throw error
        }
        if (cancelled || accountUnavailableRef.current) return
        setXray(nextXray)
        const hasEvidence = nextXray.keyThemes.length > 0 || nextXray.requirements.length > 0
        // Role refresh can be retryable independently of the evidence body.
        // Never hide stable requirements/themes because CMS role authority is
        // temporarily unavailable.
        setXrayState(nextXray.retryable && !hasEvidence ? 'failed' : 'ready')
      } catch {
        if (!cancelled && !accountUnavailableRef.current) setXrayState('failed')
      } finally {
        // A domain-less posting may become Practice-ready only after the
        // parse is persisted. Never trust the browser-visible parse as the
        // eligibility source, including when its response was lost.
        if (needsPracticeReconciliation && !cancelled && !accountUnavailableRef.current) {
          await reconcilePracticeReadiness(xrayCompletionUncertain)
        }
      }
    })()
    return () => { cancelled = true }
  }, [detailCanXray, detailIsGated, loadedDetailId, params.id, scrubAccountBoundState, xrayAttempt])

  async function refetchDetail(): Promise<boolean> {
    try {
      const r = await fetch(`/api/jobs/${params.id}`)
      if (await isAccountUnavailableResponse(r)) {
        scrubAccountBoundState()
        return false
      }
      if (r.ok) {
        const nextDetail: unknown = await r.json()
        if (!isDetailProjection(nextDetail, params.id)) return false
        if (!accountUnavailableRef.current) setDetail(nextDetail)
      }
    } catch { /* keep the current view */ }
    return !accountUnavailableRef.current
  }

  function retryXray() {
    if (accountUnavailableRef.current) return
    xrayFetchedFor.current = null
    setXrayAttempt((attempt) => attempt + 1)
  }

  async function onAtsCheck() {
    if (accountUnavailableRef.current || detail?.capabilities?.atsCheck === false) return
    setAtsBusy(true)
    setAtsHint(null)
    try {
      const res = await fetch(`/api/jobs/${params.id}/ats-check`, { method: 'POST' })
      if (await isAccountUnavailableResponse(res)) {
        scrubAccountBoundState()
        return
      }
      if (accountUnavailableRef.current) return
      if (res.status === 409) {
        const { reason } = await res.json().catch(() => ({ reason: '' }))
        if (accountUnavailableRef.current) return
        setAtsHint(
          reason === 'no-resume'
            ? 'Attach a resume first — the check compares it to this JD.'
            : reason === 'posting-unavailable'
              ? 'This posting no longer supports a new ATS check.'
              : 'Save this job first to unlock the ATS check.',
        )
        return
      }
      if (!res.ok) { setAtsHint('Could not start the check — try again.'); return }
      // Background one-shot (~35s when uncached): poll the detail a few times.
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 12_000))
        if (!(await refetchDetail())) return
      }
    } finally {
      setAtsBusy(false)
    }
  }

  function onPracticeClick() {
    if (accountUnavailableRef.current) return
    // The inference door (§4c): launching practice on an APPLIED job asks
    // one tap — and NEVER delays the session; both answers proceed.
    if (detail && !detail.gated && detail.application?.status === 'applied' && inference === 'idle') {
      setInference('asking')
      return
    }
    onPractice()
  }

  function answerInference(scheduled: boolean) {
    if (accountUnavailableRef.current) return
    setInference('idle')
    if (scheduled) {
      // The status route is the single jobs.interview_scheduled emitter —
      // it fires on the edge with this flag (Codex on #525).
      fetch(`/api/jobs/${params.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'interview_scheduled', inferredFromPrep: true }),
        keepalive: true,
      }).then(async (response) => {
        if (await isAccountUnavailableResponse(response)) scrubAccountBoundState()
      }).catch(() => {})
      // Date capture waits for the feedback page (§4c) — the session comes first.
    }
    onPractice()
  }

  async function captureDate(request: InterviewDateRequest) {
    if (accountUnavailableRef.current) return
    const response = await fetch(`/api/jobs/${params.id}/interview-date`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    }).catch(() => null)
    if (response && await isAccountUnavailableResponse(response)) {
      scrubAccountBoundState()
      return
    }
    if (accountUnavailableRef.current) return
    if (!response?.ok) throw new Error('interview timing save failed')
    refetchDetail()
  }

  async function requestPracticeEmail() {
    if (accountUnavailableRef.current) return
    if (detail?.capabilities?.practice === false) {
      setPracticeEmail('unavailable')
      return
    }
    // Honest states (EMAILS.md §3): the server declines visibly when the
    // stream is off or the user unsubscribed — never a silent accept.
    try {
      const r = await fetch(`/api/jobs/${params.id}/practice-link-email`, { method: 'POST' })
      if (await isAccountUnavailableResponse(r)) {
        scrubAccountBoundState()
        return
      }
      const d = r.ok ? await r.json() : null
      if (accountUnavailableRef.current) return
      if (d?.ok) setPracticeEmail('requested')
      else if (d?.reason === 'email-off') setPracticeEmail('email-off')
      else setPracticeEmail('unavailable')
    } catch {
      if (!accountUnavailableRef.current) setPracticeEmail('unavailable')
    }
  }

  // ?practice=1 (Codex #532): the E0/E2 emails' CTAs promise "tap → the
  // session starts". Auto-start ONCE when the detail is loaded, authed,
  // and the server has published a role + signed canonical snapshot.
  // Otherwise the link degrades to the detail page, never a broken lobby.
  const autoPracticeAttemptedFor = useRef<string | null>(null)
  useEffect(() => {
    if (autoPracticeAttemptedFor.current === params.id || !detail || detail.gated) return
    try {
      if (new URLSearchParams(window.location.search).get('practice') !== '1') return
    } catch {
      return
    }
    if (
      typeof detail.jd !== 'string' ||
      detail.jd.trim().length === 0 ||
      !detail.practiceRole ||
      !detail.practiceHandoffToken ||
      !detail.practiceExperience
    ) return
    autoPracticeAttemptedFor.current = params.id
    onPractice()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, params.id])

  async function onPractice() {
    if (accountUnavailableRef.current || !detail || detail.gated || practiceStartInFlight.current) return
    practiceStartInFlight.current = true
    setPracticeStart('loading')
    try {
      // Refresh at click time so a long-open tab never hands the lobby an
      // expired intent. The signed token binds user + job + exact JD hash;
      // the session API resolves all three back to server state.
      let response: Response
      try {
        response = await fetch(`/api/jobs/${params.id}`, { cache: 'no-store' })
      } catch {
        if (!accountUnavailableRef.current) {
          setDetail(null)
          setStatus('offline')
        }
        throw new Error('handoff offline')
      }
      if (!response.ok) {
        if (await isAccountUnavailableResponse(response)) {
          scrubAccountBoundState()
          return
        }
        if (accountUnavailableRef.current) return
        setDetail(null)
        setStatus(detailFailureStatus(response.status))
        throw new Error('handoff unavailable')
      }
      let fresh: unknown
      try {
        fresh = await response.json()
      } catch {
        if (accountUnavailableRef.current) return
        setDetail(null)
        setStatus('server-error')
        throw new Error('handoff unavailable')
      }
      if (!isDetailProjection(fresh, params.id)) {
        if (accountUnavailableRef.current) return
        setDetail(null)
        setStatus('server-error')
        throw new Error('handoff unavailable')
      }
      // Reconcile the fresh authorization projection before checking
      // readiness. A restricted/gated response must replace stale live JD,
      // X-ray, Apply, and Tailor UI even though Practice itself cannot start.
      if (accountUnavailableRef.current) return
      setDetail(fresh)
      setStatus('ready')
      if (
        fresh.gated ||
        typeof fresh.jd !== 'string' ||
        fresh.jd.trim().length === 0 ||
        !fresh.practiceRole ||
        !fresh.practiceHandoffToken ||
        !fresh.practiceExperience
      ) throw new Error('handoff unavailable')
      const config = {
        role: fresh.practiceRole,
        experience: fresh.practiceExperience,
        duration: 20,
        jobDescription: fresh.jd,
        targetCompany: fresh.company.slice(0, INTERVIEW_TARGET_COMPANY_MAX_CHARS),
        attribution: { source: 'jobs' as const, jobId: fresh.id, applicationId: fresh.application?.applicationId },
        // Transport-only: /interview extracts this before the runtime config
        // reaches question/evaluation/model routes.
        jobsHandoffToken: fresh.practiceHandoffToken,
      }
      localStorage.setItem(STORAGE_KEYS.INTERVIEW_CONFIG, JSON.stringify(config))
      const retakeParent = retakeParentFromSearch(window.location.search)
      if (retakeParent) {
        localStorage.setItem(STORAGE_KEYS.PENDING_RETAKE_PARENT, retakeParent)
      } else {
        // Do not let an abandoned generic retake link an unrelated Jobs
        // practice session. Fresh URL intent is the only authority here.
        localStorage.removeItem(STORAGE_KEYS.PENDING_RETAKE_PARENT)
      }
      fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'jobs.prep_started',
          jobPostingId: fresh.id,
          props: { applicationId: fresh.application?.applicationId, evidenceCount: fresh.application?.practiceCount ?? 0 },
        }),
        keepalive: true,
      }).catch(() => {})
      router.push('/lobby')
    } catch {
      if (!accountUnavailableRef.current) setPracticeStart('error')
    } finally {
      practiceStartInFlight.current = false
    }
  }

  async function onSave() {
    if (accountUnavailableRef.current || saveInFlight.current || detail?.application) return
    saveInFlight.current = true
    setSaveBusy(true)
    setSaveError(null)
    try {
      const res = await fetch(`/api/jobs/${params.id}/save`, { method: 'POST' })
      if (await isAccountUnavailableResponse(res)) {
        scrubAccountBoundState()
        return
      }
      if (accountUnavailableRef.current) return
      if (res.status === 401) {
        setGate('save_job')
        return
      }
      if (!res.ok) {
        setSaveError('We couldn\'t save this job. Try again.')
        return
      }

      // A successful mutation is not browser truth. Re-read the server
      // projection and show Tracked only when the application row is present.
      let projection: Response
      try {
        projection = await fetch(`/api/jobs/${params.id}`, { cache: 'no-store' })
      } catch {
        setSaveError('We couldn\'t confirm the save. Refresh the job before trying again.')
        return
      }
      if (await isAccountUnavailableResponse(projection)) {
        scrubAccountBoundState()
        return
      }
      if (!projection.ok) {
        if (projection.status === 404 || projection.status === 410) {
          // The mutation may have raced a source revocation/closure. Replace
          // the stale live projection with the authoritative terminal state
          // so Apply, Save, and retained JD-derived actions disappear.
          setDetail(null)
          setStatus(detailFailureStatus(projection.status))
          setApplyError(null)
          setXray(null)
          setXrayState('idle')
          setSheet(null)
          setSheetDone(null)
          setInference('idle')
          return
        }
        setSaveError('We couldn\'t confirm the save. Refresh the job before trying again.')
        return
      }
      const nextDetail: unknown = await projection.json().catch(() => null)
      if (!isDetailProjection(nextDetail, params.id)) {
        setSaveError('We couldn\'t confirm the save. Refresh the job before trying again.')
        return
      }
      if (accountUnavailableRef.current) return
      setDetail(nextDetail)
      setStatus('ready')
      if (!nextDetail.application) {
        setSaveError('We couldn\'t confirm the save. Refresh the job before trying again.')
      }
    } catch {
      if (!accountUnavailableRef.current) {
        setSaveError('We couldn\'t save this job. Check your connection and try again.')
      }
    } finally {
      saveInFlight.current = false
      if (!accountUnavailableRef.current) setSaveBusy(false)
    }
  }

  function onApply(opt: ApplyOption, event: ReactMouseEvent<HTMLButtonElement>) {
    if (accountUnavailableRef.current) {
      event.preventDefault()
      return
    }
    const form = event.currentTarget.form
    if (!form) {
      event.preventDefault()
      setApplyError('We couldn\'t open the application tab. Refresh this page and try again.')
      return
    }
    let popupTarget: string
    try {
      const randomBytes = new Uint8Array(16)
      if (typeof window.crypto?.getRandomValues !== 'function') throw new Error('secure randomness unavailable')
      window.crypto.getRandomValues(randomBytes)
      popupTarget = Array.from(randomBytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
    } catch {
      event.preventDefault()
      setApplyError('We couldn\'t open the application tab safely. Refresh this page and try again.')
      return
    }
    let popup: Window | null = null
    try {
      popup = window.open('', popupTarget)
    } catch { /* handled as a blocked popup below */ }
    if (!popup) {
      event.preventDefault()
      setApplyError('Your browser blocked the application tab. Allow pop-ups for this site, then try Apply again.')
      return
    }
    try {
      // Pre-opening inside the user gesture makes popup blocking observable.
      // Sever the opener before the native POST targets this named tab. The
      // /open response also sends Referrer-Policy: no-referrer.
      popup.opener = null
      popup.name = popupTarget
      form.target = popupTarget
      form.removeAttribute('rel')
    } catch {
      event.preventDefault()
      try { popup.close() } catch { /* best effort */ }
      setApplyError('We couldn\'t open the application tab safely. Refresh this page and try again.')
      return
    }
    setApplyError(null)
    sheetInvokerRef.current = event.currentTarget
    // This handler remains synchronous so the native target=_blank POST form
    // can submit immediately after the return-sheet arm is stored. The server
    // converts the successful POST to an external GET with a 303 redirect.
    // Arm the return-sheet (§4b): fires on visibilitychange→visible, ≥20s
    // after the click, within 45 minutes. localStorage — survives the
    // external-tab excursion.
    try {
      localStorage.setItem(`JOBS_RETURN_${params.id}`, JSON.stringify({
        clickedAt: Date.now(),
        optionId: opt.optionId,
        url: opt.url,
        tier: opt.tier,
        viaSite: opt.viaSite,
      }))
    } catch { /* private mode — no sheet, the next-visit confirm card (4.2) catches it */ }
  }

  // Return-to-tab sheet (§4b): ≥20s away = the real ask; <20s = lead with
  // "did the link work?". One-shot — the arm record clears when shown.
  useEffect(() => {
    if (accountUnavailableRef.current) return
    if (detailIsGated == null) return
    if (detailIsGated === true || detailPostingState !== 'live') {
      try { localStorage.removeItem(`JOBS_RETURN_${params.id}`) } catch { /* noop */ }
      closeReturnSheet()
      if (
        detailIsGated === true ||
        detailPostingState === 'restricted' ||
        detailPostingState === 'snapshot-only'
      ) {
        setInference('idle')
        setSheetDone(null)
      }
      return
    }
    let cancelled = false
    let validating = false
    async function revalidateVisible(allowReturnSheet: boolean) {
      if (document.visibilityState !== 'visible') return
      if (validating) return
      validating = true
      const clearArm = () => {
        try { localStorage.removeItem(`JOBS_RETURN_${params.id}`) } catch { /* noop */ }
      }
      const clearJobSpecificProjection = () => {
        clearArm()
        closeReturnSheet()
        setSheetDone(null)
        setInference('idle')
        setXray(null)
        setXrayState('idle')
      }
      const failClosed = (nextStatus: Extract<DetailStatus, 'missing' | 'gone' | 'server-error' | 'offline'>) => {
        if (cancelled || accountUnavailableRef.current) return
        clearJobSpecificProjection()
        setDetail(null)
        setStatus(nextStatus)
      }
      try {
        // The posting may have closed while the employer tab was active.
        // Re-authorize lifecycle before asking any apply-return question.
        let response: Response
        try {
          response = await fetch(`/api/jobs/${params.id}`, { cache: 'no-store' })
        } catch {
          failClosed('offline')
          return
        }
        if (cancelled) return
        if (!response.ok) {
          if (await isAccountUnavailableResponse(response)) {
            if (!cancelled) scrubAccountBoundState()
            return
          }
          if (cancelled || accountUnavailableRef.current) return
          failClosed(detailFailureStatus(response.status))
          return
        }
        let fresh: unknown
        try {
          fresh = await response.json()
        } catch {
          failClosed('server-error')
          return
        }
        if (cancelled || accountUnavailableRef.current) return
        if (!isDetailProjection(fresh, params.id)) {
          failClosed('server-error')
          return
        }
        if (fresh.gated) {
          clearJobSpecificProjection()
          setDetail(fresh)
          setStatus('ready')
          return
        }
        const freshState = fresh.postingState ?? 'live'
        if (freshState !== 'live') {
          clearArm()
          closeReturnSheet()
          if (freshState === 'restricted' || freshState === 'snapshot-only') {
            setSheetDone(null)
            setInference('idle')
          }
          setDetail(fresh)
          setStatus('ready')
          return
        }
        setDetail(fresh)
        if (!allowReturnSheet) return
        const rec = parseApplyReturnArm(localStorage.getItem(`JOBS_RETURN_${params.id}`))
        if (!rec) {
          clearArm()
          return
        }
        const elapsed = Date.now() - rec.clickedAt
        if (elapsed < 0 || elapsed > 45 * 60_000) {
          clearArm()
          return
        }
        // The arm is local UX state, not authority. Re-bind it to the freshly
        // authorized option so a replaced URL/tier cannot trigger mutations
        // or a misleading report sheet from a stale tab.
        const currentOption = fresh.applyOptions?.find((option) => (
          option.optionId === rec.optionId &&
          option.url === rec.url &&
          option.tier === rec.tier
        ))
        if (!currentOption) {
          clearArm()
          return
        }
        clearArm()
        setSheet({
          kind: elapsed >= 20_000 ? 'normal' : 'quick',
          clicked: currentOption,
          elapsedMs: elapsed,
        })
      } catch {
        failClosed('server-error')
      } finally {
        validating = false
      }
    }
    const onVisibilityChange = () => { void revalidateVisible(true) }
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void revalidateVisible(false)
    }, ACTIVE_TAB_REVALIDATION_MS)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      cancelled = true
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [closeReturnSheet, detailIsGated, detailPostingState, params.id, scrubAccountBoundState])

  useEffect(() => {
    if (!sheet) return
    const dialog = sheetDialogRef.current
    if (!dialog) return
    const dialogElement = dialog
    const focusableSelector = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    const focusableElements = () => Array.from(dialogElement.querySelectorAll<HTMLElement>(focusableSelector))
    ;(focusableElements()[0] ?? dialogElement).focus()
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeReturnSheet()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = focusableElements()
      if (focusable.length === 0) {
        event.preventDefault()
        dialogElement.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && (document.activeElement === first || !dialogElement.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !dialogElement.contains(document.activeElement))) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [closeReturnSheet, sheet])

  async function sheetApplied(appliedWith?: { wasTailored: boolean; tailoredAt?: string }) {
    if (accountUnavailableRef.current) return
    const elapsedMs = sheet?.elapsedMs
    closeReturnSheet()
    const res = await fetch(`/api/jobs/${params.id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'applied',
        latencyMs: elapsedMs,
        ...(appliedWith ? { appliedWith } : {}),
      }),
    }).catch(() => null)
    if (res && await isAccountUnavailableResponse(res)) {
      scrubAccountBoundState()
      return
    }
    if (accountUnavailableRef.current) return
    if (res?.ok) {
      setSheetDone('Marked as applied ✓ — it’s on your tracker.')
      refetchDetail()
    } else if (res?.status === 409) {
      const conflict = await res.json().catch(() => null) as { code?: unknown } | null
      if (conflict?.code === 'TAILORED_VERSION_UNAVAILABLE' || conflict?.code === 'APPLIED_WITH_CONFLICT') {
        setSheetDone(conflict.code === 'TAILORED_VERSION_UNAVAILABLE'
          ? 'The saved tailored version changed. Review it, then confirm your application again.'
          : 'A different resume choice is already recorded. Refresh the job before changing it.')
        refetchDetail()
        return
      }
      setSheetDone('Couldn’t record that just now — open your tracker to update the status when you’re ready.')
    } else {
      setSheetDone('Couldn’t record that just now — open your tracker to update the status when you’re ready.')
    }
  }

  async function sheetBrokenLink() {
    if (accountUnavailableRef.current) return
    const clicked = sheet?.clicked
    closeReturnSheet()
    if (!clicked) return
    const alternates = (detail?.applyOptions ?? []).filter((o) => o.url !== clicked.url)
    const post = () =>
      fetch(`/api/jobs/${params.id}/broken-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ optionId: clicked.optionId }),
      }).catch(() => null)
    const res = await post()
    if (res && await isAccountUnavailableResponse(res)) {
      scrubAccountBoundState()
      return
    }
    if (accountUnavailableRef.current) return
    const alt = alternates.length > 0 ? `Try “${alternates[0].viaSite ?? alternates[0].tier}” instead.` : ''
    if (res?.ok) {
      const body = await res.json().catch(() => null) as {
        disposition?: BrokenLinkDisposition
        alreadyReported?: boolean
      } | null
      const copy = body?.disposition === 'pending-verification'
        ? 'Thanks—we’re checking this link.'
        : body?.disposition === 'crowd-demoted'
          ? 'Several people reported this link, so we only moved it lower while we verify it.'
        : body?.disposition === 'machine-demoted'
            ? 'A recent check found this link unavailable.'
            : null
      if (copy) {
        setSheetDone(`${copy}${alt ? ` ${alt}` : ''}`)
        void refetchDetail()
        return
      }
    }
    if (res?.status === 404) {
      setSheetDone(`We couldn’t verify this report against the current link and a recent Apply attempt, so nothing changed.${alt ? ` ${alt}` : ''}`)
    } else if (res?.status === 429) {
      setSheetDone(`Too many reports right now—please try again later.${alt ? ` ${alt}` : ''}`)
    } else {
      setSheetDone(`We couldn’t submit that report just now.${alt ? ` ${alt}` : ''}`)
    }
  }

  const genericSetupHref = '/interview/setup?jobsFallback=1'
  const rememberGenericRetake = () => {
    try {
      // Exact-job comparison requires the same server-verified job + JD hash.
      // Generic fallback intentionally starts a new, non-comparable practice.
      localStorage.removeItem(STORAGE_KEYS.PENDING_RETAKE_PARENT)
    } catch { /* setup URL remains authoritative */ }
  }

  if (status === 'missing') {
    return (
      <main ref={unavailableRef} tabIndex={-1} className="mx-auto max-w-3xl px-4 py-16">
        <p className="font-medium">This posting isn&apos;t available anymore.</p>
        {retakeParentId && (
          <Link href={genericSetupHref} onClick={rememberGenericRetake} className="mt-3 block text-sm font-medium text-blue-600 hover:underline">
            Start a new general practice
          </Link>
        )}
        <Link href="/jobs" className="mt-3 inline-block text-sm text-blue-600 hover:underline">← Back to jobs</Link>
      </main>
    )
  }
  if (status === 'gone') {
    return (
      <main ref={unavailableRef} tabIndex={-1} className="mx-auto max-w-3xl px-4 py-16">
        <p className="font-medium">This posting has closed or expired.</p>
        <p className="mt-1 text-sm text-slate-500">Browse current jobs to find an active opening.</p>
        {retakeParentId && (
          <Link href={genericSetupHref} onClick={rememberGenericRetake} className="mt-3 block text-sm font-medium text-blue-600 hover:underline">
            Start a new general practice
          </Link>
        )}
        <Link href="/jobs" className="mt-3 inline-block text-sm text-blue-600 hover:underline">← Back to jobs</Link>
      </main>
    )
  }
  if (status === 'account-unavailable') {
    return (
      <main ref={unavailableRef} tabIndex={-1} className="mx-auto max-w-3xl px-4 py-16">
        <div role="status" aria-live="polite">
          <h1 className="font-medium">Your account is unavailable.</h1>
          <p className="mt-1 text-sm text-slate-500">
            Account deletion has started or completed, so this job&apos;s private details were removed from this page.
          </p>
          <p className="mt-1 text-sm text-slate-500">If you did not request deletion, contact support.</p>
        </div>
        <Link href="/jobs" className="mt-3 inline-block text-sm text-blue-600 hover:underline">← Browse public jobs</Link>
      </main>
    )
  }
  if (status === 'server-error' || status === 'offline') {
    const offline = status === 'offline'
    return (
      <main ref={unavailableRef} tabIndex={-1} className="mx-auto max-w-3xl px-4 py-16">
        <p className="font-medium">
          {offline ? 'You appear to be offline.' : 'We couldn\'t load this posting right now.'}
        </p>
        <p className="mt-1 text-sm text-slate-500">
          {offline
            ? 'Check your connection, then retry.'
            : 'The service returned a temporary or invalid response. Retry before applying or opening the employer link.'}
        </p>
        <button
          type="button"
          onClick={() => setDetailAttempt((attempt) => attempt + 1)}
          className="mt-3 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          Retry
        </button>
        {retakeParentId && (
          <Link href={genericSetupHref} onClick={rememberGenericRetake} className="mt-3 block text-sm font-medium text-blue-600 hover:underline">
            Start a new general practice
          </Link>
        )}
        <Link href="/jobs" className="mt-3 block text-sm text-blue-600 hover:underline">← Back to jobs</Link>
      </main>
    )
  }
  if (!detail) return <main className="mx-auto max-w-3xl px-4 py-16 text-sm text-slate-500">Loading…</main>

  const postingState = detail.gated ? 'live' : (detail.postingState ?? 'live')
  const isLive = postingState === 'live'
  const canApply = isLive && detail.capabilities?.apply === true
  const primary = canApply
    ? detail.applyOptions?.[0]
    : undefined
  const alternates = canApply ? (detail.applyOptions ?? []).slice(1) : []
  const practiceReady = detail.capabilities?.practice !== false && !!(
    typeof detail.jd === 'string' &&
    detail.jd.trim().length > 0 &&
    detail.practiceRole &&
    detail.practiceHandoffToken &&
    detail.practiceExperience
  )
  const practiceSetupNeeded = detail.practiceBlocker === 'experience-required'
  const tracked = !!detail.application
  const canTailor = !detail.gated && (detail.capabilities?.tailor ?? isLive)
  const hasRestrictedPrepContext = postingState === 'restricted' || postingState === 'snapshot-only'
  const exactInterviewDate = detail.application?.interviewDateConfidence === 'exact'
    ? detail.application.interviewDate
    : undefined

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href={isLive ? '/jobs' : '/jobs/tracker'} className="text-sm text-slate-500 hover:underline">
          {isLive ? '← All jobs' : '← Job tracker'}
        </Link>
        {!isLive && (
          <Link href="/jobs" className="text-sm text-blue-600 hover:underline">Browse live jobs</Link>
        )}
      </div>
      <h1 ref={titleRef} tabIndex={-1} className="mt-3 text-2xl font-semibold">{detail.title}</h1>
      <p className="mt-1 text-slate-500">
        {detail.company}
        {detail.locations[0] ? ` · ${detail.locations[0]}` : ''}
        {detail.isRemote ? ' · Remote' : ''}
        {detail.salaryText ? ` · ${detail.salaryText}` : ''}
      </p>

      {!detail.gated && !isLive && (
        <aside
          aria-label="Posting status"
          aria-live="polite"
          className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950"
        >
          <p className="font-medium">
            {postingState === 'archived'
              ? 'Posting no longer active'
              : postingState === 'snapshot-only'
                ? 'Original posting unavailable'
                : 'Posting unavailable'}
          </p>
          <p className="mt-1 text-xs text-amber-800">
            {postingState === 'archived'
              ? 'Your tracked status, saved job description, and available preparation tools are still here.'
              : postingState === 'snapshot-only'
                ? 'The original posting record is gone, so only your tracked status and saved activity summary remain.'
                : 'For safety, only your tracked status remains when a posting was removed by policy or closed before a safe archive reason was recorded.'}
          </p>
        </aside>
      )}

      {retakeParentId && !practiceReady && !practiceSetupNeeded && detail.application?.status !== 'interview_scheduled' && (
        <aside className="mt-5 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm">
          <p className="font-medium">Exact-job context is no longer available for this retake.</p>
          <p className="mt-1 text-xs text-slate-600">You can start a new general practice without the posting-derived JD. It won&apos;t be compared with this exact-job session.</p>
          <Link href={genericSetupHref} onClick={rememberGenericRetake} className="mt-2 inline-block text-xs font-medium text-blue-600 hover:underline">
            Start new general interview setup
          </Link>
        </aside>
      )}

      {detail.gated ? (
        <div className="relative mt-8">
          {/* blurred stand-in — real content never reaches the anon client */}
          <div aria-hidden className="select-none space-y-2 blur-sm">
            {['w-5/6', 'w-full', 'w-4/6', 'w-full', 'w-3/6', 'w-5/6', 'w-2/3'].map((w, i) => (
              <div key={i} className={`h-3 rounded bg-slate-300 ${w}`} />
            ))}
          </div>
          <div className="absolute inset-0 flex items-center justify-center">
            <button
              onClick={() => setGate('view_job_detail')}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow hover:bg-blue-700"
            >
              Sign in to read the full posting
            </button>
          </div>
        </div>
      ) : (
        <>
          <div id="apply" className="mt-6 flex flex-wrap items-center gap-3 scroll-mt-6">
            {primary && (
              <form
                action={applyRedirectHref(detail.id, primary.optionId, 'apply')}
                method="post"
                target="_blank"
                rel="noopener noreferrer"
              >
                <button
                  type="submit"
                  onClick={(event) => onApply(primary, event)}
                  className="rounded-lg bg-blue-600 px-5 py-2.5 font-medium text-white hover:bg-blue-700"
                >
                  Apply ↗
                </button>
                <p className="mt-1 text-xs text-slate-500">
                  {(TIER_SUBTITLE[primary.tier] ?? (() => ''))(detail.company, primary.viaSite)}
                </p>
              </form>
            )}
            {postingState === 'archived' && (
              <span className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 text-sm font-medium text-slate-600">
                Posting no longer active
              </span>
            )}
            {practiceReady ? (
              <button
                onClick={onPracticeClick}
                disabled={practiceStart === 'loading'}
                className="rounded-lg border border-blue-400 px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50"
              >
                {practiceStart === 'loading' ? 'Preparing practice…' : '🎙 Practice for this job · 20 min'}
              </button>
            ) : practiceSetupNeeded ? (
              <span className="text-xs text-amber-700">
                Add your experience level in{' '}
                <Link href="/settings" className="font-medium text-blue-600 hover:underline">Settings</Link>
                {' '}to start job-specific practice.
              </span>
            ) : detail.capabilities?.practice === false && !isLive ? (
              <span className="text-xs text-slate-500">
                Job-specific practice isn&apos;t available for this retained posting.
              </span>
            ) : xrayState === 'loading' ? (
              <button
                disabled
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-500"
              >
                Preparing job-specific practice…
              </button>
            ) : xrayState === 'ready' && xray?.retryable ? (
              <span className="text-xs text-amber-700">
                Practice setup is temporarily unavailable.{' '}
                <button className="font-medium text-blue-600 hover:underline" onClick={retryXray}>
                  Retry practice setup
                </button>
              </span>
            ) : xrayState === 'ready' ? (
              <span className="text-xs text-slate-500">Job-specific practice isn&apos;t available for this role yet.</span>
            ) : null}
            {canTailor && (
              <Link
                href={`/resume/tailor?jobId=${detail.id}`}
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-blue-700 hover:bg-slate-50"
              >
                Tailor resume
              </Link>
            )}
            {isLive && (
              <button
                onClick={onSave}
                disabled={tracked || saveBusy}
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-60"
              >
                {tracked ? 'Tracked ✓' : saveBusy ? 'Saving…' : 'Save'}
              </button>
            )}
            {primary && detail.capabilities?.viewSource !== false && (
              <a
                href={applyRedirectHref(detail.id, primary.optionId, 'view')}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-slate-500 hover:underline"
              >
                View full posting ↗
              </a>
            )}
          </div>
          {saveError && <p role="alert" className="mt-2 text-sm text-red-600">{saveError}</p>}
          {applyError && <p role="alert" className="mt-2 text-sm text-red-600">{applyError}</p>}
          {detail.application?.tailoredResume && (
            <div className="mt-3 rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-slate-700">
              <p className="font-medium">
                {detail.application.tailoredResume.current
                  ? 'Tailored resume saved for this job'
                  : 'Saved tailored resume needs an update'}
              </p>
              <p className="mt-1 text-xs text-slate-600">
                {detail.application.tailoredResume.current
                  ? 'It is attached to this tracked application and available after refresh.'
                  : 'The job description changed after this version was created.'}{' '}
                <Link href={`/resume/tailor?jobId=${detail.id}`} className="font-medium text-blue-700 hover:underline">
                  {detail.application.tailoredResume.current ? 'View or update' : 'Create a new version'}
                </Link>
              </p>
            </div>
          )}
          {detail.application?.appliedWith && APPLIED_HISTORY_STATUSES.has(detail.application.status) && (
            <p className="mt-2 text-xs text-slate-600">
              {detail.application.status === 'applied'
                ? detail.application.appliedWith.wasTailored
                  ? 'Applied with the tailored resume for this job.'
                  : 'Applied with another resume.'
                : detail.application.appliedWith.wasTailored
                  ? 'This application used the tailored resume for this job.'
                  : 'This application used another resume.'}
            </p>
          )}
          {practiceStart === 'error' && (
            <p role="alert" className="mt-2 text-sm text-red-600">
              We couldn&apos;t prepare this job practice. Refresh the posting and try again.
            </p>
          )}
          {primary && detail.allApplyOptionsDemoted === true && (
            <p className="mt-2 text-xs text-amber-700">
              This link is being verified; it may still work.
            </p>
          )}
          {isLive && alternates.length > 0 && (
            <div className="mt-2 text-xs text-slate-500">
              Also available: {alternates.map((o, i) => (
                <form
                  key={o.optionId}
                  action={applyRedirectHref(detail.id, o.optionId, 'apply')}
                  method="post"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline"
                >
                  <button
                    type="submit"
                    onClick={(event) => onApply(o, event)}
                    className="underline decoration-dotted hover:text-slate-600"
                  >
                    {o.viaSite ?? o.tier}{i < alternates.length - 1 ? ', ' : ''}
                  </button>
                </form>
              ))}
            </div>
          )}

          {inference === 'asking' && (
            <div className="mt-4 rounded-lg border border-blue-300 bg-blue-50 p-3 text-sm">
              <p className="font-medium">Prepping for a real interview at {detail.company}?</p>
              <div className="mt-2 flex gap-2">
                <button onClick={() => answerInference(true)} className="rounded-lg bg-blue-600 px-3 py-1 text-xs font-medium text-white">Yes — it&apos;s scheduled</button>
                <button onClick={() => answerInference(false)} className="rounded-lg border border-slate-200 px-3 py-1 text-xs bg-white">Just practicing</button>
              </div>
            </div>
          )}

          {detail.application?.status === 'interview_scheduled' && !practiceReady ? (
            <div className="mt-5 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm">
              <p className="font-medium">Interview status saved.</p>
              <p className="mt-1 text-xs text-slate-600">
                {interviewDateLabel(
                  detail.application.interviewDate,
                  detail.application.interviewDateConfidence,
                  detail.application.interviewDatePreference,
                )}
              </p>
              {/* Date capture belongs to the tracked application, not the
                  exact-JD Practice capability. It stays editable after every
                  selection, including coarse week preferences. */}
              <InterviewDateControls onCapture={captureDate} />
              <p className="mt-1 text-xs text-slate-600">
                {practiceSetupNeeded
                  ? 'Add your experience level in Settings to unlock job-specific preparation.'
                  : hasRestrictedPrepContext
                  ? 'Exact-job preparation is unavailable because the original posting context can no longer be used.'
                  : 'Job-specific preparation is currently unavailable, but you can still prepare in the general interview setup.'}
              </p>
              {practiceSetupNeeded ? (
                <Link href="/settings" className="mt-2 inline-block text-xs font-medium text-blue-600 hover:underline">
                  Set experience level
                </Link>
              ) : (
                <Link href={genericSetupHref} onClick={rememberGenericRetake} className="mt-2 inline-block text-xs font-medium text-blue-600 hover:underline">
                  Open general interview setup
                </Link>
              )}
            </div>
          ) : detail.application?.status === 'interview_scheduled' ? (
            /* §4c hero swap: the chip yields to the PREP PLAN panel. */
            <div className="mt-5 rounded-lg border border-blue-300 bg-blue-50 p-4 text-sm">
              <p className="font-medium">🎙 Interview recorded. Prepare for this job when you&apos;re ready.</p>
              <p className="mt-1 text-xs text-slate-600">
                {interviewDateLabel(
                  detail.application.interviewDate,
                  detail.application.interviewDateConfidence,
                  detail.application.interviewDatePreference,
                )}
              </p>
              <InterviewDateControls onCapture={captureDate} />
              {(() => {
                const plan = buildPrepPlan(exactInterviewDate ? new Date(exactInterviewDate) : null)
                return (
                  <div className="mt-2">
                    <p className="text-xs text-slate-600">{plan.headline}</p>
                    <ul className="mt-2 space-y-1.5">
                      {plan.sessions.map((sess) => (
                        <li key={sess.label} className="flex items-center justify-between gap-2">
                          <span className="text-sm">{sess.label}{sess.dayOffset > 0 ? ` (in ${sess.dayOffset}d)` : ''}</span>
                          {sess.dayOffset === 0 && practiceReady && (
                            <button
                              onClick={onPracticeClick}
                              disabled={practiceStart === 'loading'}
                              className="rounded-lg bg-blue-600 px-2.5 py-1 text-xs font-medium text-white disabled:cursor-wait disabled:opacity-60"
                            >
                              {practiceStart === 'loading' ? 'Preparing…' : 'Start'}
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )
              })()}
              <p className="mt-2 text-xs text-slate-600">
                {practiceProgressLabel(detail.application.practiceCount)}
              </p>
              {/* E0 — the load-bearing deferred CTA (PRODUCT_FLOW §4c /
                  EMAILS.md §1): voice mocks need a mic + quiet room, and
                  interview news arrives on a phone. Honest states only —
                  a request the server won't honor is declined visibly. */}
              {detail.capabilities?.practice !== false && practiceEmail === 'idle' && (
                <button
                  onClick={requestPracticeEmail}
                  className="mt-2 text-xs font-medium text-blue-600 hover:underline"
                >
                  📩 Email me this practice link
                </button>
              )}
              {practiceEmail === 'requested' && (
                <p className="mt-2 text-xs text-emerald-700">Request received — check your inbox.</p>
              )}
              {practiceEmail === 'email-off' && (
                <p className="mt-2 text-xs text-slate-600">Email is off for your account — turn it on in Settings to use this.</p>
              )}
              {practiceEmail === 'unavailable' && (
                <p className="mt-2 text-xs text-slate-600">Email links aren&apos;t available yet.</p>
              )}
            </div>
          ) : (
            /* Verdict chip — rule 1 (launch majority: no readiness band exists
                yet). Rules 2/4 arrive with readiness bands; rule 3 stays behind
                its DB row (DECISIONS #19). "Not ready" is banned copy; Apply is
                never disabled. */
            <div className="mt-5 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm">
              <span className="font-medium">
                {isLive
                  ? practiceReady
                    ? 'Apply when ready — job-specific practice is available.'
                    : 'Apply when ready — track your status here.'
                  : 'Your preparation history stays with this tracked job.'}
              </span>
              <span className="ml-2 text-xs text-slate-600">
                {practiceProgressLabel(detail.application?.practiceCount ?? 0)}
              </span>
            </div>
          )}

          <section className="mt-6" aria-label="ATS check">
            {detail.application?.ats.state === 'done' ? (
              <div className="rounded-lg border border-slate-200 p-3 text-sm bg-white">
                {hasRestrictedPrepContext ? (
                  <span className="font-medium">ATS check completed before this posting became unavailable.</span>
                ) : (
                  <>
                    <span className="font-medium">ATS match: {detail.application.ats.score}/100</span>
                    {(detail.application.ats.missingKeywords?.length ?? 0) > 0 && (
                      <span className="ml-2 text-xs text-slate-500">
                        Missing: {detail.application.ats.missingKeywords!.join(', ')}
                      </span>
                    )}
                  </>
                )}
                {/* Resume edited since? The job compares BOTH hashes — an
                    unchanged pair returns the cached score instantly. */}
                {detail.capabilities?.atsCheck !== false && (
                  <button onClick={onAtsCheck} className="ml-3 text-xs text-blue-600 hover:underline">Re-check</button>
                )}
              </div>
            ) : detail.application?.ats.state === 'pending' && detail.capabilities?.atsCheck === false ? (
              <p className="text-sm text-slate-500">An ATS check was pending when this posting became unavailable.</p>
            ) : detail.application?.ats.state === 'pending' || atsBusy ? (
              <p className="text-sm text-slate-500">Checking your resume against this JD (~1 min)…</p>
            ) : detail.application && detail.capabilities?.atsCheck !== false ? (
              <button onClick={onAtsCheck} className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium hover:bg-slate-50">
                Check my resume against this JD
              </button>
            ) : !isLive ? (
              <p className="text-xs text-slate-500">No new ATS check is available for this retained posting.</p>
            ) : (
              <p className="text-xs text-slate-500">Save this job to unlock the ATS check.</p>
            )}
            {atsHint && <p className="mt-1 text-xs text-amber-700">{atsHint}</p>}
          </section>

          <section className="mt-8" aria-label="Interview X-ray">
            <h2 className="text-lg font-medium">Interview X-ray</h2>
            <p className="mt-0.5 text-xs text-slate-500">Requirements extracted from this job description.</p>
            {detail.capabilities?.xray === false && (
              <p className="mt-3 text-sm text-slate-500">
                {postingState === 'archived'
                  ? 'X-ray wasn\'t saved while this job was live, so it can\'t be generated after closure.'
                  : 'X-ray is unavailable because the original posting content is not available.'}
              </p>
            )}
            {detailCanXray && xrayState === 'loading' && <p className="mt-3 text-sm text-slate-500">Reading the JD…</p>}
            {detailCanXray && xrayState === 'failed' && (
              <p className="mt-3 text-sm text-slate-500">
                X-ray unavailable for this posting.{' '}
                <button
                  className="font-medium text-blue-600 hover:underline"
                  onClick={retryXray}
                >
                  Try again
                </button>
              </p>
            )}
            {detailCanXray && xrayState === 'ready' && xray?.retryable && (
              <p className="mt-3 text-xs text-amber-700">
                Practice role verification is temporarily unavailable; the saved X-ray evidence remains visible.
              </p>
            )}
            {detailCanXray && xrayState === 'ready' && xray && (
              <div className="mt-3 space-y-4">
                {xray.keyThemes.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {xray.keyThemes.map((t) => (
                      <span key={t} className="rounded-full border border-slate-200 px-2 py-0.5 text-xs text-slate-500 bg-white">{t}</span>
                    ))}
                  </div>
                )}
                {xray.requirements.filter((r) => r.importance === 'must-have').length > 0 && (
                  <div>
                    <h3 className="text-sm font-medium">Must-haves</h3>
                    <ul className="mt-1 list-inside list-disc space-y-1 text-sm text-slate-600">
                      {xray.requirements.filter((r) => r.importance === 'must-have').map((r) => (
                        <li key={r.id}>{r.requirement}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {xray.requirements.filter((r) => r.importance === 'nice-to-have').length > 0 && (
                  <details>
                    <summary className="cursor-pointer text-sm font-medium text-slate-500">
                      Nice-to-haves ({xray.requirements.filter((r) => r.importance === 'nice-to-have').length})
                    </summary>
                    <ul className="mt-1 list-inside list-disc space-y-1 text-sm text-slate-500">
                      {xray.requirements.filter((r) => r.importance === 'nice-to-have').map((r) => (
                        <li key={r.id}>{r.requirement}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </section>

          {detail.jd ? (
            <section className="mt-8" aria-label={isLive ? 'Job description' : 'Saved job description'}>
              <h2 className="text-lg font-medium">{isLive ? 'Job description' : 'Saved job description'}</h2>
              <div className="prose prose-sm mt-3 max-w-none whitespace-pre-wrap text-sm leading-relaxed">
                {detail.jd}
              </div>
            </section>
          ) : (
            <p className="mt-8 text-sm text-slate-500">The original job description is not available.</p>
          )}
        </>
      )}

      {sheet && (
        <div className="fixed inset-0 z-40 flex items-end justify-center bg-slate-900/20 p-4">
          <div
            ref={sheetDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="job-return-sheet-title"
            tabIndex={-1}
            className="w-full max-w-3xl rounded-xl border border-slate-200 bg-white p-4 shadow-lg"
          >
            <p id="job-return-sheet-title" className="font-medium">
              {sheet.kind === 'quick' ? 'That was quick — did the link work?' : `Did you apply to ${detail.company}?`}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {sheet.kind === 'normal' && (
                detail.application?.tailoredResume ? (
                  <>
                    <button
                      onClick={() => sheetApplied({
                        wasTailored: true,
                        tailoredAt: detail.application!.tailoredResume!.createdAt,
                      })}
                      className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
                    >
                      ✓ Yes, with tailored resume
                    </button>
                    <button
                      onClick={() => sheetApplied({ wasTailored: false })}
                      className="rounded-lg border border-blue-200 bg-white px-3 py-1.5 text-sm font-medium text-blue-700"
                    >
                      Yes, with another resume
                    </button>
                  </>
                ) : (
                  <button onClick={() => sheetApplied()} className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700">
                    ✓ Yes, applied
                  </button>
                )
              )}
              <button
                onClick={() => {
                  closeReturnSheet()
                  setSheetDone(canTailor
                    ? 'No rush — tailor your resume for this job before applying.'
                    : 'No rush — keep this job tracked and update its status when you’re ready.')
                }}
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm bg-white"
              >
                {sheet.kind === 'quick' ? 'It worked — still applying' : 'Not yet'}
              </button>
              <button onClick={sheetBrokenLink} className="rounded-lg border border-amber-400 px-3 py-1.5 text-sm text-amber-700 bg-white">
                ⚠ Link didn&apos;t work
              </button>
            </div>
          </div>
        </div>
      )}
      {sheetDone && (
        <div className="fixed inset-x-0 bottom-0 z-40 mx-auto max-w-3xl p-4">
          <div role="status" aria-live="polite" aria-atomic="true" className="flex items-start justify-between rounded-xl border border-slate-200 bg-white p-3 text-sm shadow-lg">
            <p>{sheetDone}{canTailor && /tailor/i.test(sheetDone) && <> <Link href={`/resume/tailor?jobId=${detail.id}`} className="text-blue-600 underline">Open tailor</Link></>}</p>
            <button onClick={() => { setSheetDone(null); restoreReturnSheetFocus() }} aria-label="Dismiss" className="ml-3 text-slate-500 hover:text-slate-600">✕</button>
          </div>
        </div>
      )}

      <AuthGateModal reason={gate} onClose={() => setGate(null)} />
    </main>
  )
}
