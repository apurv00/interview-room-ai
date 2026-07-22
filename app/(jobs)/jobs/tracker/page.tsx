'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { clearAllInterviewStorage } from '@shared/storageKeys'
import {
  clickAgeLabel,
  interviewDateLabel,
  practiceProgressLabel,
} from '@jobs/config/truthfulLabels'
import InterviewDateControls, { type InterviewDateRequest } from '@jobs/components/InterviewDateControls'

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
  postingState: 'live' | 'archived' | 'restricted' | 'snapshot-only'
  daysInStatus: number
  practiceCount: number
  interviewDate?: string
  interviewDateConfidence?: 'exact' | 'week' | 'unknown'
  interviewDatePreference?: 'this-week' | 'next-week' | 'unknown'
  notes?: string
  tailoredResume?: { createdAt: string }
  appliedWith?: { wasTailored: boolean }
  nudge: 'waiting' | 'ghost-prompt' | null
  unconfirmedClick: boolean
}
interface View {
  groups: Array<{ status: string; count: number; rows: Row[] }>
  confirmCard: {
    jobPostingId: string
    company: string
    clickedAgoHours: number
    tailoredResume?: { createdAt: string }
  } | null
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
const APPLIED_HISTORY_STATUSES = new Set([
  'applied',
  'interview_scheduled',
  'offer',
  'rejected',
  'ghosted',
  'withdrawn',
])

export default function TrackerPage() {
  const [view, setView] = useState<View | null>(null)
  const [error, setError] = useState<'auth' | 'account-unavailable' | 'load' | null>(null)
  const [undo, setUndo] = useState<{ jobPostingId: string; from: string; label: string } | null>(null)
  const [notesFor, setNotesFor] = useState<string | null>(null)
  const [notesDraft, setNotesDraft] = useState('')
  const [dateSheetFor, setDateSheetFor] = useState<string | null>(null)
  const [applyChoiceFor, setApplyChoiceFor] = useState<string | null>(null)
  const [actionNotice, setActionNotice] = useState<string | null>(null)
  const accountUnavailableRef = useRef(false)
  const loadRequestRef = useRef(0)

  const clearPrivateView = useCallback(() => {
    loadRequestRef.current += 1
    setView(null)
    setUndo(null)
    setNotesFor(null)
    setNotesDraft('')
    setDateSheetFor(null)
    setApplyChoiceFor(null)
    setActionNotice(null)
  }, [])

  const handleUnauthorized = useCallback(async (response: Response | null): Promise<boolean> => {
    if (response?.status !== 401) return false
    const body = await response.json().catch(() => null) as { code?: unknown } | null
    const accountUnavailable = body?.code === 'ACCOUNT_UNAVAILABLE'
    if (accountUnavailable) {
      accountUnavailableRef.current = true
      clearAllInterviewStorage()
      clearPrivateView()
      setError('account-unavailable')
    } else if (!accountUnavailableRef.current) {
      // Once deletion is observed it is terminal. A slower ordinary 401 from
      // another in-flight request must not downgrade the page to a sign-in
      // prompt or permit an older tracker response to repopulate private rows.
      clearPrivateView()
      setError('auth')
    }
    return true
  }, [clearPrivateView])

  const load = useCallback(async () => {
    const requestId = ++loadRequestRef.current
    try {
      const r = await fetch('/api/jobs/tracker')
      if (await handleUnauthorized(r)) return
      if (accountUnavailableRef.current || requestId !== loadRequestRef.current) return
      if (!r.ok) { setError('load'); return }
      const nextView = await r.json() as View
      if (accountUnavailableRef.current || requestId !== loadRequestRef.current) return
      setView(nextView)
      setError(null)
    } catch {
      if (!accountUnavailableRef.current && requestId === loadRequestRef.current) setError('load')
    }
  }, [handleUnauthorized])

  useEffect(() => {
    load()
    return () => { loadRequestRef.current += 1 }
  }, [load])

  async function transition(
    jobPostingId: string,
    from: string,
    to: string,
    appliedWith?: { wasTailored: boolean; tailoredAt?: string },
  ) {
    const res = await fetch(`/api/jobs/${jobPostingId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: to, ...(appliedWith ? { appliedWith } : {}) }),
    }).catch(() => null)
    if (await handleUnauthorized(res)) return
    if (accountUnavailableRef.current) return
    if (res?.status === 409) {
      const conflict = await res.json().catch(() => null) as { code?: unknown } | null
      if (conflict?.code === 'TAILORED_VERSION_UNAVAILABLE' || conflict?.code === 'APPLIED_WITH_CONFLICT') {
        setApplyChoiceFor(null)
        setActionNotice(conflict.code === 'TAILORED_VERSION_UNAVAILABLE'
          ? 'The saved tailored version changed. Review the refreshed row, then confirm again.'
          : 'A different resume choice is already recorded. Review the refreshed row before changing it.')
        load()
        return
      }
    }
    if (!res?.ok) {
      setActionNotice('Couldn’t record that update just now. Try again.')
      return
    }
    if (res.ok) {
      // §4c: landing on interview_scheduled opens the date sheet.
      if (to === 'interview_scheduled') setDateSheetFor(jobPostingId)
      setApplyChoiceFor(null)
      setActionNotice(null)
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
    setDateSheetFor(null) // an undone transition must not leave its date sheet armed (Codex #525)
    const res = await fetch(`/api/jobs/${jobPostingId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: from }),
    }).catch(() => null)
    if (await handleUnauthorized(res)) return
    if (accountUnavailableRef.current) return
    if (!res?.ok) {
      setActionNotice('Couldn’t record that update just now. Try again.')
      return
    }
    setActionNotice(null)
    load()
  }

  async function confirmCardAnswer(
    jobPostingId: string,
    applied: boolean,
    appliedWith?: { wasTailored: boolean; tailoredAt?: string },
  ) {
    let res: Response | null
    if (applied) {
      res = await fetch(`/api/jobs/${jobPostingId}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'applied',
          viaNudge: true,
          ...(appliedWith ? { appliedWith } : {}),
        }),
      }).catch(() => null)
    } else {
      res = await fetch(`/api/jobs/${jobPostingId}/nudge-dismiss`, { method: 'POST' }).catch(() => null)
    }
    if (await handleUnauthorized(res)) return
    if (accountUnavailableRef.current) return
    if (res?.status === 409) {
      const conflict = await res.json().catch(() => null) as { code?: unknown } | null
      if (conflict?.code === 'TAILORED_VERSION_UNAVAILABLE' || conflict?.code === 'APPLIED_WITH_CONFLICT') {
        setActionNotice(conflict.code === 'TAILORED_VERSION_UNAVAILABLE'
          ? 'The saved tailored version changed. Review the refreshed row, then confirm again.'
          : 'A different resume choice is already recorded. Review the refreshed row before changing it.')
        load()
        return
      }
    }
    if (!res?.ok) {
      setActionNotice('Couldn’t record that update just now. Try again.')
      return
    }
    setActionNotice(null)
    load()
  }

  async function captureDate(jobPostingId: string, request: InterviewDateRequest) {
    const res = await fetch(`/api/jobs/${jobPostingId}/interview-date`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    }).catch(() => null)
    if (await handleUnauthorized(res)) return
    if (accountUnavailableRef.current) return
    if (!res?.ok) throw new Error('interview timing save failed')
    setDateSheetFor(null)
    load()
  }

  async function saveNotes(jobPostingId: string) {
    const res = await fetch(`/api/jobs/${jobPostingId}/nudge-dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: notesDraft }),
    }).catch(() => null)
    if (await handleUnauthorized(res)) return
    if (accountUnavailableRef.current) return
    setNotesFor(null)
    load()
  }

  if (error === 'auth') {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16">
        <p className="font-medium">Sign in to see your job tracker.</p>
        <Link href="/jobs" className="mt-3 inline-block text-sm text-blue-600 hover:underline">← Browse jobs</Link>
      </main>
    )
  }
  if (error === 'account-unavailable') {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16">
        <div role="status" aria-live="polite">
          <h1 className="font-medium">Your account is unavailable.</h1>
          <p className="mt-1 text-sm text-slate-500">
            Account deletion has started or completed, so your private tracker data was cleared from this page.
          </p>
          <p className="mt-1 text-sm text-slate-500">If you did not request deletion, contact support.</p>
        </div>
        <Link href="/jobs" className="mt-3 inline-block text-sm text-blue-600 hover:underline">← Browse public jobs</Link>
      </main>
    )
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Job tracker</h1>
          <p className="mt-1 text-sm text-slate-500">Tracked jobs, grouped by your current status.</p>
        </div>
        <Link href="/jobs" className="text-sm text-blue-600 hover:underline">Browse jobs</Link>
      </div>

      {view?.confirmCard && (
        <div className="mt-4 rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm">
          <p className="font-medium">You clicked {view.confirmCard.company} {clickAgeLabel(view.confirmCard.clickedAgoHours)} — did you apply?</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {view.confirmCard.tailoredResume ? (
              <>
                <button
                  onClick={() => confirmCardAnswer(view.confirmCard!.jobPostingId, true, {
                    wasTailored: true,
                    tailoredAt: view.confirmCard!.tailoredResume!.createdAt,
                  })}
                  className="rounded-lg bg-blue-600 px-3 py-1 text-xs font-medium text-white"
                >
                  ✓ Yes, with tailored resume
                </button>
                <button
                  onClick={() => confirmCardAnswer(view.confirmCard!.jobPostingId, true, { wasTailored: false })}
                  className="rounded-lg border border-blue-200 bg-white px-3 py-1 text-xs font-medium text-blue-700"
                >
                  Yes, with another resume
                </button>
              </>
            ) : (
              <button onClick={() => confirmCardAnswer(view.confirmCard!.jobPostingId, true)} className="rounded-lg bg-blue-600 px-3 py-1 text-xs font-medium text-white">✓ Yes, applied</button>
            )}
            <button onClick={() => confirmCardAnswer(view.confirmCard!.jobPostingId, false)} className="rounded-lg border border-slate-200 px-3 py-1 text-xs bg-white">Not yet</button>
          </div>
        </div>
      )}

      {error === 'load' && <p className="mt-8 text-sm text-red-600">Couldn&apos;t load the tracker — refresh to retry.</p>}
      {actionNotice && (
        <div role="status" aria-live="polite" className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {actionNotice}
        </div>
      )}
      {!view && !error && <p className="mt-8 text-sm text-slate-500">Loading…</p>}

      {view && view.groups.length === 0 && (
        <div className="mt-8 rounded-xl border border-slate-200 border-dashed p-6 bg-white">
          <p className="font-medium">No tracked jobs yet.</p>
          <p className="mt-1 text-sm text-slate-500">Save or apply to a job and it lands here automatically.</p>
        </div>
      )}

      {view?.groups.map((g) => (
        <section key={g.status} className="mt-8" aria-label={STATUS_LABEL[g.status] ?? g.status}>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            {STATUS_LABEL[g.status] ?? g.status} · {g.count}
          </h2>
          <ul className="mt-2 space-y-2">
            {g.rows.map((r) => (
              <li key={r.jobPostingId} className="rounded-xl border border-slate-200 p-3 bg-white">
                <div className="flex items-baseline justify-between gap-2">
                  <Link
                    href={`/jobs/${r.jobPostingId}`}
                    aria-label={`${r.postingState === 'live' ? 'Open job' : 'Open saved details'} for ${r.title} at ${r.company}`}
                    className="font-medium hover:underline"
                  >
                    {r.title}
                  </Link>
                  <span className="shrink-0 text-xs text-slate-500">{r.daysInStatus}d</span>
                </div>
                <p className="mt-0.5 text-sm text-slate-500">
                  {r.company}{r.location ? ` · ${r.location}` : ''} · {practiceProgressLabel(r.practiceCount)}
                </p>
                {r.postingState !== 'live' && (
                  <p className="mt-1 text-xs font-medium text-amber-700">
                    {r.postingState === 'archived' ? 'Posting no longer active · saved details available' : 'Posting unavailable · tracked history preserved'}
                  </p>
                )}
                {r.tailoredResume && (
                  <p className="mt-1 text-xs text-blue-700">
                    Tailored resume saved ·{' '}
                    <Link href={`/resume/tailor?jobId=${r.jobPostingId}`} className="font-medium underline">
                      View or update
                    </Link>
                  </p>
                )}
                {r.appliedWith && APPLIED_HISTORY_STATUSES.has(r.status) && (
                  <p className="mt-1 text-xs text-slate-600">
                    {r.status === 'applied'
                      ? r.appliedWith.wasTailored
                        ? 'Applied with the tailored resume.'
                        : 'Applied with another resume.'
                      : r.appliedWith.wasTailored
                        ? 'This application used the tailored resume.'
                        : 'This application used another resume.'}
                  </p>
                )}
                {r.status === 'applied' && r.nudge === 'waiting' && <p className="mt-1 text-xs text-amber-700">Still marked Applied at {r.company}. Job-specific practice stays with this tracked job.</p>}
                {r.status === 'applied' && r.nudge === 'ghost-prompt' && (
                  <p className="mt-1 text-xs text-amber-700">
                    No tracker update for 3 weeks. <button onClick={() => transition(r.jobPostingId, r.status, 'ghosted')} className="underline">Mark “No response”?</button>
                  </p>
                )}
                {r.status === 'interview_scheduled' && (
                  <p className="mt-1 text-xs text-slate-600">
                    {interviewDateLabel(r.interviewDate, r.interviewDateConfidence, r.interviewDatePreference)}{' '}
                    <button onClick={() => setDateSheetFor(r.jobPostingId)} className="text-blue-600 underline">
                      {r.interviewDateConfidence === 'exact' ? 'Change date' : 'Add exact date'}
                    </button>
                  </p>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {(CHIP_TARGETS[r.status] ?? []).map((to) => (
                    <button
                      key={to}
                      onClick={() => {
                        if (to === 'applied' && r.tailoredResume) {
                          setApplyChoiceFor(r.jobPostingId)
                        } else {
                          void transition(r.jobPostingId, r.status, to)
                        }
                      }}
                      className="rounded-full border border-slate-200 px-2 py-0.5 text-xs hover:bg-slate-50"
                    >
                      → {STATUS_LABEL[to] ?? to}
                    </button>
                  ))}
                  <button onClick={() => { setNotesFor(r.jobPostingId); setNotesDraft(r.notes ?? '') }} className="rounded-full border border-slate-200 px-2 py-0.5 text-xs text-slate-500 bg-white">
                    {r.notes ? 'Edit note' : 'Add note'}
                  </button>
                  <Link
                    href={`/jobs/${r.jobPostingId}`}
                    aria-label={`${r.postingState === 'live' ? 'View job' : 'View saved details'} for ${r.title} at ${r.company}`}
                    className="rounded-full border border-slate-200 px-2 py-0.5 text-xs text-blue-600 bg-white"
                  >
                    {r.postingState === 'live' ? 'View' : 'View saved details'}
                  </Link>
                </div>
                {applyChoiceFor === r.jobPostingId && r.tailoredResume && (
                  <div className="mt-2 rounded-lg border border-blue-200 bg-blue-50 p-2 text-xs">
                    <p className="font-medium">Which resume did you apply with?</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        onClick={() => transition(r.jobPostingId, r.status, 'applied', {
                          wasTailored: true,
                          tailoredAt: r.tailoredResume!.createdAt,
                        })}
                        className="rounded-lg bg-blue-600 px-3 py-1 font-medium text-white"
                      >
                        Tailored resume
                      </button>
                      <button
                        onClick={() => transition(r.jobPostingId, r.status, 'applied', { wasTailored: false })}
                        className="rounded-lg border border-blue-200 bg-white px-3 py-1 font-medium text-blue-700"
                      >
                        Another resume
                      </button>
                      <button onClick={() => setApplyChoiceFor(null)} className="px-2 py-1 text-slate-600 underline">
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
                {dateSheetFor === r.jobPostingId && r.status === 'interview_scheduled' && (
                  <div className="mt-2 rounded-lg border border-blue-300 bg-blue-50 p-2 text-xs">
                    <p className="font-medium">Interview timing</p>
                    <InterviewDateControls onCapture={(request) => captureDate(r.jobPostingId, request)} />
                  </div>
                )}
                {r.notes && notesFor !== r.jobPostingId && <p className="mt-2 whitespace-pre-wrap text-xs text-slate-500">{r.notes}</p>}
                {notesFor === r.jobPostingId && (
                  <div className="mt-2">
                    <textarea aria-label={`Notes for ${r.title} at ${r.company}`} value={notesDraft} onChange={(e) => setNotesDraft(e.target.value)} rows={3} className="w-full rounded-lg border border-slate-200 p-2 text-sm bg-white text-slate-900 placeholder-slate-400" />
                    <div className="mt-1 flex gap-2">
                      <button onClick={() => saveNotes(r.jobPostingId)} className="rounded-lg bg-blue-600 px-3 py-1 text-xs font-medium text-white">Save note</button>
                      <button onClick={() => setNotesFor(null)} className="rounded-lg border border-slate-200 px-3 py-1 text-xs bg-white">Cancel</button>
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
          <div role="status" aria-live="polite" aria-atomic="true" className="flex items-center justify-between rounded-xl border border-slate-200 bg-white p-3 text-sm shadow-lg">
            <span>{undo.label}</span>
            <button onClick={undoLast} className="ml-3 font-medium text-blue-600 hover:underline">Undo</button>
          </div>
        </div>
      )}
    </main>
  )
}
