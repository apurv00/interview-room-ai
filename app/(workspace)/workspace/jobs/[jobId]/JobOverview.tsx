'use client'

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import Badge from '@shared/ui/Badge'
import Button from '@shared/ui/Button'
import StateView from '@shared/ui/StateView'
import JobSubnav from './JobSubnav'
import JobWorkspaceHeader from './JobWorkspaceHeader'

const STAGES = ['new', 'screened', 'interviewing', 'shortlist', 'offer', 'hired', 'rejected', 'withdrawn'] as const
type Stage = (typeof STAGES)[number]
type ManageAction = 'department' | 'duplicate' | 'close' | 'delete' | null

const STAGE_LABEL: Record<Stage, string> = {
  new: 'New', screened: 'Screened', interviewing: 'Interviewing', shortlist: 'Shortlist',
  offer: 'Offer', hired: 'Hired', rejected: 'Rejected', withdrawn: 'Withdrawn',
}

const ACTIVITY_LABEL: Record<string, string> = {
  application_created: 'Candidate applied',
  application_reapplied: 'Candidate reapplied',
  application_stage_changed: 'Candidate stage changed',
  ai_interview_sent: 'AI interview sent',
  ai_result_linked: 'AI interview result linked',
  human_interview_logged: 'Human interview logged',
  human_scorecard_submitted: 'Human scorecard submitted',
}

interface JobOverviewData {
  asOf: string
  job: {
    jobId: string
    title: string
    status: 'open' | 'on_hold' | 'closed'
    department: { id: string; name: string }
    createdAt: string
    daysOpen: number
  }
  counts: {
    total: number
    stages: Record<Stage, number>
    attention: { scoring: number; screening: number; interview: number; decision: number; offers: number }
  }
  recentActivity: Array<{ kind: string; occurredAt: string; actorName: string; applicationId: string }>
  acquisition: { applyPageEnabled: boolean }
  screening: {
    latestGate: null | { gateId: string; status: 'confirmed' | 'cancelled'; selectedCount: number; confirmedAt: string }
    latestBatch: null | { batchId: string; status: string; plannedCount: number; sentCount: number; failedCount: number; createdAt: string }
    delivery: { pending: number; sending: number; sent: number; failed: number; cancelled: number; skipped: number }
  }
}

interface DepartmentRow {
  id: string
  name: string
  status: 'active' | 'archived'
  kind: string
}

