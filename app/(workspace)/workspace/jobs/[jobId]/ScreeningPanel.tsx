'use client'

/**
 * Recruiter-only screening review surface.
 *
 * A preview is deliberately read-only. HR must explicitly confirm the exact
 * fingerprint they reviewed before the server creates a durable invitation
 * schedule. The delivery worker sends only after that explicit confirmation
 * and its planned time. This component never changes a candidate stage,
 * exposes a resume, or handles a public capability.
 */

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from 'react'
import Link from 'next/link'
import Badge from '@shared/ui/Badge'
import Button from '@shared/ui/Button'

type SelectionMode = 'top_n' | 'above_threshold'
type ExceptionAction = 'include' | 'exclude'
type ScoreState = 'scored' | 'stale' | 'unscored'

interface ScreeningRuleRequest {
  mode: SelectionMode
  topN?: number
  scoreThreshold?: number
  knockoutSettings?: {
    location?: string
    experienceFloorYears?: number
  }
}

interface ScreeningExceptionRequest {
  applicationId: string
  action: ExceptionAction
  note: string
}

type CandidateIdentityState = 'available' | 'privacy_protected' | 'unavailable'

interface CandidateIdentityView {
  applicationId: string
  candidateId: string
  identityState: CandidateIdentityState
  displayName: string | null
  email: string | null
  applicationUrl: string | null
}

interface PreviewEntry {
  applicationId: string
  candidateId: string
  applicationCreatedAt: string
  rank: number | null
  score: number | null
  scoreState: ScoreState
  knockoutReasons: Array<'location' | 'experience'>
  automaticallySelected: boolean
  selected: boolean
  selectionReason:
    | 'top_n'
    | 'above_threshold'
    | 'below_cut_line'
    | 'below_threshold'
    | 'stale_or_unscored'
    | 'knockout'
    | 'manual_include'
    | 'manual_exclude'
  candidate?: CandidateIdentityView | null
}

interface ScreeningPreview {
  workspaceId: string
  jobId: string
  rule: {
    mode: SelectionMode
    topN?: number
    scoreThreshold?: number
    knockoutSettings: {
      location?: string
      experienceFloorYears?: number
    }
  }
  generatedAt: string
  evaluatedCount: number
  eligibleCount: number
  automaticallySelectedCount: number
  selectedCount: number
  cutLine: {
    mode: SelectionMode
    requestedTopN?: number
    scoreThreshold?: number
    applicationId?: string
    rank?: number
    score?: number | null
  }
  rankedApplications: PreviewEntry[]
  exceptions: Array<ScreeningExceptionRequest & { actorName?: string; at?: string }>
  selectedApplicationIds: string[]
}

interface PreviewResponse {
  preview: ScreeningPreview
  requirementVersion: {
    id: string
    version: number
    contentHash: string
  }
  previewFingerprint: string
}

interface InvitationBatch {
  id: string
  screeningGateId: string
  wave: number
  sendAfter: string
  status: 'planned' | 'scheduled' | 'dispatching' | 'completed' | 'cancelled' | 'failed'
  plannedCount: number
  sentCount: number
  failedCount: number
  lastError: string | null
  completedAt: string | null
  cancelledAt: string | null
  createdByName: string
  createdAt: string
  recipients: RecipientDelivery[]
}

interface RecipientDelivery {
  id: string
  batchId: string
  applicationId: string | null
  candidate: CandidateIdentityView | null
  identityState: CandidateIdentityState | 'privacy_redacted'
  rank: number | null
  score: number | null
  scoreState: ScoreState
  selectionReason: 'top_n' | 'above_threshold' | 'manual_include' | 'waterfall'
  sendAfter: string
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled' | 'skipped'
  deliveryStatus: 'pending' | 'sending' | 'sent' | 'failed' | null
  attempts: number
  sentAt: string | null
  issue: {
    code:
      | 'privacy_redacted'
      | 'delivery_failed'
      | 'retry_scheduled'
      | 'delivery_cancelled'
      | 'delivery_skipped'
    message: string
  } | null
}

interface RecipientDeliveryPage {
  recipients: RecipientDelivery[]
  hasMore: boolean
  nextCursor: string | null
}

interface ScreeningGate {
  id: string
  status: 'confirmed' | 'cancelled'
  requirementVersion: { id: string; version: number; contentHash: string }
  rule: {
    mode: SelectionMode
    topN: number | null
    scoreThreshold: number | null
    knockoutSettings: { location: string | null; experienceFloorYears: number | null }
  }
  cutLine: {
    mode: SelectionMode
    requestedTopN: number | null
    scoreThreshold: number | null
    applicationId: string | null
    rank: number | null
    score: number | null
    candidate?: CandidateIdentityView | null
  }
  counts: {
    evaluated: number
    eligible: number
    automaticallySelected: number
    selected: number
  }
  rankedApplications: PreviewEntry[]
  exceptions: Array<
    ScreeningExceptionRequest & {
      actorName: string
      at: string
      candidate?: CandidateIdentityView | null
    }
  >
  confirmedByName: string
  confirmedAt: string
  cancelledAt: string | null
  cancelNote: string | null
  createdAt: string
  batches: InvitationBatch[]
}

interface ScreeningRuleDraft {
  mode: SelectionMode
  topN: string
  scoreThreshold: string
  location: string
  experienceFloorYears: string
}

export interface ScreeningPanelProps {
  jobId: string
  /** Passing the job status prevents an unnecessary preview on a closed job. */
  jobStatus?: 'open' | 'on_hold' | 'closed'
}

const INITIAL_RULE: ScreeningRuleDraft = {
  mode: 'top_n',
  topN: '10',
  scoreThreshold: '70',
  location: '',
  experienceFloorYears: '',
}

const PREVIEW_ROW_PAGE_SIZE = 50
const EXCEPTION_RESULT_LIMIT = 50

function endpoint(jobId: string, suffix = ''): string {
  return `/api/workspace/jobs/${encodeURIComponent(jobId)}/screening${suffix}`
}

function responseError(data: unknown, fallback: string): string {
  if (data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string') {
    return (data as { error: string }).error
  }
  return fallback
}

