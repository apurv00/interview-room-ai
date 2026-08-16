'use client'

/**
 * Recruiter bulk-resume intake. Each browser request only stores one durable
 * task; parsing, JD scoring, and candidate writes are performed by the Hire
 * worker. The panel polls task state and can supply an email later without
 * asking the recruiter to upload the document again.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import Badge from '@shared/ui/Badge'
import Button from '@shared/ui/Button'

// Phase 2's operational target is a 50-resume screening batch. Uploads still
// queue only three lightweight task writes at a time; parsing and scoring are
// performed by the durable worker, not in the browser.
const MAX_BATCH = 50
const UPLOAD_CONCURRENCY = 3
const STATUS_POLL_CONCURRENCY = 3
const POLL_INTERVAL_MS = 3_000
const ACCEPT = '.pdf,.docx,.txt'

type IntakeTaskStatus =
  | 'queued'
  | 'processing'
  | 'needs_identity'
  | 'completed'
  | 'failed'
  | 'cancelled'

type IntakeDispatchStatus = 'pending' | 'dispatched' | 'failed'

type FileRowStatus = IntakeTaskStatus | 'uploading' | 'error'

interface IntakeDispatchView {
  status: IntakeDispatchStatus
  attempts: number
  /** A controlled queue-delivery code; never an upstream exception string. */
  lastErrorCode?: 'inngest_dispatch_unavailable'
}

interface IntakeTaskView {
  taskId: string
  status: IntakeTaskStatus
  attempts: number
  dispatch: IntakeDispatchView
  lastError?: string
  candidateId?: string
  applicationId?: string
}

interface FileRow {
  key: string
  file: File
  status: FileRowStatus
  taskId?: string
  attempts?: number
  dispatch?: IntakeDispatchView
  candidateId?: string
  applicationId?: string
  error?: string
  emailFix?: string
  identitySubmitting?: boolean
  identityError?: string
}

const TASK_STATUSES: IntakeTaskStatus[] = [
  'queued',
  'processing',
  'needs_identity',
  'completed',
  'failed',
  'cancelled',
]

function isTaskStatus(value: unknown): value is IntakeTaskStatus {
  return typeof value === 'string' && TASK_STATUSES.includes(value as IntakeTaskStatus)
}

function readDispatch(value: unknown): IntakeDispatchView {
  if (!value || typeof value !== 'object') return { status: 'pending', attempts: 0 }
  const dispatch = value as Record<string, unknown>
  const status: IntakeDispatchStatus = dispatch.status === 'dispatched' || dispatch.status === 'failed'
    ? dispatch.status
    : 'pending'
  return {
    status,
    attempts: typeof dispatch.attempts === 'number' && dispatch.attempts >= 0
      ? dispatch.attempts
      : 0,
    ...(dispatch.lastErrorCode === 'inngest_dispatch_unavailable'
      ? { lastErrorCode: dispatch.lastErrorCode }
      : {}),
  }
}

function isTerminal(status: FileRowStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'error'
}

/** A recruiter needs an up-to-date pipeline as soon as a task can affect it. */
function isPipelineRefreshable(status: FileRowStatus): boolean {
  return status === 'needs_identity' || isTerminal(status)
}

function isPollable(row: FileRow): boolean {
  return Boolean(row.taskId) && (row.status === 'queued' || row.status === 'processing')
}

function readTask(value: unknown): IntakeTaskView | null {
  if (!value || typeof value !== 'object') return null
  const task = value as Record<string, unknown>
  if (
    typeof task.taskId !== 'string' ||
    !isTaskStatus(task.status)
  ) {
    return null
  }
  return {
    taskId: task.taskId,
    status: task.status,
    // Enqueue responses deliberately expose only the opaque task id and
    // status plus safe dispatch state. The authenticated status endpoint adds
    // worker attempt counts and the eventual application coordinate.
    attempts: typeof task.attempts === 'number' ? task.attempts : 0,
    dispatch: readDispatch(task.dispatch),
    ...(typeof task.lastError === 'string' ? { lastError: task.lastError } : {}),
    ...(typeof task.candidateId === 'string' ? { candidateId: task.candidateId } : {}),
    ...(typeof task.applicationId === 'string' ? { applicationId: task.applicationId } : {}),
  }
}

