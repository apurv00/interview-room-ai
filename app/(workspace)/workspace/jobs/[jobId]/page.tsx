'use client'

/**
 * Job pipeline board — the operating screen. Applications grouped by the
 * fixed stages; every card carries its evidence chip (AI score / round
 * status) and explicit Advance / Reject buttons. Stage moves record the
 * acting member server-side; closing the job requires a decision note.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import Badge from '@shared/ui/Badge'
import Button from '@shared/ui/Button'
import Input from '@shared/ui/Input'
import StateView from '@shared/ui/StateView'

const STAGES = ['new', 'screened', 'interviewing', 'shortlist', 'offer', 'hired', 'rejected'] as const
type Stage = (typeof STAGES)[number]

const STAGE_LABEL: Record<Stage, string> = {
  new: 'New',
  screened: 'Screened',
  interviewing: 'Interviewing',
  shortlist: 'Shortlist',
  offer: 'Offer',
  hired: 'Hired',
  rejected: 'Rejected',
}

interface Entry {
  application: {
    id: string
    stage: Stage
    decisionNote: string | null
    createdAt: string
  }
  candidate: { id: string; name: string; email: string } | null
  latestRound: {
    id: string
    status: string
    invitedAt: string
    inviteExpiresAt: string
    revokedAt: string | null
    linkedAt: string | null
    overallScore: number | null
    resultsPending: boolean
  } | null
}

interface JobDetail {
  id: string
  title: string
  status: 'open' | 'on_hold' | 'closed'
  closeNote: string | null
  jdText: string
}

interface PoolCandidate {
  id: string
  name: string
  email: string
}

function roundChip(round: Entry['latestRound']): { label: string; variant: 'default' | 'primary' | 'success' | 'caution' | 'danger' } | null {
  if (!round) return null
  if (round.revokedAt) return { label: 'AI revoked', variant: 'default' }
  if (round.overallScore !== null) return { label: `AI ${round.overallScore}`, variant: round.overallScore >= 70 ? 'success' : round.overallScore >= 50 ? 'caution' : 'danger' }
  if (round.status === 'completed') return { label: 'AI done — report pending', variant: 'primary' }
  if (round.status === 'prepared' || round.status === 'auth_verified') return { label: 'AI in progress', variant: 'primary' }
  if (new Date(round.inviteExpiresAt) < new Date()) return { label: 'AI link expired', variant: 'caution' }
  return { label: 'AI sent', variant: 'default' }
}

export default function JobPipelinePage({ params }: { params: { jobId: string } }) {
  const [job, setJob] = useState<JobDetail | null>(null)
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [pool, setPool] = useState<PoolCandidate[]>([])
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const [addName, setAddName] = useState('')
  const [addEmail, setAddEmail] = useState('')
  const [selectedPoolId, setSelectedPoolId] = useState('')
  const [showClose, setShowClose] = useState(false)
  const [closeNote, setCloseNote] = useState('')
  const [noteFor, setNoteFor] = useState<{ appId: string; action: 'advance' | 'reject' } | null>(null)
  const [note, setNote] = useState('')

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch(`/api/workspace/jobs/${params.jobId}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setJob(data.job)
      setEntries(data.entries)
    } catch {
      setError('Could not load this job.')
    }
  }, [params.jobId])

  useEffect(() => {
    void load()
    fetch('/api/workspace/candidates')
      .then((r) => r.json())
      .then((d) => setPool(d.candidates ?? []))
      .catch(() => {})
  }, [load])

  async function addToJob(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setActionError(null)
    try {
      let candidateId = selectedPoolId
      if (!candidateId) {
        const res = await fetch('/api/workspace/candidates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: addName.trim(), email: addEmail.trim() }),
        })
        const data = await res.json()
        if (!res.ok) {
          setActionError(data.error || 'Could not add the candidate.')
          return
        }
        candidateId = data.candidate.id
      }
      const res = await fetch('/api/workspace/applications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: params.jobId, candidateId }),
      })
      const data = await res.json()
      if (!res.ok) {
        setActionError(data.error || 'Could not add the candidate to this job.')
        return
      }
      setAddName('')
      setAddEmail('')
      setSelectedPoolId('')
      setShowAdd(false)
      await load()
    } catch {
      setActionError('Something went wrong. Check your connection.')
    } finally {
      setBusy(false)
    }
  }

  async function moveStage(appId: string, action: 'advance' | 'reject', moveNote?: string) {
    setBusy(true)
    setActionError(null)
    try {
      const res = await fetch(`/api/workspace/applications/${appId}/stage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...(moveNote ? { note: moveNote } : {}) }),
      })
      const data = await res.json()
      if (!res.ok) {
        if (data.code === 'DECISION_NOTE_REQUIRED') {
          setNoteFor({ appId, action })
          return
        }
        setActionError(data.error || 'Could not move the candidate.')
        return
      }
      setNoteFor(null)
      setNote('')
      await load()
    } catch {
      setActionError('Something went wrong. Check your connection.')
    } finally {
      setBusy(false)
    }
  }

  async function closeJob(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setActionError(null)
    try {
      const res = await fetch(`/api/workspace/jobs/${params.jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'closed', closeNote: closeNote.trim() }),
      })
      const data = await res.json()
      if (!res.ok) {
        setActionError(data.details?.[0]?.message || data.error || 'Could not close the job.')
        return
      }
      setShowClose(false)
      await load()
    } catch {
      setActionError('Something went wrong. Check your connection.')
    } finally {
      setBusy(false)
    }
  }

  if (error) return <StateView state="error" error={error} onRetry={load} />
  if (!job || entries === null) return <StateView state="loading" skeletonLayout="list" />

  const availablePool = pool.filter(
    (c) => !entries.some((en) => en.candidate?.id === c.id)
  )

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Link href="/workspace/jobs" className="text-xs text-[#71767b] hover:text-indigo-600">
            ← All jobs
          </Link>
          <h1 className="text-xl font-bold text-[#0f1419] truncate">{job.title}</h1>
          <div className="flex items-center gap-2 mt-1">
            <Badge variant={job.status === 'open' ? 'success' : job.status === 'on_hold' ? 'caution' : 'default'}>
              {job.status.replace('_', ' ')}
            </Badge>
            {job.closeNote && (
              <span className="text-xs text-[#71767b]">Decision: {job.closeNote}</span>
            )}
          </div>
        </div>
        <div className="flex gap-2 shrink-0">
          {job.status !== 'closed' && (
            <>
              <Button variant="secondary" onClick={() => setShowAdd((v) => !v)}>
                {showAdd ? 'Cancel' : 'Add candidate'}
              </Button>
              <Button variant="secondary" onClick={() => setShowClose((v) => !v)}>
                Close job
              </Button>
            </>
          )}
        </div>
      </div>

      {actionError && <p className="text-sm text-[#f4212e]">{actionError}</p>}

      {showClose && (
        <form onSubmit={closeJob} className="bg-white border border-[#e1e8ed] rounded-2xl p-5 space-y-3">
          <p className="text-sm font-medium text-[#0f1419]">
            Close this job — a decision note is required (it becomes the close-out record).
          </p>
          <textarea
            value={closeNote}
            onChange={(e) => setCloseNote(e.target.value)}
            required
            minLength={5}
            maxLength={4000}
            rows={3}
            placeholder="e.g. Hired Jane Doe — strongest system-design evidence of the pool."
            className="w-full px-3 py-2 border border-[#e1e8ed] rounded-xl bg-[#f8fafc] text-sm"
          />
          <Button type="submit" disabled={busy || closeNote.trim().length < 5}>
            {busy ? 'Closing…' : 'Close job'}
          </Button>
        </form>
      )}

      {showAdd && (
        <form onSubmit={addToJob} className="bg-white border border-[#e1e8ed] rounded-2xl p-5 space-y-4">
          {availablePool.length > 0 && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-[#0f1419] block">
                From your talent pool
              </label>
              <select
                value={selectedPoolId}
                onChange={(e) => setSelectedPoolId(e.target.value)}
                className="w-full px-3 py-2 border border-[#e1e8ed] rounded-xl bg-[#f8fafc] text-sm"
              >
                <option value="">— Add a new person instead —</option>
                {availablePool.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.email})
                  </option>
                ))}
              </select>
            </div>
          )}
          {!selectedPoolId && (
            <div className="grid md:grid-cols-2 gap-4">
              <Input
                label="Name"
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                required
                maxLength={120}
              />
              <Input
                label="Email"
                type="email"
                value={addEmail}
                onChange={(e) => setAddEmail(e.target.value)}
                required
                maxLength={254}
              />
            </div>
          )}
          <Button type="submit" disabled={busy || (!selectedPoolId && (!addName.trim() || !addEmail.trim()))}>
            {busy ? 'Adding…' : 'Add to job'}
          </Button>
        </form>
      )}

      {entries.length === 0 ? (
        <StateView
          state="empty"
          title="No candidates yet"
          description="Add your first candidate — then send them the AI interview from their card."
          action={{ label: 'Add candidate', onClick: () => setShowAdd(true) }}
        />
      ) : (
        <div className="space-y-6">
          {STAGES.map((stage) => {
            const stageEntries = entries.filter((en) => en.application.stage === stage)
            if (stageEntries.length === 0) return null
            return (
              <section key={stage}>
                <h2 className="text-sm font-semibold text-[#536471] uppercase tracking-wide mb-2">
                  {STAGE_LABEL[stage]} · {stageEntries.length}
                </h2>
                <div className="space-y-2">
                  {stageEntries.map((en) => {
                    const chip = roundChip(en.latestRound)
                    const terminal = stage === 'hired' || stage === 'rejected'
                    const needsNote = noteFor?.appId === en.application.id
                    return (
                      <div
                        key={en.application.id}
                        className="bg-white border border-[#e1e8ed] rounded-2xl p-4"
                      >
                        <div className="flex items-center justify-between gap-3 flex-wrap">
                          <div className="min-w-0">
                            <Link
                              href={`/workspace/applications/${en.application.id}`}
                              className="font-medium text-[#0f1419] hover:text-indigo-600 truncate block"
                            >
                              {en.candidate?.name ?? 'Unknown candidate'}
                            </Link>
                            <p className="text-xs text-[#71767b] truncate">{en.candidate?.email}</p>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            {chip && <Badge variant={chip.variant}>{chip.label}</Badge>}
                            <Link
                              href={`/workspace/applications/${en.application.id}`}
                              className="text-xs text-indigo-600 hover:underline"
                            >
                              View card
                            </Link>
                            {!terminal && job.status === 'open' && (
                              <>
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  disabled={busy}
                                  onClick={() => void moveStage(en.application.id, 'advance')}
                                >
                                  Advance
                                </Button>
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  disabled={busy}
                                  onClick={() => void moveStage(en.application.id, 'reject')}
                                >
                                  Reject
                                </Button>
                              </>
                            )}
                          </div>
                        </div>
                        {needsNote && (
                          <div className="mt-3 space-y-2">
                            <p className="text-xs text-[#536471]">
                              A decision note is required to mark this candidate Hired.
                            </p>
                            <textarea
                              value={note}
                              onChange={(e) => setNote(e.target.value)}
                              rows={2}
                              maxLength={4000}
                              className="w-full px-3 py-2 border border-[#e1e8ed] rounded-xl bg-[#f8fafc] text-sm"
                              placeholder="Why this candidate?"
                            />
                            <div className="flex gap-2">
                              <Button
                                size="sm"
                                disabled={busy || note.trim().length === 0}
                                onClick={() => void moveStage(en.application.id, noteFor.action, note.trim())}
                              >
                                Confirm
                              </Button>
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => {
                                  setNoteFor(null)
                                  setNote('')
                                }}
                              >
                                Cancel
                              </Button>
                            </div>
                          </div>
                        )}
                        {en.application.decisionNote && stage === 'hired' && (
                          <p className="mt-2 text-xs text-emerald-700">
                            Decision: {en.application.decisionNote}
                          </p>
                        )}
                      </div>
                    )
                  })}
                </div>
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}
