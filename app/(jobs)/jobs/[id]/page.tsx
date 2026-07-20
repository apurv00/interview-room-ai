'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { STORAGE_KEYS } from '@shared/storageKeys'
import { INTERVIEW_TARGET_COMPANY_MAX_CHARS } from '@shared/interviewContract'
import { buildPrepPlan } from '@jobs/config/prepPlan'
import AuthGateModal from '@shared/ui/AuthGateModal'
import { retakeParentFromSearch } from '@interview/utils/retakeNavigation'

/**
 * /jobs/[id] — public SHELL, authed BODY (founder ruling P-2, 2026-07-14).
 * The API enforces the split server-side; this page renders whatever
 * projection it was given. Anon = title/company/tier + a blurred stand-in
 * over the sign-in gate. Authed = JD, tier-honest apply ladder (sync
 * window.open — popup blockers kill async opens), Save, and a low-key
 * "view full posting" link so Apply clicks aren't polluted by read intent.
 */

interface ApplyOption { url: string; tier: string; viaSite?: string }
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
  jd?: string
  applyOptions?: ApplyOption[]
  flags?: { staffing: boolean; shortJd: boolean; repost: boolean }
  application?: {
    applicationId: string
    status: string
    practiceCount: number
    interviewDate?: string
    interviewDateConfidence?: 'exact' | 'week' | 'unknown'
    ats: { state: 'none' | 'pending' | 'done'; score?: number; missingKeywords?: string[] }
  } | null
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