function taskPatch(task: IntakeTaskView): Partial<FileRow> {
  return {
    taskId: task.taskId,
    status: task.status,
    attempts: task.attempts,
    dispatch: task.dispatch,
    ...(task.candidateId ? { candidateId: task.candidateId } : {}),
    ...(task.applicationId ? { applicationId: task.applicationId } : {}),
    ...(task.status === 'needs_identity' || task.status === 'failed' || task.status === 'cancelled'
      ? { error: task.lastError }
      : { error: undefined }),
  }
}

function taskError(data: unknown, fallback: string): string {
  if (data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string') {
    return (data as { error: string }).error
  }
  return fallback
}

export default function BulkUploadPanel({
  jobId,
  onSettled,
}: {
  jobId: string
  /** Called when a row reaches a state that can change the visible pipeline. */
  onSettled: () => void
}) {
  const [rows, setRows] = useState<FileRow[]>([])
  const rowsRef = useRef<FileRow[]>([])
  const uploadQueueRef = useRef<FileRow[]>([])
  const uploadingKeysRef = useRef(new Set<string>())
  const uploadsInFlightRef = useRef(0)
  const pollingRef = useRef(false)
  const pollCursorRef = useRef(0)
  // Keep the last notification per row so a polling repaint does not refetch
  // the board. A retry clears this record when it returns to a queued state.
  const notifiedRefreshStateRef = useRef(new Map<string, FileRowStatus>())
  const onSettledRef = useRef(onSettled)
  onSettledRef.current = onSettled

  const patchRow = useCallback((key: string, patch: Partial<FileRow>) => {
    setRows((previous) => {
      const next = previous.map((row) => (row.key === key ? { ...row, ...patch } : row))
      rowsRef.current = next
      return next
    })
  }, [])

  async function uploadOne(row: FileRow) {
    patchRow(row.key, { status: 'uploading', error: undefined, identityError: undefined })
    try {
      const formData = new FormData()
      formData.append('file', row.file)
      const response = await fetch(`/api/workspace/jobs/${jobId}/intake`, {
        method: 'POST',
        body: formData,
      })
      const data = await response.json().catch(() => null)
      if (!response.ok) {
        patchRow(row.key, {
          status: 'error',
          error: taskError(data, `Upload failed (${response.status})`),
        })
        return
      }
      const task = readTask((data as { task?: unknown } | null)?.task)
      if (!task) {
        patchRow(row.key, {
          status: 'error',
          error: 'The upload was accepted but returned an invalid task response. Retry upload.',
        })
        return
      }
      patchRow(row.key, taskPatch(task))
    } catch {
      patchRow(row.key, { status: 'error', error: 'Network error — retry upload.' })
    } finally {
      uploadsInFlightRef.current -= 1
      uploadingKeysRef.current.delete(row.key)
      pumpUploads()
    }
  }

  function pumpUploads() {
    while (
      uploadsInFlightRef.current < UPLOAD_CONCURRENCY &&
      uploadQueueRef.current.length > 0
    ) {
      const next = uploadQueueRef.current.shift()
      if (!next) break
      uploadsInFlightRef.current += 1
      void uploadOne(next)
    }
  }

  function enqueueUpload(row: FileRow) {
    // Prevent an accidental double-click from enqueuing the same local file
    // twice before React has painted its new row status.
    if (uploadingKeysRef.current.has(row.key)) return
    uploadingKeysRef.current.add(row.key)
    uploadQueueRef.current.push(row)
    pumpUploads()
  }

  function addFiles(fileList: FileList | null) {
    if (!fileList) return
    const remaining = MAX_BATCH - rowsRef.current.length
    if (remaining <= 0) return
    const fresh: FileRow[] = Array.from(fileList)
      .slice(0, remaining)
      .map((file, index) => ({
        key: `${Date.now()}-${index}-${file.name}`,
        file,
        status: 'queued',
      }))
    if (fresh.length === 0) return

    rowsRef.current = [...rowsRef.current, ...fresh]
    setRows((previous) => [...previous, ...fresh])
    for (const row of fresh) enqueueUpload(row)
  }

  function retryUpload(row: FileRow) {
    if (row.status === 'uploading') return
    const retry: FileRow = {
      ...row,
      status: 'queued',
      taskId: undefined,
      attempts: undefined,
      dispatch: undefined,
      candidateId: undefined,
      applicationId: undefined,
      error: undefined,
      identitySubmitting: false,
      identityError: undefined,
    }
    patchRow(row.key, retry)
    enqueueUpload(retry)
  }

  const pollTask = useCallback(async (row: FileRow) => {
    if (!row.taskId) return
    try {
      const response = await fetch(`/api/workspace/jobs/${jobId}/intake/${row.taskId}`, {
        cache: 'no-store',
      })
      const data = await response.json().catch(() => null)
      if (!response.ok) {
        // Transient status failures should not hide a task that is still
        // safely queued in the server. Hard authorization/not-found results
        // are terminal from this panel's perspective.
        if ([401, 403, 404].includes(response.status)) {
          patchRow(row.key, {
            status: 'error',
            error: taskError(data, 'The intake task is no longer available.'),
          })
        }
        return
      }
      const task = readTask((data as { task?: unknown } | null)?.task)
      if (!task || task.taskId !== row.taskId) return
      patchRow(row.key, taskPatch(task))
    } catch {
      // Keep the last safe state and retry on the next polling interval.
    }
  }, [jobId, patchRow])

  useEffect(() => {
    let disposed = false

    async function pollActiveTasks() {
      if (disposed || pollingRef.current) return
      const activeRows = rowsRef.current.filter(isPollable)
      if (activeRows.length === 0) return
      const pollCount = Math.min(STATUS_POLL_CONCURRENCY, activeRows.length)
      const start = pollCursorRef.current % activeRows.length
      const batch = Array.from(
        { length: pollCount },
        (_, index) => activeRows[(start + index) % activeRows.length],
      )
      pollCursorRef.current = (start + batch.length) % activeRows.length
      pollingRef.current = true
      try {
        await Promise.all(batch.map((row) => pollTask(row)))
      } finally {
        pollingRef.current = false
      }
    }

    void pollActiveTasks()
    const interval = window.setInterval(() => void pollActiveTasks(), POLL_INTERVAL_MS)
    return () => {
      disposed = true
      window.clearInterval(interval)
    }
  }, [pollTask, rows])

  useEffect(() => {
    let shouldRefreshPipeline = false
    for (const row of rows) {
      if (!isPipelineRefreshable(row.status)) {
        notifiedRefreshStateRef.current.delete(row.key)
        continue
      }
      if (notifiedRefreshStateRef.current.get(row.key) !== row.status) {
        notifiedRefreshStateRef.current.set(row.key, row.status)
        shouldRefreshPipeline = true
      }
    }
    if (shouldRefreshPipeline) {
      onSettledRef.current()
    }
  }, [rows])

  async function submitIdentity(row: FileRow) {
    const email = row.emailFix?.trim()
    if (!row.taskId || !email) {
      patchRow(row.key, { identityError: 'Enter the candidate’s email address.' })
      return
    }
    patchRow(row.key, { identitySubmitting: true, identityError: undefined })
    try {
      const response = await fetch(`/api/workspace/jobs/${jobId}/intake/${row.taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok) {
        patchRow(row.key, {
          identitySubmitting: false,
          identityError: taskError(data, `Could not save email (${response.status})`),
        })
        return
      }
      const task = readTask((data as { task?: unknown } | null)?.task)
      if (!task || task.taskId !== row.taskId) {
        patchRow(row.key, {
          identitySubmitting: false,
          identityError: 'The email was accepted but task status was unavailable. Try again.',
        })
        return
      }
      patchRow(row.key, { ...taskPatch(task), identitySubmitting: false, identityError: undefined })
    } catch {
      patchRow(row.key, {
        identitySubmitting: false,
        identityError: 'Network error — the saved resume is still waiting for an email.',
      })
    }
  }

  return (
    <div className="bg-white border border-[#e1e8ed] rounded-2xl p-5 space-y-4">
      <div>
        <p className="text-sm font-medium text-[#0f1419]">Bulk upload résumés</p>
        <p id="bulk-upload-description" className="text-xs text-[#71767b] mt-0.5">
          PDF, DOCX or TXT — up to {MAX_BATCH} at a time, 10MB each. Files are safely queued,
          then parsed and matched against the JD in the background. Existing people are merged
          by email within this workspace.
        </p>
      </div>

      <input
        id="hire-bulk-resume-files"
        type="file"
        multiple
        accept={ACCEPT}
        aria-describedby="bulk-upload-description"
        className="sr-only"
        onChange={(event) => {
          addFiles(event.target.files)
          event.target.value = ''
        }}
      />
      <label
        htmlFor="hire-bulk-resume-files"
        className="block border-2 border-dashed border-[#e1e8ed] rounded-2xl p-6 text-center cursor-pointer hover:border-[#2563eb]/40 transition-colors"
      >
        <span className="text-sm text-[#536471]">
          Choose résumé files or <span className="text-[#2563eb] font-medium">browse</span>
        </span>
      </label>

      {rows.length > 0 ? (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li
              key={row.key}
              className="border border-[#e1e8ed] rounded-xl px-3 py-2 text-sm flex flex-col gap-1.5"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="truncate font-medium text-[#0f1419]">{row.file.name}</span>
                <span className="ml-auto shrink-0">
                  {row.status === 'queued' ? <Badge>queued</Badge> : null}
                  {row.status === 'uploading' ? <Badge variant="caution">uploading…</Badge> : null}
                  {row.status === 'processing' ? <Badge variant="caution">processing…</Badge> : null}
                  {row.status === 'needs_identity' ? <Badge variant="caution">needs email</Badge> : null}
                  {row.status === 'completed' ? <Badge variant="success">added</Badge> : null}
                  {row.status === 'failed' ? <Badge variant="danger">failed</Badge> : null}
                  {row.status === 'cancelled' ? <Badge variant="danger">cancelled</Badge> : null}
                  {row.status === 'error' ? <Badge variant="danger">upload failed</Badge> : null}
                </span>
              </div>

              {(row.status === 'queued' || row.status === 'processing') && row.attempts ? (
                <p className="text-xs text-[#71767b]">
                  Background attempt {row.attempts}; you can keep working while this finishes.
                </p>
              ) : null}

              {row.status === 'queued' && row.dispatch?.status === 'failed' ? (
                <p className="text-xs text-[#a16207]">
                  Saved. The queue handoff is delayed; automatic recovery will retry.
                </p>
              ) : null}

              {row.status === 'queued' && row.dispatch?.status !== 'failed' ? (
                <p className="text-xs text-[#71767b]">
                  Queued for parsing and JD scoring.
                </p>
              ) : null}

              {row.status === 'processing' ? (
                <p className="text-xs text-[#71767b]">
                  Parsing the résumé and scoring it against this job description.
                </p>
              ) : null}

              {row.status === 'completed' ? (
                <p className="text-xs text-[#71767b]">
                  Candidate and application saved. The ranked pipeline will refresh when this batch settles.
                </p>
              ) : null}

              {row.status === 'needs_identity' ? (
                <form
                  className="space-y-1.5"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void submitIdentity(row)
                  }}
                >
                  <div className="flex items-center gap-2">
                    <label className="sr-only" htmlFor={`${row.key}-email`}>
                      Candidate email address
                    </label>
                    <input
                      id={`${row.key}-email`}
                      type="email"
                      required
                      value={row.emailFix ?? ''}
                      onChange={(event) =>
                        patchRow(row.key, {
                          emailFix: event.target.value,
                          identityError: undefined,
                        })
                      }
                      placeholder="candidate@email.com"
                      className="flex-1 min-w-0 px-2 py-1 border border-[#e1e8ed] rounded-lg bg-[#f8fafc] text-xs"
                    />
                    <Button type="submit" disabled={row.identitySubmitting}>
                      {row.identitySubmitting ? 'Saving…' : 'Add email'}
                    </Button>
                  </div>
                  <p className="text-xs text-[#71767b]">
                    {row.error || 'No email was found. Add one to continue without re-uploading the résumé.'}
                  </p>
                  {row.identityError ? (
                    <p className="text-xs text-[#f4212e]">{row.identityError}</p>
                  ) : null}
                </form>
              ) : null}

              {row.status === 'error' || row.status === 'failed' || row.status === 'cancelled' ? (
                <div className="flex items-center gap-2 text-xs text-[#f4212e]">
                  <span>{row.error || 'This intake task did not complete.'}</span>
                  <button
                    type="button"
                    onClick={() => retryUpload(row)}
                    className="text-[#2563eb] font-medium"
                  >
                    Upload again
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
