'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { clearAllInterviewStorage } from '@shared/storageKeys'
import { JOB_TARGET_QUESTION_SUMMARY } from '@jobs/config/truthfulLabels'

/**
 * /jobs/start — the attach chooser + confirm bar (PRODUCT_FLOW §1 Stage 1,
 * §4a). Doors (founder directive 2026-07-16): saved resume / upload PDF /
 * build one / target-role question. PASTE IS NOT A PRIMARY DOOR — it is the
 * inline fallback shown only when the PDF parse fails ("if PDF upload fails
 * then paste the resume text, nothing else"). PDFs go through the stateless
 * /api/jobs/parse-pdf (text extraction only — an anon stranger's resume
 * never persists server-side; sessionStorage dies with the tab).
 * All doors converge on the confirm bar: extracted facts read-only + the
 * EDITABLE "Role you're targeting" (resume = past, target = future).
 * The question path is marked method:'questions' so the feed never makes
 * resume-flavored claims for it.
 */

interface SkillGroup { category?: string; items?: string[] }
interface ParsedResume {
  contact?: { name?: string }
  experience?: Array<{ title?: string }>
  skills?: SkillGroup[]
}

export interface JobsTarget {
  method: 'paste' | 'upload' | 'questions' | 'import'
  role: string
  skills: string[]
}

