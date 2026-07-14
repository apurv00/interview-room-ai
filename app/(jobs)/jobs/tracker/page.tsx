'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'

/**
 * /jobs/tracker — tracker v1 (Wave 4.2). Mobile-first single list grouped
 * by status with counts. Chip-strip transitions + undo toast; inline notes;
 * read-time nudges; the confirm card (anti-nag ask #2). `ghosted` renders
 * as "No response" — banned-copy discipline holds here too.
 */

interface Row {
  jobPostingId: string
  title: string
  company: string
  location: string
  status: string
  daysInStatus: number
  practiceCount: number
  notes?: string
  nudge: 'waiting' | 'ghost-prompt' | null
  unconfirmedClick: boolean
}
interface View {
  groups: Array<{ status: string; count: number; rows: Row[] }>
  confirmCard: { jobPostingId: string; company: string; clickedAgoHours: number } | null
}

const STATUS_LABEL: Record<string, string> = {
  saved: 'Saved',
  apply_clicked: 'Clicked · not confirmed',
  applied: 'Applied',
  interview_scheduled: 'Interview scheduled',
  offer: 'Offer',
  rejected: 'Rejected',
  ghosted: 'No response',
  withdrawn: 'Withdrawn',
}
const CHIP_TARGETS: Record<string, string[]> = {
  saved: ['applied', 'withdrawn'],
  apply_clicked: ['applied', 'withdrawn'],
  applied: ['interview_scheduled', 'rejected', 'ghosted', 'withdrawn'],
  interview_scheduled: ['offer', 'rejected'],
  ghosted: ['applied', 'interview_scheduled'],
  rejected: ['applied'],
  offer: [],
  withdrawn: ['saved'],
}

