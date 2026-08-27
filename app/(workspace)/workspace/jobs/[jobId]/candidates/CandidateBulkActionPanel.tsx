'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import Button from '@shared/ui/Button'
import type { HireCandidateBulkReasonCode } from '@/modules/hire-candidate-actions'
import { CANDIDATE_STAGE_LABEL, type CandidateSelectionSnapshot, type CandidateStage } from './candidateWorkspaceTypes'

type BulkAction = 'advance' | 'reject' | 'withdraw'
type BulkStatus = 'queued' | 'processing' | 'completed' | 'partial' | 'failed'
type OperationLoadResult =
  | { kind: 'loaded' }
  | { kind: 'aborted' }
  | { kind: 'error'; message: string }

interface OperationLoadOptions {
  cursor?: string | null
  updateIssuePage?: boolean
  focusIssuePage?: boolean
  issuePageIndex?: number
  issueNavigationGeneration?: number
}

const BULK_ISSUE_PAGE_LIMIT = 50

const BULK_REASON_OPTIONS: Array<{ value: HireCandidateBulkReasonCode; label: string }> = [
  { value: 'requirements_mismatch', label: 'Requirements mismatch' },
  { value: 'position_closed', label: 'Position closed' },
  { value: 'duplicate_application', label: 'Duplicate application' },
  { value: 'candidate_withdrew', label: 'Candidate withdrew' },
  { value: 'role_filled', label: 'Role filled' },
]

interface BulkOperationView {
  operationId: string
  action: BulkAction
  status: BulkStatus
  total: number
  processed: number
  succeeded: number
  conflicts: number
  failed: number
}

interface BulkIssue {
  itemId: string
  applicationId: string
  outcome: string
  message: string
}

interface BulkIssuePage {
  items: BulkIssue[]
  nextCursor: string | null
}

