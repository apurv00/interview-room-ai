'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

/**
 * /jobs/start — the attach chooser + confirm bar (PRODUCT_FLOW §1 Stage 1,
 * §4a). Doors: paste text / upload .txt / 3 questions (resume-less majority).
 * Anon resume structure lives in sessionStorage ONLY — it dies with the tab;
 * a stranger's PII never persists server-side (the parse API is stateless).
 * All doors converge on the confirm bar: extracted facts read-only + the
 * EDITABLE "Role you're targeting" (resume = past, target = future).
 * The 3-questions path is marked method:'questions' so the feed never makes
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
  city: string
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

export default function JobsStartPage() {
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement>(null)
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
  const [city, setCity] = useState('')
  // The full parse result + original text — held for the authed base-resume
  // auto-save (preserveFullText). Stays in memory/sessionStorage only.
  const [parsedResume, setParsedResume] = useState<ParsedResume | null>(null)
  const [rawText, setRawText] = useState('')
  const [importDoor, setImportDoor] = useState<{ id: string; name: string; targetRole: string; skills: string[] } | null>(null)

  // Authed import door — 401 = anon, hide silently.
  useEffect(() => {
    fetch('/api/jobs/base-resume')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.base) setImportDoor(d.base) })
      .catch(() => {})
  }, [])

  async function parseAndConfirm(text: string, m: JobsTarget['method']) {
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
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? 'Could not read that resume — try pasting the text instead.')
        return
      }
      const { resume } = (await res.json()) as { resume: ParsedResume }
      setParsedResume(resume)
      setRawText(text)
      setDetectedName(resume.contact?.name ?? '')
      setSkills(flatSkills(resume))
      const detected = resume.experience?.[0]?.title ?? ''
      setDetectedRole(detected)
      setRole(detected)
      setDoor('confirm')
    } catch {
      setError('Something went wrong reading the resume. Paste the text instead?')
    } finally {
      setBusy(false)
    }
  }

  function onFile(f: File | undefined) {
    if (!f) return
    if (!f.name.endsWith('.txt') && f.type !== 'text/plain') {
      setError('For now, upload a .txt export — or paste the resume text (fastest).')
      return
    }
    const reader = new FileReader()
    reader.onload = () => parseAndConfirm(String(reader.result ?? ''), 'upload')
    reader.readAsText(f)
  }

  async function confirmTarget() {
    const target: JobsTarget = { method, role: role.trim(), city: city.trim(), skills }
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
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (d && d.saved === false && d.reason === 'cap') {
            try { sessionStorage.setItem('JOBS_CAP_NOTICE', '1') } catch { /* noop */ }
          }
        })
        .catch(() => {})
      await Promise.race([save, new Promise((r) => setTimeout(r, 1200))])
    }
    router.push('/jobs')
  }

  function importBase() {
    if (!importDoor) return
    setMethod('import')
    setSkills(importDoor.skills)
    setDetectedRole(importDoor.targetRole)
    setRole(importDoor.targetRole)
    track('jobs.resume_attach_started', { method: 'import' })
    setDoor('confirm')
  }

  return (
    <main className="mx-auto max-w-xl px-4 py-10">
      <Link href="/jobs" className="text-sm text-slate-500 hover:underline">← Jobs</Link>
      <h1 className="mt-3 text-2xl font-semibold">Sort the feed for you</h1>

      {door === 'chooser' && (
        <div className="mt-6 space-y-3">
          {importDoor && (
            <button onClick={importBase} className="block w-full rounded-xl border border-blue-300 p-4 text-left hover:border-blue-500 bg-white">
              <span className="font-medium">Use my saved resume</span>
              <span className="mt-0.5 block text-sm text-slate-500">{importDoor.name}</span>
            </button>
          )}
          <button onClick={() => setDoor('paste')} className="block w-full rounded-xl border p-4 text-left hover:border-blue-400 bg-white">
            <span className="font-medium">Paste your resume text</span>
            <span className="mt-0.5 block text-sm text-slate-500">Fastest — copy everything, paste here.</span>
          </button>
          <button onClick={() => fileRef.current?.click()} className="block w-full rounded-xl border p-4 text-left hover:border-blue-400 bg-white">
            <span className="font-medium">Upload a .txt file</span>
            <span className="mt-0.5 block text-sm text-slate-500">Plain-text export of your resume.</span>
          </button>
          <input ref={fileRef} type="file" accept=".txt,text/plain" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
          <Link href="/resume/builder?return=/jobs/start" className="block w-full rounded-xl border p-4 text-left hover:border-blue-400 bg-white">
            <span className="font-medium">No resume yet? Build one</span>
            <span className="mt-0.5 block text-sm text-slate-500">You&apos;ll need one on Naukri anyway — 10 minutes in the builder.</span>
          </Link>
          <button onClick={() => { setMethod('questions'); setDoor('questions') }} className="block w-full rounded-xl border p-4 text-left hover:border-blue-400 bg-white">
            <span className="font-medium">Just ask me 3 questions</span>
            <span className="mt-0.5 block text-sm text-slate-500">Role, city, done.</span>
          </button>
        </div>
      )}

      {door === 'paste' && (
        <div className="mt-6">
          <textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            rows={12}
            placeholder="Paste your full resume text here…"
            className="w-full rounded-xl border border-slate-200 p-3 text-sm bg-white text-slate-900 placeholder-slate-400"
          />
          <div className="mt-3 flex gap-3">
            <button
              disabled={busy || pasteText.trim().length < 50}
              onClick={() => parseAndConfirm(pasteText, 'paste')}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? 'Reading your resume…' : 'Continue'}
            </button>
            <button onClick={() => setDoor('chooser')} className="rounded-lg border border-slate-200 px-4 py-2 text-sm bg-white text-slate-900 placeholder-slate-400">Back</button>
          </div>
        </div>
      )}

      {door === 'questions' && (
        <div className="mt-6 space-y-4">
          <label className="block">
            <span className="text-sm font-medium">What role are you looking for?</span>
            <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="e.g. Backend Engineer, Sales Executive" className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm bg-white text-slate-900 placeholder-slate-400" />
          </label>
          <label className="block">
            <span className="text-sm font-medium">Which city? (anywhere works — remote is always included)</span>
            <input value={city} onChange={(e) => setCity(e.target.value)} placeholder="e.g. Pune" className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm bg-white text-slate-900 placeholder-slate-400" />
          </label>
          <div className="flex gap-3">
            <button disabled={!role.trim()} onClick={confirmTarget} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
              Show my jobs
            </button>
            <button onClick={() => setDoor('chooser')} className="rounded-lg border border-slate-200 px-4 py-2 text-sm bg-white text-slate-900 placeholder-slate-400">Back</button>
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
          <label className="mt-3 block">
            <span className="text-sm font-medium">City</span>
            <input value={city} onChange={(e) => setCity(e.target.value)} placeholder="Any location — remote always included" className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm bg-white text-slate-900 placeholder-slate-400" />
          </label>
          <button onClick={confirmTarget} className="mt-5 rounded-lg bg-blue-600 px-5 py-2.5 font-medium text-white hover:bg-blue-700">
            Show my jobs →
          </button>
        </div>
      )}

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
    </main>
  )
}
