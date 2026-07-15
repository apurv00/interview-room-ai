'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { STORAGE_KEYS } from '@shared/storageKeys'
// Deep import (app/** is barrel-exempt): domains.ts is pure constants —
// the @jobs barrel would drag mongoose into this client chunk.
import { interviewSlugForDomain } from '@jobs/config/domains'
import { buildPrepPlan } from '@jobs/config/prepPlan'
import AuthGateModal from '@shared/ui/AuthGateModal'

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
interface Xray { role: string; inferredDomain?: string; keyThemes: string[]; requirements: XrayReq[] }
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

export default function JobDetailPage({ params }: { params: { id: string } }) {
  const router = useRouter()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing'>('loading')
  const [gate, setGate] = useState<null | 'view_job_detail' | 'save_job'>(null)
  const [saved, setSaved] = useState(false)
  const [xray, setXray] = useState<Xray | null>(null)
  const [xrayState, setXrayState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const [atsBusy, setAtsBusy] = useState(false)
  const [atsHint, setAtsHint] = useState<string | null>(null)
  const [sheet, setSheet] = useState<null | { kind: 'normal' | 'quick'; clicked: { url: string; tier: string }; elapsedMs: number }>(null)
  const [inference, setInference] = useState<'idle' | 'asking'>('idle')
  const [practiceEmail, setPracticeEmail] = useState<'idle' | 'sent' | 'email-off' | 'unavailable'>('idle')
  const [sheetDone, setSheetDone] = useState<string | null>(null)

  useEffect(() => {
    fetch(`/api/jobs/${params.id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { setDetail(d); setStatus('ready') })
      .catch(() => setStatus('missing'))
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
  const xrayFetchedFor = useRef<string | null>(null)
  const pendingPollFor = useRef<string | null>(null)

  // A check queued in another tab / before a refresh arrives as state
  // 'pending' with no local poll loop — poll until it settles or times out
  // (Codex on #521), once per posting.
  useEffect(() => {
    if (detail?.gated !== false || detail.application?.ats.state !== 'pending') return
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
  useEffect(() => {
    if (!detail || detail.gated) return
    if (xrayFetchedFor.current === params.id) return
    xrayFetchedFor.current = params.id
    setXrayState('loading')
    fetch(`/api/jobs/${params.id}/xray`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((x) => { setXray(x); setXrayState('ready') })
      .catch(() => setXrayState('failed'))
  }, [detail, params.id])

  async function refetchDetail() {
    try {
      const r = await fetch(`/api/jobs/${params.id}`)
      if (r.ok) setDetail(await r.json())
    } catch { /* keep the current view */ }
  }

  async function onAtsCheck() {
    setAtsBusy(true)
    setAtsHint(null)
    try {
      const res = await fetch(`/api/jobs/${params.id}/ats-check`, { method: 'POST' })
      if (res.status === 409) {
        const { reason } = await res.json().catch(() => ({ reason: '' }))
        setAtsHint(reason === 'no-resume' ? 'Attach a resume first — the check compares it to this JD.' : 'Save this job first to unlock the ATS check.')
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
  // and the role is resolvable — otherwise the page still shows Start
  // front and center; the link degrades to the detail page, never breaks.
  const autoPracticeFired = useRef(false)
  useEffect(() => {
    if (autoPracticeFired.current || !detail || detail.gated) return
    try {
      if (new URLSearchParams(window.location.search).get('practice') !== '1') return
    } catch {
      return
    }
    const role = interviewSlugForDomain(detail.domain) ?? xray?.inferredDomain
    if (!role) return // domain-less posting: leave the user on the Start button
    autoPracticeFired.current = true
    onPractice()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, xray])

  function onPractice() {
    if (!detail || detail.gated) return
    // Resolve through the domain metadata: jobs-only slugs (hr) map to
    // 'general', never raw into InterviewConfig.role (Codex on #524);
    // the X-ray's inferredDomain is already an interview slug.
    const role = interviewSlugForDomain(detail.domain) ?? xray?.inferredDomain
    if (!role) return
    // The hand-off (PRODUCT_FLOW §1 Stage 4; precedent learn/practice):
    // config to localStorage, then the lobby owns everything — auth gate,
    // post-OAuth resume, JD-skip. attribution rides the Wave-0 schema field
    // (round-trip tested); generate-question spends ~60% of questions on JD
    // must-haves for free. Zero hot-path edits.
    const config = {
      role,
      experience: '3-6',
      duration: 15,
      jobDescription: detail.jd,
      targetCompany: detail.company,
      attribution: { source: 'jobs', jobId: detail.id, applicationId: detail.application?.applicationId },
    }
    try {
      localStorage.setItem(STORAGE_KEYS.INTERVIEW_CONFIG, JSON.stringify(config))
    } catch { return }
    fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'jobs.prep_started',
        jobPostingId: params.id,
        props: { applicationId: detail.application?.applicationId, evidenceCount: detail.application?.practiceCount ?? 0 },
      }),
      keepalive: true,
    }).catch(() => {})
    router.push('/lobby')
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

  function onApply(opt: ApplyOption) {
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
    function onVisible() {
      if (document.visibilityState !== 'visible') return
      let rec: { clickedAt: number; url: string; tier: string } | null = null
      try {
        const raw = localStorage.getItem(`JOBS_RETURN_${params.id}`)
        if (raw) rec = JSON.parse(raw)
      } catch { /* noop */ }
      if (!rec) return
      const elapsed = Date.now() - rec.clickedAt
      if (elapsed > 45 * 60_000) {
        try { localStorage.removeItem(`JOBS_RETURN_${params.id}`) } catch { /* noop */ }
        return
      }
      try { localStorage.removeItem(`JOBS_RETURN_${params.id}`) } catch { /* noop */ }
      setSheet({ kind: elapsed >= 20_000 ? 'normal' : 'quick', clicked: { url: rec.url, tier: rec.tier }, elapsedMs: elapsed })
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [params.id])

  async function sheetApplied() {
    const clicked = sheet?.clicked
    const elapsedMs = sheet?.elapsedMs
    setSheet(null)
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
      setSheetDone('Couldn’t record that just now — your application is real either way; hit Save and mark it applied in a moment.')
    }
  }

  async function sheetBrokenLink() {
    const clicked = sheet?.clicked
    setSheet(null)
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

  if (status === 'missing') {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16">
        <p className="font-medium">This posting isn&apos;t available anymore.</p>
        <Link href="/jobs" className="mt-3 inline-block text-sm text-blue-600 hover:underline">← Back to jobs</Link>
      </main>
    )
  }
  if (!detail) return <main className="mx-auto max-w-3xl px-4 py-16 text-sm text-slate-500">Loading…</main>

  const primary = detail.applyOptions?.[0]
  const alternates = (detail.applyOptions ?? []).slice(1)

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <Link href="/jobs" className="text-sm text-slate-500 hover:underline">← All jobs</Link>
      <h1 className="mt-3 text-2xl font-semibold">{detail.title}</h1>
      <p className="mt-1 text-slate-500">
        {detail.company}
        {detail.locations[0] ? ` · ${detail.locations[0]}` : ''}
        {detail.isRemote ? ' · Remote' : ''}
        {detail.salaryText ? ` · ${detail.salaryText}` : ''}
      </p>

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
                  onClick={() => onApply(primary)}
                  className="rounded-lg bg-blue-600 px-5 py-2.5 font-medium text-white hover:bg-blue-700"
                >
                  Apply ↗
                </button>
                <p className="mt-1 text-xs text-slate-500">
                  {(TIER_SUBTITLE[primary.tier] ?? (() => ''))(detail.company, primary.viaSite)}
                </p>
              </div>
            )}
            {(interviewSlugForDomain(detail.domain) ?? xray?.inferredDomain) && (
              <button
                onClick={onPracticeClick}
                className="rounded-lg border border-blue-400 px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50"
              >
                🎙 Practice for this job · 15 min
              </button>
            )}
            <button
              onClick={onSave}
              disabled={saved}
              className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-60"
            >
              {saved ? 'Saved ✓' : 'Save'}
            </button>
            {primary && (
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
          {alternates.length > 0 && (
            <p className="mt-2 text-xs text-slate-500">
              Also available: {alternates.map((o, i) => (
                <button key={i} onClick={() => onApply(o)} className="underline decoration-dotted hover:text-slate-600">
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

          {detail.application?.status === 'interview_scheduled' ? (
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
                            {sess.dayOffset === 0 && (
                              <button onClick={onPracticeClick} className="rounded-lg bg-blue-600 px-2.5 py-1 text-xs font-medium text-white">Start</button>
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
              {practiceEmail === 'idle' && (
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
              <span className="font-medium">Apply now — prep while you wait.</span>
              <span className="ml-2 text-xs text-slate-600">
                Evidence toward readiness on this job: {detail.application?.practiceCount ?? 0}/3 sessions
              </span>
            </div>
          )}

          <section className="mt-6" aria-label="ATS check">
            {detail.application?.ats.state === 'done' ? (
              <div className="rounded-lg border border-slate-200 p-3 text-sm bg-white">
                <span className="font-medium">ATS match: {detail.application.ats.score}/100</span>
                {(detail.application.ats.missingKeywords?.length ?? 0) > 0 && (
                  <span className="ml-2 text-xs text-slate-500">
                    Missing: {detail.application.ats.missingKeywords!.join(', ')}
                  </span>
                )}
                {/* Resume edited since? The job compares BOTH hashes — an
                    unchanged pair returns the cached score instantly. */}
                <button onClick={onAtsCheck} className="ml-3 text-xs text-blue-600 hover:underline">Re-check</button>
              </div>
            ) : detail.application?.ats.state === 'pending' || atsBusy ? (
              <p className="text-sm text-slate-500">Checking your resume against this JD (~1 min)…</p>
            ) : detail.application ? (
              <button onClick={onAtsCheck} className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium hover:bg-slate-50">
                Check my resume against this JD
              </button>
            ) : (
              <p className="text-xs text-slate-500">Save this job to unlock the ATS check.</p>
            )}
            {atsHint && <p className="mt-1 text-xs text-amber-700">{atsHint}</p>}
          </section>

          <section className="mt-8" aria-label="Interview X-ray">
            <h2 className="text-lg font-medium">Interview X-ray</h2>
            <p className="mt-0.5 text-xs text-slate-500">What this JD says the interview will probe.</p>
            {xrayState === 'loading' && <p className="mt-3 text-sm text-slate-500">Reading the JD…</p>}
            {xrayState === 'failed' && <p className="mt-3 text-sm text-slate-500">X-ray unavailable for this posting.</p>}
            {xrayState === 'ready' && xray && (
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

          <section className="prose prose-sm mt-8 max-w-none whitespace-pre-wrap text-sm leading-relaxed">
            {detail.jd || 'The source didn’t provide a full description — use the posting link above.'}
          </section>
        </>
      )}

      {sheet && (
        <div className="fixed inset-x-0 bottom-0 z-40 mx-auto max-w-3xl p-4">
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-lg">
            <p className="font-medium">
              {sheet.kind === 'quick' ? 'That was quick — did the link work?' : `Did you apply to ${detail.company}?`}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {sheet.kind === 'normal' && (
                <button onClick={sheetApplied} className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700">
                  ✓ Yes, applied
                </button>
              )}
              <button
                onClick={() => { setSheet(null); setSheetDone('No rush — want an edge first? Tailor your resume for this job (~15s).') }}
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
          <div className="flex items-start justify-between rounded-xl border border-slate-200 bg-white p-3 text-sm shadow-lg">
            <p>{sheetDone}{sheetDone.includes('Tailor') && <> <Link href="/resume/tailor" className="text-blue-600 underline">Open tailor</Link></>}</p>
            <button onClick={() => setSheetDone(null)} aria-label="Dismiss" className="ml-3 text-slate-500 hover:text-slate-600">✕</button>
          </div>
        </div>
      )}

      <AuthGateModal reason={gate} onClose={() => setGate(null)} />
    </main>
  )
}
