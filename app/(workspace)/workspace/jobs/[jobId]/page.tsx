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
import { scoreBand } from '@shared/ui/ScoreBar'
import BulkUploadPanel from './BulkUploadPanel'

const STAGES = [
  'new',
  'screened',
  'interviewing',
  'shortlist',
  'offer',
  'hired',
  'rejected',
  'withdrawn',
] as const
type Stage = (typeof STAGES)[number]
type StageAction = 'advance' | 'reject' | 'withdraw' | 'offer_accepted' | 'offer_declined'

const STAGE_LABEL: Record<Stage, string> = {
  new: 'New',
  screened: 'Screened',
  interviewing: 'Interviewing',
  shortlist: 'Shortlist',
  offer: 'Offer',
  hired: 'Hired',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
}

interface Entry {
  application: {
    id: string
    stage: Stage
    decisionNote: string | null
    offerDecision: {
      outcome: 'accepted' | 'declined'
      actorName: string
      note: string | null
      at: string
    } | null
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
    resultsUnscored: boolean
  } | null
}

interface JobDetail {
  id: string
  title: string
  status: 'open' | 'on_hold' | 'closed'
  closeNote: string | null
  closedByName: string | null
  jdText: string
  /** Public apply page live? The token itself is never sent to the client. */
  applyPageEnabled: boolean
}

interface PoolCandidate {
  id: string
  name: string
  email: string
}

interface EmailDeliveryFailure {
  recipientEmail: string
  recipientName: string
  attempts: number
  lastError: string | null
  failedAt: string
}

interface EmailDeliverySummary {
  total: number
  pending: number
  sending: number
  sent: number
  failed: number
  failures: EmailDeliveryFailure[]
}

const EMPTY_EMAIL_DELIVERY: EmailDeliverySummary = {
  total: 0,
  pending: 0,
  sending: 0,
  sent: 0,
  failed: 0,
  failures: [],
}

function roundChip(round: Entry['latestRound']): { label: string; variant: 'default' | 'primary' | 'success' | 'caution' | 'danger' } | null {
  if (!round) return null
  if (round.revokedAt) return { label: 'AI revoked', variant: 'default' }
  if (round.overallScore !== null) {
    // Canonical 75/55 bands (shared/ui/ScoreBar.scoreBand) — keep chips
    // consistent with every other score surface.
    const band = scoreBand(round.overallScore)
    return {
      label: `AI ${round.overallScore}`,
      variant: band === 'strong' ? 'success' : band === 'ok' ? 'caution' : 'danger',
    }
  }
  if (round.resultsUnscored) return { label: 'AI — not enough answers to score', variant: 'caution' }
  if (round.status === 'completed') return { label: 'AI done — report pending', variant: 'primary' }
  if (round.status === 'prepared' || round.status === 'auth_verified') return { label: 'AI in progress', variant: 'primary' }
  if (new Date(round.inviteExpiresAt) < new Date()) return { label: 'AI link expired', variant: 'caution' }
  return { label: 'AI sent', variant: 'default' }
}

