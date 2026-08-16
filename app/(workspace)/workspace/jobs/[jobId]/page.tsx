'use client'

/**
 * Job pipeline board — the operating screen. Applications grouped by the
 * fixed stages; every card carries its evidence chip (AI score / round
 * status) and explicit Advance / Reject buttons. Stage moves record the
 * acting member server-side; closing the job requires a decision note.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import Badge from '@shared/ui/Badge'
import Button from '@shared/ui/Button'
import Input from '@shared/ui/Input'
import StateView from '@shared/ui/StateView'
import { scoreBand } from '@shared/ui/ScoreBar'
import BulkUploadPanel from './BulkUploadPanel'
import PoolSuggestionPanel from './PoolSuggestionPanel'
import ScreeningPanel from './ScreeningPanel'

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
    resumeMatch: {
      score: number | null
      stale: boolean
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
  /** Separate from engine-backed latestRound; this is human evidence only. */
  humanRoundSummary?: {
    total: number
    completed: number
    pendingScorecard: number
    revoked: number
    rounds: Array<{
      id: string
      mode: 'guest_kit' | 'member_room'
      status: 'pending_scorecard' | 'completed' | 'revoked'
      openedAt: string | null
      scorecardSubmittedAt: string | null
      revokedAt: string | null
      createdAt: string
    }>
  }
  ranking: {
    scoreState: 'scored' | 'stale' | 'unscored'
    rank: number | null
  }
  previouslySeenIn: Array<{
    jobId: string
    jobTitle: string
    stage: Stage
  }>
}

interface JobDetail {
  id: string
  departmentId: string
  title: string
  status: 'open' | 'on_hold' | 'closed'
  closeNote: string | null
  closedByName: string | null
  jdText: string
  /** Public apply page live? The token itself is never sent to the client. */
  applyPageEnabled: boolean
}

interface DuplicatedJobNotice {
  jobId: string
  title: string
  applyLink: string
}

