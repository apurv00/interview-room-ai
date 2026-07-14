'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
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
}

const TIER_SUBTITLE: Record<string, (co: string, via?: string) => string> = {
  'direct-ats': (co) => `Opens ${co}'s application form`,
  employer: (co) => `Opens ${co}'s careers site`,
  'aggregator-deep': (_co, via) => `Opens on ${via ?? 'a job board'} — you may need a free account`,
  'platform-funnel': (_co, via) => `Opens on ${via ?? 'the source platform'}`,
  'aggregator-redirect': (_co, via) => `Via ${via ?? 'the source'} — this link redirects`,
}

export default function JobDetailPage({ params }: { params: { id: string } }) {
  const [detail, setDetail] = useState<Detail | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing'>('loading')
  const [gate, setGate] = useState<null | 'view_job_detail' | 'save_job'>(null)
  const [saved, setSaved] = useState(false)

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

  async function onSave() {
    const res = await fetch(`/api/jobs/${params.id}/save`, { method: 'POST' })
    if (res.status === 401) { setGate('save_job'); return }
    if (res.ok) setSaved(true)
  }

  function onApply(opt: ApplyOption) {
    // SYNC open inside the click handler — never after an await.
    window.open(opt.url, '_blank', 'noopener')
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

  if (status === 'missing') {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16">
        <p className="font-medium">This posting isn&apos;t available anymore.</p>
        <Link href="/jobs" className="mt-3 inline-block text-sm text-blue-600 hover:underline">← Back to jobs</Link>
      </main>
    )
  }
  if (!detail) return <main className="mx-auto max-w-3xl px-4 py-16 text-sm text-gray-500">Loading…</main>

  const primary = detail.applyOptions?.[0]
  const alternates = (detail.applyOptions ?? []).slice(1)

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <Link href="/jobs" className="text-sm text-gray-500 hover:underline">← All jobs</Link>
      <h1 className="mt-3 text-2xl font-semibold">{detail.title}</h1>
      <p className="mt-1 text-gray-600 dark:text-gray-400">
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
              <div key={i} className={`h-3 rounded bg-gray-300 dark:bg-gray-700 ${w}`} />
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
                <p className="mt-1 text-xs text-gray-500">
                  {(TIER_SUBTITLE[primary.tier] ?? (() => ''))(detail.company, primary.viaSite)}
                </p>
              </div>
            )}
            <button
              onClick={onSave}
              disabled={saved}
              className="rounded-lg border px-4 py-2 text-sm font-medium hover:bg-gray-50 disabled:opacity-60 dark:hover:bg-gray-800"
            >
              {saved ? 'Saved ✓' : 'Save'}
            </button>
            {primary && (
              <a
                href={primary.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-gray-500 hover:underline"
              >
                View full posting ↗
              </a>
            )}
          </div>
          {alternates.length > 0 && (
            <p className="mt-2 text-xs text-gray-500">
              Also available: {alternates.map((o, i) => (
                <button key={i} onClick={() => onApply(o)} className="underline decoration-dotted hover:text-gray-700 dark:hover:text-gray-300">
                  {o.viaSite ?? o.tier}{i < alternates.length - 1 ? ', ' : ''}
                </button>
              ))}
            </p>
          )}

          <section className="prose prose-sm mt-8 max-w-none whitespace-pre-wrap text-sm leading-relaxed dark:prose-invert">
            {detail.jd || 'The source didn’t provide a full description — use the posting link above.'}
          </section>
        </>
      )}

      <AuthGateModal reason={gate} onClose={() => setGate(null)} />
    </main>
  )
}