interface CandidateBulkActionPanelProps {
  jobId: string
  selection: CandidateSelectionSnapshot | null
  expectedStage: CandidateStage | null
  initialOperationId?: string | null
  canStartActions?: boolean
  returnTo?: string
  onOperationAccepted?: (operationId: string) => void
  onFinish: () => void
  onSettled: () => void
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function readOperation(value: unknown): BulkOperationView | null {
  const envelope = objectValue(value)
  const operation = objectValue(envelope?.operation) ?? envelope
  if (!operation) return null
  const operationId = typeof operation?.operationId === 'string'
    ? operation.operationId
    : typeof operation?.id === 'string' ? operation.id : null
  const action = operation?.action
  const status = operation?.status
  if (
    !operationId || (action !== 'advance' && action !== 'reject' && action !== 'withdraw') ||
    (status !== 'queued' && status !== 'processing' && status !== 'completed' && status !== 'partial' && status !== 'failed')
  ) return null
  return {
    operationId,
    action,
    status,
    total: numberValue(operation.totalCount),
    processed:
      numberValue(operation.succeededCount) + numberValue(operation.conflictCount) + numberValue(operation.failedCount),
    succeeded: numberValue(operation.succeededCount),
    conflicts: numberValue(operation.conflictCount),
    failed: numberValue(operation.failedCount),
  }
}

function readIssuePage(value: unknown): BulkIssuePage {
  const envelope = objectValue(value)
  const issues = objectValue(envelope?.issues)
  if (!issues || !Array.isArray(issues.items)) return { items: [], nextCursor: null }
  const items = issues.items.slice(0, BULK_ISSUE_PAGE_LIMIT).flatMap((item) => {
    const issue = objectValue(item)
    if (!issue) return []
    const applicationId = typeof issue.applicationId === 'string' ? issue.applicationId : null
    if (!applicationId) return []
    const outcome = typeof issue.status === 'string' ? issue.status : 'controlled_failure'
    return [{
      itemId: typeof issue.itemId === 'string' ? issue.itemId : `${applicationId}:${outcome}`,
      applicationId,
      outcome,
      message: typeof issue.code === 'string' ? issue.code.replaceAll('_', ' ').toLowerCase() : 'This candidate could not be updated.',
    }]
  })
  return {
    items,
    nextCursor: typeof issues.nextCursor === 'string' ? issues.nextCursor : null,
  }
}

function operationId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `bulk-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export default function CandidateBulkActionPanel({
  jobId,
  selection,
  expectedStage,
  initialOperationId = null,
  canStartActions = true,
  returnTo = `/workspace/jobs/${encodeURIComponent(jobId)}/candidates`,
  onOperationAccepted,
  onFinish,
  onSettled,
}: CandidateBulkActionPanelProps) {
  const [action, setAction] = useState<BulkAction | null>(null)
  const [reasonCode, setReasonCode] = useState<HireCandidateBulkReasonCode | ''>('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [operation, setOperation] = useState<BulkOperationView | null>(null)
  const [issues, setIssues] = useState<BulkIssue[]>([])
  const [issueNextCursor, setIssueNextCursor] = useState<string | null>(null)
  const [issueCursorHistory, setIssueCursorHistory] = useState<Array<string | null>>([null])
  const [issuePageIndex, setIssuePageIndex] = useState(0)
  const [issuePageLoading, setIssuePageLoading] = useState(false)
  const [issuePageError, setIssuePageError] = useState<string | null>(null)
  const [issuePageAnnouncement, setIssuePageAnnouncement] = useState('')
  const [recovering, setRecovering] = useState(Boolean(initialOperationId))
  const [recoveryError, setRecoveryError] = useState<string | null>(null)
  const [copyStatus, setCopyStatus] = useState<string | null>(null)
  const commandRef = useRef<{ key: string; id: string } | null>(null)
  const settledOperationRef = useRef<string | null>(null)
  const actionTriggerRef = useRef<HTMLButtonElement | null>(null)
  const confirmationHeadingRef = useRef<HTMLHeadingElement | null>(null)
  const issuePageHeadingRef = useRef<HTMLHeadingElement | null>(null)
  const issueCursorHistoryRef = useRef<Array<string | null>>([null])
  const issuePageIndexRef = useRef(0)
  const issueNavigationInFlightRef = useRef(false)
  const issueNavigationGenerationRef = useRef(0)
  const operationRequestGenerationRef = useRef(0)
  const onSettledRef = useRef(onSettled)
  onSettledRef.current = onSettled

  const resetIssuePaging = useCallback(() => {
    operationRequestGenerationRef.current += 1
    issueNavigationGenerationRef.current += 1
    issueCursorHistoryRef.current = [null]
    issuePageIndexRef.current = 0
    issueNavigationInFlightRef.current = false
    setIssues([])
    setIssueNextCursor(null)
    setIssueCursorHistory([null])
    setIssuePageIndex(0)
    setIssuePageLoading(false)
    setIssuePageError(null)
    setIssuePageAnnouncement('')
  }, [])

  const loadOperation = useCallback(async (
    operationIdValue: string,
    signal?: AbortSignal,
    options: OperationLoadOptions = {},
  ): Promise<OperationLoadResult> => {
    const requestGeneration = ++operationRequestGenerationRef.current
    const cursor = options.cursor === undefined
      ? issueCursorHistoryRef.current[issuePageIndexRef.current] ?? null
      : options.cursor
    try {
      const query = new URLSearchParams({ limit: String(BULK_ISSUE_PAGE_LIMIT) })
      if (cursor) query.set('cursor', cursor)
      const response = await fetch(
        `/api/workspace/jobs/${encodeURIComponent(jobId)}/candidate-bulk-operations/${encodeURIComponent(operationIdValue)}?${query}`,
        { cache: 'no-store', signal },
      )
      const raw = await response.json().catch(() => null)
      if (signal?.aborted || requestGeneration !== operationRequestGenerationRef.current) {
        return { kind: 'aborted' }
      }
      if (!response.ok) {
        const detail = objectValue(raw)?.error
        return {
          kind: 'error',
          message: typeof detail === 'string'
            ? detail
            : `The operation status endpoint returned HTTP ${response.status}.`,
        }
      }
      const parsed = readOperation(raw)
      if (!parsed || parsed.operationId !== operationIdValue) {
        return { kind: 'error', message: 'The operation status response was incomplete or did not match this operation ID.' }
      }
      setOperation(parsed)
      if (options.updateIssuePage !== false) {
        const issuePage = readIssuePage(raw)
        setIssues(issuePage.items)
        setIssueNextCursor(issuePage.nextCursor)
        if (options.focusIssuePage) {
          const pageNumber = (options.issuePageIndex ?? issuePageIndexRef.current) + 1
          setIssuePageAnnouncement(
            `Loaded bulk-operation issue page ${pageNumber} with ${issuePage.items.length} item${issuePage.items.length === 1 ? '' : 's'}.`,
          )
          const navigationGeneration = options.issueNavigationGeneration
          window.requestAnimationFrame(() => {
            if (
              navigationGeneration === undefined ||
              navigationGeneration === issueNavigationGenerationRef.current
            ) issuePageHeadingRef.current?.focus()
          })
        }
      }
      if (
        (parsed.status === 'completed' || parsed.status === 'partial' || parsed.status === 'failed') &&
        settledOperationRef.current !== parsed.operationId
      ) {
        settledOperationRef.current = parsed.operationId
        onSettledRef.current()
      }
      return { kind: 'loaded' }
    } catch {
      if (signal?.aborted || requestGeneration !== operationRequestGenerationRef.current) {
        return { kind: 'aborted' }
      }
      return { kind: 'error', message: 'A network error prevented recovery of the durable operation status.' }
    }
  }, [jobId])

  const recoverInitialOperation = useCallback(async (operationIdValue: string, signal?: AbortSignal) => {
    setRecovering(true)
    setRecoveryError(null)
    setCopyStatus(null)
    const result = await loadOperation(operationIdValue, signal)
    if (result.kind === 'aborted') return
    if (result.kind === 'error') setRecoveryError(result.message)
    setRecovering(false)
  }, [loadOperation])

  useEffect(() => {
    if (!initialOperationId) {
      setRecovering(false)
      setRecoveryError(null)
      return
    }
    if (operation?.operationId === initialOperationId) {
      setRecovering(false)
      setRecoveryError(null)
      return
    }
    resetIssuePaging()
    const controller = new AbortController()
    void recoverInitialOperation(initialOperationId, controller.signal)
    return () => controller.abort()
  }, [initialOperationId, operation?.operationId, recoverInitialOperation, resetIssuePaging])

  const operationIdValue = operation?.operationId ?? null
  const operationStatus = operation?.status ?? null

  useEffect(() => {
    if (
      !operationIdValue ||
      (initialOperationId && operationIdValue !== initialOperationId) ||
      (operationStatus !== 'queued' && operationStatus !== 'processing')
    ) return
    const controller = new AbortController()
    const refresh = () => {
      if (issueNavigationInFlightRef.current) return
      void loadOperation(operationIdValue, controller.signal)
    }
    const interval = window.setInterval(refresh, 2_500)
    refresh()
    return () => {
      controller.abort()
      window.clearInterval(interval)
    }
  }, [initialOperationId, loadOperation, operationIdValue, operationStatus])

  function chooseAction(nextAction: BulkAction, trigger: HTMLButtonElement) {
    actionTriggerRef.current = trigger
    setAction(nextAction)
    setReasonCode('')
    setAcknowledged(false)
    setError(null)
    setOperation(null)
    resetIssuePaging()
    commandRef.current = null
    window.requestAnimationFrame(() => confirmationHeadingRef.current?.focus())
  }

  function cancelAction() {
    const trigger = actionTriggerRef.current
    setAction(null)
    setReasonCode('')
    setAcknowledged(false)
    setError(null)
    window.requestAnimationFrame(() => trigger?.focus())
  }

  async function submit() {
    const activeSelection = selection
    if (!activeSelection || !action || busy || !acknowledged) return
    if (action === 'advance' && !expectedStage) {
      setError('Advance requires candidates from one stage. Filter to one stage, then create a new selection.')
      return
    }
    if ((action === 'reject' || action === 'withdraw') && !reasonCode) {
      setError('Choose a structured reason before confirming this bulk action.')
      return
    }
    const key = `${activeSelection.selectionId}:${action}:${reasonCode}:${expectedStage ?? ''}`
    const clientOperationId = commandRef.current?.key === key ? commandRef.current.id : operationId()
    commandRef.current = { key, id: clientOperationId }
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(
        `/api/workspace/jobs/${encodeURIComponent(jobId)}/candidate-bulk-operations`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            selectionId: activeSelection.selectionId,
            clientOperationId,
            action,
            ...(action === 'advance' && expectedStage ? { expectedStage } : {}),
            communication: 'none',
            ...(action !== 'advance' && reasonCode ? { reasonCode } : {}),
            confirmed: true,
            confirmedCount: activeSelection.count,
          }),
        },
      )
      const raw = await response.json().catch(() => null)
      if (!response.ok) {
        const message = objectValue(raw)?.error
        setError(typeof message === 'string' ? message : 'The bulk action was not started. Nothing has changed.')
        return
      }
      const parsed = readOperation(raw)
      if (!parsed) {
        setError('The operation was accepted but its durable status was unavailable. Refresh before retrying.')
        return
      }
      commandRef.current = null
      resetIssuePaging()
      setOperation(parsed)
      onOperationAccepted?.(parsed.operationId)
      void loadOperation(parsed.operationId)
    } catch {
      setError('No confirmation was received. You can retry safely with the same operation coordinate.')
    } finally {
      setBusy(false)
    }
  }

  async function copyDurableOperationId() {
    if (!initialOperationId) return
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(initialOperationId)
      setCopyStatus('Operation ID copied.')
    } catch {
      setCopyStatus('Copy was unavailable. Select the operation ID and copy it manually.')
    }
  }

  async function navigateIssuePage(cursor: string | null, nextPageIndex: number) {
    if (!operation || issuePageLoading || nextPageIndex < 0) return
    const navigationGeneration = ++issueNavigationGenerationRef.current
    issueNavigationInFlightRef.current = true
    setIssuePageLoading(true)
    setIssuePageError(null)
    const result = await loadOperation(operation.operationId, undefined, {
      cursor,
      focusIssuePage: true,
      issuePageIndex: nextPageIndex,
      issueNavigationGeneration: navigationGeneration,
    })
    if (navigationGeneration !== issueNavigationGenerationRef.current) return
    if (result.kind === 'loaded') {
      const nextHistory = nextPageIndex > issuePageIndexRef.current
        ? [...issueCursorHistoryRef.current.slice(0, issuePageIndexRef.current + 1), cursor]
        : issueCursorHistoryRef.current
      issueCursorHistoryRef.current = nextHistory
      issuePageIndexRef.current = nextPageIndex
      setIssueCursorHistory(nextHistory)
      setIssuePageIndex(nextPageIndex)
    } else if (result.kind === 'error') {
      setIssuePageError(result.message)
    }
    if (navigationGeneration !== issueNavigationGenerationRef.current) return
    issueNavigationInFlightRef.current = false
    setIssuePageLoading(false)
  }

  const unresolvedInitialOperation = Boolean(
    initialOperationId && operation?.operationId !== initialOperationId,
  )
  const reasonOptions = action === 'withdraw'
    ? BULK_REASON_OPTIONS.filter((option) => option.value === 'candidate_withdrew')
    : action === 'reject'
      ? BULK_REASON_OPTIONS.filter((option) => option.value !== 'candidate_withdrew')
      : []

  return (
    <div className="mt-4 border-t border-indigo-200 pt-4">
      {initialOperationId && unresolvedInitialOperation && recovering ? (
        <p className="rounded-xl border border-indigo-200 bg-white px-4 py-3 text-sm text-indigo-900" role="status">
          Recovering durable operation status…
        </p>
      ) : null}

      {initialOperationId && unresolvedInitialOperation && recoveryError ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800" role="alert">
          <p className="font-semibold">Durable operation status could not be recovered.</p>
          <p className="mt-1">{recoveryError} The server-side operation may still exist; do not start a replacement operation until this ID is checked.</p>
          <label htmlFor="durable-operation-id" className="mt-3 block text-xs font-semibold uppercase tracking-wide text-red-900">Durable operation ID</label>
          <input
            id="durable-operation-id"
            value={initialOperationId}
            readOnly
            onFocus={(event) => event.currentTarget.select()}
            className="mt-1 w-full rounded-lg border border-red-200 bg-white px-3 py-2 font-mono text-xs text-[#0f1419]"
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => void recoverInitialOperation(initialOperationId)}>Retry recovery</Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => void copyDurableOperationId()}>Copy operation ID</Button>
          </div>
          {copyStatus ? <p className="mt-2 text-xs" role="status">{copyStatus}</p> : null}
        </div>
      ) : null}

      {selection && canStartActions && !operation && !unresolvedInitialOperation ? (
        <>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Bulk stage actions">
            <Button type="button" variant="secondary" size="sm" disabled={!expectedStage} onClick={(event) => chooseAction('advance', event.currentTarget)}>
              Advance selected
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={(event) => chooseAction('reject', event.currentTarget)}>Reject selected…</Button>
            <Button type="button" variant="secondary" size="sm" onClick={(event) => chooseAction('withdraw', event.currentTarget)}>Mark withdrawn…</Button>
          </div>
          {!expectedStage ? <p className="mt-2 text-xs text-indigo-800">Advance is available only when the stable selection contains one stage. Filter to one stage and select again.</p> : null}
        </>
      ) : null}

      {selection && canStartActions && action && !operation && !unresolvedInitialOperation ? (
        <div className="mt-4 rounded-xl border border-indigo-200 bg-white p-4">
          <h3 ref={confirmationHeadingRef} tabIndex={-1} className="font-semibold text-[#0f1419] focus:outline-none">
            Confirm {action.replace('_', ' ')} for {selection.count.toLocaleString()} candidate{selection.count === 1 ? '' : 's'}
          </h3>
          <p className="mt-1 text-sm text-[#536471]">
            {action === 'advance' && expectedStage
              ? `Every candidate must still be in ${CANDIDATE_STAGE_LABEL[expectedStage]}. Stage races become conflicts rather than silent overwrites.`
              : 'The server revalidates stage, privacy, membership, and job state for every candidate.'}
          </p>
          {action !== 'advance' ? (
            <div className="mt-3">
              <label htmlFor="bulk-action-reason" className="block text-sm font-medium text-[#0f1419]">Structured reason</label>
              <select
                id="bulk-action-reason"
                value={reasonCode}
                onChange={(event) => setReasonCode(event.target.value as HireCandidateBulkReasonCode | '')}
                className="mt-1 h-10 w-full rounded-xl border border-[#dbe4ea] bg-[#f8fafc] px-3 text-sm"
              >
                <option value="">Choose a reason</option>
                {reasonOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              <p className="mt-1 text-xs text-[#536471]">Only a neutral operational code is stored. Do not add candidate details; this bulk workflow accepts no free-text notes.</p>
            </div>
          ) : null}
          <label className="mt-3 flex items-start gap-2 text-sm text-[#0f1419]">
            <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} className="mt-1" />
            <span>I confirm this exact {selection.count.toLocaleString()}-candidate snapshot. Communication is set to none; this action will not send candidate email.</span>
          </label>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button type="button" disabled={busy || !acknowledged || (action !== 'advance' && !reasonCode)} onClick={() => void submit()}>{busy ? 'Starting…' : 'Start durable operation'}</Button>
            <Button type="button" variant="secondary" disabled={busy} onClick={cancelAction}>Cancel</Button>
          </div>
        </div>
      ) : null}

      {error ? <p className="mt-3 text-sm text-red-700" role="alert">{error}</p> : null}
      <p className="sr-only" aria-live="polite">
        {operation ? `${operation.processed} of ${operation.total} processed; ${operation.succeeded} succeeded; ${operation.conflicts} conflicts; ${operation.failed} failures.` : ''}
      </p>
      {operation ? (
        <div className="mt-4 rounded-xl border border-indigo-200 bg-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold text-[#0f1419]">Bulk {operation.action.replace('_', ' ')} · {operation.status}</h3>
            {(operation.status === 'queued' || operation.status === 'processing') ? (
              <Button type="button" variant="ghost" size="sm" disabled={issuePageLoading} onClick={() => void loadOperation(operation.operationId)}>Refresh status</Button>
            ) : (
              <Button type="button" variant="secondary" size="sm" onClick={onFinish}>Finish and choose candidates again</Button>
            )}
          </div>
          <p className="mt-2 text-sm text-[#536471]">{operation.processed} processed · {operation.succeeded} succeeded · {operation.conflicts} conflicts · {operation.failed} controlled failures</p>
          {operation.conflicts + operation.failed > 0 || issues.length > 0 ? (
            <details className="mt-3">
              <summary className="cursor-pointer text-sm font-medium text-[#2563eb]">Review conflicts and failures</summary>
              <h4
                ref={issuePageHeadingRef}
                tabIndex={-1}
                className="mt-3 text-sm font-semibold text-[#0f1419] focus:outline-none"
              >
                Issue page {issuePageIndex + 1}
              </h4>
              <p className="mt-1 text-xs text-[#536471]">
                {issues.length} shown on this page · at most {BULK_ISSUE_PAGE_LIMIT} issues are mounted at once
              </p>
              {issuePageError ? <p className="mt-2 text-sm text-red-700" role="alert">{issuePageError}</p> : null}
              {issues.length > 0 ? (
                <ul className="mt-2 space-y-2 text-sm text-[#536471]">
                  {issues.map((issue) => (
                    <li key={issue.itemId}>
                      <Link
                        href={`/workspace/applications/${encodeURIComponent(issue.applicationId)}?${new URLSearchParams({ returnTo })}`}
                        aria-label={`Review bulk issue for application ${issue.applicationId}`}
                        className="font-medium text-[#2563eb] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                      >
                        Application {issue.applicationId}
                      </Link>
                      {' · '}
                      <span className="font-medium text-[#0f1419]">{issue.outcome.replaceAll('_', ' ')}</span> · {issue.message}
                    </li>
                  ))}
                </ul>
              ) : <p className="mt-2 text-sm text-[#536471]">No issues were returned for this page.</p>}
              <div className="mt-3 flex flex-wrap gap-2" aria-label="Bulk-operation issue pages">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={issuePageLoading || issuePageIndex === 0}
                  onClick={() => void navigateIssuePage(issueCursorHistory[issuePageIndex - 1] ?? null, issuePageIndex - 1)}
                >
                  Previous issues
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={issuePageLoading || !issueNextCursor}
                  onClick={() => void navigateIssuePage(issueNextCursor, issuePageIndex + 1)}
                >
                  Next issues
                </Button>
              </div>
            </details>
          ) : null}
          <p className="sr-only" aria-live="polite">{issuePageAnnouncement}</p>
        </div>
      ) : null}
    </div>
  )
}