interface DepartmentRow {
  id: string
  name: string
  status: 'active' | 'archived'
  kind: string
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

const MANUAL_INTAKE_TASK_STATUSES = [
  'queued',
  'processing',
  'needs_identity',
  'completed',
  'failed',
  'cancelled',
] as const
type ManualIntakeTaskStatus = (typeof MANUAL_INTAKE_TASK_STATUSES)[number]
type ManualIntakeDispatchStatus = 'pending' | 'dispatched' | 'failed'

interface ManualIntakeTask {
  taskId: string
  status: ManualIntakeTaskStatus
  attempts: number
  dispatch: {
    status: ManualIntakeDispatchStatus
    attempts: number
    /** A controlled delivery code, never a provider exception. */
    lastErrorCode?: 'inngest_dispatch_unavailable'
  }
  applicationId?: string
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

function humanRoundChip(summary: Entry['humanRoundSummary']): {
  label: string
  variant: 'default' | 'success' | 'caution'
} | null {
  if (!summary || summary.total === 0) return null
  if (summary.pendingScorecard > 0) {
    return {
      label: `${summary.pendingScorecard} human scorecard${summary.pendingScorecard === 1 ? '' : 's'} pending`,
      variant: 'caution',
    }
  }
  if (summary.completed > 0) {
    return {
      label: `${summary.completed} human scorecard${summary.completed === 1 ? '' : 's'} submitted`,
      variant: 'success',
    }
  }
  return { label: 'Human round revoked', variant: 'default' }
}

function rankingChip(entry: Entry): {
  label: string
  variant: 'default' | 'primary' | 'success' | 'caution'
} {
  const score = entry.application.resumeMatch?.score
  if (entry.ranking.scoreState === 'scored') {
    return {
      label: entry.ranking.rank === null
        ? `JD match ${score ?? '—'}`
        : `Pool rank #${entry.ranking.rank} · ${score ?? '—'}`,
      variant: 'success',
    }
  }
  if (entry.ranking.scoreState === 'stale') {
    return { label: 'JD match needs refresh', variant: 'caution' }
  }
  return { label: 'JD match pending', variant: 'default' }
}

function isManualIntakeTaskStatus(value: unknown): value is ManualIntakeTaskStatus {
  return typeof value === 'string' && MANUAL_INTAKE_TASK_STATUSES.includes(value as ManualIntakeTaskStatus)
}

function readManualIntakeTask(value: unknown): ManualIntakeTask | null {
  if (!value || typeof value !== 'object') return null
  const task = value as Record<string, unknown>
  if (typeof task.taskId !== 'string' || !isManualIntakeTaskStatus(task.status)) return null

  const rawDispatch = task.dispatch && typeof task.dispatch === 'object'
    ? task.dispatch as Record<string, unknown>
    : {}
  const dispatchStatus: ManualIntakeDispatchStatus = rawDispatch.status === 'dispatched' || rawDispatch.status === 'failed'
    ? rawDispatch.status
    : 'pending'

  return {
    taskId: task.taskId,
    status: task.status,
    attempts: typeof task.attempts === 'number' && task.attempts >= 0 ? task.attempts : 0,
    dispatch: {
      status: dispatchStatus,
      attempts: typeof rawDispatch.attempts === 'number' && rawDispatch.attempts >= 0
        ? rawDispatch.attempts
        : 0,
      ...(rawDispatch.lastErrorCode === 'inngest_dispatch_unavailable'
        ? { lastErrorCode: rawDispatch.lastErrorCode }
        : {}),
    },
    ...(typeof task.applicationId === 'string' ? { applicationId: task.applicationId } : {}),
  }
}

function isManualIntakePolling(status: ManualIntakeTaskStatus | undefined): boolean {
  return status === 'queued' || status === 'processing'
}

function manualIntakeStatusMessage(task: ManualIntakeTask): string {
  if (task.status === 'queued' && task.dispatch.status === 'failed') {
    return 'Résumé saved. The queue handoff is delayed; automatic recovery will retry.'
  }
  if (task.status === 'queued') return 'Résumé queued for parsing and JD scoring.'
  if (task.status === 'processing') return 'Parsing the résumé and scoring it against this job description.'
  if (task.status === 'needs_identity') {
    return 'This résumé needs a confirmed email before JD scoring can continue.'
  }
  if (task.status === 'completed') return 'Candidate added. The pipeline now shows its JD-match state.'
  if (task.status === 'cancelled') return 'This intake was cancelled because the job is no longer accepting candidates.'
  return 'This résumé could not be processed. Upload a corrected file or use Quick add.'
}

function selectableDepartments(departments: DepartmentRow[]): DepartmentRow[] {
  return departments.filter(
    (department) => department.status === 'active' && department.kind === 'standard',
  )
}

export default function JobPipelinePage({ params }: { params: { jobId: string } }) {
  const router = useRouter()
  const [job, setJob] = useState<JobDetail | null>(null)
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [pool, setPool] = useState<PoolCandidate[]>([])
  const [departments, setDepartments] = useState<DepartmentRow[]>([])
  const [workspaceRole, setWorkspaceRole] = useState<'admin' | 'member' | null>(null)
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
  const [showDuplicate, setShowDuplicate] = useState(false)
  const [duplicateBusy, setDuplicateBusy] = useState(false)
  const [duplicateDepartmentId, setDuplicateDepartmentId] = useState('')
  const [duplicatedJob, setDuplicatedJob] = useState<DuplicatedJobNotice | null>(null)
  const [duplicateLinkCopied, setDuplicateLinkCopied] = useState(false)
  const [showDepartmentEditor, setShowDepartmentEditor] = useState(false)
  const [reassignDepartmentId, setReassignDepartmentId] = useState('')
  const [reassignBusy, setReassignBusy] = useState(false)
  const [addName, setAddName] = useState('')
  const [addEmail, setAddEmail] = useState('')
  const [addResumeFile, setAddResumeFile] = useState<File | null>(null)
  const [manualIntakeTask, setManualIntakeTask] = useState<ManualIntakeTask | null>(null)
  const [selectedPoolId, setSelectedPoolId] = useState('')
  const [addCommand, setAddCommand] = useState<{
    key: string
    operationId: string
  } | null>(null)
  const [showClose, setShowClose] = useState(false)
  const [showDelete, setShowDelete] = useState(false)
  const [deleteConfirmationTitle, setDeleteConfirmationTitle] = useState('')
  const [deleteAcknowledged, setDeleteAcknowledged] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [closeNote, setCloseNote] = useState('')
  const [useCustomCloseEmail, setUseCustomCloseEmail] = useState(false)
  const [closeEmailSubject, setCloseEmailSubject] = useState('')
  const [closeEmailBody, setCloseEmailBody] = useState('')
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

  const loadDepartmentContext = useCallback(async () => {
    try {
      const [departmentsResponse, workspaceResponse] = await Promise.all([
        fetch('/api/workspace/departments', { cache: 'no-store' }),
        fetch('/api/workspace', { cache: 'no-store' }),
      ])
      const [departmentsData, workspaceData] = await Promise.all([
        departmentsResponse.json().catch(() => ({})),
        workspaceResponse.json().catch(() => ({})),
      ])
      if (departmentsResponse.ok && Array.isArray(departmentsData.departments)) {
        setDepartments(departmentsData.departments as DepartmentRow[])
      }
      if (workspaceResponse.ok) {
        setWorkspaceRole(workspaceData.membership?.role === 'admin' ? 'admin' : 'member')
      }
    } catch {
      // Job operations stay available even if the contextual catalog read is
      // temporarily unavailable. The server still enforces every assignment.
    }
  }, [])

  useEffect(() => {
    void load()
    void loadDepartmentContext()
    fetch('/api/workspace/candidates')
      .then((r) => r.json())
      .then((d) => setPool(d.candidates ?? []))
      .catch(() => {})
  }, [load, loadDepartmentContext])

  useEffect(() => {
    const taskId = manualIntakeTask?.taskId
    const taskStatus = manualIntakeTask?.status
    if (!taskId || !isManualIntakePolling(taskStatus)) return

    let disposed = false
    async function pollManualIntakeTask() {
      try {
        const response = await fetch(`/api/workspace/jobs/${params.jobId}/intake/${taskId}`, {
          cache: 'no-store',
        })
        const data = await response.json().catch(() => null)
        if (!response.ok || disposed) return
        const nextTask = readManualIntakeTask((data as { task?: unknown } | null)?.task)
        if (!nextTask || nextTask.taskId !== taskId) return
        setManualIntakeTask((current) => current?.taskId === taskId ? nextTask : current)
        if (nextTask.status === 'completed') void load()
      } catch {
        // The durable task remains server-side. Keep its last safe state and
        // retry on the next interval rather than treating a poll miss as loss.
      }
    }

    void pollManualIntakeTask()
    const interval = window.setInterval(() => void pollManualIntakeTask(), 3_000)
    return () => {
      disposed = true
      window.clearInterval(interval)
    }
  }, [load, manualIntakeTask?.status, manualIntakeTask?.taskId, params.jobId])

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

  function openDuplicateDialog() {
    setActionError(null)
    setDuplicateLinkCopied(false)
    setDuplicateDepartmentId('')
    setDuplicatedJob(null)
    setShowDuplicate(true)
  }

  function dismissDuplicateDialog() {
    // The public-apply capability is intentionally only held in component
    // memory. Clearing this panel also removes it from the rendered DOM.
    setDuplicateLinkCopied(false)
    setDuplicatedJob(null)
    setShowDuplicate(false)
  }

  async function duplicateCurrentJob() {
    if (!duplicateDepartmentId) {
      setActionError('Choose a department for the duplicate.')
      return
    }
    setDuplicateBusy(true)
    setActionError(null)
    try {
      const res = await fetch(`/api/workspace/jobs/${params.jobId}/duplicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ departmentId: duplicateDepartmentId }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || typeof data.capability !== 'string' || typeof data.job?.id !== 'string') {
        setActionError(data.error || 'Could not duplicate this job.')
        return
      }
      // This capability is shown in a transient, authenticated confirmation
      // surface only. It is never placed in a query string or browser storage.
      setDuplicatedJob({
        jobId: data.job.id,
        title: typeof data.job.title === 'string' ? data.job.title : 'New job',
        applyLink: `${window.location.origin}/apply#apply=${encodeURIComponent(data.capability)}`,
      })
      setDuplicateLinkCopied(false)
    } catch {
      setActionError('Something went wrong. Check your connection.')
    } finally {
      setDuplicateBusy(false)
    }
  }