function displayDate(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

function shortId(value: string): string {
  return value.length > 8 ? `…${value.slice(-8)}` : value
}

function entryLabel(
  entry: Pick<PreviewEntry, 'applicationId' | 'candidateId' | 'candidate'>,
): string {
  if (entry.candidate?.identityState === 'available') {
    return `${entry.candidate.displayName} · ${entry.candidate.email}`
  }
  if (entry.candidate?.identityState === 'privacy_protected') {
    return 'Candidate details unavailable while a privacy request is active'
  }
  return `Candidate details unavailable · application ${shortId(entry.applicationId)}`
}

function filterPreviewEntries(
  entries: PreviewEntry[],
  query: string,
): PreviewEntry[] {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return entries
  return entries.filter((entry) =>
    [
      entry.applicationId,
      entry.candidateId,
      entry.candidate?.displayName,
      entry.candidate?.email,
    ].some(
      (value) =>
        typeof value === 'string' &&
        value.toLowerCase().includes(normalizedQuery),
    ),
  )
}

function CandidateIdentityLine({
  candidate,
  identityState,
}: {
  candidate?: CandidateIdentityView | null
  identityState?: CandidateIdentityState | 'privacy_redacted'
}) {
  if (
    candidate?.identityState === 'available' &&
    candidate.displayName &&
    candidate.email &&
    candidate.applicationUrl
  ) {
    return (
      <div className="min-w-0">
        <Link
          href={candidate.applicationUrl}
          className="block truncate font-medium text-indigo-700 hover:underline"
        >
          {candidate.displayName}
        </Link>
        <p className="truncate text-xs text-[#536471]">{candidate.email}</p>
      </div>
    )
  }
  const privacyProtected =
    identityState === 'privacy_redacted' ||
    identityState === 'privacy_protected' ||
    candidate?.identityState === 'privacy_protected'
  return (
    <div className="min-w-0">
      <p className="font-medium text-[#536471]">Candidate details unavailable</p>
      <p className="text-xs text-[#71767b]">
        {privacyProtected
          ? 'Identity is hidden because privacy processing is active or complete.'
          : 'The current candidate record could not be loaded. Refresh before acting.'}
      </p>
    </div>
  )
}

function recipientVariant(
  recipient: RecipientDelivery,
): 'default' | 'primary' | 'success' | 'caution' | 'danger' {
  if (recipient.status === 'sent') return 'success'
  if (
    recipient.status === 'failed' ||
    recipient.status === 'cancelled' ||
    recipient.status === 'skipped'
  ) {
    return 'danger'
  }
  if (recipient.status === 'sending') return 'caution'
  return 'primary'
}

function recipientStatusLabel(recipient: RecipientDelivery): string {
  if (recipient.status === 'pending' && recipient.issue?.code === 'retry_scheduled') {
    return 'retry scheduled'
  }
  return recipient.status
}

function browserTimeZoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'browser local time'
  } catch {
    return 'browser local time'
  }
}

