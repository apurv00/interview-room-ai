'use client'

import { useCallback, useEffect, useState } from 'react'
import Badge from '@shared/ui/Badge'
import Button from '@shared/ui/Button'

type AssessmentExportStatus = 'pending' | 'generating' | 'ready' | 'failed' | 'cancelled'

interface AssessmentExportView {
  id: string
  status: AssessmentExportStatus
  requestedAt: string
  expiresAt: string
  readyAt: string | null
}

const EXPORT_ID = /^[a-f0-9]{24}$/i
const POLL_INTERVAL_MS = 3_000

function isProcessing(status: AssessmentExportStatus): boolean {
  return status === 'pending' || status === 'generating'
}

function statusPresentation(status: AssessmentExportStatus): {
  label: string
  variant: 'default' | 'primary' | 'success' | 'caution'
} {
  switch (status) {
    case 'ready':
      return { label: 'ready', variant: 'success' }
    case 'failed':
      return { label: 'could not prepare', variant: 'caution' }
    case 'cancelled':
      return { label: 'cancelled', variant: 'default' }
    case 'generating':
      return { label: 'preparing', variant: 'primary' }
    default:
      return { label: 'queued', variant: 'primary' }
  }
}

function exportViewFrom(value: unknown): AssessmentExportView | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  const id = source.id
  const status = source.status
  const requestedAt = source.requestedAt
  const expiresAt = source.expiresAt
  const readyAt = source.readyAt
  if (
    typeof id !== 'string' ||
    !EXPORT_ID.test(id) ||
    !['pending', 'generating', 'ready', 'failed', 'cancelled'].includes(String(status)) ||
    typeof requestedAt !== 'string' ||
    typeof expiresAt !== 'string' ||
    (readyAt !== null && typeof readyAt !== 'string')
  ) {
    return null
  }
  return {
    id,
    status: status as AssessmentExportStatus,
    requestedAt,
    expiresAt,
    readyAt: readyAt as string | null,
  }
}

async function responseJson(response: Response): Promise<Record<string, unknown> | null> {
  const value: unknown = await response.json().catch(() => null)
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/**
 * Creates a one-week internal PDF from the same allowlisted decision view.
 * The browser learns only opaque lifecycle status; it never receives storage
 * keys, a snapshot, an object URL, or worker failure detail.
 */
export default function AssessmentExportsPanel({
  applicationId,
  jobIsOpen,
  terminal,
}: {
  applicationId: string
  jobIsOpen: boolean
  terminal: boolean
}) {
  const [assessmentExport, setAssessmentExport] = useState<AssessmentExportView | null>(null)
  const [operationId, setOperationId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const canRequest = jobIsOpen && !terminal
  const requestInProgress = assessmentExport ? isProcessing(assessmentExport.status) : false

  const refreshStatus = useCallback(async () => {
    if (!assessmentExport) return
    try {
      const response = await fetch(
        `/api/workspace/assessment-exports/${assessmentExport.id}`,
        { cache: 'no-store' },
      )
      const body = await responseJson(response)
      const next = exportViewFrom(body?.assessmentExport)
      if (!response.ok || !next) {
        setError('Could not refresh the assessment export status.')
        return
      }
      setError(null)
      setAssessmentExport(next)
    } catch {
      setError('Could not refresh the assessment export status.')
    }
  }, [assessmentExport])

  useEffect(() => {
    if (!assessmentExport || !isProcessing(assessmentExport.status)) return
    const timer = window.setTimeout(() => void refreshStatus(), POLL_INTERVAL_MS)
    return () => window.clearTimeout(timer)
  }, [assessmentExport, refreshStatus])

  async function requestExport() {
    if (!canRequest) return
    const commandId = operationId ?? crypto.randomUUID()
    setOperationId(commandId)
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const response = await fetch(
        `/api/workspace/applications/${applicationId}/assessment-exports`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ operationId: commandId }),
          cache: 'no-store',
        },
      )
      const body = await responseJson(response)
      const next = exportViewFrom(body?.assessmentExport)
      if (!response.ok || !next) {
        setError('Could not request an assessment export.')
        return
      }
      setAssessmentExport(next)
      setOperationId(null)
      setNotice(
        next.status === 'ready'
          ? 'Assessment export is ready to download.'
          : 'Assessment export queued. This page will check its status automatically.',
      )
    } catch {
      setError('Could not request an assessment export.')
    } finally {
      setBusy(false)
    }
  }

  async function downloadExport() {
    if (!assessmentExport || assessmentExport.status !== 'ready') return
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(
        `/api/workspace/assessment-exports/${assessmentExport.id}/download`,
        { cache: 'no-store' },
      )
      if (!response.ok) {
        setError('The assessment export is no longer available to download.')
        return
      }
      const blob = await response.blob()
      const objectUrl = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = objectUrl
      anchor.download = 'candidate-assessment.pdf'
      anchor.style.display = 'none'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(objectUrl)
      setNotice('Assessment export downloaded.')
    } catch {
      setError('The assessment export is no longer available to download.')
    } finally {
      setBusy(false)
    }
  }

  const presentation = assessmentExport ? statusPresentation(assessmentExport.status) : null

  return (
    <section
      className="space-y-4 rounded-2xl border border-[#e1e8ed] bg-white p-5"
      aria-labelledby="assessment-export-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="assessment-export-heading" className="text-sm font-semibold text-[#0f1419]">
            Assessment export
          </h2>
          <p className="mt-1 text-xs text-[#71767b]">
            Generate a private PDF of the candidate&apos;s decision evidence for internal use.
          </p>
        </div>
        {presentation ? <Badge variant={presentation.variant}>{presentation.label}</Badge> : null}
      </div>

      {!canRequest ? (
        <p className="text-xs text-[#71767b]">
          Assessment exports can be created only while this application and job are active.
        </p>
      ) : null}
      {assessmentExport && isProcessing(assessmentExport.status) ? (
        <p className="text-xs text-[#71767b]" aria-live="polite">
          Preparing the report. Status refreshes automatically.
        </p>
      ) : null}
      {assessmentExport?.status === 'failed' ? (
        <p className="text-xs text-[#71767b]">
          The report could not be prepared. Create a new export to try again.
        </p>
      ) : null}
      {assessmentExport?.status === 'cancelled' ? (
        <p className="text-xs text-[#71767b]">
          This report is no longer available. Create a new export while the application remains active.
        </p>
      ) : null}
      {error ? <p className="text-sm text-[#f4212e]" role="alert">{error}</p> : null}
      {notice ? <p className="text-sm text-emerald-700">{notice}</p> : null}

      <div className="flex flex-wrap gap-2">
        {canRequest ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || requestInProgress}
            onClick={() => void requestExport()}
          >
            {requestInProgress
              ? 'Preparing…'
              : busy && !assessmentExport
                ? 'Requesting…'
                : assessmentExport
                  ? 'Create new export'
                  : 'Create assessment PDF'}
          </Button>
        ) : null}
        {assessmentExport?.status === 'ready' ? (
          <Button size="sm" disabled={busy} onClick={() => void downloadExport()}>
            {busy ? 'Downloading…' : 'Download PDF'}
          </Button>
        ) : null}
      </div>
    </section>
  )
}