function flatSkills(resume: ParsedResume): string[] {
  const out: string[] = []
  for (const g of resume.skills ?? []) for (const s of g.items ?? []) if (s?.trim()) out.push(s.trim())
  return Array.from(new Set(out)).slice(0, 20)
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
  const fileRef = useRef<HTMLInputElement>(null)
  const mountedRef = useRef(true)
  const terminalRef = useRef(false)
  const requestGenerationRef = useRef(0)
  const [door, setDoor] = useState<'chooser' | 'paste' | 'questions' | 'confirm'>('chooser')
  const [method, setMethod] = useState<JobsTarget['method']>('paste')
  const [pasteText, setPasteText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // confirm-bar state
  const [detectedName, setDetectedName] = useState('')
  const [skills, setSkills] = useState<string[]>([])
  const [role, setRole] = useState('')
  const [detectedRole, setDetectedRole] = useState('')
  // The full parse result + original text — held for the authed base-resume
  // auto-save (preserveFullText). Stays in memory/sessionStorage only.
  const [parsedResume, setParsedResume] = useState<ParsedResume | null>(null)
  const [rawText, setRawText] = useState('')
  const [importDoor, setImportDoor] = useState<{ id: string; name: string; targetRole: string; latestRole?: string; skills: string[] } | null>(null)
  const [accountUnavailable, setAccountUnavailable] = useState(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      requestGenerationRef.current += 1
    }
  }, [])

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
    setError(null)
    setDetectedName('')
    setSkills([])
    setRole('')
    setDetectedRole('')
    setParsedResume(null)
    setRawText('')
    setImportDoor(null)
    setAccountUnavailable(true)
  }, [])

  // Authed import door — 401 = anon, hide silently.
  useEffect(() => {
    let cancelled = false
    fetch('/api/jobs/base-resume')
      .then(async (response) => {
        if (await isAccountUnavailableResponse(response)) {
          scrubAccountBoundState()
          return null
        }
        return response.ok ? response.json() : null
      })
      .then((data) => {
        if (!cancelled && !terminalRef.current && data?.base) setImportDoor(data.base)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [scrubAccountBoundState])

  /** Returns false on failure so the UPLOAD path can drop the user on the
   *  paste fallback — with paste gone as a primary door, leaving them on
   *  the chooser with a "paste instead" error is a dead end (Codex #540). */
  async function parseAndConfirm(text: string, m: JobsTarget['method']): Promise<boolean> {
    if (terminalRef.current) return false
    const generation = requestGenerationRef.current
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
      const { resume } = (await res.json()) as { resume: ParsedResume }
      if (terminalRef.current || generation !== requestGenerationRef.current) return false
      setParsedResume(resume)
      setRawText(text)
      setDetectedName(resume.contact?.name ?? '')
      setSkills(flatSkills(resume))
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
    const generation = requestGenerationRef.current
    if (f.type !== 'application/pdf' && !/\.pdf$/i.test(f.name)) {
      setError('Upload a PDF — or paste your resume text below.')
      setDoor('paste')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const fd = new FormData()
      fd.append('file', f)
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
      const ok = await parseAndConfirm(data.text, 'upload')
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
    if (terminalRef.current) return
    const generation = requestGenerationRef.current
    // City is deliberately NOT part of the target (founder directive
    // 2026-07-16): typed cities hard-collapsed the pool via alias-mismatched
    // location keys ('Bangalore' matched zero rows keyed 'bengaluru').
    const target: JobsTarget = { method, role: role.trim(), skills }
    try {
      sessionStorage.setItem('JOBS_TARGET', JSON.stringify(target))
    } catch { /* private mode — the feed just stays Tier-A */ }
    track('jobs.resume_attach_completed', { method, skillCount: skills.length })
    track('jobs.target_role_confirmed', { edited: role.trim() !== detectedRole.trim() })
    // Authed auto-save as "Base Resume — {role}" (Stage 2). Deliberately NOT
    // keepalive: resume payloads routinely exceed the 64KiB keepalive body
    // cap and would reject silently (Codex on #520) — and an SPA router.push
    // doesn't abort in-flight fetches, so keepalive buys nothing here. The
    // reveal waits at most 1.2s so the CAP flag (a fast DB check) lands
    // before the feed's one mount-read; a slower save still completes in
    // flight and flags a later visit. 401 (anon) skips silently; the cap is
    // a notice, never a block — extraction already fed ranking.
    if ((method === 'paste' || method === 'upload') && parsedResume) {
      const save = fetch('/api/jobs/base-resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resume: parsedResume, targetRole: role.trim(), fullText: rawText }),
      }).then(async (response) => {
        if (await isAccountUnavailableResponse(response)) {
          scrubAccountBoundState()
          return 'account-unavailable' as const
        }
        if (!response.ok) return 'ignored' as const
        const d = await response.json()
        if (terminalRef.current || generation !== requestGenerationRef.current) return 'ignored' as const
        if (d && d.saved === false && d.reason === 'cap') {
          try { sessionStorage.setItem('JOBS_CAP_NOTICE', '1') } catch { /* noop */ }
        }
        return 'saved' as const
      })
        .catch(() => 'ignored' as const)
      const outcome = await Promise.race([
        save,
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1200)),
      ])
      if (outcome === 'account-unavailable' || terminalRef.current || generation !== requestGenerationRef.current) return
    }
    if (terminalRef.current || generation !== requestGenerationRef.current) return
    router.push('/jobs')
  }

  function importBase() {
    if (!importDoor || busy || terminalRef.current) return
    setMethod('import')
    setSkills(importDoor.skills)
    // Saved TARGET (future intent) wins when present; else prefill from the
    // resume's latest experience title — editable, same as the upload path
    // (founder 2026-07-19: the saved-resume door left the role box empty).
    // trim(): a whitespace-only saved target must not beat the experience
    // title on truthiness (Codex #557 — the save path preserves targets
    // as typed).
    const prefill = importDoor.targetRole?.trim() || importDoor.latestRole || ''
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
      <h1 className="mt-3 text-2xl font-semibold">Sort the feed for you</h1>

      {door === 'chooser' && (
        <div className="mt-6 space-y-3">
          {importDoor && (
            <button disabled={busy} onClick={importBase} className="block w-full rounded-2xl border border-blue-300 p-4 text-left shadow-sm hover:border-blue-500 bg-white disabled:opacity-60">
              <span className="font-medium">Use my saved resume</span>
              <span className="mt-0.5 block text-sm text-slate-500">{importDoor.name}</span>
            </button>
          )}
          <button disabled={busy} onClick={() => fileRef.current?.click()} className="block w-full rounded-2xl border border-slate-200 p-4 text-left shadow-sm hover:border-blue-400 bg-white disabled:opacity-60">
            <span className="font-medium">{busy ? 'Reading your PDF…' : 'Upload your resume (PDF)'}</span>
            <span className="mt-0.5 block text-sm text-slate-500">The one you already send to recruiters.</span>
          </button>
          <input ref={fileRef} type="file" accept=".pdf,application/pdf" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
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

      {door === 'paste' && (
        <div className="mt-6">
          {/* Paste is the PDF-failure fallback, never a primary door
              (founder directive 2026-07-16). The error above says why
              the user landed here. */}
          {error && <p className="mb-3 text-sm text-amber-700">{error}</p>}
          <textarea
            aria-label="Resume text"
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            rows={12}
            placeholder="Paste your full resume text here…"
            className="w-full rounded-2xl border border-slate-200 p-3 text-sm shadow-sm bg-white text-slate-900 placeholder-slate-400"
          />
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
            <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="e.g. Backend Engineer, Sales Executive" className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm bg-white text-slate-900 placeholder-slate-400" />
          </label>
          <div className="flex gap-3">
            <button disabled={!role.trim()} onClick={confirmTarget} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
              Show my jobs
            </button>
            <button onClick={() => setDoor('chooser')} className="rounded-lg border border-slate-200 px-4 py-2 text-sm bg-white text-slate-900 hover:bg-slate-50">Back</button>
          </div>
        </div>
      )}

      {door === 'confirm' && (
        <div className="mt-6">
          <p className="text-sm text-slate-500">
            Got it{detectedName ? `, ${detectedName.split(' ')[0]}` : ''}. Here&apos;s what we read — confirm your target and we&apos;ll sort the feed.
          </p>
          {skills.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {skills.slice(0, 10).map((s) => (
                <span key={s} className="rounded-full border border-slate-200 px-2 py-0.5 text-xs text-slate-500 bg-white">{s}</span>
              ))}
              {skills.length > 10 && <span className="text-xs text-slate-400">+{skills.length - 10} more</span>}
            </div>
          )}
          <label className="mt-5 block">
            <span className="text-sm font-medium">Role you&apos;re targeting</span>
            <span className="ml-2 text-xs text-slate-500">(your resume is your past — this is where you&apos;re headed)</span>
            <input value={role} onChange={(e) => setRole(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm bg-white text-slate-900 placeholder-slate-400" />
          </label>
          <button onClick={confirmTarget} className="mt-5 rounded-lg bg-blue-600 px-5 py-2.5 font-medium text-white hover:bg-blue-700">
            Show my jobs →
          </button>
        </div>
      )}

      {/* The paste door renders the error inline as its lead-in. */}
      {error && door !== 'paste' && <p className="mt-4 text-sm text-red-600">{error}</p>}
    </main>
  )
}