function RecipientDeliveryLedger({
  jobId,
  batchId,
}: {
  jobId: string
  batchId: string
}) {
  const [recipients, setRecipients] = useState<RecipientDelivery[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadRecipients = useCallback(async (cursor?: string) => {
    setLoading(true)
    setError(null)
    try {
      const search = new URLSearchParams({ limit: '25' })
      if (cursor) search.set('cursor', cursor)
      const response = await fetch(
        endpoint(
          jobId,
          `/batches/${encodeURIComponent(batchId)}/recipients?${search.toString()}`,
        ),
        { cache: 'no-store' },
      )
      const data = await response.json().catch(() => null)
      if (
        !response.ok ||
        !data ||
        !Array.isArray((data as Partial<RecipientDeliveryPage>).recipients) ||
        typeof (data as Partial<RecipientDeliveryPage>).hasMore !== 'boolean'
      ) {
        throw new Error(responseError(data, 'Could not load recipient delivery status.'))
      }
      const page = data as RecipientDeliveryPage
      setRecipients((previous) => cursor ? [...previous, ...page.recipients] : page.recipients)
      setNextCursor(page.hasMore ? page.nextCursor : null)
      setLoaded(true)
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : 'Could not load recipient delivery status.',
      )
    } finally {
      setLoading(false)
    }
  }, [batchId, jobId])

  return (
    <details
      className="mt-3 rounded-lg border border-[#e1e8ed] bg-white p-3"
      onToggle={(event) => {
        if (event.currentTarget.open && !loaded && !loading) {
          void loadRecipients()
        }
      }}
    >
      <summary className="cursor-pointer text-sm font-medium text-[#0f1419]">
        Recipient delivery details
      </summary>
      {loading && !loaded ? (
        <p className="mt-3 text-xs text-[#71767b]" aria-busy="true">
          Loading recipient delivery status…
        </p>
      ) : null}
      {error ? (
        <div role="alert" className="mt-3 rounded-lg bg-red-50 p-3 text-xs text-red-800">
          <p>{error}</p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="mt-2"
            disabled={loading}
            onClick={() => void loadRecipients(loaded ? nextCursor ?? undefined : undefined)}
          >
            Try loading recipients again
          </Button>
        </div>
      ) : null}
      {loaded && recipients.length === 0 ? (
        <p className="mt-3 text-xs text-[#71767b]">
          No recipient rows are available for this batch.
        </p>
      ) : null}
      {recipients.length ? (
        <ul className="mt-3 divide-y divide-[#e1e8ed]" aria-label="Recipient delivery status">
          {recipients.map((recipient) => (
            <li key={recipient.id} className="space-y-2 py-3 first:pt-0 last:pb-0">
              <div className="flex items-start justify-between gap-3">
                <CandidateIdentityLine
                  candidate={recipient.candidate}
                  identityState={recipient.identityState}
                />
                <Badge variant={recipientVariant(recipient)}>
                  {recipientStatusLabel(recipient)}
                </Badge>
              </div>
              <p className="text-xs text-[#71767b]">
                Planned {displayDate(recipient.sendAfter)} · {recipient.attempts}{' '}
                {recipient.attempts === 1 ? 'attempt' : 'attempts'}
                {recipient.sentAt ? ` · sent ${displayDate(recipient.sentAt)}` : ''}
              </p>
              {recipient.issue ? (
                <p className="text-xs text-[#a16207]">{recipient.issue.message}</p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {loaded && nextCursor ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="mt-3"
          disabled={loading}
          onClick={() => void loadRecipients(nextCursor)}
        >
          {loading ? 'Loading more recipients…' : 'Load more recipients'}
        </Button>
      ) : null}
    </details>
  )
}

function ruleFromDraft(draft: ScreeningRuleDraft):
  | { rule: ScreeningRuleRequest; error: null }
  | { rule: null; error: string } {
  const knockoutSettings: NonNullable<ScreeningRuleRequest['knockoutSettings']> = {}
  const location = draft.location.trim()
  if (location) knockoutSettings.location = location

  const experience = draft.experienceFloorYears.trim()
  if (experience) {
    const floor = Number(experience)
    if (!Number.isFinite(floor) || floor < 0 || floor > 50) {
      return { rule: null, error: 'Experience floor must be a number from 0 to 50.' }
    }
    knockoutSettings.experienceFloorYears = floor
  }

  if (draft.mode === 'top_n') {
    const topN = Number(draft.topN)
    if (!Number.isInteger(topN) || topN < 1 || topN > 5000) {
      return { rule: null, error: 'Top N must be a whole number from 1 to 5,000.' }
    }
    return {
      rule: {
        mode: 'top_n',
        topN,
        ...(Object.keys(knockoutSettings).length ? { knockoutSettings } : {}),
      },
      error: null,
    }
  }

  const scoreThreshold = Number(draft.scoreThreshold)
  if (!Number.isFinite(scoreThreshold) || scoreThreshold < 0 || scoreThreshold > 100) {
    return { rule: null, error: 'Score threshold must be a number from 0 to 100.' }
  }
  return {
    rule: {
      mode: 'above_threshold',
      scoreThreshold,
      ...(Object.keys(knockoutSettings).length ? { knockoutSettings } : {}),
    },
    error: null,
  }
}

function requestKey(input: { rule: ScreeningRuleRequest; exceptions: ScreeningExceptionRequest[] }): string {
  return JSON.stringify(input)
}

function selectionReasonLabel(reason: PreviewEntry['selectionReason']): string {
  const labels: Record<PreviewEntry['selectionReason'], string> = {
    top_n: 'Within top N',
    above_threshold: 'At or above threshold',
    below_cut_line: 'Below cut line',
    below_threshold: 'Below threshold',
    stale_or_unscored: 'Unknown score',
    knockout: 'Known knockout',
    manual_include: 'Manually included',
    manual_exclude: 'Manually excluded',
  }
  return labels[reason]
}

function scoreStateLabel(state: ScoreState): string {
  if (state === 'scored') return 'Fresh score'
  if (state === 'stale') return 'Stale score'
  return 'Unknown score'
}

function batchVariant(status: InvitationBatch['status']): 'default' | 'primary' | 'success' | 'caution' | 'danger' {
  if (status === 'completed') return 'success'
  if (status === 'failed' || status === 'cancelled') return 'danger'
  if (status === 'dispatching') return 'caution'
  if (status === 'scheduled') return 'primary'
  return 'default'
}

function selectionVariant(entry: PreviewEntry): 'default' | 'primary' | 'success' | 'caution' | 'danger' {
  if (entry.selected) return 'success'
  if (entry.knockoutReasons.length) return 'danger'
  if (entry.scoreState !== 'scored') return 'caution'
  return 'default'
}

function scoreStateCount(entries: PreviewEntry[], state: ScoreState): number {
  return entries.filter((entry) => entry.scoreState === state).length
}

function knockoutCount(entries: PreviewEntry[]): number {
  return entries.filter((entry) => entry.knockoutReasons.length > 0).length
}

function cutLineDescription(preview: ScreeningPreview): string {
  if (preview.rule.mode === 'above_threshold') {
    return `Threshold: ${preview.cutLine.scoreThreshold ?? preview.rule.scoreThreshold ?? '—'} / 100`
  }
  if (!preview.cutLine.applicationId) {
    return `Top ${preview.cutLine.requestedTopN ?? preview.rule.topN ?? '—'}; no eligible scored cut line yet`
  }
  const score = preview.cutLine.score === null || preview.cutLine.score === undefined
    ? 'unknown score'
    : `${preview.cutLine.score}/100`
  return `Cut line: rank ${preview.cutLine.rank ?? '—'} · ${score}`
}

function normaliseConfirmTime(value: string): { value?: string; error?: string } {
  if (!value) return {}
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return { error: 'Choose a valid planned send time.' }
  return { value: parsed.toISOString() }
}

export default function ScreeningPanel({ jobId, jobStatus }: ScreeningPanelProps) {
  const [ruleDraft, setRuleDraft] = useState<ScreeningRuleDraft>(INITIAL_RULE)
  const [exceptions, setExceptions] = useState<ScreeningExceptionRequest[]>([])
  const [exceptionTargetId, setExceptionTargetId] = useState('')
  const [exceptionSearch, setExceptionSearch] = useState('')
  const [exceptionAction, setExceptionAction] = useState<ExceptionAction>('include')
  const [exceptionNote, setExceptionNote] = useState('')
  const [previewState, setPreviewState] = useState<PreviewResponse | null>(null)
  const [reviewedRequest, setReviewedRequest] = useState<{
    rule: ScreeningRuleRequest
    exceptions: ScreeningExceptionRequest[]
  } | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [sendAfter, setSendAfter] = useState('')
  const [confirmAcknowledged, setConfirmAcknowledged] = useState(false)
  const [confirmBusy, setConfirmBusy] = useState(false)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const [confirmNotice, setConfirmNotice] = useState<string | null>(null)
  const [gates, setGates] = useState<ScreeningGate[] | null>(null)
  const [gatesError, setGatesError] = useState<string | null>(null)
  const [gatesLoading, setGatesLoading] = useState(false)
  const [waterfallCounts, setWaterfallCounts] = useState<Record<string, string>>({})
  const [waterfallAcknowledged, setWaterfallAcknowledged] = useState<Record<string, boolean>>({})
  const [waterfallBusyGateId, setWaterfallBusyGateId] = useState<string | null>(null)
  const [waterfallError, setWaterfallError] = useState<string | null>(null)
  const [waterfallNotice, setWaterfallNotice] = useState<string | null>(null)
  const [retryBusyBatchId, setRetryBusyBatchId] = useState<string | null>(null)
  const [retryError, setRetryError] = useState<string | null>(null)
  const [retryNotice, setRetryNotice] = useState<string | null>(null)
  const [browserTimeZone, setBrowserTimeZone] = useState('browser local time')
  const [selectedSearch, setSelectedSearch] = useState('')
  const [selectedVisibleCount, setSelectedVisibleCount] = useState(
    PREVIEW_ROW_PAGE_SIZE,
  )
  const [evaluatedOpen, setEvaluatedOpen] = useState(false)
  const [evaluatedSearch, setEvaluatedSearch] = useState('')
  const [evaluatedVisibleCount, setEvaluatedVisibleCount] = useState(
    PREVIEW_ROW_PAGE_SIZE,
  )

  const deferredExceptionSearch = useDeferredValue(exceptionSearch)
  const deferredSelectedSearch = useDeferredValue(selectedSearch)
  const deferredEvaluatedSearch = useDeferredValue(evaluatedSearch)

  const jobOpen = jobStatus === undefined || jobStatus === 'open'
  const ruleResult = useMemo(() => ruleFromDraft(ruleDraft), [ruleDraft])
  const currentRequest = useMemo(() => {
    if (!ruleResult.rule) return null
    return { rule: ruleResult.rule, exceptions }
  }, [exceptions, ruleResult])
  const previewIsCurrent = Boolean(
    previewState &&
      reviewedRequest &&
      currentRequest &&
      requestKey(reviewedRequest) === requestKey(currentRequest),
  )

  const loadGates = useCallback(async () => {
    setGatesLoading(true)
    setGatesError(null)
    try {
      const response = await fetch(endpoint(jobId), { cache: 'no-store' })
      const data = await response.json().catch(() => null)
      if (!response.ok || !Array.isArray((data as { gates?: unknown } | null)?.gates)) {
        throw new Error(responseError(data, 'Could not load screening batches.'))
      }
      setGates((data as { gates: ScreeningGate[] }).gates)
    } catch (error) {
      setGatesError(error instanceof Error ? error.message : 'Could not load screening batches.')
    } finally {
      setGatesLoading(false)
    }
  }, [jobId])

  useEffect(() => {
    setBrowserTimeZone(browserTimeZoneName())
  }, [])

  useEffect(() => {
    void loadGates()
  }, [loadGates])

  async function requestPreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPreviewError(null)
    setConfirmError(null)
    setConfirmNotice(null)
    if (!jobOpen) {
      setPreviewError('Reopen this job before creating a screening review.')
      return
    }
    if (!currentRequest) {
      setPreviewError(ruleResult.error || 'Fix the screening rule before previewing it.')
      return
    }

    setPreviewBusy(true)
    try {
      const response = await fetch(endpoint(jobId, '/preview'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(currentRequest),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data || typeof data.previewFingerprint !== 'string') {
        setPreviewError(responseError(data, 'Could not build the screening preview.'))
        return
      }
      const nextPreview = data as PreviewResponse
      setPreviewState(nextPreview)
      setReviewedRequest(currentRequest)
      setConfirmAcknowledged(false)
      setExceptionTargetId((previous) =>
        nextPreview.preview.rankedApplications.some(
          (entry) => entry.applicationId === previous,
        )
          ? previous
          : nextPreview.preview.rankedApplications[0]?.applicationId || '',
      )
      setExceptionSearch('')
      setSelectedSearch('')
      setSelectedVisibleCount(PREVIEW_ROW_PAGE_SIZE)
      setEvaluatedOpen(false)
      setEvaluatedSearch('')
      setEvaluatedVisibleCount(PREVIEW_ROW_PAGE_SIZE)
    } catch {
      setPreviewError('Something went wrong. Check your connection and try again.')
    } finally {
      setPreviewBusy(false)
    }
  }

  function addException() {
    const applicationId = exceptionTargetId.trim()
    const note = exceptionNote.trim()
    if (!applicationId) {
      setPreviewError('Choose an application before adding an exception.')
      return
    }
    if (!note) {
      setPreviewError('Every include or exclude exception needs a note.')
      return
    }
    setPreviewError(null)
    setExceptions((previous) => [
      ...previous.filter((exception) => exception.applicationId !== applicationId),
      { applicationId, action: exceptionAction, note },
    ])
    setExceptionNote('')
    setConfirmAcknowledged(false)
  }

  function removeException(applicationId: string) {
    setExceptions((previous) => previous.filter((exception) => exception.applicationId !== applicationId))
    setConfirmAcknowledged(false)
  }

  async function confirmPreview() {
    setConfirmError(null)
    setConfirmNotice(null)
    if (!jobOpen) {
      setConfirmError('Reopen this job before confirming a screening batch.')
      return
    }
    if (!previewState || !reviewedRequest || !previewIsCurrent) {
      setConfirmError('Refresh the preview after any rule or exception change before confirming.')
      return
    }
    if (previewState.preview.selectedCount < 1) {
      setConfirmError('This review selects no candidates, so there is no invitation batch to confirm.')
      return
    }
    if (!confirmAcknowledged) {
      setConfirmError('Confirm that you reviewed this selection before creating the batch.')
      return
    }
    const plannedTime = normaliseConfirmTime(sendAfter)
    if (plannedTime.error) {
      setConfirmError(plannedTime.error)
      return
    }

    setConfirmBusy(true)
    try {
      const response = await fetch(endpoint(jobId, '/confirm'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...reviewedRequest,
          previewFingerprint: previewState.previewFingerprint,
          ...(plannedTime.value ? { sendAfter: plannedTime.value } : {}),
        }),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok) {
        setConfirmError(responseError(data, 'Could not create the screening batch.'))
        return
      }
      const count = typeof data?.itemCount === 'number' ? data.itemCount : previewState.preview.selectedCount
      setConfirmNotice(
        `Created a scheduled batch for ${count} ${count === 1 ? 'candidate' : 'candidates'}. Staggered invitations begin at the planned time; no candidate was rejected or moved.`,
      )
      setPreviewState(null)
      setReviewedRequest(null)
      setConfirmAcknowledged(false)
      await loadGates()
    } catch {
      setConfirmError('Something went wrong. Check your connection and try again.')
    } finally {
      setConfirmBusy(false)
    }
  }

  async function createWaterfall(gate: ScreeningGate) {
    setWaterfallError(null)
    setWaterfallNotice(null)
    if (!jobOpen) {
      setWaterfallError('Reopen this job before scheduling another invitation wave.')
      return
    }
    const count = Number(waterfallCounts[gate.id] || '1')
    if (!Number.isInteger(count) || count < 1 || count > 100) {
      setWaterfallError('Next-wave size must be a whole number from 1 to 100.')
      return
    }
    if (!waterfallAcknowledged[gate.id]) {
      setWaterfallError('Confirm the next-wave schedule before creating it.')
      return
    }

    setWaterfallBusyGateId(gate.id)
    try {
      const response = await fetch(endpoint(jobId, `/gates/${encodeURIComponent(gate.id)}/waterfall`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count }),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok) {
        setWaterfallError(responseError(data, 'Could not schedule the next invitation wave.'))
        return
      }
      const scheduled = typeof data?.count === 'number' ? data.count : count
      setWaterfallNotice(
        `Scheduled the next wave for ${scheduled} ${scheduled === 1 ? 'candidate' : 'candidates'}. Delivery is staggered from now; previous reservations remain excluded.`,
      )
      setWaterfallAcknowledged((previous) => ({ ...previous, [gate.id]: false }))
      await loadGates()
    } catch {
      setWaterfallError('Something went wrong. Check your connection and try again.')
    } finally {
      setWaterfallBusyGateId(null)
    }
  }

  async function retryFailedBatch(batch: InvitationBatch) {
    setRetryError(null)
    setRetryNotice(null)
    if (!jobOpen) {
      setRetryError('Reopen this job before retrying a failed invitation batch.')
      return
    }

    setRetryBusyBatchId(batch.id)
    try {
      const response = await fetch(endpoint(jobId, `/batches/${encodeURIComponent(batch.id)}/retry`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok) {
        setRetryError(responseError(data, 'Could not requeue the failed invitations.'))
        return
      }
      const requeued = typeof data?.requeued === 'number' ? data.requeued : 0
      setRetryNotice(
        requeued
          ? `Requeued ${requeued} failed ${requeued === 1 ? 'invitation' : 'invitations'} using their existing secure delivery records.`
          : 'There were no failed invitations left to requeue.',
      )
      await loadGates()
    } catch {
      setRetryError('Something went wrong. Check your connection and try again.')
    } finally {
      setRetryBusyBatchId(null)
    }
  }

  const preview = previewState?.preview ?? null
  const allPreviewEntries = useMemo(
    () => preview?.rankedApplications ?? [],
    [preview],
  )
  const selectedEntries = useMemo(
    () => allPreviewEntries.filter((entry) => entry.selected),
    [allPreviewEntries],
  )
  const entriesByApplicationId = useMemo(
    () =>
      new Map(
        allPreviewEntries.map((entry) => [entry.applicationId, entry] as const),
      ),
    [allPreviewEntries],
  )
  const cutLineEntry = preview?.cutLine.applicationId
    ? entriesByApplicationId.get(preview.cutLine.applicationId)
    : null
  const staleCount = useMemo(
    () => scoreStateCount(allPreviewEntries, 'stale'),
    [allPreviewEntries],
  )
  const unknownCount = useMemo(
    () => scoreStateCount(allPreviewEntries, 'unscored'),
    [allPreviewEntries],
  )
  const knownKnockoutCount = useMemo(
    () => knockoutCount(allPreviewEntries),
    [allPreviewEntries],
  )
  const matchingExceptionEntries = useMemo(
    () => filterPreviewEntries(allPreviewEntries, deferredExceptionSearch),
    [allPreviewEntries, deferredExceptionSearch],
  )
  const exceptionOptions = useMemo(() => {
    const options = matchingExceptionEntries.slice(0, EXCEPTION_RESULT_LIMIT)
    const selectedEntry = entriesByApplicationId.get(exceptionTargetId)
    if (
      selectedEntry &&
      !options.some((entry) => entry.applicationId === selectedEntry.applicationId)
    ) {
      return [selectedEntry, ...options.slice(0, EXCEPTION_RESULT_LIMIT - 1)]
    }
    return options
  }, [entriesByApplicationId, exceptionTargetId, matchingExceptionEntries])
  const matchingSelectedEntries = useMemo(
    () => filterPreviewEntries(selectedEntries, deferredSelectedSearch),
    [deferredSelectedSearch, selectedEntries],
  )
  const visibleSelectedEntries = matchingSelectedEntries.slice(
    0,
    selectedVisibleCount,
  )
  const matchingEvaluatedEntries = useMemo(
    () => filterPreviewEntries(allPreviewEntries, deferredEvaluatedSearch),
    [allPreviewEntries, deferredEvaluatedSearch],
  )
  const visibleEvaluatedEntries = matchingEvaluatedEntries.slice(
    0,
    evaluatedVisibleCount,
  )

  return (
    <section aria-labelledby="screening-title" className="rounded-2xl border border-[#e1e8ed] bg-white p-5 space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 id="screening-title" className="text-base font-semibold text-[#0f1419]">
            Screening gate
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-[#536471]">
            Review the ranked queue, then explicitly authorize a planned invitation schedule. Due
            invitations are delivered in a bounded stagger; the workflow never auto-rejects people
            or changes a candidate stage.
          </p>
        </div>
        {!jobOpen ? <Badge variant="caution">job is not open</Badge> : null}
      </div>

      <form onSubmit={requestPreview} className="space-y-4 border-t border-[#e1e8ed] pt-5">
        <fieldset disabled={!jobOpen || previewBusy || confirmBusy} className="space-y-4 disabled:opacity-60">
          <legend className="text-sm font-medium text-[#0f1419]">Selection rule</legend>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="rounded-xl border border-[#e1e8ed] p-3 text-sm text-[#0f1419]">
              <input
                type="radio"
                name="screening-mode"
                value="top_n"
                checked={ruleDraft.mode === 'top_n'}
                onChange={() => setRuleDraft((previous) => ({ ...previous, mode: 'top_n' }))}
                className="mr-2"
              />
              Invite the top N ranked candidates
            </label>
            <label className="rounded-xl border border-[#e1e8ed] p-3 text-sm text-[#0f1419]">
              <input
                type="radio"
                name="screening-mode"
                value="above_threshold"
                checked={ruleDraft.mode === 'above_threshold'}
                onChange={() => setRuleDraft((previous) => ({ ...previous, mode: 'above_threshold' }))}
                className="mr-2"
              />
              Invite everyone at or above a score
            </label>
          </div>

          {ruleDraft.mode === 'top_n' ? (
            <label className="block max-w-xs text-sm font-medium text-[#0f1419]">
              Top N
              <input
                aria-label="Top N"
                type="number"
                min="1"
                max="5000"
                step="1"
                required
                value={ruleDraft.topN}
                onChange={(event) => setRuleDraft((previous) => ({ ...previous, topN: event.target.value }))}
                className="mt-1 block h-9 w-full rounded-lg border border-[#e1e8ed] px-3 text-sm"
              />
            </label>
          ) : (
            <label className="block max-w-xs text-sm font-medium text-[#0f1419]">
              Score threshold (0–100)
              <input
                aria-label="Score threshold"
                type="number"
                min="0"
                max="100"
                step="0.1"
                required
                value={ruleDraft.scoreThreshold}
                onChange={(event) =>
                  setRuleDraft((previous) => ({ ...previous, scoreThreshold: event.target.value }))
                }
                className="mt-1 block h-9 w-full rounded-lg border border-[#e1e8ed] px-3 text-sm"
              />
            </label>
          )}

          <div>
            <p className="text-sm font-medium text-[#0f1419]">Optional known knockouts</p>
            <p className="mt-0.5 text-xs text-[#71767b]">
              Missing profile information remains unknown; it is not a knockout.
            </p>
            <div className="mt-2 grid gap-3 md:grid-cols-2">
              <label className="text-sm text-[#0f1419]">
                Required location
                <input
                  aria-label="Required location"
                  type="text"
                  maxLength={160}
                  value={ruleDraft.location}
                  onChange={(event) =>
                    setRuleDraft((previous) => ({ ...previous, location: event.target.value }))
                  }
                  placeholder="e.g. Bengaluru"
                  className="mt-1 block h-9 w-full rounded-lg border border-[#e1e8ed] px-3 text-sm"
                />
              </label>
              <label className="text-sm text-[#0f1419]">
                Minimum years of experience
                <input
                  aria-label="Minimum years of experience"
                  type="number"
                  min="0"
                  max="50"
                  step="0.5"
                  value={ruleDraft.experienceFloorYears}
                  onChange={(event) =>
                    setRuleDraft((previous) => ({
                      ...previous,
                      experienceFloorYears: event.target.value,
                    }))
                  }
                  placeholder="e.g. 3"
                  className="mt-1 block h-9 w-full rounded-lg border border-[#e1e8ed] px-3 text-sm"
                />
              </label>
            </div>
          </div>
        </fieldset>

        {ruleResult.error ? <p role="alert" className="text-sm text-[#f4212e]">{ruleResult.error}</p> : null}
        {previewError ? <p role="alert" className="text-sm text-[#f4212e]">{previewError}</p> : null}
        <Button type="submit" disabled={!jobOpen || previewBusy || confirmBusy || !currentRequest}>
          {previewBusy ? 'Refreshing preview…' : preview ? 'Refresh screening preview' : 'Preview screening selection'}
        </Button>
      </form>

      {confirmNotice ? <p role="status" className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">{confirmNotice}</p> : null}

      {preview ? (
        <div className="space-y-5 border-t border-[#e1e8ed] pt-5">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <h3 className="text-sm font-semibold text-[#0f1419]">Read-only preview</h3>
              <p className="mt-1 text-xs text-[#71767b]">
                Requirement version {previewState?.requirementVersion.version} · generated {displayDate(preview.generatedAt)}
              </p>
            </div>
            {previewIsCurrent ? <Badge variant="primary">ready to confirm</Badge> : <Badge variant="caution">refresh required</Badge>}
          </div>

          {!previewIsCurrent ? (
            <p role="status" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
              The rule or exceptions changed after this preview. Refresh it before confirming so the
              count and cut line remain deterministic.
            </p>
          ) : null}

          <dl className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <div className="rounded-xl bg-[#f8fafc] p-3">
              <dt className="text-xs text-[#71767b]">Evaluated</dt>
              <dd className="mt-1 text-lg font-semibold text-[#0f1419]">{preview.evaluatedCount}</dd>
            </div>
            <div className="rounded-xl bg-[#f8fafc] p-3">
              <dt className="text-xs text-[#71767b]">Eligible</dt>
              <dd className="mt-1 text-lg font-semibold text-[#0f1419]">{preview.eligibleCount}</dd>
            </div>
            <div className="rounded-xl bg-emerald-50 p-3">
              <dt className="text-xs text-emerald-800">Selected</dt>
              <dd className="mt-1 text-lg font-semibold text-emerald-900">{preview.selectedCount}</dd>
            </div>
            <div className="rounded-xl bg-amber-50 p-3">
              <dt className="text-xs text-amber-800">Unknown / unscored</dt>
              <dd className="mt-1 text-lg font-semibold text-amber-900">{unknownCount}</dd>
            </div>
            <div className="rounded-xl bg-rose-50 p-3">
              <dt className="text-xs text-rose-800">Known knockouts</dt>
              <dd className="mt-1 text-lg font-semibold text-rose-900">{knownKnockoutCount}</dd>
            </div>
          </dl>

          <div className="rounded-xl border border-indigo-100 bg-indigo-50 p-3">
            <p className="text-sm font-medium text-indigo-950">{cutLineDescription(preview)}</p>
            {cutLineEntry ? (
              <div className="mt-2">
                <CandidateIdentityLine
                  candidate={cutLineEntry.candidate}
                  identityState={cutLineEntry.candidate?.identityState}
                />
              </div>
            ) : null}
            <p className="mt-1 text-xs text-indigo-900">
              Fresh scores rank first, then original application time, then application ID. Stale and
              unknown scores never silently become a passing score.
            </p>
          </div>

          <section aria-labelledby="screening-exceptions-title" className="space-y-3">
            <div>
              <h4 id="screening-exceptions-title" className="text-sm font-semibold text-[#0f1419]">
                Include or exclude exception
              </h4>
              <p className="mt-1 text-xs text-[#71767b]">
                Every override needs a recruiter note and is stored with the confirmed gate. It changes
                only this planned batch — never a candidate&apos;s pipeline stage.
              </p>
            </div>
            <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_10rem_minmax(0,1fr)_auto] md:items-end">
              <div className="space-y-2">
                <label className="block text-sm text-[#0f1419]">
                  Find application
                  <input
                    aria-label="Search exception applications"
                    aria-describedby="exception-search-status"
                    aria-busy={exceptionSearch !== deferredExceptionSearch}
                    type="search"
                    value={exceptionSearch}
                    onChange={(event) => {
                      setExceptionSearch(event.target.value)
                      setExceptionTargetId('')
                    }}
                    placeholder="Name, email, application or candidate ID"
                    className="mt-1 block h-9 w-full rounded-lg border border-[#e1e8ed] px-3 text-sm"
                  />
                </label>
                <label className="block text-sm text-[#0f1419]">
                  Application
                  <select
                    aria-label="Exception application"
                    value={exceptionTargetId}
                    onChange={(event) => setExceptionTargetId(event.target.value)}
                    className="mt-1 block h-9 w-full rounded-lg border border-[#e1e8ed] bg-white px-3 text-sm"
                  >
                    <option value="">Choose an application</option>
                    {exceptionOptions.map((entry) => (
                      <option key={entry.applicationId} value={entry.applicationId}>
                        {entryLabel(entry)}
                      </option>
                    ))}
                  </select>
                </label>
                <p id="exception-search-status" className="text-xs text-[#71767b]" aria-live="polite">
                  {matchingExceptionEntries.length
                    ? `Showing up to ${Math.min(EXCEPTION_RESULT_LIMIT, matchingExceptionEntries.length)} of ${matchingExceptionEntries.length} matching applications.`
                    : 'No applications match this search.'}
                </p>
              </div>
              <label className="text-sm text-[#0f1419]">
                Action
                <select
                  aria-label="Exception action"
                  value={exceptionAction}
                  onChange={(event) => setExceptionAction(event.target.value as ExceptionAction)}
                  className="mt-1 block h-9 w-full rounded-lg border border-[#e1e8ed] bg-white px-3 text-sm"
                >
                  <option value="include">Include</option>
                  <option value="exclude">Exclude</option>
                </select>
              </label>
              <label className="text-sm text-[#0f1419]">
                Reason note
                <input
                  aria-label="Exception reason note"
                  type="text"
                  maxLength={4000}
                  value={exceptionNote}
                  onChange={(event) => setExceptionNote(event.target.value)}
                  placeholder="Document the recruiter decision"
                  className="mt-1 block h-9 w-full rounded-lg border border-[#e1e8ed] px-3 text-sm"
                />
              </label>
              <Button type="button" variant="secondary" onClick={addException} disabled={!jobOpen || previewBusy || confirmBusy}>
                Add exception
              </Button>
            </div>
            {exceptions.length ? (
              <ul aria-label="Screening exceptions" className="space-y-2">
                {exceptions.map((exception) => {
                  const entry = entriesByApplicationId.get(exception.applicationId)
                  return (
                    <li key={exception.applicationId} className="flex items-center gap-2 rounded-lg border border-[#e1e8ed] p-2 text-sm flex-wrap">
                      <Badge variant={exception.action === 'include' ? 'success' : 'danger'}>
                        {exception.action}
                      </Badge>
                      <span className="min-w-0 text-xs font-medium text-[#536471]">
                        {entry ? entryLabel(entry) : 'Candidate details unavailable'}
                      </span>
                      <span className="min-w-0 flex-1 text-[#0f1419]">{exception.note}</span>
                      <Button type="button" variant="ghost" size="sm" onClick={() => removeException(exception.applicationId)} disabled={confirmBusy}>
                        Remove
                      </Button>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p className="text-xs text-[#71767b]">No exceptions added.</p>
            )}
          </section>

          <section aria-labelledby="selected-candidates-title" className="space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <h4 id="selected-candidates-title" className="text-sm font-semibold text-[#0f1419]">
                  Planned selection ({selectedEntries.length})
                </h4>
                <p className="mt-1 text-xs text-[#71767b]">
                  This list is a review only until you explicitly confirm the durable batch below.
                </p>
              </div>
              {staleCount ? <Badge variant="caution">{staleCount} stale score{staleCount === 1 ? '' : 's'}</Badge> : null}
            </div>
            {selectedEntries.length ? (
              <div className="space-y-3">
                {selectedEntries.length > PREVIEW_ROW_PAGE_SIZE || selectedSearch ? (
                  <label className="block max-w-md text-sm text-[#0f1419]">
                    Search planned selection
                    <input
                      aria-label="Search planned selection"
                      aria-busy={selectedSearch !== deferredSelectedSearch}
                      type="search"
                      value={selectedSearch}
                      onChange={(event) => {
                        setSelectedSearch(event.target.value)
                        setSelectedVisibleCount(PREVIEW_ROW_PAGE_SIZE)
                      }}
                      placeholder="Name, email, application or candidate ID"
                      className="mt-1 block h-9 w-full rounded-lg border border-[#e1e8ed] px-3 text-sm"
                    />
                  </label>
                ) : null}
                {visibleSelectedEntries.length ? (
                  <ul
                    aria-label="Planned selected applications"
                    className="divide-y divide-[#e1e8ed] rounded-xl border border-[#e1e8ed]"
                  >
                    {visibleSelectedEntries.map((entry) => (
                      <li key={entry.applicationId} className="flex items-center gap-3 p-3 text-sm flex-wrap">
                        <div className="min-w-0 flex-1">
                          <CandidateIdentityLine
                            candidate={entry.candidate}
                            identityState={entry.candidate?.identityState}
                          />
                          <p className="mt-1 text-xs text-[#71767b]">
                            {entry.rank ? `Rank ${entry.rank}` : 'Not ranked'} · {scoreStateLabel(entry.scoreState)}
                            {entry.score === null ? '' : ` ${entry.score}/100`} · {selectionReasonLabel(entry.selectionReason)}
                          </p>
                        </div>
                        <Badge variant="success">selected</Badge>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="rounded-xl border border-dashed border-[#e1e8ed] p-4 text-sm text-[#71767b]">
                    No selected applications match this search.
                  </p>
                )}
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <p className="text-xs text-[#71767b]" aria-live="polite">
                    Showing {visibleSelectedEntries.length} of {matchingSelectedEntries.length}
                    {selectedSearch ? ` matches (${selectedEntries.length} selected total).` : ' selected applications.'}
                  </p>
                  {visibleSelectedEntries.length < matchingSelectedEntries.length ? (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        setSelectedVisibleCount((current) =>
                          Math.min(
                            current + PREVIEW_ROW_PAGE_SIZE,
                            matchingSelectedEntries.length,
                          ),
                        )
                      }
                    >
                      Show next{' '}
                      {Math.min(
                        PREVIEW_ROW_PAGE_SIZE,
                        matchingSelectedEntries.length - visibleSelectedEntries.length,
                      )}{' '}
                      selected applications
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : (
              <p className="rounded-xl border border-dashed border-[#e1e8ed] p-4 text-sm text-[#71767b]">
                No candidates are selected by this rule. Adjust the rule or add a documented include exception.
              </p>
            )}

            <details
              open={evaluatedOpen}
              className="rounded-xl border border-[#e1e8ed] p-3"
              onToggle={(event) => setEvaluatedOpen(event.currentTarget.open)}
            >
              <summary className="cursor-pointer text-sm font-medium text-[#0f1419]">
                View all {allPreviewEntries.length} evaluated applications
              </summary>
              {evaluatedOpen ? (
                <div className="mt-3 space-y-3">
                  <label className="block max-w-md text-sm text-[#0f1419]">
                    Search evaluated applications
                    <input
                      aria-label="Search evaluated applications"
                      aria-busy={evaluatedSearch !== deferredEvaluatedSearch}
                      type="search"
                      value={evaluatedSearch}
                      onChange={(event) => {
                        setEvaluatedSearch(event.target.value)
                        setEvaluatedVisibleCount(PREVIEW_ROW_PAGE_SIZE)
                      }}
                      placeholder="Name, email, application or candidate ID"
                      className="mt-1 block h-9 w-full rounded-lg border border-[#e1e8ed] px-3 text-sm"
                    />
                  </label>
                  {visibleEvaluatedEntries.length ? (
                    <ul
                      aria-label="Evaluated applications"
                      className="divide-y divide-[#e1e8ed]"
                    >
                      {visibleEvaluatedEntries.map((entry) => (
                        <li key={entry.applicationId} className="flex items-center gap-3 py-2 text-sm flex-wrap">
                          <div className="min-w-0 flex-1">
                            <CandidateIdentityLine
                              candidate={entry.candidate}
                              identityState={entry.candidate?.identityState}
                            />
                            <p className="mt-1 text-xs text-[#71767b]">
                              {entry.rank ? `Rank ${entry.rank}` : 'Not ranked'} · {scoreStateLabel(entry.scoreState)}
                              {entry.score === null ? '' : ` ${entry.score}/100`} · {selectionReasonLabel(entry.selectionReason)}
                              {entry.knockoutReasons.length ? ` · knockout: ${entry.knockoutReasons.join(', ')}` : ''}
                            </p>
                          </div>
                          <Badge variant={selectionVariant(entry)}>{entry.selected ? 'selected' : 'not selected'}</Badge>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="rounded-lg border border-dashed border-[#e1e8ed] p-3 text-sm text-[#71767b]">
                      No evaluated applications match this search.
                    </p>
                  )}
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <p className="text-xs text-[#71767b]" aria-live="polite">
                      Showing {visibleEvaluatedEntries.length} of {matchingEvaluatedEntries.length}
                      {evaluatedSearch ? ` matches (${allPreviewEntries.length} evaluated total).` : ' evaluated applications.'}
                    </p>
                    {visibleEvaluatedEntries.length < matchingEvaluatedEntries.length ? (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() =>
                          setEvaluatedVisibleCount((current) =>
                            Math.min(
                              current + PREVIEW_ROW_PAGE_SIZE,
                              matchingEvaluatedEntries.length,
                            ),
                          )
                        }
                      >
                        Show next{' '}
                        {Math.min(
                          PREVIEW_ROW_PAGE_SIZE,
                          matchingEvaluatedEntries.length - visibleEvaluatedEntries.length,
                        )}{' '}
                        evaluated applications
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </details>
          </section>

          <section aria-labelledby="confirm-screening-title" className="rounded-xl border border-indigo-200 bg-indigo-50 p-4 space-y-3">
            <div>
              <h4 id="confirm-screening-title" className="text-sm font-semibold text-indigo-950">
                Confirm planned invitation batch
              </h4>
              <p className="mt-1 text-xs text-indigo-900">
                This creates a durable schedule. Once due, invitations are delivered at a 60-second
                stagger; it does not reject candidates or change their stages.
              </p>
            </div>
            <label className="block max-w-sm text-sm text-indigo-950">
              Planned send time (optional)
              <input
                aria-label="Planned send time"
                type="datetime-local"
                value={sendAfter}
                onChange={(event) => setSendAfter(event.target.value)}
                disabled={!jobOpen || confirmBusy || !previewIsCurrent}
                className="mt-1 block h-9 w-full rounded-lg border border-indigo-200 bg-white px-3 text-sm"
              />
              <span className="mt-1 block text-xs text-indigo-900">
                Leave blank to create a batch planned for now. Times use your browser timezone:{' '}
                <strong>{browserTimeZone}</strong>.
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm text-indigo-950">
              <input
                type="checkbox"
                checked={confirmAcknowledged}
                disabled={!jobOpen || confirmBusy || !previewIsCurrent || preview.selectedCount < 1}
                onChange={(event) => setConfirmAcknowledged(event.target.checked)}
                className="mt-1"
              />
              <span>
                I reviewed the deterministic cut line, known knockouts, unknown/stale scores, and
                every exception, and authorize staggered invitation delivery at the planned time.
              </span>
            </label>
            {confirmError ? <p role="alert" className="text-sm text-[#f4212e]">{confirmError}</p> : null}
            <Button
              type="button"
              onClick={() => void confirmPreview()}
              disabled={
                !jobOpen ||
                confirmBusy ||
                !previewIsCurrent ||
                !confirmAcknowledged ||
                preview.selectedCount < 1
              }
            >
              {confirmBusy
                ? 'Creating planned batch…'
                : `Confirm & schedule ${preview.selectedCount} ${preview.selectedCount === 1 ? 'candidate' : 'candidates'}`}
            </Button>
          </section>
        </div>
      ) : null}

      <section aria-labelledby="screening-history-title" className="space-y-3 border-t border-[#e1e8ed] pt-5">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h3 id="screening-history-title" className="text-sm font-semibold text-[#0f1419]">Confirmed screening batches</h3>
            <p className="mt-1 text-xs text-[#71767b]">Durable gates and invitation-batch progress for this job only.</p>
          </div>
          <Button type="button" variant="secondary" size="sm" onClick={() => void loadGates()} disabled={gatesLoading}>
            {gatesLoading ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>

        {waterfallNotice ? (
          <p role="status" className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">
            {waterfallNotice}
          </p>
        ) : null}
        {waterfallError ? (
          <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">
            {waterfallError}
          </p>
        ) : null}
        {retryNotice ? (
          <p role="status" className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">
            {retryNotice}
          </p>
        ) : null}
        {retryError ? (
          <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">
            {retryError}
          </p>
        ) : null}

        {gatesError ? (
          <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            <p>{gatesError}</p>
            <Button type="button" variant="secondary" size="sm" className="mt-2" onClick={() => void loadGates()}>
              Try again
            </Button>
          </div>
        ) : null}
        {gatesLoading && gates === null ? <p aria-busy="true" className="text-sm text-[#71767b]">Loading confirmed batches…</p> : null}
        {!gatesLoading && gates && gates.length === 0 ? (
          <p className="rounded-xl border border-dashed border-[#e1e8ed] p-4 text-sm text-[#71767b]">
            No screening gate has been confirmed yet.
          </p>
        ) : null}
        {gates?.map((gate) => (
          <article key={gate.id} className="rounded-xl border border-[#e1e8ed] p-4 space-y-3">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <p className="text-sm font-semibold text-[#0f1419]">
                  {gate.rule.mode === 'top_n' ? `Top ${gate.rule.topN}` : `Score ≥ ${gate.rule.scoreThreshold}`}
                  {' · '}requirement v{gate.requirementVersion.version}
                </p>
                <p className="mt-1 text-xs text-[#71767b]">
                  Confirmed by {gate.confirmedByName} · {displayDate(gate.confirmedAt)} · {gate.counts.selected} selected
                </p>
              </div>
              <Badge variant={gate.status === 'cancelled' ? 'danger' : 'success'}>{gate.status}</Badge>
            </div>
            {gate.exceptions.length ? (
              <p className="text-xs text-[#536471]">
                {gate.exceptions.length} documented {gate.exceptions.length === 1 ? 'exception' : 'exceptions'}
              </p>
            ) : null}
            {gate.cancelNote ? <p className="text-xs text-[#f4212e]">Cancellation note: {gate.cancelNote}</p> : null}
            {gate.batches.length ? (
              <ul className="space-y-2">
                {gate.batches.map((batch) => (
                  <li key={batch.id} className="rounded-lg bg-[#f8fafc] p-3">
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <p className="text-sm font-medium text-[#0f1419]">
                        Wave {batch.wave} · {batch.plannedCount} planned · {batch.sentCount} sent
                        {batch.failedCount ? ` · ${batch.failedCount} failed` : ''}
                      </p>
                      <Badge variant={batchVariant(batch.status)}>{batch.status}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-[#71767b]">Planned for {displayDate(batch.sendAfter)}</p>
                    {batch.lastError ? <p className="mt-1 text-xs text-[#f4212e]">Latest delivery issue: {batch.lastError}</p> : null}
                    <RecipientDeliveryLedger jobId={jobId} batchId={batch.id} />
                    {batch.status === 'failed' && batch.failedCount > 0 ? (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        className="mt-2"
                        disabled={!jobOpen || retryBusyBatchId !== null}
                        onClick={() => void retryFailedBatch(batch)}
                      >
                        {retryBusyBatchId === batch.id
                          ? 'Requeueing failed invitations…'
                          : `Requeue ${batch.failedCount} failed ${batch.failedCount === 1 ? 'invitation' : 'invitations'}`}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-[#71767b]">No invitation batch was recorded for this gate.</p>
            )}

            {gate.status === 'confirmed' ? (
              <section
                aria-label={`Invite next wave for ${gate.id}`}
                className="rounded-xl border border-indigo-200 bg-indigo-50 p-3 space-y-3"
              >
                <div>
                  <h4 className="text-sm font-semibold text-indigo-950">Invite next N</h4>
                  <p className="mt-1 text-xs text-indigo-900">
                    Explicitly schedule the next ranked, eligible, unreserved candidates from this
                    frozen gate. Existing invitations and reservations stay excluded; this never
                    auto-rejects or moves candidates.
                  </p>
                </div>
                <label className="block max-w-xs text-sm font-medium text-indigo-950">
                  Next-wave size
                  <input
                    aria-label={`Next-wave size for ${gate.id}`}
                    type="number"
                    min="1"
                    max="100"
                    step="1"
                    value={waterfallCounts[gate.id] ?? '1'}
                    onChange={(event) =>
                      setWaterfallCounts((previous) => ({
                        ...previous,
                        [gate.id]: event.target.value,
                      }))
                    }
                    disabled={!jobOpen || waterfallBusyGateId !== null}
                    className="mt-1 block h-9 w-full rounded-lg border border-indigo-200 bg-white px-3 text-sm"
                  />
                </label>
                <label className="flex items-start gap-2 text-sm text-indigo-950">
                  <input
                    aria-label={`Confirm next-wave schedule for ${gate.id}`}
                    type="checkbox"
                    checked={Boolean(waterfallAcknowledged[gate.id])}
                    onChange={(event) =>
                      setWaterfallAcknowledged((previous) => ({
                        ...previous,
                        [gate.id]: event.target.checked,
                      }))
                    }
                    disabled={!jobOpen || waterfallBusyGateId !== null}
                    className="mt-1"
                  />
                  <span>
                    I confirm this schedules the next eligible candidates for staggered invitation
                    delivery.
                  </span>
                </label>
                <Button
                  type="button"
                  onClick={() => void createWaterfall(gate)}
                  disabled={
                    !jobOpen ||
                    waterfallBusyGateId !== null ||
                    !waterfallAcknowledged[gate.id]
                  }
                >
                  {waterfallBusyGateId === gate.id
                    ? 'Scheduling next wave…'
                    : 'Confirm & schedule next wave'}
                </Button>
              </section>
            ) : null}
          </article>
        ))}
      </section>
    </section>
  )
}

export const __screeningPanelTestUtils = {
  ruleFromDraft,
}