export default function JobPipelinePage({ params }: { params: { jobId: string } }) {
  const [job, setJob] = useState<JobDetail | null>(null)
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [pool, setPool] = useState<PoolCandidate[]>([])
  const [emailDelivery, setEmailDelivery] = useState<EmailDeliverySummary>(EMPTY_EMAIL_DELIVERY)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [emailRetryNotice, setEmailRetryNotice] = useState<string | null>(null)
  const [retryingEmails, setRetryingEmails] = useState(false)
  const [busy, setBusy] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const [showBulk, setShowBulk] = useState(false)
  const [applyLink, setApplyLink] = useState<string | null>(null)
  const [applyBusy, setApplyBusy] = useState(false)
  const [addName, setAddName] = useState('')
  const [addEmail, setAddEmail] = useState('')
  const [selectedPoolId, setSelectedPoolId] = useState('')
  const [showClose, setShowClose] = useState(false)
  const [closeNote, setCloseNote] = useState('')
  const [noteFor, setNoteFor] = useState<{
    appId: string
    expectedFrom: Stage
    action: StageAction
  } | null>(null)
  const [note, setNote] = useState('')
  const [closeOperationId, setCloseOperationId] = useState<string | null>(null)
  const [statusCommand, setStatusCommand] = useState<{
    expectedStatus: JobDetail['status']
    status: JobDetail['status']
    operationId: string
  } | null>(null)
  const [stageCommand, setStageCommand] = useState<{
    appId: string
    expectedFrom: Stage
    action: StageAction
    operationId: string
  } | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch(`/api/workspace/jobs/${params.jobId}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setJob(data.job)
      setEntries(data.entries)
      setEmailDelivery(data.emailDelivery ?? EMPTY_EMAIL_DELIVERY)
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

  async function issueApplyLink() {
    setApplyBusy(true)
    setActionError(null)
    try {
      const res = await fetch(`/api/workspace/jobs/${params.jobId}/apply-link`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok || typeof data.capability !== 'string') {
        setActionError(data.error || 'Could not create the apply link.')
        return
      }
      // Shown once — the server stores only a hash and can never return it again.
      setApplyLink(
        `${window.location.origin}/apply#apply=${encodeURIComponent(data.capability)}`,
      )
      await load()
    } finally {
      setApplyBusy(false)
    }
  }

  async function disableApplyLink() {
    setApplyBusy(true)
    setActionError(null)
    try {
      const res = await fetch(`/api/workspace/jobs/${params.jobId}/apply-link`, { method: 'DELETE' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setActionError(data.error || 'Could not turn the apply link off.')
        return
      }
      setApplyLink(null)
      await load()
    } finally {
      setApplyBusy(false)
    }
  }

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

  async function moveStage(
    appId: string,
    expectedFrom: Stage,
    action: StageAction,
    moveNote?: string,
  ) {
    if (action === 'offer_accepted' && !moveNote) {
      setNoteFor({ appId, expectedFrom, action })
      return
    }
    setBusy(true)
    setActionError(null)
    try {
      const operationId =
        stageCommand?.appId === appId &&
        stageCommand.expectedFrom === expectedFrom &&
        stageCommand.action === action
          ? stageCommand.operationId
          : crypto.randomUUID()
      setStageCommand({ appId, expectedFrom, action, operationId })
      const res = await fetch(`/api/workspace/applications/${appId}/stage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          expectedFrom,
          operationId,
          ...(moveNote ? { note: moveNote } : {}),
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        if (data.code === 'DECISION_NOTE_REQUIRED') {
          setNoteFor({ appId, expectedFrom, action })
          return
        }
        setActionError(data.error || 'Could not move the candidate.')
        return
      }
      setNoteFor(null)
      setNote('')
      setStageCommand(null)
      await load()
    } catch {
      setActionError('Something went wrong. Check your connection.')
    } finally {
      setBusy(false)
    }
  }

  async function closeJob(e: React.FormEvent) {
    e.preventDefault()
    if (!job) return
    setBusy(true)
    setActionError(null)
    try {
      const operationId = closeOperationId ?? crypto.randomUUID()
      setCloseOperationId(operationId)
      const res = await fetch(`/api/workspace/jobs/${params.jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'closed',
          expectedStatus: job.status,
          operationId,
          closeNote: closeNote.trim(),
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setActionError(data.details?.[0]?.message || data.error || 'Could not close the job.')
        return
      }
      setShowClose(false)
      setCloseOperationId(null)
      await load()
    } catch {
      setActionError('Something went wrong. Check your connection.')
    } finally {
      setBusy(false)
    }
  }

  async function changeJobStatus(status: 'open' | 'on_hold') {
    if (!job || status === job.status) return
    const command =
      statusCommand?.expectedStatus === job.status && statusCommand.status === status
        ? statusCommand
        : { expectedStatus: job.status, status, operationId: crypto.randomUUID() }
    setStatusCommand(command)
    setBusy(true)
    setActionError(null)
    try {
      const res = await fetch(`/api/workspace/jobs/${params.jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(command),
      })
      const data = await res.json()
      if (!res.ok) {
        setActionError(data.details?.[0]?.message || data.error || 'Could not update the job.')
        return
      }
      setStatusCommand(null)
      setShowAdd(false)
      setShowBulk(false)
      await load()
    } catch {
      setActionError('Something went wrong. Check your connection.')
    } finally {
      setBusy(false)
    }
  }

  async function retryFailedEmails() {
    setRetryingEmails(true)
    setActionError(null)
    setEmailRetryNotice(null)
    try {
      const res = await fetch(
        `/api/workspace/jobs/${params.jobId}/email-delivery/retry`,
        { method: 'POST' },
      )
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setActionError(data.error || 'Could not retry the failed emails.')
        return
      }
      const requeued = typeof data.requeued === 'number' ? data.requeued : 0
      setEmailRetryNotice(
        requeued > 0
          ? `${requeued} failed ${requeued === 1 ? 'email was' : 'emails were'} requeued for delivery.`
          : 'No terminal email failures remain to retry.',
      )
      await load()
    } catch {
      setActionError('Something went wrong. Check your connection.')
    } finally {
      setRetryingEmails(false)
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
              <span className="text-xs text-[#71767b]">
                Decision{job.closedByName ? ` by ${job.closedByName}` : ''}: {job.closeNote}
              </span>
            )}
          </div>
        </div>
        <div className="flex gap-2 shrink-0">
          {job.status === 'open' && (
            <Button variant="secondary" disabled={busy} onClick={() => void changeJobStatus('on_hold')}>
              Put on hold
            </Button>
          )}
          {job.status !== 'open' && (
            <Button variant="secondary" disabled={busy} onClick={() => void changeJobStatus('open')}>
              Reopen
            </Button>
          )}
          {job.status !== 'closed' && (
            <>
              {job.status === 'open' && (
                <>
                  <Button variant="secondary" onClick={() => setShowAdd((v) => !v)}>
                    {showAdd ? 'Cancel' : 'Add candidate'}
                  </Button>
                  <Button variant="secondary" onClick={() => setShowBulk((v) => !v)}>
                    {showBulk ? 'Hide bulk upload' : 'Bulk upload résumés'}
                  </Button>
                </>
              )}
              <Button variant="secondary" onClick={() => setShowClose((v) => !v)}>
                Close job
              </Button>
            </>
          )}
        </div>
      </div>

      {actionError && <p className="text-sm text-[#f4212e]">{actionError}</p>}

      {emailRetryNotice && (
        <p role="status" className="text-sm text-emerald-700">
          {emailRetryNotice}
        </p>
      )}

      {emailDelivery.failed > 0 && (
        <section
          role="alert"
          aria-labelledby="email-delivery-failure-title"
          className="rounded-2xl border border-amber-300 bg-amber-50 p-5 space-y-3"
        >
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <h2 id="email-delivery-failure-title" className="text-sm font-semibold text-amber-950">
                {emailDelivery.failed} rejection {emailDelivery.failed === 1 ? 'email' : 'emails'} could not be delivered
              </h2>
              <p className="mt-1 text-xs text-amber-900">
                Automatic delivery stopped after repeated provider failures. Retrying
                requeues only these failed messages; sent and in-flight email is untouched.
              </p>
            </div>
            <Button
              variant="secondary"
              disabled={retryingEmails}
              onClick={() => void retryFailedEmails()}
            >
              {retryingEmails
                ? 'Requeuing…'
                : `Retry failed ${emailDelivery.failed === 1 ? 'email' : 'emails'}`}
            </Button>
          </div>
          <ul className="space-y-1 text-xs text-amber-950">
            {emailDelivery.failures.map((failure, index) => (
              <li key={`${failure.recipientEmail}:${failure.failedAt}:${index}`}>
                {failure.recipientName} ({failure.recipientEmail}) · {failure.attempts}{' '}
                attempts
                {failure.lastError ? ` · ${failure.lastError}` : ''}
              </li>
            ))}
          </ul>
        </section>
      )}

      {showBulk && job.status === 'open' && (
        <BulkUploadPanel jobId={params.jobId} onSettled={() => void load()} />
      )}

      {job.status === 'open' && (
        <div className="bg-white border border-[#e1e8ed] rounded-2xl p-5 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-[#0f1419]">Public apply link</p>
              <p className="text-xs text-[#71767b] mt-0.5">
                Share anywhere — applicants submit their résumé straight into this
                pipeline, scored against the JD. No account needed on their side.
              </p>
            </div>
            <div className="shrink-0 flex gap-2">
              <Button variant="secondary" disabled={applyBusy} onClick={() => void issueApplyLink()}>
                {job.applyPageEnabled ? 'Replace link' : 'Create link'}
              </Button>
              {job.applyPageEnabled && (
                <Button variant="secondary" disabled={applyBusy} onClick={() => void disableApplyLink()}>
                  Turn off
                </Button>
              )}
            </div>
          </div>
          {applyLink && (
            <div className="space-y-1.5">
              <input
                readOnly
                value={applyLink}
                onFocus={(e) => e.currentTarget.select()}
                className="w-full px-3 py-2 border border-[#e1e8ed] rounded-xl bg-[#f8fafc] text-xs font-mono"
              />
              <p className="text-xs text-[#f4212e]">
                Copy this now — it is shown only once. Creating a replacement link
                immediately stops the previous one from working.
              </p>
            </div>
          )}
          {!applyLink && job.applyPageEnabled && (
            <p className="text-xs text-[#71767b]">
              A link is live. The URL cannot be shown again — use Replace link to issue a
              new one (which disables the old).
            </p>
          )}
        </div>
      )}

      {showClose && (
        <form onSubmit={closeJob} className="bg-white border border-[#e1e8ed] rounded-2xl p-5 space-y-3">
          <p className="text-sm font-medium text-[#0f1419]">
            Close this job — a decision note is required.
          </p>
          <p className="text-xs text-[#71767b]">
            Every candidate without a final decision will be moved to Rejected with your
            name and timestamp recorded, and one rejection email will be queued for each.
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

      {showAdd && job.status === 'open' && (
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
          description={
            job.status === 'open'
              ? 'Add your first candidate — then send them the AI interview from their card.'
              : 'Reopen this job before adding candidates.'
          }
          action={
            job.status === 'open'
              ? { label: 'Add candidate', onClick: () => setShowAdd(true) }
              : undefined
          }
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
                    const terminal = stage === 'hired' || stage === 'rejected' || stage === 'withdrawn'
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
                                {stage === 'offer' ? (
                                  <>
                                    <Button
                                      size="sm"
                                      variant="secondary"
                                      disabled={busy}
                                      onClick={() =>
                                        setNoteFor({
                                          appId: en.application.id,
                                          expectedFrom: stage,
                                          action: 'offer_accepted',
                                        })
                                      }
                                    >
                                      Offer accepted
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="secondary"
                                      disabled={busy}
                                      onClick={() =>
                                        void moveStage(
                                          en.application.id,
                                          stage,
                                          'offer_declined',
                                        )
                                      }
                                    >
                                      Offer declined
                                    </Button>
                                  </>
                                ) : (
                                  <Button
                                    size="sm"
                                    variant="secondary"
                                    disabled={busy}
                                    onClick={() =>
                                      void moveStage(en.application.id, stage, 'advance')
                                    }
                                  >
                                    Advance
                                  </Button>
                                )}
                                {stage !== 'offer' && (
                                  <Button
                                    size="sm"
                                    variant="secondary"
                                    disabled={busy}
                                    onClick={() =>
                                      void moveStage(en.application.id, stage, 'reject')
                                    }
                                  >
                                    Reject
                                  </Button>
                                )}
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  disabled={busy}
                                  onClick={() => void moveStage(en.application.id, stage, 'withdraw')}
                                >
                                  Withdraw
                                </Button>
                              </>
                            )}
                          </div>
                        </div>
                        {needsNote && (
                          <div className="mt-3 space-y-2">
                            <p className="text-xs text-[#536471]">
                              Record why the candidate accepted the offer and should be hired.
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
                                onClick={() =>
                                  void moveStage(
                                    en.application.id,
                                    noteFor.expectedFrom,
                                    noteFor.action,
                                    note.trim(),
                                  )
                                }
                              >
                                Confirm hire
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
                        {en.application.offerDecision && (
                          <p className="mt-2 text-xs text-[#536471]">
                            Offer {en.application.offerDecision.outcome} · recorded by{' '}
                            {en.application.offerDecision.actorName} ·{' '}
                            {new Date(en.application.offerDecision.at).toLocaleString()}
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