export default function JobDetailPage({ params }: { params: { id: string } }) {
  const router = useRouter()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing' | 'unavailable'>('loading')
  const [gate, setGate] = useState<null | 'view_job_detail' | 'save_job'>(null)
  const [saved, setSaved] = useState(false)
  const [xray, setXray] = useState<Xray | null>(null)
  const [xrayState, setXrayState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const [xrayAttempt, setXrayAttempt] = useState(0)
  const [atsBusy, setAtsBusy] = useState(false)
  const [atsHint, setAtsHint] = useState<string | null>(null)
  const [sheet, setSheet] = useState<null | { kind: 'normal' | 'quick'; clicked: { url: string; tier: string }; elapsedMs: number }>(null)
  const [inference, setInference] = useState<'idle' | 'asking'>('idle')
  const [practiceEmail, setPracticeEmail] = useState<'idle' | 'sent' | 'email-off' | 'unavailable'>('idle')
  const [practiceStart, setPracticeStart] = useState<'idle' | 'loading' | 'error'>('idle')
  const [sheetDone, setSheetDone] = useState<string | null>(null)
  const [retakeParentId, setRetakeParentId] = useState<string | null>(null)

  useEffect(() => {
    try {
      setRetakeParentId(retakeParentFromSearch(window.location.search) ?? null)
    } catch {
      setRetakeParentId(null)
    }
  }, [params.id])

  useEffect(() => {
    let cancelled = false
    setDetail(null)
    setStatus('loading')
    void (async () => {
      try {
        const response = await fetch(`/api/jobs/${params.id}`)
        if (cancelled) return
        if (!response.ok) {
          setStatus(response.status === 404 ? 'missing' : 'unavailable')
          return
        }
        const nextDetail = await response.json() as Detail
        if (cancelled) return
        setDetail(nextDetail)
        setStatus('ready')
      } catch {
        if (!cancelled) {
          setDetail(null)
          setStatus('unavailable')
        }
      }
    })()
    fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'jobs.job_viewed', jobPostingId: params.id, props: {} }),
      keepalive: true,
    }).catch(() => {})
    return () => { cancelled = true }
  }, [params.id])

  // X-ray loads progressively AFTER the body — the first view on a posting
  // pays a lazy LLM parse (seconds); cached thereafter. Authed only (P-2).
  // Fetch ONCE per posting: ATS polling replaces `detail` every tick, and an
  // effect keyed on the whole object re-fired the parse while the first one
  // was still uncached — concurrent LLM calls for one JD (Codex on #521).
  const xrayFetchedFor = useRef<string | null>(null)
  const pendingPollFor = useRef<string | null>(null)
  const practiceStartInFlight = useRef(false)
  const practiceReadyRef = useRef(false)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const unavailableRef = useRef<HTMLElement>(null)
  const sheetDialogRef = useRef<HTMLDivElement>(null)
  const sheetInvokerRef = useRef<HTMLElement | null>(null)
  practiceReadyRef.current = !!(
    detail && !detail.gated && detail.practiceRole && detail.practiceHandoffToken
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
        await refetchDetail()
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
          if (!response.ok) continue
          const reconciled = await response.json() as Detail
          if (!cancelled) setDetail(reconciled)
          const isReady = !!(reconciled.practiceRole && reconciled.practiceHandoffToken)
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
        if (cancelled) return
        setXray(nextXray)
        const hasEvidence = nextXray.keyThemes.length > 0 || nextXray.requirements.length > 0
        // Role refresh can be retryable independently of the evidence body.
        // Never hide stable requirements/themes because CMS role authority is
        // temporarily unavailable.
        setXrayState(nextXray.retryable && !hasEvidence ? 'failed' : 'ready')
      } catch {
        if (!cancelled) setXrayState('failed')
      } finally {
        // A domain-less posting may become Practice-ready only after the
        // parse is persisted. Never trust the browser-visible parse as the
        // eligibility source, including when its response was lost.
        if (needsPracticeReconciliation && !cancelled) {
          await reconcilePracticeReadiness(xrayCompletionUncertain)
        }
      }
    })()
    return () => { cancelled = true }
  }, [detailCanXray, detailIsGated, loadedDetailId, params.id, xrayAttempt])

  async function refetchDetail() {
    try {
      const r = await fetch(`/api/jobs/${params.id}`)
      if (r.ok) setDetail(await r.json())
    } catch { /* keep the current view */ }
  }

  function retryXray() {
    xrayFetchedFor.current = null
    setXrayAttempt((attempt) => attempt + 1)
  }

  async function onAtsCheck() {
    if (detail?.capabilities?.atsCheck === false) return
    setAtsBusy(true)
    setAtsHint(null)
    try {
      const res = await fetch(`/api/jobs/${params.id}/ats-check`, { method: 'POST' })
      if (res.status === 409) {
        const { reason } = await res.json().catch(() => ({ reason: '' }))
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
        await refetchDetail()
      }
    } finally {
      setAtsBusy(false)
    }
  }

  function onPracticeClick() {
    // The inference door (§4c): launching practice on an APPLIED job asks
    // one tap — and NEVER delays the session; both answers proceed.
    if (detail && !detail.gated && detail.application?.status === 'applied' && inference === 'idle') {
      setInference('asking')
      return
    }
    onPractice()
  }

  function answerInference(scheduled: boolean) {
    setInference('idle')
    if (scheduled) {
      // The status route is the single jobs.interview_scheduled emitter —
      // it fires on the edge with this flag (Codex on #525).
      fetch(`/api/jobs/${params.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'interview_scheduled', inferredFromPrep: true }),
        keepalive: true,
      }).catch(() => {})
      // Date capture waits for the feedback page (§4c) — the session comes first.
    }
    onPractice()
  }

  async function captureDate(choice: string) {
    await fetch(`/api/jobs/${params.id}/interview-date`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ choice }),
    }).catch(() => {})
    refetchDetail()
  }

  async function requestPracticeEmail() {
    if (detail?.capabilities?.practice === false) {
      setPracticeEmail('unavailable')
      return
    }
    // Honest states (EMAILS.md §3): the server declines visibly when the
    // stream is off or the user unsubscribed — never a silent accept.
    try {
      const r = await fetch(`/api/jobs/${params.id}/practice-link-email`, { method: 'POST' })
      const d = r.ok ? await r.json() : null
      if (d?.ok) setPracticeEmail('sent')
      else if (d?.reason === 'email-off') setPracticeEmail('email-off')
      else setPracticeEmail('unavailable')
    } catch {
      setPracticeEmail('unavailable')
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
    if (!detail.practiceRole || !detail.practiceHandoffToken) return
    autoPracticeAttemptedFor.current = params.id
    onPractice()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, params.id])

  async function onPractice() {
    if (!detail || detail.gated || practiceStartInFlight.current) return
    practiceStartInFlight.current = true
    setPracticeStart('loading')
    try {
      // Refresh at click time so a long-open tab never hands the lobby an
      // expired intent. The signed token binds user + job + exact JD hash;
      // the session API resolves all three back to server state.
      const response = await fetch(`/api/jobs/${params.id}`, { cache: 'no-store' })
      if (!response.ok) {
        setDetail(null)
        setStatus(response.status === 404 ? 'missing' : 'unavailable')
        throw new Error('handoff unavailable')
      }
      let fresh: Detail
      try {
        fresh = (await response.json()) as Detail
      } catch {
        setDetail(null)
        setStatus('unavailable')
        throw new Error('handoff unavailable')
      }
      // Reconcile the fresh authorization projection before checking
      // readiness. A restricted/gated response must replace stale live JD,
      // X-ray, Apply, and Tailor UI even though Practice itself cannot start.
      setDetail(fresh)
      setStatus('ready')
      if (
        fresh.gated ||
        !fresh.jd ||
        !fresh.practiceRole ||
        !fresh.practiceHandoffToken
      ) throw new Error('handoff unavailable')
      const config = {
        role: fresh.practiceRole,
        experience: '3-6' as const,
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
      setPracticeStart('error')
    } finally {
      practiceStartInFlight.current = false
    }
  }

  async function onSave() {
    const res = await fetch(`/api/jobs/${params.id}/save`, { method: 'POST' })
    if (res.status === 401) { setGate('save_job'); return }
    if (res.ok) {
      setSaved(true)
      // Materialize the fresh application row so Save-gated surfaces (the
      // ATS button, the evidence ticker) unlock without a manual refresh
      // (Codex on #521).
      await refetchDetail()
    }
  }

  function onApply(opt: ApplyOption, invoker: HTMLElement) {
    sheetInvokerRef.current = invoker
    // SYNC open inside the click handler — never after an await.
    window.open(opt.url, '_blank', 'noopener')
    // Arm the return-sheet (§4b): fires on visibilitychange→visible, ≥20s
    // after the click, within 45 minutes. localStorage — survives the
    // external-tab excursion.
    try {
      localStorage.setItem(`JOBS_RETURN_${params.id}`, JSON.stringify({ clickedAt: Date.now(), url: opt.url, tier: opt.tier }))
    } catch { /* private mode — no sheet, the next-visit confirm card (4.2) catches it */ }
    // Machine fact (apply_clicked) + server-side telemetry in one call —
    // the JobApplication row transitions/creates even if this tab dies
    // (keepalive). Never conflated with the user claim 'applied' (Wave 4).
    fetch(`/api/jobs/${params.id}/apply-click`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: opt.tier, url: opt.url }),
      keepalive: true,
    }).catch(() => {})
  }

  // Return-to-tab sheet (§4b): ≥20s away = the real ask; <20s = lead with
  // "did the link work?". One-shot — the arm record clears when shown.
  useEffect(() => {
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
    async function onVisible() {
      if (document.visibilityState !== 'visible') return
      if (validating) return
      validating = true
      try {
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
        // The posting may have closed while the employer tab was active.
        // Re-authorize lifecycle before asking any apply-return question.
        const response = await fetch(`/api/jobs/${params.id}`, { cache: 'no-store' })
        if (cancelled) return
        if (!response.ok) {
          clearJobSpecificProjection()
          setDetail(null)
          setStatus('unavailable')
          return
        }
        const fresh = await response.json() as Detail
        if (cancelled) return
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
        let rec: { clickedAt: number; url: string; tier: string } | null = null
        try {
          const raw = localStorage.getItem(`JOBS_RETURN_${params.id}`)
          if (raw) rec = JSON.parse(raw)
        } catch { /* noop */ }
        if (!rec) return
        const elapsed = Date.now() - rec.clickedAt
        if (elapsed > 45 * 60_000) {
          clearArm()
          return
        }
        clearArm()
        setSheet({ kind: elapsed >= 20_000 ? 'normal' : 'quick', clicked: { url: rec.url, tier: rec.tier }, elapsedMs: elapsed })
      } catch {
        if (!cancelled) {
          try { localStorage.removeItem(`JOBS_RETURN_${params.id}`) } catch { /* noop */ }
          closeReturnSheet()
          setSheetDone(null)
          setInference('idle')
          setXray(null)
          setXrayState('idle')
          setDetail(null)
          setStatus('unavailable')
        }
      } finally {
        validating = false
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [closeReturnSheet, detailIsGated, detailPostingState, params.id])

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

  async function sheetApplied() {
    const clicked = sheet?.clicked
    const elapsedMs = sheet?.elapsedMs
    closeReturnSheet()
    const post = () =>
      fetch(`/api/jobs/${params.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'applied', latencyMs: elapsedMs }),
      }).catch(() => null)
    let res = await post()
    // 404 = the apply-click keepalive row hasn't landed (in flight or lost) —
    // recreate the machine fact, then retry the claim. The user's 'Yes,
    // applied' must never be silently dropped (Codex on #522 round-3).
    if (res && res.status === 404 && clicked) {
      await fetch(`/api/jobs/${params.id}/apply-click`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier: clicked.tier, url: clicked.url }),
      }).catch(() => {})
      res = await post()
    }
    if (res?.ok) {
      setSheetDone('Marked as applied ✓ — it’s on your tracker.')
      refetchDetail()
    } else {
      setSheetDone('Couldn’t record that just now — open your tracker to update the status when you’re ready.')
    }
  }

  async function sheetBrokenLink() {
    const clicked = sheet?.clicked
    closeReturnSheet()
    if (!clicked) return
    const alternates = (detail?.applyOptions ?? []).filter((o) => o.url !== clicked.url)
    const post = () =>
      fetch(`/api/jobs/${params.id}/broken-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: clicked.url, tier: clicked.tier, hadFailover: alternates.length > 0 }),
      }).catch(() => null)
    // The apply-click keepalive creates the application row this report
    // attaches to — if it's still in flight the first POST 404s; one retry
    // covers that. A report that never lands must NOT claim global healing
    // (Codex on #522).
    let res = await post()
    if (res && res.status === 404) {
      await new Promise((r) => setTimeout(r, 1500))
      res = await post()
    }
    const alt = alternates.length > 0 ? `Try “${alternates[0].viaSite ?? alternates[0].tier}” below instead.` : ''
    if (res?.ok) {
      setSheetDone(alternates.length > 0
        ? `Thanks — that link is demoted for everyone. ${alt}`
        : 'Thanks — noted. This posting’s links may have gone stale; it stays saved on your tracker.')
      refetchDetail() // ladder re-sorts with the reported rung demoted
    } else {
      // Honest fallback: the report didn't record — still locally useful.
      setSheetDone(alt || 'That link may be stale — use “View full posting” above to reach the source directly.')
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
      <main className="mx-auto max-w-3xl px-4 py-16">
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
  if (status === 'unavailable') {
    return (
      <main ref={unavailableRef} tabIndex={-1} className="mx-auto max-w-3xl px-4 py-16">
        <p className="font-medium">We couldn&apos;t confirm this posting is still available.</p>
        <p className="mt-1 text-sm text-slate-500">Refresh before applying or opening the employer link.</p>
        {retakeParentId && (
          <Link href={genericSetupHref} onClick={rememberGenericRetake} className="mt-3 block text-sm font-medium text-blue-600 hover:underline">
            Start a new general practice
          </Link>
        )}
        <Link href="/jobs" className="mt-3 inline-block text-sm text-blue-600 hover:underline">← Back to jobs</Link>
      </main>
    )
  }
  if (!detail) return <main className="mx-auto max-w-3xl px-4 py-16 text-sm text-slate-500">Loading…</main>

  const postingState = detail.gated ? 'live' : (detail.postingState ?? 'live')
  const isLive = postingState === 'live'
  const primary = isLive && detail.capabilities?.apply !== false
    ? detail.applyOptions?.[0]
    : undefined
  const alternates = isLive ? (detail.applyOptions ?? []).slice(1) : []
  const practiceReady = detail.capabilities?.practice !== false && !!detail.practiceRole && !!detail.practiceHandoffToken
  const canTailor = !detail.gated && (detail.capabilities?.tailor ?? isLive)
  const hasRestrictedPrepContext = postingState === 'restricted' || postingState === 'snapshot-only'

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href={isLive ? '/jobs' : '/jobs/tracker'} className="text-sm text-slate-500 hover:underline">
          {isLive ? '← All jobs' : '← Job tracker'}
        </Link>
        {!isLive && (
          <Link href="/jobs" className="text-sm text-blue-600 hover:underline">Find similar live jobs</Link>
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

      {retakeParentId && !practiceReady && detail.application?.status !== 'interview_scheduled' && (
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
          <div className="mt-6 flex flex-wrap items-center gap-3">
            {primary && (
              <div>
                <button
                  onClick={(event) => onApply(primary, event.currentTarget)}
                  className="rounded-lg bg-blue-600 px-5 py-2.5 font-medium text-white hover:bg-blue-700"
                >
                  Apply ↗
                </button>
                <p className="mt-1 text-xs text-slate-500">
                  {(TIER_SUBTITLE[primary.tier] ?? (() => ''))(detail.company, primary.viaSite)}
                </p>
              </div>
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
                disabled={saved}
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-60"
              >
                {saved ? 'Saved ✓' : 'Save'}
              </button>
            )}
            {primary && detail.capabilities?.viewSource !== false && (
              <a
                href={primary.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-slate-500 hover:underline"
              >
                View full posting ↗
              </a>
            )}
          </div>
          {practiceStart === 'error' && (
            <p role="alert" className="mt-2 text-sm text-red-600">
              We couldn&apos;t prepare this job practice. Refresh the posting and try again.
            </p>
          )}
          {isLive && alternates.length > 0 && (
            <p className="mt-2 text-xs text-slate-500">
              Also available: {alternates.map((o, i) => (
                <button key={i} onClick={(event) => onApply(o, event.currentTarget)} className="underline decoration-dotted hover:text-slate-600">
                  {o.viaSite ?? o.tier}{i < alternates.length - 1 ? ', ' : ''}
                </button>
              ))}
            </p>
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
              <p className="font-medium">
                {detail.application.interviewDate
                  ? 'Interview status and date saved.'
                  : 'Interview status saved.'}
              </p>
              {/* Date capture belongs to the tracked application, not the
                  exact-JD Practice capability. Keep it usable when the role
                  is unsupported, CMS is unavailable, or context is restricted. */}
              {!detail.application.interviewDate && (
                <div className="mt-2">
                  <p className="text-xs text-slate-600">
                    {detail.application.interviewDateConfidence === 'unknown' ? 'Know the date now?' : 'When is it?'}
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {[
                      ['tomorrow', 'Tomorrow'],
                      ['this-week', 'This week'],
                      ['next-week', 'Next week'],
                      ...(detail.application.interviewDateConfidence === 'unknown' ? [] : [['not-sure', 'Not sure yet']]),
                    ].map(([c, l]) => (
                      <button key={c} onClick={() => captureDate(c)} className="rounded-full border border-slate-200 px-2.5 py-1 text-xs hover:bg-white">{l}</button>
                    ))}
                  </div>
                </div>
              )}
              <p className="mt-1 text-xs text-slate-600">
                {hasRestrictedPrepContext
                  ? 'Exact-job preparation is unavailable because the original posting context can no longer be used.'
                  : 'Job-specific preparation is currently unavailable, but you can still prepare in the general interview setup.'}
              </p>
              <Link href={genericSetupHref} onClick={rememberGenericRetake} className="mt-2 inline-block text-xs font-medium text-blue-600 hover:underline">
                Open general interview setup
              </Link>
            </div>
          ) : detail.application?.status === 'interview_scheduled' ? (
            /* §4c hero swap: the chip yields to the PREP PLAN panel. */
            <div className="mt-5 rounded-lg border border-blue-300 bg-blue-50 p-4 text-sm">
              <p className="font-medium">🎙 You got the interview. Let&apos;s make sure you&apos;re ready.</p>
              {/* Capture stays reachable until a real date exists — 'Not sure
                  yet' must not hide the buttons forever (Codex on #525). */}
              {!detail.application.interviewDate && (
                <div className="mt-2">
                  <p className="text-xs text-slate-600">
                    {detail.application.interviewDateConfidence === 'unknown' ? 'Know the date now?' : 'When is it?'}
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {[['tomorrow', 'Tomorrow'], ['this-week', 'This week'], ['next-week', 'Next week'], ...(detail.application.interviewDateConfidence === 'unknown' ? [] : [['not-sure', 'Not sure yet']])].map(([c, l]) => (
                      <button key={c} onClick={() => captureDate(c)} className="rounded-full border border-slate-200 px-2.5 py-1 text-xs hover:bg-white">{l}</button>
                    ))}
                  </div>
                </div>
              )}
              {(detail.application.interviewDate || detail.application.interviewDateConfidence === 'unknown') && (
                (() => {
                  const plan = buildPrepPlan(detail.application.interviewDate ? new Date(detail.application.interviewDate) : null)
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
                })()
              )}
              <p className="mt-2 text-xs text-slate-600">
                Evidence toward readiness on this job: {detail.application.practiceCount}/3 sessions
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
                  📩 Email me tonight&apos;s practice link
                </button>
              )}
              {practiceEmail === 'sent' && (
                <p className="mt-2 text-xs text-emerald-700">Sent — check your inbox this evening.</p>
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
                {isLive ? 'Apply now — prep while you wait.' : 'Your preparation history stays with this tracked job.'}
              </span>
              <span className="ml-2 text-xs text-slate-600">
                Evidence toward readiness on this job: {detail.application?.practiceCount ?? 0}/3 sessions
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
            <p className="mt-0.5 text-xs text-slate-500">What this JD says the interview will probe.</p>
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
                <button onClick={sheetApplied} className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700">
                  ✓ Yes, applied
                </button>
              )}
              <button
                onClick={() => {
                  closeReturnSheet()
                  setSheetDone(canTailor
                    ? 'No rush — want an edge first? Tailor your resume for this job (~15s).'
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
            <p>{sheetDone}{canTailor && sheetDone.includes('Tailor') && <> <Link href={`/resume/tailor?jobId=${detail.id}`} className="text-blue-600 underline">Open tailor</Link></>}</p>
            <button onClick={() => { setSheetDone(null); restoreReturnSheetFocus() }} aria-label="Dismiss" className="ml-3 text-slate-500 hover:text-slate-600">✕</button>
          </div>
        </div>
      )}

      <AuthGateModal reason={gate} onClose={() => setGate(null)} />
    </main>
  )
}