  function openDepartmentEditor() {
    const assignable = selectableDepartments(departments)
    setActionError(null)
    setReassignDepartmentId(
      assignable.some((department) => department.id === job?.departmentId)
        ? job?.departmentId ?? ''
        : '',
    )
    setShowDepartmentEditor(true)
  }

  async function reassignJobDepartment() {
    if (!reassignDepartmentId) {
      setActionError('Choose an active department for this job.')
      return
    }
    setReassignBusy(true)
    setActionError(null)
    try {
      const response = await fetch(`/api/workspace/jobs/${params.jobId}/department`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ departmentId: reassignDepartmentId }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        setActionError(data.error || 'Could not update the job department.')
        return
      }
      setShowDepartmentEditor(false)
      await load()
      await loadDepartmentContext()
    } catch {
      setActionError('Something went wrong. Check your connection.')
    } finally {
      setReassignBusy(false)
    }
  }

  async function copyDuplicateApplyLink() {
    if (!duplicatedJob) return
    try {
      await navigator.clipboard.writeText(duplicatedJob.applyLink)
      setDuplicateLinkCopied(true)
    } catch {
      setActionError('Clipboard access was blocked. Select and copy the link below.')
    }
  }

  async function addToJob(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setActionError(null)
    try {
      const name = addName.trim()
      const email = addEmail.trim()
      if (!selectedPoolId && addResumeFile) {
        const formData = new FormData()
        formData.append('file', addResumeFile)
        formData.append('name', name)
        formData.append('email', email)
        const response = await fetch(`/api/workspace/jobs/${params.jobId}/intake`, {
          method: 'POST',
          body: formData,
        })
        const data = await response.json().catch(() => null)
        if (!response.ok) {
          const message = data && typeof data === 'object' &&
            typeof (data as { error?: unknown }).error === 'string'
            ? (data as { error: string }).error
            : 'Could not queue the résumé for JD scoring.'
          setActionError(message)
          return
        }
        const task = readManualIntakeTask((data as { task?: unknown } | null)?.task)
        if (!task) {
          setActionError('The résumé was accepted but its safe queue status was unavailable. Refresh this job.')
          return
        }
        setManualIntakeTask(task)
        setAddName('')
        setAddEmail('')
        setAddResumeFile(null)
        setAddCommand(null)
        return
      }
      const key = selectedPoolId
        ? `pool:${selectedPoolId}`
        : `manual:${name.toLowerCase()}:${email.toLowerCase()}`
      // Keep one command id only while retrying the same intent. The server
      // records it on the application event, preventing a network retry from
      // producing another re-application event/card.
      const operationId =
        addCommand?.key === key ? addCommand.operationId : crypto.randomUUID()
      setAddCommand({ key, operationId })
      const res = await fetch(`/api/workspace/jobs/${params.jobId}/candidates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          selectedPoolId
            ? { candidateId: selectedPoolId, operationId }
            : { name, email, operationId },
        ),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (data.status === 'already_considered') {
          setActionError(
            'This candidate has already been considered for this role. Reinstatement requires an explicit recruiter stage decision.',
          )
          setAddCommand(null)
          return
        }
        if (data.status === 'already_decided') {
          setActionError(
            'This candidate already has a final decision for this role and cannot be added again automatically.',
          )
          setAddCommand(null)
          return
        }
        setActionError(data.error || 'Could not add the candidate to this job.')
        return
      }
      setAddName('')
      setAddEmail('')
      setSelectedPoolId('')
      setAddCommand(null)
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
          ...(useCustomCloseEmail
            ? {
                closeEmailTemplate: {
                  subject: closeEmailSubject,
                  body: closeEmailBody,
                },
              }
            : {}),
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setActionError(data.details?.[0]?.message || data.error || 'Could not close the job.')
        return
      }
      setShowClose(false)
      setCloseOperationId(null)
      setUseCustomCloseEmail(false)
      setCloseEmailSubject('')
      setCloseEmailBody('')
      await load()
    } catch {
      setActionError('Something went wrong. Check your connection.')
    } finally {
      setBusy(false)
    }
  }

  function openDeleteDialog() {
    setActionError(null)
    setDeleteConfirmationTitle('')
    setDeleteAcknowledged(false)
    setShowDelete(true)
  }

  function dismissDeleteDialog() {
    setShowDelete(false)
    setDeleteConfirmationTitle('')
    setDeleteAcknowledged(false)
  }

  async function deleteEmptyJob() {
    if (!job) return
    setDeleteBusy(true)
    setActionError(null)
    try {
      const response = await fetch(`/api/workspace/jobs/${params.jobId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirmationTitle: deleteConfirmationTitle,
          acknowledgeEmptyJobDeletion: true,
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        setActionError(data.error || 'Could not delete this job.')
        return
      }
      router.replace('/workspace/jobs')
      router.refresh()
    } catch {
      setActionError('Something went wrong. Check your connection.')
    } finally {
      setDeleteBusy(false)
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
  // Keep a single, compact visual ordering for the automatically ranked part
  // of the pool. The detailed board below remains stage-based for operations,
  // but it must not hide the low end of a 50-resume intake behind every other
  // job-management panel or stage column.
  const rankedEntries = entries
    .filter((entry) => entry.ranking.scoreState === 'scored' && entry.ranking.rank !== null)
    .sort((left, right) => (left.ranking.rank ?? Number.MAX_SAFE_INTEGER) - (right.ranking.rank ?? Number.MAX_SAFE_INTEGER))
  const assignableDepartments = selectableDepartments(departments)
  const departmentName = departments.find((department) => department.id === job.departmentId)?.name
    ?? 'Department unavailable'
  const canAttemptDelete =
    workspaceRole === 'admin' &&
    job.status !== 'closed' &&
    !job.applyPageEnabled &&
    entries.length === 0
  const deleteConfirmationMatches =
    deleteConfirmationTitle.normalize('NFKC').trim() === job.title.normalize('NFKC').trim()

  return (
    <div id="job-pipeline-top" className="space-y-6">
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
            <span className="text-xs text-[#536471]">
              Department: <span className="font-medium text-[#0f1419]">{departmentName}</span>
            </span>
            <Link
              href={`/workspace/jobs/${job.id}/decision`}
              className="text-xs font-medium text-indigo-600 hover:underline"
            >
              Decision workspace
            </Link>
            {job.closeNote && (
              <span className="text-xs text-[#71767b]">
                Decision{job.closedByName ? ` by ${job.closedByName}` : ''}: {job.closeNote}
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 shrink-0">
          <Button
            variant="secondary"
            disabled={busy || duplicateBusy || Boolean(duplicatedJob)}
            onClick={openDuplicateDialog}
          >
            Duplicate job
          </Button>
          {workspaceRole === 'admin' && (
            <Button
              type="button"
              variant="secondary"
              disabled={reassignBusy}
              onClick={openDepartmentEditor}
            >
              Change department
            </Button>
          )}
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
          {workspaceRole === 'admin' && job.status !== 'closed' && (
            <Button
              type="button"
              variant="danger"
              disabled={!canAttemptDelete || deleteBusy}
              title={
                job.applyPageEnabled
                  ? 'Turn off the public apply link before deleting this job.'
                  : entries.length > 0
                  ? 'Jobs with candidates must be closed instead of deleted.'
                  : undefined
              }
              onClick={openDeleteDialog}
            >
              Delete empty job
            </Button>
          )}
        </div>
      </div>

      {actionError && <p className="text-sm text-[#f4212e]">{actionError}</p>}

      {showDepartmentEditor && workspaceRole === 'admin' && (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void reassignJobDepartment()
          }}
          aria-labelledby="change-job-department-title"
          className="rounded-2xl border border-[#e1e8ed] bg-white p-5"
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0 flex-1">
              <h2 id="change-job-department-title" className="text-sm font-semibold text-[#0f1419]">
                Change department
              </h2>
              <p className="mt-1 text-xs text-[#71767b]">
                This updates the job&apos;s tracking department without changing its candidates,
                interviews, or lifecycle status.
              </p>
              <label htmlFor="job-department" className="mt-3 block text-sm font-medium text-[#0f1419]">
                Department
              </label>
              <select
                id="job-department"
                value={reassignDepartmentId}
                onChange={(event) => setReassignDepartmentId(event.target.value)}
                required
                disabled={reassignBusy || assignableDepartments.length === 0}
                className="mt-1 w-full max-w-md rounded-xl border border-[#e1e8ed] bg-[#f8fafc] px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
              >
                <option value="">Select an active department</option>
                {assignableDepartments.map((department) => (
                  <option key={department.id} value={department.id}>
                    {department.name}
                  </option>
                ))}
              </select>
              {assignableDepartments.length === 0 && (
                <p className="mt-2 text-xs text-amber-700">
                  No active departments are available. Restore or add one before reassigning this job.
                </p>
              )}
            </div>
            <div className="flex shrink-0 gap-2">
              <Button
                type="button"
                variant="secondary"
                disabled={reassignBusy}
                onClick={() => setShowDepartmentEditor(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={reassignBusy || !reassignDepartmentId}
              >
                {reassignBusy ? 'Saving…' : 'Save department'}
              </Button>
            </div>
          </div>
        </form>
      )}

      {showDuplicate && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/30 p-4"
          role="presentation"
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="duplicate-job-title"
            className="w-full max-w-lg rounded-2xl border border-[#e1e8ed] bg-white p-6 shadow-xl"
          >
            {!duplicatedJob ? (
              <div className="space-y-4">
                <div>
                  <h2 id="duplicate-job-title" className="text-lg font-semibold text-[#0f1419]">
                    Duplicate this job?
                  </h2>
                  <p className="mt-1 text-sm text-[#536471]">
                    We&apos;ll copy the JD, structured requirements, and job settings into a
                    new requisition. It starts with zero candidates and a fresh public apply
                    link.
                  </p>
                </div>
                <div>
                  <label
                    htmlFor="duplicate-job-department"
                    className="block text-sm font-medium text-[#0f1419]"
                  >
                    Department for duplicate
                  </label>
                  <select
                    id="duplicate-job-department"
                    value={duplicateDepartmentId}
                    onChange={(event) => setDuplicateDepartmentId(event.target.value)}
                    required
                    disabled={duplicateBusy || assignableDepartments.length === 0}
                    className="mt-1 w-full rounded-xl border border-[#e1e8ed] bg-[#f8fafc] px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <option value="">Select an active department</option>
                    {assignableDepartments.map((department) => (
                      <option key={department.id} value={department.id}>
                        {department.name}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-[#71767b]">
                    Choose explicitly for the new requisition. The source department is {departmentName}.
                  </p>
                  {assignableDepartments.length === 0 && (
                    <p className="mt-2 text-xs text-amber-700">
                      No active departments are available. Add or restore one before duplicating this job.
                    </p>
                  )}
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="secondary" type="button" disabled={duplicateBusy} onClick={dismissDuplicateDialog}>
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    disabled={duplicateBusy || !duplicateDepartmentId}
                    onClick={() => void duplicateCurrentJob()}
                  >
                    {duplicateBusy ? 'Duplicating…' : 'Create duplicate'}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <h2 id="duplicate-job-title" className="text-lg font-semibold text-[#0f1419]">
                    Job duplicated
                  </h2>
                  <p className="mt-1 text-sm text-[#536471]">
                    <span className="font-medium text-[#0f1419]">{duplicatedJob.title}</span> is ready.
                    Copy its fresh apply link before continuing — it is displayed only for
                    this confirmation.
                  </p>
                </div>
                <input
                  aria-label="Fresh public apply link"
                  readOnly
                  value={duplicatedJob.applyLink}
                  onFocus={(event) => event.currentTarget.select()}
                  className="w-full px-3 py-2 border border-[#e1e8ed] rounded-xl bg-[#f8fafc] text-xs font-mono"
                />
                <p className="text-xs text-[#f4212e]">
                  Copy this now. Closing this confirmation removes the link from this screen.
                </p>
                <div className="flex justify-end gap-2 flex-wrap">
                  <Button type="button" variant="secondary" onClick={() => void copyDuplicateApplyLink()}>
                    {duplicateLinkCopied ? 'Copied' : 'Copy apply link'}
                  </Button>
                  <Link
                    href={`/workspace/jobs/${duplicatedJob.jobId}`}
                    onClick={dismissDuplicateDialog}
                    className="inline-flex h-9 items-center justify-center rounded-full bg-[#2563eb] px-5 text-sm font-semibold text-white shadow-sm transition-all hover:bg-[#1d4ed8] hover:shadow-md active:scale-[0.97]"
                  >
                    Continue to new job
                  </Link>
                </div>
              </div>
            )}
          </section>
        </div>
      )}

      {showDelete && workspaceRole === 'admin' && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/30 p-4"
          role="presentation"
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-empty-job-title"
            className="w-full max-w-lg rounded-2xl border border-red-200 bg-white p-6 shadow-xl"
          >
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault()
                void deleteEmptyJob()
              }}
            >
              <div>
                <h2 id="delete-empty-job-title" className="text-lg font-semibold text-[#0f1419]">
                  Delete this empty job?
                </h2>
                <p className="mt-1 text-sm text-[#536471]">
                  This permanently removes the requisition and its job-description revisions.
                  It will not delete candidate, interview, report, or media data. If any hiring
                  activity exists, the server will stop this action and you should close the job instead.
                </p>
              </div>
              <div>
                <label
                  htmlFor="delete-empty-job-confirmation"
                  className="block text-sm font-medium text-[#0f1419]"
                >
                  Type <span className="font-semibold">{job.title}</span> to confirm
                </label>
                <input
                  id="delete-empty-job-confirmation"
                  value={deleteConfirmationTitle}
                  onChange={(event) => setDeleteConfirmationTitle(event.target.value)}
                  autoComplete="off"
                  disabled={deleteBusy}
                  className="mt-1 w-full rounded-xl border border-[#e1e8ed] bg-[#f8fafc] px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                />
              </div>
              <label className="flex items-start gap-2 text-sm text-[#0f1419]">
                <input
                  type="checkbox"
                  checked={deleteAcknowledged}
                  onChange={(event) => setDeleteAcknowledged(event.target.checked)}
                  disabled={deleteBusy}
                />
                <span>I understand that this permanently deletes an empty requisition.</span>
              </label>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={deleteBusy}
                  onClick={dismissDeleteDialog}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="danger"
                  disabled={deleteBusy || !deleteAcknowledged || !deleteConfirmationMatches}
                >
                  {deleteBusy ? 'Deleting…' : 'Delete job permanently'}
                </Button>
              </div>
            </form>
          </section>
        </div>
      )}

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

      {rankedEntries.length > 0 ? (
        <>
          <nav
            aria-label="Ranked candidate queue"
            className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-indigo-100 bg-indigo-50 px-4 py-3 text-sm text-indigo-950"
          >
            <span className="font-medium">
              {rankedEntries.length} fresh JD-match {rankedEntries.length === 1 ? 'score' : 'scores'} ranked
            </span>
            <a href="#ranked-queue" className="font-medium text-indigo-700 hover:underline">
              View ranked queue
            </a>
            <a href="#ranked-queue-bottom" className="font-medium text-indigo-700 hover:underline">
              Jump to rank #{rankedEntries.length}
            </a>
          </nav>

          <section
            id="ranked-queue"
            aria-labelledby="ranked-queue-title"
            className="scroll-mt-6 rounded-2xl border border-[#e1e8ed] bg-white p-5"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 id="ranked-queue-title" className="text-base font-semibold text-[#0f1419]">
                  Ranked queue · {rankedEntries.length}
                </h2>
                <p className="mt-1 text-xs text-[#71767b]">
                  Fresh JD-match scores, highest first. Use the direct jump above to reach the bottom-ranked candidate in a large batch.
                </p>
              </div>
              <a href="#job-pipeline-top" className="text-sm font-medium text-indigo-600 hover:underline">
                Back to job actions
              </a>
            </div>
            <ol className="mt-4 divide-y divide-[#e1e8ed] rounded-xl border border-[#e1e8ed]">
              {rankedEntries.map((entry, index) => {
                const rank = entry.ranking.rank as number
                const isLast = index === rankedEntries.length - 1
                return (
                  <li
                    key={entry.application.id}
                    id={isLast ? 'ranked-queue-bottom' : undefined}
                    className="scroll-mt-6 flex flex-wrap items-center gap-x-3 gap-y-1 p-3 text-sm"
                  >
                    <span className="font-semibold text-[#0f1419]">Rank #{rank}</span>
                    <Link
                      href={`/workspace/applications/${entry.application.id}`}
                      className="min-w-0 flex-1 truncate font-medium text-indigo-700 hover:underline"
                    >
                      {entry.candidate?.name ?? 'Unknown candidate'}
                    </Link>
                    <span className="text-xs text-[#536471]">
                      JD match {entry.application.resumeMatch?.score ?? '—'} · {STAGE_LABEL[entry.application.stage]}
                    </span>
                  </li>
                )
              })}
            </ol>
          </section>
        </>
      ) : null}

      {showBulk && job.status === 'open' && (
        <BulkUploadPanel jobId={params.jobId} onSettled={() => void load()} />
      )}

      <PoolSuggestionPanel jobId={params.jobId} jobStatus={job.status} />

      <ScreeningPanel jobId={params.jobId} jobStatus={job.status} />

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
          <p className="text-xs text-[#71767b]">
            This decision note stays internal and is never included in candidate email.
          </p>
          <label className="flex items-center gap-2 text-sm text-[#0f1419]">
            <input
              type="checkbox"
              checked={useCustomCloseEmail}
              onChange={(e) => setUseCustomCloseEmail(e.target.checked)}
            />
            Customize the candidate rejection email
          </label>
          {useCustomCloseEmail && (
            <div className="space-y-3 rounded-xl border border-[#e1e8ed] bg-[#f8fafc] p-3">
              <p className="text-xs text-[#71767b]">
                Plain text only. You may use {'{candidate_first_name}'}, {'{job_title}'},
                and {'{workspace_name}'}. Each recipient gets an immutable copy when the
                job closes.
              </p>
              <div>
                <label htmlFor="close-email-subject" className="mb-1 block text-xs font-medium text-[#0f1419]">
                  Candidate email subject
                </label>
                <input
                  id="close-email-subject"
                  value={closeEmailSubject}
                  onChange={(e) => setCloseEmailSubject(e.target.value)}
                  required
                  maxLength={200}
                  placeholder="Update on your {job_title} application"
                  className="w-full px-3 py-2 border border-[#e1e8ed] rounded-xl bg-white text-sm"
                />
              </div>
              <div>
                <label htmlFor="close-email-body" className="mb-1 block text-xs font-medium text-[#0f1419]">
                  Candidate email body
                </label>
                <textarea
                  id="close-email-body"
                  value={closeEmailBody}
                  onChange={(e) => setCloseEmailBody(e.target.value)}
                  required
                  maxLength={4000}
                  rows={6}
                  placeholder={'Hi {candidate_first_name},\n\nThank you for your time interviewing for {job_title}.'}
                  className="w-full px-3 py-2 border border-[#e1e8ed] rounded-xl bg-white text-sm"
                />
              </div>
            </div>
          )}
          <Button
            type="submit"
            disabled={
              busy ||
              closeNote.trim().length < 5 ||
              (useCustomCloseEmail && (!closeEmailSubject.trim() || !closeEmailBody.trim()))
            }
          >
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
                onChange={(e) => {
                  setSelectedPoolId(e.target.value)
                  if (e.target.value) setAddResumeFile(null)
                }}
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
            <>
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
              <div className="space-y-1.5">
                <label htmlFor="manual-candidate-resume" className="text-sm font-medium text-[#0f1419] block">
                  Résumé <span className="font-normal text-[#71767b]">(optional)</span>
                </label>
                <input
                  id="manual-candidate-resume"
                  type="file"
                  accept=".pdf,.docx,.txt"
                  aria-describedby="manual-candidate-resume-help"
                  disabled={isManualIntakePolling(manualIntakeTask?.status)}
                  onChange={(event) => setAddResumeFile(event.target.files?.[0] ?? null)}
                  className="block w-full text-sm text-[#536471] file:mr-3 file:px-3 file:py-1.5 file:rounded-lg file:border-0 file:bg-[#e8f0fe] file:text-[#2563eb] file:font-medium"
                />
                <p id="manual-candidate-resume-help" className="text-xs text-[#71767b]">
                  Attach a résumé to use the durable queue and score it against this job description. Leave it empty to quick-add an unscored candidate.
                </p>
              </div>
            </>
          )}
          {manualIntakeTask ? (
            <div
              role="status"
              aria-live="polite"
              className="rounded-xl border border-[#dbeafe] bg-[#f8fbff] px-3 py-2 text-sm text-[#1d4ed8]"
            >
              {manualIntakeStatusMessage(manualIntakeTask)}
              {manualIntakeTask.status === 'queued' && manualIntakeTask.attempts > 0 ? (
                <span className="ml-1 text-[#536471]">Background attempt {manualIntakeTask.attempts}.</span>
              ) : null}
            </div>
          ) : null}
          <Button
            type="submit"
            disabled={
              busy ||
              isManualIntakePolling(manualIntakeTask?.status) ||
              (!selectedPoolId && (!addName.trim() || !addEmail.trim()))
            }
          >
            {busy
              ? 'Adding…'
              : selectedPoolId
                ? 'Add pool candidate (unscored)'
                : addResumeFile
                  ? 'Queue résumé & score against JD'
                  : 'Quick add (unscored)'}
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
                    const humanChip = humanRoundChip(en.humanRoundSummary)
                    const matchChip = rankingChip(en)
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
                            <Badge variant={matchChip.variant}>{matchChip.label}</Badge>
                            {chip && <Badge variant={chip.variant}>{chip.label}</Badge>}
                            {humanChip && <Badge variant={humanChip.variant}>{humanChip.label}</Badge>}
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
                        {en.previouslySeenIn.length > 0 && (
                          <p className="mt-2 text-xs text-indigo-700">
                            Previously seen in{' '}
                            {en.previouslySeenIn.map((seen, index) => (
                              <span key={seen.jobId}>
                                {index > 0 ? ', ' : ''}
                                <Link
                                  href={`/workspace/jobs/${seen.jobId}`}
                                  className="font-medium hover:underline"
                                >
                                  {seen.jobTitle}
                                </Link>
                                {' '}({STAGE_LABEL[seen.stage]})
                              </span>
                            ))}
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