export default function TrackerPage() {
  const [view, setView] = useState<View | null>(null)
  const [error, setError] = useState<'auth' | 'load' | null>(null)
  const [undo, setUndo] = useState<{ jobPostingId: string; from: string; label: string } | null>(null)
  const [notesFor, setNotesFor] = useState<string | null>(null)
  const [notesDraft, setNotesDraft] = useState('')

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/jobs/tracker')
      if (r.status === 401) { setError('auth'); return }
      if (!r.ok) { setError('load'); return }
      setView(await r.json())
      setError(null)
    } catch {
      setError('load')
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function transition(jobPostingId: string, from: string, to: string) {
    const res = await fetch(`/api/jobs/${jobPostingId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: to }),
    }).catch(() => null)
    if (res?.ok) {
      // Undo replays `from` through the USER status route — apply_clicked is
      // the machine fact and deliberately not user-settable (letting undo
      // restore it would let anyone fabricate clicks), so moves off a
      // 'Clicked · not confirmed' row don't offer undo; the chip strip still
      // reaches every legitimate state (Codex on #523).
      if (from !== 'apply_clicked') {
        setUndo({ jobPostingId, from, label: `Moved to ${STATUS_LABEL[to] ?? to}` })
      }
      load()
    }
  }

  async function undoLast() {
    if (!undo) return
    const { jobPostingId, from } = undo
    setUndo(null)
    await fetch(`/api/jobs/${jobPostingId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: from }),
    }).catch(() => null)
    load()
  }

  async function confirmCardAnswer(jobPostingId: string, applied: boolean) {
    if (applied) {
      await fetch(`/api/jobs/${jobPostingId}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'applied', viaNudge: true }),
      }).catch(() => null)
    } else {
      await fetch(`/api/jobs/${jobPostingId}/nudge-dismiss`, { method: 'POST' }).catch(() => null)
    }
    load()
  }

  async function saveNotes(jobPostingId: string) {
    await fetch(`/api/jobs/${jobPostingId}/nudge-dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: notesDraft }),
    }).catch(() => null)
    setNotesFor(null)
    load()
  }

  if (error === 'auth') {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16">
        <p className="font-medium">Sign in to see your tracker.</p>
        <Link href="/jobs" className="mt-3 inline-block text-sm text-blue-600 hover:underline">← Browse jobs</Link>
      </main>
    )
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">My applications</h1>
        <Link href="/jobs" className="text-sm text-blue-600 hover:underline">Browse jobs</Link>
      </div>

      {view?.confirmCard && (
        <div className="mt-4 rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm dark:border-blue-900 dark:bg-blue-950">
          <p className="font-medium">You clicked {view.confirmCard.company} {view.confirmCard.clickedAgoHours >= 24 ? 'yesterday' : 'earlier'} — did you apply?</p>
          <div className="mt-2 flex gap-2">
            <button onClick={() => confirmCardAnswer(view.confirmCard!.jobPostingId, true)} className="rounded-lg bg-blue-600 px-3 py-1 text-xs font-medium text-white">✓ Yes, applied</button>
            <button onClick={() => confirmCardAnswer(view.confirmCard!.jobPostingId, false)} className="rounded-lg border px-3 py-1 text-xs">Not yet</button>
          </div>
        </div>
      )}

      {error === 'load' && <p className="mt-8 text-sm text-red-600">Couldn&apos;t load the tracker — refresh to retry.</p>}
      {!view && !error && <p className="mt-8 text-sm text-gray-500">Loading…</p>}

      {view && view.groups.length === 0 && (
        <div className="mt-8 rounded-xl border border-dashed p-6">
          <p className="font-medium">Nothing tracked yet.</p>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">Save or apply to a job and it lands here automatically.</p>
        </div>
      )}

      {view?.groups.map((g) => (
        <section key={g.status} className="mt-8" aria-label={STATUS_LABEL[g.status] ?? g.status}>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
            {STATUS_LABEL[g.status] ?? g.status} · {g.count}
          </h2>
          <ul className="mt-2 space-y-2">
            {g.rows.map((r) => (
              <li key={r.jobPostingId} className="rounded-xl border p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <Link href={`/jobs/${r.jobPostingId}`} className="font-medium hover:underline">{r.title}</Link>
                  <span className="shrink-0 text-xs text-gray-500">{r.daysInStatus}d</span>
                </div>
                <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">
                  {r.company}{r.location ? ` · ${r.location}` : ''} · Evidence {r.practiceCount}/3
                </p>
                {r.nudge === 'waiting' && <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">Still waiting on {r.company}? Keep prepping — evidence carries to similar jobs.</p>}
                {r.nudge === 'ghost-prompt' && (
                  <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                    3 weeks quiet. <button onClick={() => transition(r.jobPostingId, r.status, 'ghosted')} className="underline">Mark “No response”?</button>
                  </p>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {(CHIP_TARGETS[r.status] ?? []).map((to) => (
                    <button key={to} onClick={() => transition(r.jobPostingId, r.status, to)} className="rounded-full border px-2 py-0.5 text-xs hover:bg-gray-50 dark:hover:bg-gray-800">
                      → {STATUS_LABEL[to] ?? to}
                    </button>
                  ))}
                  <button onClick={() => { setNotesFor(r.jobPostingId); setNotesDraft(r.notes ?? '') }} className="rounded-full border px-2 py-0.5 text-xs text-gray-500">
                    {r.notes ? 'Edit note' : 'Add note'}
                  </button>
                  <Link href={`/jobs/${r.jobPostingId}`} className="rounded-full border px-2 py-0.5 text-xs text-blue-600">View</Link>
                </div>
                {r.notes && notesFor !== r.jobPostingId && <p className="mt-2 whitespace-pre-wrap text-xs text-gray-500">{r.notes}</p>}
                {notesFor === r.jobPostingId && (
                  <div className="mt-2">
                    <textarea value={notesDraft} onChange={(e) => setNotesDraft(e.target.value)} rows={3} className="w-full rounded-lg border p-2 text-sm dark:bg-gray-900" />
                    <div className="mt-1 flex gap-2">
                      <button onClick={() => saveNotes(r.jobPostingId)} className="rounded-lg bg-blue-600 px-3 py-1 text-xs font-medium text-white">Save note</button>
                      <button onClick={() => setNotesFor(null)} className="rounded-lg border px-3 py-1 text-xs">Cancel</button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}

      {undo && (
        <div className="fixed inset-x-0 bottom-0 z-40 mx-auto max-w-3xl p-4">
          <div className="flex items-center justify-between rounded-xl border bg-white p-3 text-sm shadow-lg dark:bg-gray-900">
            <span>{undo.label}</span>
            <button onClick={undoLast} className="ml-3 font-medium text-blue-600 hover:underline">Undo</button>
          </div>
        </div>
      )}
    </main>
  )
}