interface DuplicatedJob {
  id: string
  title: string
  applyLink: string
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function countRecord(value: unknown): Record<Stage, number> {
  const source = objectValue(value)
  return Object.fromEntries(STAGES.map((stage) => [stage, numberValue(source?.[stage])])) as Record<Stage, number>
}

function readOverview(value: unknown): JobOverviewData | null {
  const response = objectValue(value)
  const job = objectValue(response?.job)
  const department = objectValue(job?.department)
  const counts = objectValue(response?.counts)
  const attention = objectValue(counts?.attention)
  const acquisition = objectValue(response?.acquisition)
  const screening = objectValue(response?.screening)
  const delivery = objectValue(screening?.delivery)
  const latestGate = objectValue(screening?.latestGate)
  const latestBatch = objectValue(screening?.latestBatch)
  const jobId = stringValue(job?.jobId)
  const title = stringValue(job?.title)
  const status = job?.status
  const departmentId = stringValue(department?.id)
  const departmentName = stringValue(department?.name)
  const createdAt = stringValue(job?.createdAt)
  const asOf = stringValue(response?.asOf)
  if (!jobId || !title || !departmentId || !departmentName || !createdAt || !asOf || (status !== 'open' && status !== 'on_hold' && status !== 'closed')) return null
  const activity = Array.isArray(response?.recentActivity) ? response.recentActivity.flatMap((item) => {
    const row = objectValue(item)
    const kind = stringValue(row?.kind)
    const occurredAt = stringValue(row?.occurredAt)
    const actorName = stringValue(row?.actorName)
    const applicationId = stringValue(row?.applicationId)
    return kind && occurredAt && actorName && applicationId ? [{ kind, occurredAt, actorName, applicationId }] : []
  }) : []

  return {
    asOf,
    job: { jobId, title, status, department: { id: departmentId, name: departmentName }, createdAt, daysOpen: numberValue(job?.daysOpen) },
    counts: {
      total: numberValue(counts?.total),
      stages: countRecord(counts?.stages),
      attention: {
        scoring: numberValue(attention?.scoring), screening: numberValue(attention?.screening),
        interview: numberValue(attention?.interview), decision: numberValue(attention?.decision), offers: numberValue(attention?.offers),
      },
    },
    recentActivity: activity,
    acquisition: { applyPageEnabled: acquisition?.applyPageEnabled === true },
    screening: {
      latestGate: latestGate && stringValue(latestGate.gateId) && (latestGate.status === 'confirmed' || latestGate.status === 'cancelled') && stringValue(latestGate.confirmedAt)
        ? { gateId: String(latestGate.gateId), status: latestGate.status, selectedCount: numberValue(latestGate.selectedCount), confirmedAt: String(latestGate.confirmedAt) }
        : null,
      latestBatch: latestBatch && stringValue(latestBatch.batchId) && stringValue(latestBatch.status) && stringValue(latestBatch.createdAt)
        ? { batchId: String(latestBatch.batchId), status: String(latestBatch.status), plannedCount: numberValue(latestBatch.plannedCount), sentCount: numberValue(latestBatch.sentCount), failedCount: numberValue(latestBatch.failedCount), createdAt: String(latestBatch.createdAt) }
        : null,
      delivery: {
        pending: numberValue(delivery?.pending), sending: numberValue(delivery?.sending), sent: numberValue(delivery?.sent),
        failed: numberValue(delivery?.failed), cancelled: numberValue(delivery?.cancelled), skipped: numberValue(delivery?.skipped),
      },
    },
  }
}

function dateLabel(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? 'Unavailable' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function responseError(value: unknown, fallback: string): string {
  const response = objectValue(value)
  return stringValue(response?.error) ?? fallback
}

function operationId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `job-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export default function JobOverview({ jobId }: { jobId: string }) {
  const router = useRouter()
  const [overview, setOverview] = useState<JobOverviewData | null>(null)
  const [departments, setDepartments] = useState<DepartmentRow[]>([])
  const [workspaceRole, setWorkspaceRole] = useState<'admin' | 'member'>('member')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [manageAction, setManageAction] = useState<ManageAction>(null)
  const [departmentId, setDepartmentId] = useState('')
  const [duplicateDepartmentId, setDuplicateDepartmentId] = useState('')
  const [duplicatedJob, setDuplicatedJob] = useState<DuplicatedJob | null>(null)
  const [closeNote, setCloseNote] = useState('')
  const [customCloseEmail, setCustomCloseEmail] = useState(false)
  const [closeEmailSubject, setCloseEmailSubject] = useState('')
  const [closeEmailBody, setCloseEmailBody] = useState('')
  const [deleteTitle, setDeleteTitle] = useState('')
  const [deleteAcknowledged, setDeleteAcknowledged] = useState(false)
  const [applyLink, setApplyLink] = useState<string | null>(null)
  const [applyLinkState, setApplyLinkState] = useState<'idle' | 'loading' | 'available' | 'unavailable' | 'error'>('idle')
  const [pendingApplyLinkAction, setPendingApplyLinkAction] = useState<'replace' | 'disable' | null>(null)
  const manageDetailsRef = useRef<HTMLDetailsElement | null>(null)
  const manageTriggerRef = useRef<HTMLElement | null>(null)
  const manageSectionHeadingRef = useRef<HTMLHeadingElement | null>(null)
  const applyLinkTriggerRef = useRef<HTMLButtonElement | null>(null)
  const applyLinkConfirmationRef = useRef<HTMLDivElement | null>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch(`/api/workspace/jobs/${encodeURIComponent(jobId)}/summary`, { cache: 'no-store', signal })
      const raw = await response.json().catch(() => null)
      if (!response.ok) {
        if (!signal?.aborted) setError(responseError(raw, 'Could not load this job.'))
        return
      }
      const parsed = readOverview(raw)
      if (!parsed) {
        if (!signal?.aborted) setError('The job overview response was incomplete. Refresh and try again.')
        return
      }
      if (!signal?.aborted) setOverview(parsed)
    } catch {
      if (!signal?.aborted) setError('Could not load this job. Check your connection and try again.')
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [jobId])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    Promise.all([
      fetch('/api/workspace/departments', { cache: 'no-store', signal: controller.signal }).then((response) => response.json()),
      fetch('/api/workspace', { cache: 'no-store', signal: controller.signal }).then((response) => response.json()),
    ]).then(([departmentData, workspaceData]) => {
      if (Array.isArray(departmentData?.departments)) setDepartments(departmentData.departments)
      setWorkspaceRole(workspaceData?.membership?.role === 'admin' ? 'admin' : 'member')
    }).catch(() => {})
    return () => controller.abort()
  }, [load])

  useEffect(() => {
    if (!overview?.acquisition.applyPageEnabled) {
      setApplyLink(null)
      setApplyLinkState('idle')
      return
    }
    const controller = new AbortController()
    setApplyLinkState('loading')
    fetch(`/api/workspace/jobs/${encodeURIComponent(jobId)}/apply-link`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => ({ response, raw: await response.json().catch(() => null) }))
      .then(({ response, raw }) => {
        const capability = stringValue(objectValue(raw)?.capability)
        if (!response.ok) setApplyLinkState('error')
        else if (!capability) setApplyLinkState('unavailable')
        else {
          setApplyLink(`${window.location.origin}/apply#apply=${encodeURIComponent(capability)}`)
          setApplyLinkState('available')
        }
      }).catch(() => { if (!controller.signal.aborted) setApplyLinkState('error') })
    return () => controller.abort()
  }, [jobId, overview?.acquisition.applyPageEnabled])

  useEffect(() => {
    if (!pendingApplyLinkAction) return
    const dialog = applyLinkConfirmationRef.current
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? [])
    window.requestAnimationFrame(() => focusable()[0]?.focus())
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault()
        closeApplyLinkConfirmation()
        return
      }
      if (event.key !== 'Tab') return
      const targets = focusable()
      if (targets.length === 0) return
      const first = targets[0]
      const last = targets[targets.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [busy, pendingApplyLinkAction])

  function openManage(action: Exclude<ManageAction, null>) {
    setManageAction(action)
    setActionError(null)
    setNotice(null)
    if (action === 'department') setDepartmentId(overview?.job.department.id ?? '')
    if (action === 'duplicate') { setDuplicateDepartmentId(''); setDuplicatedJob(null) }
    if (action === 'delete') { setDeleteTitle(''); setDeleteAcknowledged(false) }
    manageDetailsRef.current?.removeAttribute('open')
    window.requestAnimationFrame(() => manageSectionHeadingRef.current?.focus())
  }

  function closeManage() {
    setManageAction(null)
    setActionError(null)
    setDepartmentId('')
    setDuplicateDepartmentId('')
    setDuplicatedJob(null)
    setCloseNote('')
    setCustomCloseEmail(false)
    setCloseEmailSubject('')
    setCloseEmailBody('')
    setDeleteTitle('')
    setDeleteAcknowledged(false)
    manageDetailsRef.current?.removeAttribute('open')
    window.requestAnimationFrame(() => manageTriggerRef.current?.focus())
  }

  function openApplyLinkConfirmation(action: 'replace' | 'disable', trigger: HTMLButtonElement) {
    applyLinkTriggerRef.current = trigger
    setActionError(null)
    setPendingApplyLinkAction(action)
  }

  function closeApplyLinkConfirmation() {
    const trigger = applyLinkTriggerRef.current
    setPendingApplyLinkAction(null)
    setActionError(null)
    applyLinkTriggerRef.current = null
    window.requestAnimationFrame(() => trigger?.focus())
  }

  async function updateStatus(status: 'open' | 'on_hold') {
    if (!overview) return
    setBusy(true)
    setActionError(null)
    try {
      const response = await fetch(`/api/workspace/jobs/${encodeURIComponent(jobId)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, expectedStatus: overview.job.status, operationId: operationId() }),
      })
      const raw = await response.json().catch(() => null)
      if (!response.ok) setActionError(responseError(raw, 'Could not update the job status.'))
      else {
        manageDetailsRef.current?.removeAttribute('open')
        setNotice(status === 'open' ? 'Job reopened.' : 'Job put on hold.')
        window.requestAnimationFrame(() => manageTriggerRef.current?.focus())
        await load()
      }
    } catch { setActionError('Network error. Refresh before retrying.') } finally { setBusy(false) }
  }

  async function changeDepartment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true); setActionError(null)
    try {
      const response = await fetch(`/api/workspace/jobs/${encodeURIComponent(jobId)}/department`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ departmentId }),
      })
      const raw = await response.json().catch(() => null)
      if (!response.ok) setActionError(responseError(raw, 'Could not change the department.'))
      else { closeManage(); setNotice('Department updated.'); await load() }
    } catch { setActionError('Network error. Nothing was changed.') } finally { setBusy(false) }
  }

  async function duplicateJob() {
    setBusy(true); setActionError(null)
    try {
      const response = await fetch(`/api/workspace/jobs/${encodeURIComponent(jobId)}/duplicate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ departmentId: duplicateDepartmentId }),
      })
      const raw = await response.json().catch(() => null)
      const data = objectValue(raw); const job = objectValue(data?.job); const capability = stringValue(data?.capability)
      if (!response.ok || !job || !capability || !stringValue(job.id)) setActionError(responseError(raw, 'Could not duplicate this job.'))
      else setDuplicatedJob({ id: String(job.id), title: stringValue(job.title) ?? 'Duplicated job', applyLink: `${window.location.origin}/apply#apply=${encodeURIComponent(capability)}` })
    } catch { setActionError('Network error. Nothing was duplicated.') } finally { setBusy(false) }
  }

  async function closeJob(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!overview) return
    setBusy(true); setActionError(null)
    try {
      const response = await fetch(`/api/workspace/jobs/${encodeURIComponent(jobId)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'closed', expectedStatus: overview.job.status, operationId: operationId(), closeNote: closeNote.trim(),
          ...(customCloseEmail ? { closeEmailTemplate: { subject: closeEmailSubject.trim(), body: closeEmailBody.trim() } } : {}),
        }),
      })
      const raw = await response.json().catch(() => null)
      if (!response.ok) setActionError(responseError(raw, 'Could not close this job.'))
      else { closeManage(); setNotice('Job closed. Remaining active candidates were handled by the close workflow.'); await load() }
    } catch { setActionError('Network error. Refresh before retrying.') } finally { setBusy(false) }
  }

  async function deleteJob(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!overview) return
    setBusy(true); setActionError(null)
    try {
      const response = await fetch(`/api/workspace/jobs/${encodeURIComponent(jobId)}`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmationTitle: deleteTitle.trim(), acknowledgeEmptyJobDeletion: deleteAcknowledged }),
      })
      const raw = await response.json().catch(() => null)
      if (!response.ok) setActionError(responseError(raw, 'Could not delete this empty job.'))
      else router.replace('/workspace/jobs')
    } catch { setActionError('Network error. Nothing was deleted.') } finally { setBusy(false) }
  }

  async function createApplyLink() {
    setBusy(true); setActionError(null)
    try {
      const response = await fetch(`/api/workspace/jobs/${encodeURIComponent(jobId)}/apply-link`, { method: 'POST' })
      const raw = await response.json().catch(() => null); const capability = stringValue(objectValue(raw)?.capability)
      if (!response.ok || !capability) setActionError(responseError(raw, 'Could not create an apply link.'))
      else {
        setApplyLink(`${window.location.origin}/apply#apply=${encodeURIComponent(capability)}`)
        setApplyLinkState('available')
        if (pendingApplyLinkAction) closeApplyLinkConfirmation()
        await load()
      }
    } catch { setActionError('Network error. The apply link was not changed.') } finally { setBusy(false) }
  }

  async function disableApplyLink() {
    setBusy(true); setActionError(null)
    try {
      const response = await fetch(`/api/workspace/jobs/${encodeURIComponent(jobId)}/apply-link`, { method: 'DELETE' })
      const raw = await response.json().catch(() => null)
      if (!response.ok) setActionError(responseError(raw, 'Could not turn off the apply link.'))
      else {
        setApplyLink(null)
        setApplyLinkState('idle')
        closeApplyLinkConfirmation()
        await load()
      }
    } catch { setActionError('Network error. The apply link was not changed.') } finally { setBusy(false) }
  }

  if (error && !overview) return <div className="space-y-6"><JobSubnav jobId={jobId} active="overview" /><StateView state="error" error={error} onRetry={() => void load()} /></div>
  if (loading && !overview) return <div className="space-y-6"><JobSubnav jobId={jobId} active="overview" /><StateView state="loading" skeletonLayout="list" skeletonCount={7} /></div>
  if (!overview) return null

  const activeDepartments = departments.filter((department) => department.status === 'active' && department.kind === 'standard')
  const canDelete = workspaceRole === 'admin' && overview.counts.total === 0 && !overview.acquisition.applyPageEnabled && overview.job.status !== 'closed'
  const deleteTitleMatches = deleteTitle.normalize('NFKC').trim() === overview.job.title.normalize('NFKC').trim()
  const candidateBase = `/workspace/jobs/${encodeURIComponent(jobId)}/candidates`
  const deliveryStates = [
    ['Pending', overview.screening.delivery.pending],
    ['Sending', overview.screening.delivery.sending],
    ['Sent', overview.screening.delivery.sent],
    ['Failed', overview.screening.delivery.failed],
    ['Cancelled', overview.screening.delivery.cancelled],
    ['Skipped', overview.screening.delivery.skipped],
  ].filter((entry): entry is [string, number] => Number(entry[1]) > 0)

  return (
    <div className="space-y-6">
      <JobSubnav jobId={jobId} active="overview" />
      <JobWorkspaceHeader
        title={overview.job.title}
        status={overview.job.status}
        departmentName={overview.job.department.name}
        candidateCount={overview.counts.total}
        actions={
          <>
            {overview.job.status === 'open' ? <Link href={`${candidateBase}?panel=add`} className="inline-flex h-9 items-center rounded-full bg-[#2563eb] px-5 text-sm font-semibold text-white hover:bg-[#1d4ed8]">Add candidate</Link> : null}
            {overview.job.status === 'open' ? <Link href={`${candidateBase}?panel=import`} className="inline-flex h-9 items-center rounded-full border border-[#dbe4ea] bg-white px-4 text-sm font-semibold text-[#0f1419] hover:bg-[#f8fafc]">Import résumés</Link> : null}
            <details ref={manageDetailsRef} className="relative">
              <summary ref={manageTriggerRef} className="flex h-9 cursor-pointer list-none items-center rounded-full border border-[#dbe4ea] bg-white px-4 text-sm font-semibold text-[#0f1419] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">Manage job</summary>
              <div className="absolute right-0 z-30 mt-2 w-56 space-y-1 rounded-xl border border-[#dbe4ea] bg-white p-2 shadow-xl">
                {workspaceRole === 'admin' ? <button type="button" className="block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-[#f8fafc]" onClick={() => openManage('department')}>Change department</button> : null}
                <button type="button" className="block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-[#f8fafc]" onClick={() => openManage('duplicate')}>Duplicate job</button>
                {overview.job.status === 'open' ? <button type="button" disabled={busy} className="block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-[#f8fafc]" onClick={() => void updateStatus('on_hold')}>Put on hold</button> : <button type="button" disabled={busy} className="block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-[#f8fafc]" onClick={() => void updateStatus('open')}>Reopen job</button>}
                {overview.job.status !== 'closed' ? <button type="button" className="block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-[#f8fafc]" onClick={() => openManage('close')}>Close job…</button> : null}
                {workspaceRole === 'admin' && overview.job.status !== 'closed' ? <button type="button" disabled={!canDelete} title={!canDelete ? 'Only an empty job with its apply link off can be deleted.' : undefined} className="block w-full rounded-lg px-3 py-2 text-left text-sm text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50" onClick={() => openManage('delete')}>Delete empty job…</button> : null}
              </div>
            </details>
          </>
        }
      />

      {notice ? <p role="status" className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{notice}</p> : null}
      {actionError ? <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{actionError}</p> : null}

      {manageAction === 'department' ? (
        <form onSubmit={changeDepartment} className="rounded-2xl border border-[#dbe4ea] bg-white p-5" aria-labelledby="change-department-title">
          <h2 ref={manageSectionHeadingRef} id="change-department-title" tabIndex={-1} className="font-semibold text-[#0f1419] focus:outline-none">Change department</h2>
          <p className="mt-1 text-sm text-[#536471]">Candidate and interview history remain attached to this job.</p>
          <label htmlFor="change-department-select" className="mt-4 block text-sm font-medium text-[#0f1419]">Active department</label>
          <select id="change-department-select" value={departmentId} onChange={(event) => setDepartmentId(event.target.value)} required className="mt-1 w-full max-w-md rounded-xl border border-[#dbe4ea] bg-[#f8fafc] px-3 py-2 text-sm"><option value="">Choose an active department</option>{activeDepartments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select>
          <div className="mt-4 flex gap-2"><Button type="submit" disabled={busy || !departmentId}>{busy ? 'Saving…' : 'Save department'}</Button><Button type="button" variant="secondary" onClick={closeManage}>Cancel</Button></div>
        </form>
      ) : null}

      {manageAction === 'duplicate' ? (
        <section className="rounded-2xl border border-[#dbe4ea] bg-white p-5" aria-labelledby="duplicate-title">
          <h2 ref={manageSectionHeadingRef} id="duplicate-title" tabIndex={-1} className="font-semibold text-[#0f1419] focus:outline-none">Duplicate job</h2>
          {!duplicatedJob ? <><p className="mt-1 text-sm text-[#536471]">Copies job requirements and settings into a new job with no candidates.</p><label htmlFor="duplicate-department-select" className="mt-4 block text-sm font-medium text-[#0f1419]">Department for duplicate</label><select id="duplicate-department-select" value={duplicateDepartmentId} onChange={(event) => setDuplicateDepartmentId(event.target.value)} className="mt-1 w-full max-w-md rounded-xl border border-[#dbe4ea] bg-[#f8fafc] px-3 py-2 text-sm"><option value="">Choose an active department</option>{activeDepartments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select><div className="mt-4 flex gap-2"><Button type="button" disabled={busy || !duplicateDepartmentId} onClick={() => void duplicateJob()}>{busy ? 'Duplicating…' : 'Create duplicate'}</Button><Button type="button" variant="secondary" onClick={closeManage}>Cancel</Button></div></> : <><p className="mt-2 text-sm text-[#536471]">{duplicatedJob.title} is ready. This fresh link can also be recovered from its Overview.</p><input readOnly aria-label="Fresh public apply link" value={duplicatedJob.applyLink} onFocus={(event) => event.currentTarget.select()} className="mt-3 w-full rounded-xl border border-[#dbe4ea] bg-[#f8fafc] px-3 py-2 font-mono text-xs" /><div className="mt-4 flex flex-wrap gap-3"><Link href={`/workspace/jobs/${encodeURIComponent(duplicatedJob.id)}`} className="text-sm font-semibold text-[#2563eb] hover:underline">Open duplicate →</Link><Button type="button" variant="secondary" size="sm" onClick={closeManage}>Done</Button></div></>}
        </section>
      ) : null}

      {manageAction === 'close' ? (
        <form onSubmit={closeJob} className="rounded-2xl border border-amber-200 bg-white p-5" aria-labelledby="close-job-title">
          <h2 ref={manageSectionHeadingRef} id="close-job-title" tabIndex={-1} className="font-semibold text-[#0f1419] focus:outline-none">Close this job</h2><p className="mt-1 text-sm text-[#536471]">A decision note is required. Active candidates will be resolved by the existing close lifecycle.</p>
          <label htmlFor="close-note" className="mt-4 block text-sm font-medium text-[#0f1419]">Internal decision note</label><textarea id="close-note" value={closeNote} onChange={(event) => setCloseNote(event.target.value)} required minLength={5} maxLength={4000} rows={3} className="mt-1 w-full rounded-xl border border-[#dbe4ea] bg-[#f8fafc] px-3 py-2 text-sm" />
          <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={customCloseEmail} onChange={(event) => setCustomCloseEmail(event.target.checked)} /> Customize candidate rejection email</label>
          {customCloseEmail ? <div className="mt-3 grid gap-3"><input aria-label="Candidate email subject" placeholder="Subject" value={closeEmailSubject} onChange={(event) => setCloseEmailSubject(event.target.value)} maxLength={200} className="rounded-xl border border-[#dbe4ea] px-3 py-2 text-sm" /><textarea aria-label="Candidate email body" placeholder="Plain-text message" value={closeEmailBody} onChange={(event) => setCloseEmailBody(event.target.value)} maxLength={4000} rows={5} className="rounded-xl border border-[#dbe4ea] px-3 py-2 text-sm" /></div> : null}
          <div className="mt-4 flex gap-2"><Button type="submit" disabled={busy || closeNote.trim().length < 5 || (customCloseEmail && (!closeEmailSubject.trim() || !closeEmailBody.trim()))}>{busy ? 'Closing…' : 'Close job'}</Button><Button type="button" variant="secondary" onClick={closeManage}>Cancel</Button></div>
        </form>
      ) : null}

      {manageAction === 'delete' ? (
        <form onSubmit={deleteJob} className="rounded-2xl border border-red-200 bg-white p-5" aria-labelledby="delete-job-title">
          <h2 ref={manageSectionHeadingRef} id="delete-job-title" tabIndex={-1} className="font-semibold text-red-800 focus:outline-none">Delete this empty job</h2><p className="mt-1 text-sm text-[#536471]">This is permanent. The server will stop the action if any hiring activity exists.</p>
          <label htmlFor="delete-title" className="mt-4 block text-sm font-medium">Type {overview.job.title} to confirm</label><input id="delete-title" value={deleteTitle} onChange={(event) => setDeleteTitle(event.target.value)} className="mt-1 w-full max-w-md rounded-xl border border-[#dbe4ea] px-3 py-2 text-sm" />
          <label className="mt-3 flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={deleteAcknowledged} onChange={(event) => setDeleteAcknowledged(event.target.checked)} /> I understand this action never deletes candidate records.</label>
          <div className="mt-4 flex gap-2"><Button type="submit" variant="danger" disabled={busy || !deleteTitleMatches || !deleteAcknowledged}>Delete empty job</Button><Button type="button" variant="secondary" onClick={closeManage}>Cancel</Button></div>
        </form>
      ) : null}

      <section aria-labelledby="attention-title" className="rounded-2xl border border-[#dbe4ea] bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 id="attention-title" className="text-base font-semibold text-[#0f1419]">Needs attention</h2><p className="mt-1 text-sm text-[#536471]">Open a bounded candidate view for the next recruiting task.</p></div><span className="text-xs text-[#71767b]">Created {overview.job.daysOpen} day{overview.job.daysOpen === 1 ? '' : 's'} ago</span></div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {[['Scoring', overview.counts.attention.scoring, 'scoring_attention'], ['Screening', overview.counts.attention.screening, 'screening_attention'], ['Interview', overview.counts.attention.interview, 'interview_attention'], ['Decision', overview.counts.attention.decision, 'decision_ready'], ['Offers', overview.counts.attention.offers, 'offers']].map(([label, count, view]) => <Link key={String(label)} href={`${candidateBase}?view=${view}`} className="rounded-xl border border-[#dbe4ea] p-4 hover:border-indigo-200 hover:bg-indigo-50"><span className="block text-2xl font-bold text-[#0f1419]">{Number(count).toLocaleString()}</span><span className="text-sm text-[#536471]">{label}</span></Link>)}
        </div>
      </section>

      <section aria-labelledby="funnel-title" className="rounded-2xl border border-[#dbe4ea] bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="funnel-title" className="text-base font-semibold text-[#0f1419]">Candidate funnel</h2><Link href={candidateBase} className="text-sm font-semibold text-[#2563eb] hover:underline">Open Candidates →</Link></div>
        <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">{STAGES.map((stage) => <Link key={stage} href={`${candidateBase}?stage=${stage}`} className="rounded-xl bg-[#f8fafc] p-3"><dt className="text-xs text-[#536471]">{STAGE_LABEL[stage]}</dt><dd className="mt-1 text-xl font-bold text-[#0f1419]">{overview.counts.stages[stage].toLocaleString()}</dd></Link>)}</dl>
      </section>

      <div className="grid gap-6 xl:grid-cols-2">
        <section aria-labelledby="acquisition-title" className="rounded-2xl border border-[#dbe4ea] bg-white p-5">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 id="acquisition-title" className="text-base font-semibold text-[#0f1419]">Candidate acquisition</h2><p className="mt-1 text-sm text-[#536471]">Public apply page and recruiter-led intake.</p></div><Badge variant={overview.acquisition.applyPageEnabled ? 'success' : 'default'}>{overview.acquisition.applyPageEnabled ? 'Apply page live' : 'Apply page off'}</Badge></div>
          {applyLink ? <input readOnly aria-label="Active public apply link" value={applyLink} onFocus={(event) => event.currentTarget.select()} className="mt-4 w-full rounded-xl border border-[#dbe4ea] bg-[#f8fafc] px-3 py-2 font-mono text-xs" /> : null}
          {applyLinkState === 'loading' ? <p className="mt-3 text-sm text-[#536471]">Loading the active link…</p> : null}{applyLinkState === 'unavailable' ? <p className="mt-3 text-sm text-amber-700">The current capability cannot be shown. Replace it only if you intend to invalidate the old link.</p> : null}{applyLinkState === 'error' ? <p className="mt-3 text-sm text-amber-700">The link could not be retrieved. It may still be live.</p> : null}
          <div className="mt-4 flex flex-wrap gap-2">
            {overview.acquisition.applyPageEnabled ? (
              <Button type="button" variant="secondary" disabled={busy} onClick={(event) => openApplyLinkConfirmation('replace', event.currentTarget)}>Replace link</Button>
            ) : (
              <Button type="button" variant="secondary" disabled={busy} onClick={() => void createApplyLink()}>Create link</Button>
            )}
            {overview.acquisition.applyPageEnabled ? <Button type="button" variant="secondary" disabled={busy} onClick={(event) => openApplyLinkConfirmation('disable', event.currentTarget)}>Turn off</Button> : null}
            {overview.job.status === 'open' ? <Link href={`${candidateBase}?panel=suggestions`} className="inline-flex h-9 items-center text-sm font-semibold text-[#2563eb] hover:underline">Review talent-pool suggestions</Link> : null}
          </div>
          {pendingApplyLinkAction ? (
            <div ref={applyLinkConfirmationRef} className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4" role="alertdialog" aria-labelledby="apply-link-confirmation-title" aria-describedby="apply-link-confirmation-description" aria-modal="false">
              <h3 id="apply-link-confirmation-title" className="font-semibold text-[#0f1419]">{pendingApplyLinkAction === 'replace' ? 'Replace the active apply link?' : 'Turn off the active apply link?'}</h3>
              <p id="apply-link-confirmation-description" className="mt-2 text-sm text-[#536471]">The current public URL will stop working immediately. Anyone using that old link will no longer be able to start an application.</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button type="button" variant={pendingApplyLinkAction === 'disable' ? 'danger' : 'primary'} disabled={busy} onClick={() => void (pendingApplyLinkAction === 'replace' ? createApplyLink() : disableApplyLink())}>{busy ? 'Updating…' : pendingApplyLinkAction === 'replace' ? 'Confirm replacement' : 'Confirm turn off'}</Button>
                <Button type="button" variant="secondary" disabled={busy} onClick={closeApplyLinkConfirmation}>Cancel</Button>
              </div>
            </div>
          ) : null}
        </section>

        <section aria-labelledby="screening-summary-title" className="rounded-2xl border border-[#dbe4ea] bg-white p-5">
          <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="screening-summary-title" className="text-base font-semibold text-[#0f1419]">Screening</h2><Link href={`/workspace/jobs/${encodeURIComponent(jobId)}/screening`} className="text-sm font-semibold text-[#2563eb] hover:underline">Open Screening →</Link></div>
          {overview.screening.latestGate ? <p className="mt-4 text-sm text-[#536471]">Latest gate · <span className="font-medium capitalize text-[#0f1419]">{overview.screening.latestGate.status}</span> · {overview.screening.latestGate.selectedCount.toLocaleString()} selected</p> : <p className="mt-4 text-sm text-[#536471]">No screening gate has been confirmed.</p>}
          {overview.screening.latestBatch ? <div className="mt-4"><p className="font-medium text-[#0f1419]">Latest batch · {overview.screening.latestBatch.status.replaceAll('_', ' ')}</p><p className="mt-1 text-sm text-[#536471]">{overview.screening.latestBatch.sentCount} sent of {overview.screening.latestBatch.plannedCount} planned · {overview.screening.latestBatch.failedCount} failed</p></div> : <p className="mt-4 text-sm text-[#536471]">No screening batch has been scheduled.</p>}
          {deliveryStates.length > 0 ? <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">{deliveryStates.map(([label, count]) => <div key={label}><dt className="text-xs text-[#71767b]">{label}</dt><dd className="font-semibold">{count.toLocaleString()}</dd></div>)}</dl> : <p className="mt-4 text-sm text-[#536471]">No screening deliveries have been recorded.</p>}
        </section>
      </div>

      <section aria-labelledby="activity-title" className="rounded-2xl border border-[#dbe4ea] bg-white p-5">
        <h2 id="activity-title" className="text-base font-semibold text-[#0f1419]">Recent activity</h2>
        {overview.recentActivity.length === 0 ? <p className="mt-3 text-sm text-[#536471]">No candidate activity yet.</p> : <ol className="mt-3 divide-y divide-[#e6ecf0]">{overview.recentActivity.map((activity, index) => <li key={`${activity.applicationId}:${activity.occurredAt}:${index}`} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between"><Link href={`/workspace/applications/${encodeURIComponent(activity.applicationId)}?returnTo=${encodeURIComponent(`/workspace/jobs/${jobId}`)}`} className="text-sm font-medium text-[#0f1419] hover:text-[#2563eb] hover:underline">{ACTIVITY_LABEL[activity.kind] ?? activity.kind.replaceAll('_', ' ')}</Link><span className="text-xs text-[#71767b]">{activity.actorName} · {dateLabel(activity.occurredAt)}</span></li>)}</ol>}
      </section>
    </div>
  )
}
