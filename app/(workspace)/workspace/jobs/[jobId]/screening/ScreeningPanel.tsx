'use client'

/**
 * Recruiter-only screening review surface for the dedicated job task route.
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
  useRef,
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

interface ScreeningSelectionSnapshot {
  selectionId: string
  count: number
  expiresAt: string
  description: string
}

interface ScreeningPreviewRequest {
  rule: ScreeningRuleRequest
  exceptions: ScreeningExceptionRequest[]
  selectionSnapshotId?: string
  selectionNote?: string
}

type PreviewPageScope = 'selected' | 'evaluated' | 'attention' | 'knockouts'

type CandidateIdentityState = 'available' | 'privacy_protected' | 'unavailable'

interface CandidateIdentityView {
  applicationId: string
  candidateId: string
  identityState: CandidateIdentityState
  displayName: string | null
  email: string | null
  applicationUrl: string | null
}

interface ExceptionCandidateOption {
  applicationId: string
  candidateName: string
  candidateEmail: string
}

interface ExceptionCandidatePage {
  candidates: ExceptionCandidateOption[]
  pageInfo: {
    limit: number
    nextCursor: string | null
  }
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

interface PreviewPage {
  scope: PreviewPageScope
  rows: PreviewEntry[]
  total: number
  offset: number
  hasPrevious: boolean
  previousCursor: string | null
  hasNext: boolean
  nextCursor: string | null
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
  scoreStateCounts: {
    scored: number
    stale: number
    unscored: number
  }
  knownKnockoutCount: number
  cutLine: {
    mode: SelectionMode
    requestedTopN?: number
    scoreThreshold?: number
    applicationId?: string
    rank?: number
    score?: number | null
    candidate?: CandidateIdentityView | null
  }
  exceptions: Array<ScreeningExceptionRequest & { actorName?: string; at?: string }>
  page: PreviewPage
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
  exceptionCount: number
  selectionHandoff: {
    actorName: string
    note: string
    at: string
  } | null
  confirmedByName: string
  confirmedAt: string
  cancelledAt: string | null
  cancelNote: string | null
  createdAt: string
  batches: InvitationBatch[]
  batchPageInfo: {
    limit: number
    hasNextPage: boolean
    nextCursor: string | null
  }
}

interface ScreeningGatePageInfo {
  limit: number
  hasNextPage: boolean
  nextCursor: string | null
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
  /** Immutable, server-owned Candidates selection handed to this workflow. */
  selectionSnapshotId?: string
}

const INITIAL_RULE: ScreeningRuleDraft = {
  mode: 'top_n',
  topN: '10',
  scoreThreshold: '70',
  location: '',
  experienceFloorYears: '',
}

const PREVIEW_ROW_PAGE_SIZE = 50
const SCREENING_HISTORY_PAGE_SIZE = 25
const EMPTY_PREVIEW_ROWS: PreviewEntry[] = []
const OBJECT_ID = /^[a-f0-9]{24}$/i

function endpoint(jobId: string, suffix = ''): string {
  return `/api/workspace/jobs/${encodeURIComponent(jobId)}/screening${suffix}`
}

function selectionEndpoint(jobId: string, selectionId: string): string {
  return `/api/workspace/jobs/${encodeURIComponent(jobId)}/candidate-selections/${encodeURIComponent(selectionId)}`
}

function jobSummaryEndpoint(jobId: string): string {
  return `/api/workspace/jobs/${encodeURIComponent(jobId)}/summary`
}

function responseError(data: unknown, fallback: string): string {
  if (data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string') {
    return (data as { error: string }).error
  }
  return fallback
}

function readScreeningPageInfo(value: unknown): ScreeningGatePageInfo | null {
  if (!value || typeof value !== 'object') return null
  const pageInfo = value as Partial<ScreeningGatePageInfo>
  if (
    typeof pageInfo.limit !== 'number' ||
    !Number.isInteger(pageInfo.limit) ||
    pageInfo.limit < 1 ||
    pageInfo.limit > SCREENING_HISTORY_PAGE_SIZE ||
    typeof pageInfo.hasNextPage !== 'boolean' ||
    !(
      pageInfo.nextCursor === null ||
      typeof pageInfo.nextCursor === 'string'
    ) ||
    pageInfo.hasNextPage !== (typeof pageInfo.nextCursor === 'string')
  ) {
    return null
  }
  return pageInfo as ScreeningGatePageInfo
}

function readScreeningGatePage(
  value: unknown,
): { gates: ScreeningGate[]; pageInfo: ScreeningGatePageInfo } | null {
  if (!value || typeof value !== 'object') return null
  const response = value as { gates?: unknown; pageInfo?: unknown }
  const pageInfo = readScreeningPageInfo(response.pageInfo)
  if (
    !pageInfo ||
    !Array.isArray(response.gates) ||
    response.gates.length > pageInfo.limit ||
    response.gates.length > SCREENING_HISTORY_PAGE_SIZE
  ) {
    return null
  }
  for (const value of response.gates) {
    if (!value || typeof value !== 'object') return null
    const gate = value as Partial<ScreeningGate>
    const batchPageInfo = readScreeningPageInfo(gate.batchPageInfo)
    if (
      !batchPageInfo ||
      !Array.isArray(gate.batches) ||
      gate.batches.length > batchPageInfo.limit ||
      gate.batches.length > SCREENING_HISTORY_PAGE_SIZE
    ) {
      return null
    }
  }
  return {
    gates: response.gates as ScreeningGate[],
    pageInfo,
  }
}

function readInvitationBatchPage(
  value: unknown,
): { batches: InvitationBatch[]; pageInfo: ScreeningGatePageInfo } | null {
  if (!value || typeof value !== 'object') return null
  const response = value as { batches?: unknown; pageInfo?: unknown }
  const pageInfo = readScreeningPageInfo(response.pageInfo)
  if (
    !pageInfo ||
    !Array.isArray(response.batches) ||
    response.batches.length > pageInfo.limit ||
    response.batches.length > SCREENING_HISTORY_PAGE_SIZE
  ) {
    return null
  }
  return {
    batches: response.batches as InvitationBatch[],
    pageInfo,
  }
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

function boundedPreviewPage(page: PreviewPage): PreviewPage {
  return {
    ...page,
    rows: page.rows.slice(0, PREVIEW_ROW_PAGE_SIZE),
  }
}

function readPreviewPage(
  value: unknown,
  expectedScope: PreviewPageScope,
): PreviewPage | null {
  if (!value || typeof value !== 'object') return null
  const page = value as Partial<PreviewPage>
  if (
    page.scope !== expectedScope ||
    !Array.isArray(page.rows) ||
    typeof page.total !== 'number' ||
    !Number.isInteger(page.total) ||
    page.total < 0 ||
    typeof page.offset !== 'number' ||
    !Number.isInteger(page.offset) ||
    page.offset < 0 ||
    typeof page.hasPrevious !== 'boolean' ||
    typeof page.hasNext !== 'boolean' ||
    !(page.previousCursor === null || typeof page.previousCursor === 'string') ||
    !(page.nextCursor === null || typeof page.nextCursor === 'string')
  ) {
    return null
  }
  return boundedPreviewPage(page as PreviewPage)
}

function readExceptionCandidatePage(value: unknown): ExceptionCandidatePage | null {
  if (!value || typeof value !== 'object') return null
  const page = value as Partial<ExceptionCandidatePage>
  if (
    !Array.isArray(page.candidates) ||
    page.candidates.length > 20 ||
    !page.pageInfo ||
    typeof page.pageInfo !== 'object' ||
    typeof page.pageInfo.limit !== 'number' ||
    !Number.isInteger(page.pageInfo.limit) ||
    page.pageInfo.limit < 1 ||
    page.pageInfo.limit > 20 ||
    !(
      page.pageInfo.nextCursor === null ||
      typeof page.pageInfo.nextCursor === 'string'
    ) ||
    page.candidates.some(
      (candidate) =>
        !candidate ||
        typeof candidate !== 'object' ||
        typeof candidate.applicationId !== 'string' ||
        !OBJECT_ID.test(candidate.applicationId) ||
        typeof candidate.candidateName !== 'string' ||
        !candidate.candidateName.trim() ||
        typeof candidate.candidateEmail !== 'string' ||
        !candidate.candidateEmail.trim(),
    )
  ) {
    return null
  }
  return page as ExceptionCandidatePage
}

function pageRange(page: PreviewPage): string {
  if (!page.rows.length || page.total === 0) return `0 of ${page.total}`
  return `${page.offset + 1}–${page.offset + page.rows.length} of ${page.total}`
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
  historyRevision,
}: {
  jobId: string
  batchId: string
  historyRevision: number
}) {
  const [recipients, setRecipients] = useState<RecipientDelivery[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [pageNumber, setPageNumber] = useState(1)
  const [pageCursors, setPageCursors] = useState<Array<string | undefined>>([
    undefined,
  ])
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestControllerRef = useRef<AbortController | null>(null)
  const requestedPageRef = useRef<{ cursor?: string; pageNumber: number }>({
    pageNumber: 1,
  })
  const detailsRef = useRef<HTMLDetailsElement | null>(null)
  const pageStatusRef = useRef<HTMLParagraphElement | null>(null)
  const focusPageStatusRef = useRef(false)
  const observedHistoryRevisionRef = useRef(historyRevision)

  const loadRecipients = useCallback(async (
    cursor?: string,
    targetPage = 1,
    focusAfterLoad = false,
  ) => {
    requestControllerRef.current?.abort()
    const controller = new AbortController()
    requestControllerRef.current = controller
    requestedPageRef.current = { cursor, pageNumber: targetPage }
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
        { cache: 'no-store', signal: controller.signal },
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
      if (requestControllerRef.current !== controller) return
      const page = data as RecipientDeliveryPage
      setRecipients(page.recipients.slice(0, 25))
      setNextCursor(page.hasMore ? page.nextCursor : null)
      setPageNumber(targetPage)
      setPageCursors((previous) => {
        const next = previous.slice(0, targetPage)
        next[targetPage - 1] = cursor
        return next
      })
      focusPageStatusRef.current = focusAfterLoad
      setLoaded(true)
    } catch (loadError) {
      if (controller.signal.aborted) return
      setError(
        loadError instanceof Error
          ? loadError.message
          : 'Could not load recipient delivery status.',
      )
    } finally {
      if (requestControllerRef.current === controller) {
        requestControllerRef.current = null
        setLoading(false)
      }
    }
  }, [batchId, jobId])

  useEffect(() => {
    if (!focusPageStatusRef.current) return
    focusPageStatusRef.current = false
    pageStatusRef.current?.focus()
  }, [pageNumber, recipients])

  useEffect(() => {
    if (observedHistoryRevisionRef.current === historyRevision) return
    observedHistoryRevisionRef.current = historyRevision
    requestControllerRef.current?.abort()
    requestControllerRef.current = null
    requestedPageRef.current = { pageNumber: 1 }
    setRecipients([])
    setNextCursor(null)
    setPageNumber(1)
    setPageCursors([undefined])
    setLoaded(false)
    setLoading(false)
    setError(null)
    if (detailsRef.current?.open) {
      void loadRecipients()
    }
  }, [historyRevision, loadRecipients])

  useEffect(() => () => requestControllerRef.current?.abort(), [])

  return (
    <details
      ref={detailsRef}
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
            onClick={() => void loadRecipients(
              requestedPageRef.current.cursor,
              requestedPageRef.current.pageNumber,
              true,
            )}
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
      {loaded ? (
        <div className="mt-3 flex items-center justify-between gap-3 flex-wrap">
          <p
            ref={pageStatusRef}
            className="text-xs text-[#71767b]"
            aria-live="polite"
            tabIndex={-1}
          >
            Recipient page {pageNumber} · {recipients.length} of at most 25 rows shown
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            {pageNumber > 1 ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={loading}
                onClick={() => void loadRecipients(
                  pageCursors[pageNumber - 2],
                  pageNumber - 1,
                  true,
                )}
              >
                Previous recipient page
              </Button>
            ) : null}
            {pageNumber > 2 ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={loading}
                onClick={() => void loadRecipients(undefined, 1, true)}
              >
                Return to first recipients
              </Button>
            ) : null}
            {nextCursor ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={loading}
                onClick={() => void loadRecipients(
                  nextCursor,
                  pageNumber + 1,
                  true,
                )}
              >
                {loading ? 'Loading recipient page…' : 'Next recipient page'}
              </Button>
            ) : null}
          </div>
        </div>
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

function requestKey(input: ScreeningPreviewRequest): string {
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

function PreviewCandidatePageDisclosure({
  summary,
  pageName,
  listLabel,
  count,
  page,
  open,
  busy,
  globalBusy,
  search,
  deferredSearch,
  onToggle,
  onSearch,
  onLoad,
}: {
  summary: string
  pageName: string
  listLabel: string
  count: number
  page: PreviewPage | null
  open: boolean
  busy: boolean
  globalBusy: boolean
  search: string
  deferredSearch: string
  onToggle: (open: boolean) => void
  onSearch: (value: string) => void
  onLoad: (cursor?: string) => void
}) {
  const matchingEntries = filterPreviewEntries(page?.rows ?? EMPTY_PREVIEW_ROWS, deferredSearch)
  return (
    <details
      open={open}
      aria-disabled={globalBusy && !busy}
      className="rounded-xl border border-[#e1e8ed] p-3"
      onToggle={(event) => {
        const nextOpen = event.currentTarget.open
        if (nextOpen && globalBusy && !busy) {
          event.currentTarget.open = false
        }
        onToggle(nextOpen)
      }}
    >
      <summary
        aria-disabled={globalBusy && !busy}
        className="cursor-pointer text-sm font-medium text-[#0f1419]"
      >
        {summary}
      </summary>
      {open ? (
        <div className="mt-3 space-y-3">
          {busy && !page ? (
            <p className="text-sm text-[#71767b]" aria-busy="true">
              Loading {pageName} applications…
            </p>
          ) : null}
          {!busy && !page && count === 0 ? (
            <p className="text-sm text-[#71767b]">No {pageName} applications.</p>
          ) : null}
          {page ? (
            <label className="block max-w-md text-sm text-[#0f1419]">
              Filter current {pageName} page
              <input
                aria-label={`Filter current ${pageName} page`}
                aria-busy={search !== deferredSearch}
                type="search"
                value={search}
                onChange={(event) => onSearch(event.target.value)}
                placeholder="Name, email, application or candidate ID"
                className="mt-1 block h-9 w-full rounded-lg border border-[#e1e8ed] px-3 text-sm"
              />
            </label>
          ) : null}
          {page && matchingEntries.length ? (
            <ul aria-label={listLabel} className="divide-y divide-[#e1e8ed]">
              {matchingEntries.map((entry) => (
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
                  <Badge variant={selectionVariant(entry)}>
                    {entry.selected ? 'selected' : 'not selected'}
                  </Badge>
                </li>
              ))}
            </ul>
          ) : page ? (
            <p className="rounded-lg border border-dashed border-[#e1e8ed] p-3 text-sm text-[#71767b]">
              No {pageName} applications match this page filter.
            </p>
          ) : null}
          {page ? (
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <p className="text-xs text-[#71767b]" aria-live="polite">
                {search
                  ? `Showing ${matchingEntries.length} of ${page.rows.length} applications on this page; ${page.total} ${pageName} total.`
                  : `Showing ${pageRange(page)} ${pageName} applications.`}
              </p>
              <div className="flex items-center gap-2 flex-wrap">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={!page.hasPrevious || globalBusy}
                  onClick={() => onLoad(page.previousCursor ?? undefined)}
                >
                  Previous {pageName} page
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={!page.hasNext || globalBusy}
                  onClick={() => onLoad(page.nextCursor ?? undefined)}
                >
                  {busy ? `Loading ${pageName} page…` : `Next ${pageName} page`}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </details>
  )
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

export default function ScreeningPanel({
  jobId,
  jobStatus,
  selectionSnapshotId,
}: ScreeningPanelProps) {
  const [ruleDraft, setRuleDraft] = useState<ScreeningRuleDraft>(INITIAL_RULE)
  const [exceptions, setExceptions] = useState<ScreeningExceptionRequest[]>([])
  const [selectionSnapshot, setSelectionSnapshot] =
    useState<ScreeningSelectionSnapshot | null>(null)
  const [selectionSnapshotLoading, setSelectionSnapshotLoading] = useState(false)
  const [selectionSnapshotError, setSelectionSnapshotError] = useState<string | null>(null)
  const [selectionNote, setSelectionNote] = useState('')
  const [exceptionTargetId, setExceptionTargetId] = useState('')
  const [exceptionSearch, setExceptionSearch] = useState('')
  const [exceptionCandidates, setExceptionCandidates] =
    useState<ExceptionCandidateOption[]>([])
  const [exceptionCandidateLabels, setExceptionCandidateLabels] =
    useState<Record<string, string>>({})
  const [exceptionSearchCursor, setExceptionSearchCursor] = useState<string | null>(null)
  const [exceptionSearchPage, setExceptionSearchPage] = useState(1)
  const [exceptionSearchPageCursors, setExceptionSearchPageCursors] =
    useState<Array<string | undefined>>([undefined])
  const [exceptionSearchBusy, setExceptionSearchBusy] = useState(false)
  const [exceptionSearchError, setExceptionSearchError] = useState<string | null>(null)
  const [exceptionAction, setExceptionAction] = useState<ExceptionAction>('include')
  const [exceptionNote, setExceptionNote] = useState('')
  const [previewState, setPreviewState] = useState<PreviewResponse | null>(null)
  const [selectedPage, setSelectedPage] = useState<PreviewPage | null>(null)
  const [evaluatedPage, setEvaluatedPage] = useState<PreviewPage | null>(null)
  const [attentionPage, setAttentionPage] = useState<PreviewPage | null>(null)
  const [knockoutPage, setKnockoutPage] = useState<PreviewPage | null>(null)
  const [previewPageBusy, setPreviewPageBusy] =
    useState<PreviewPageScope | null>(null)
  const [previewPageError, setPreviewPageError] = useState<string | null>(null)
  const [reviewedRequest, setReviewedRequest] =
    useState<ScreeningPreviewRequest | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [sendAfter, setSendAfter] = useState('')
  const [confirmAcknowledged, setConfirmAcknowledged] = useState(false)
  const [confirmBusy, setConfirmBusy] = useState(false)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const [confirmNotice, setConfirmNotice] = useState<string | null>(null)
  const [gates, setGates] = useState<ScreeningGate[] | null>(null)
  const [gatePageInfo, setGatePageInfo] = useState<ScreeningGatePageInfo>({
    limit: 10,
    hasNextPage: false,
    nextCursor: null,
  })
  const [gatePageNumber, setGatePageNumber] = useState(1)
  const [gatePageCursors, setGatePageCursors] =
    useState<Array<string | undefined>>([undefined])
  const [historyRevision, setHistoryRevision] = useState(0)
  const [gatesError, setGatesError] = useState<string | null>(null)
  const [gatesLoading, setGatesLoading] = useState(false)
  const [batchPageBusyGateId, setBatchPageBusyGateId] = useState<string | null>(null)
  const [batchPageError, setBatchPageError] = useState<string | null>(null)
  const [batchPageNumbers, setBatchPageNumbers] = useState<Record<string, number>>({})
  const [batchPageCursors, setBatchPageCursors] =
    useState<Record<string, Array<string | undefined>>>({})
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
  const [evaluatedOpen, setEvaluatedOpen] = useState(false)
  const [evaluatedSearch, setEvaluatedSearch] = useState('')
  const [attentionOpen, setAttentionOpen] = useState(false)
  const [attentionSearch, setAttentionSearch] = useState('')
  const [knockoutOpen, setKnockoutOpen] = useState(false)
  const [knockoutSearch, setKnockoutSearch] = useState('')
  const [resolvedJobStatus, setResolvedJobStatus] = useState(jobStatus)
  const [jobTitle, setJobTitle] = useState<string | null>(null)
  const [jobContextLoading, setJobContextLoading] = useState(
    jobStatus === undefined,
  )
  const [jobContextError, setJobContextError] = useState<string | null>(null)

  const deferredSelectedSearch = useDeferredValue(selectedSearch)
  const deferredEvaluatedSearch = useDeferredValue(evaluatedSearch)
  const deferredAttentionSearch = useDeferredValue(attentionSearch)
  const deferredKnockoutSearch = useDeferredValue(knockoutSearch)
  const previewGenerationRef = useRef(0)
  const previewRequestControllerRef = useRef<AbortController | null>(null)
  const previewPageControllerRef = useRef<AbortController | null>(null)
  const previewPageActiveScopeRef = useRef<PreviewPageScope | null>(null)
  const exceptionSearchGenerationRef = useRef(0)
  const exceptionSearchControllerRef = useRef<AbortController | null>(null)
  const exceptionSearchStatusRef = useRef<HTMLParagraphElement | null>(null)
  const focusExceptionSearchStatusRef = useRef(false)
  const gatesGenerationRef = useRef(0)
  const gatesRequestControllerRef = useRef<AbortController | null>(null)
  const gatePageStatusRef = useRef<HTMLParagraphElement | null>(null)
  const focusGatePageStatusRef = useRef(false)
  const batchPageControllersRef = useRef<Map<string, AbortController>>(new Map())
  const batchPageGenerationsRef = useRef<Record<string, number>>({})
  const batchPageStatusRefs = useRef<Record<string, HTMLParagraphElement | null>>({})
  const focusBatchPageStatusRef = useRef<string | null>(null)
  const confirmNoticeRef = useRef<HTMLParagraphElement | null>(null)
  const retryNoticeRef = useRef<HTMLParagraphElement | null>(null)

  // Missing/loading context is deliberately closed. The split route must
  // never regain the old root page's write authority by assuming "open".
  const jobOpen = resolvedJobStatus === 'open'
  const ruleResult = useMemo(() => ruleFromDraft(ruleDraft), [ruleDraft])
  const currentRequest = useMemo(() => {
    if (!ruleResult.rule) return null
    if (selectionSnapshotId) {
      const note = selectionNote.trim()
      if (!selectionSnapshot || !note) return null
      return {
        rule: ruleResult.rule,
        exceptions,
        selectionSnapshotId: selectionSnapshot.selectionId,
        selectionNote: note,
      }
    }
    return { rule: ruleResult.rule, exceptions }
  }, [exceptions, ruleResult, selectionNote, selectionSnapshot, selectionSnapshotId])
  const currentRequestKey = currentRequest ? requestKey(currentRequest) : ''
  const previewIsCurrent = Boolean(
    previewState &&
      reviewedRequest &&
      currentRequest &&
      requestKey(reviewedRequest) === requestKey(currentRequest),
  )

  const loadGates = useCallback(async (
    cursor?: string,
    targetPage = 1,
    focusAfterLoad = false,
  ) => {
    const generation = ++gatesGenerationRef.current
    gatesRequestControllerRef.current?.abort()
    batchPageControllersRef.current.forEach((controller) => controller.abort())
    batchPageControllersRef.current.clear()
    const controller = new AbortController()
    gatesRequestControllerRef.current = controller
    setBatchPageBusyGateId(null)
    setBatchPageError(null)
    setGatesLoading(true)
    setGatesError(null)
    try {
      const historyUrl = cursor
        ? `${endpoint(jobId)}?${new URLSearchParams({ cursor }).toString()}`
        : endpoint(jobId)
      const response = await fetch(historyUrl, {
        cache: 'no-store',
        signal: controller.signal,
      })
      const data = await response.json().catch(() => null)
      if (
        controller.signal.aborted ||
        gatesRequestControllerRef.current !== controller ||
        gatesGenerationRef.current !== generation
      ) return
      const page = readScreeningGatePage(data)
      if (!response.ok || !page) {
        throw new Error(responseError(data, 'Could not load screening batches.'))
      }
      const nextGates = page.gates
      focusGatePageStatusRef.current = focusAfterLoad
      setGates(nextGates)
      setBatchPageNumbers(
        Object.fromEntries(nextGates.map((gate) => [gate.id, 1])),
      )
      setBatchPageCursors(
        Object.fromEntries(nextGates.map((gate) => [gate.id, [undefined]])),
      )
      setGatePageInfo(page.pageInfo)
      setGatePageNumber(targetPage)
      setGatePageCursors((previous) => {
        const next = previous.slice(0, targetPage)
        next[targetPage - 1] = cursor
        return next
      })
      setHistoryRevision((previous) => previous + 1)
    } catch (error) {
      if (
        controller.signal.aborted ||
        gatesRequestControllerRef.current !== controller ||
        gatesGenerationRef.current !== generation
      ) return
      setGatesError(error instanceof Error ? error.message : 'Could not load screening batches.')
    } finally {
      if (
        gatesRequestControllerRef.current === controller &&
        gatesGenerationRef.current === generation
      ) {
        gatesRequestControllerRef.current = null
        setGatesLoading(false)
      }
    }
  }, [jobId])

  async function loadGateBatchPage(
    gate: ScreeningGate,
    cursor?: string,
    targetPage = 1,
  ) {
    const historyGeneration = gatesGenerationRef.current
    const generation = (batchPageGenerationsRef.current[gate.id] ?? 0) + 1
    batchPageGenerationsRef.current[gate.id] = generation
    batchPageControllersRef.current.get(gate.id)?.abort()
    const controller = new AbortController()
    batchPageControllersRef.current.set(gate.id, controller)
    setBatchPageBusyGateId(gate.id)
    setBatchPageError(null)
    try {
      const search = new URLSearchParams()
      if (cursor) search.set('cursor', cursor)
      const query = search.size ? `?${search.toString()}` : ''
      const response = await fetch(
        endpoint(
          jobId,
          `/gates/${encodeURIComponent(gate.id)}/batches${query}`,
        ),
        { cache: 'no-store', signal: controller.signal },
      )
      const data = await response.json().catch(() => null)
      if (
        controller.signal.aborted ||
        batchPageControllersRef.current.get(gate.id) !== controller ||
        batchPageGenerationsRef.current[gate.id] !== generation ||
        gatesGenerationRef.current !== historyGeneration
      ) return
      const page = readInvitationBatchPage(data)
      if (!response.ok || !page) {
        throw new Error(responseError(data, 'Could not load invitation wave history.'))
      }
      focusBatchPageStatusRef.current = gate.id
      setGates((previous) => previous?.map((item) =>
        item.id === gate.id
          ? {
              ...item,
              batches: page.batches,
              batchPageInfo: page.pageInfo,
            }
          : item,
      ) ?? null)
      setBatchPageNumbers((previous) => ({
        ...previous,
        [gate.id]: targetPage,
      }))
      setBatchPageCursors((previous) => {
        const next = (previous[gate.id] ?? [undefined]).slice(0, targetPage)
        next[targetPage - 1] = cursor
        return {
          ...previous,
          [gate.id]: next,
        }
      })
    } catch (error) {
      if (
        controller.signal.aborted ||
        batchPageControllersRef.current.get(gate.id) !== controller ||
        batchPageGenerationsRef.current[gate.id] !== generation ||
        gatesGenerationRef.current !== historyGeneration
      ) return
      setBatchPageError(
        error instanceof Error
          ? error.message
          : 'Could not load invitation wave history.',
      )
    } finally {
      if (batchPageControllersRef.current.get(gate.id) === controller) {
        batchPageControllersRef.current.delete(gate.id)
        setBatchPageBusyGateId(null)
      }
    }
  }

  const loadExceptionCandidatePage = useCallback(async (
    query: string,
    cursor: string | undefined,
    generation: number,
    targetPage = 1,
    focusAfterLoad = false,
  ) => {
    exceptionSearchControllerRef.current?.abort()
    const controller = new AbortController()
    exceptionSearchControllerRef.current = controller
    setExceptionTargetId('')
    setExceptionNote('')
    setExceptionSearchBusy(true)
    setExceptionSearchError(null)
    try {
      const search = new URLSearchParams({ q: query, limit: '20' })
      if (cursor) search.set('cursor', cursor)
      const response = await fetch(
        endpoint(jobId, `/candidates?${search.toString()}`),
        { cache: 'no-store', signal: controller.signal },
      )
      const data = await response.json().catch(() => null)
      const page = readExceptionCandidatePage(data)
      if (!response.ok || !page) {
        throw new Error(responseError(data, 'Could not search screening candidates.'))
      }
      if (
        controller.signal.aborted ||
        exceptionSearchControllerRef.current !== controller ||
        exceptionSearchGenerationRef.current !== generation
      ) return
      setExceptionCandidates(page.candidates)
      setExceptionSearchCursor(page.pageInfo.nextCursor)
      setExceptionSearchPage(targetPage)
      setExceptionSearchPageCursors((previous) => {
        const next = previous.slice(0, targetPage)
        next[targetPage - 1] = cursor
        return next
      })
      focusExceptionSearchStatusRef.current = focusAfterLoad
    } catch (error) {
      if (controller.signal.aborted) return
      setExceptionSearchError(
        error instanceof Error
          ? error.message
          : 'Could not search screening candidates.',
      )
    } finally {
      if (exceptionSearchControllerRef.current === controller) {
        exceptionSearchControllerRef.current = null
        setExceptionSearchBusy(false)
      }
    }
  }, [jobId])

  useEffect(() => {
    const generation = ++exceptionSearchGenerationRef.current
    exceptionSearchControllerRef.current?.abort()
    const query = exceptionSearch.trim()
    setExceptionTargetId('')
    setExceptionNote('')
    setExceptionCandidates([])
    setExceptionSearchCursor(null)
    setExceptionSearchPage(1)
    setExceptionSearchPageCursors([undefined])
    setExceptionSearchError(null)
    if (query.length < 2) {
      setExceptionSearchBusy(false)
      return
    }
    setExceptionSearchBusy(true)
    const timer = window.setTimeout(() => {
      void loadExceptionCandidatePage(query, undefined, generation)
    }, 300)
    return () => {
      window.clearTimeout(timer)
      exceptionSearchControllerRef.current?.abort()
    }
  }, [exceptionSearch, loadExceptionCandidatePage])

  useEffect(() => {
    if (!focusExceptionSearchStatusRef.current) return
    focusExceptionSearchStatusRef.current = false
    exceptionSearchStatusRef.current?.focus()
  }, [exceptionCandidates, exceptionSearchPage])

  useEffect(() => {
    if (!focusGatePageStatusRef.current) return
    focusGatePageStatusRef.current = false
    gatePageStatusRef.current?.focus()
  }, [gatePageNumber, gates])

  useEffect(() => {
    const gateId = focusBatchPageStatusRef.current
    if (!gateId) return
    focusBatchPageStatusRef.current = null
    batchPageStatusRefs.current[gateId]?.focus()
  }, [batchPageNumbers, gates])

  useEffect(() => {
    previewGenerationRef.current += 1
    previewRequestControllerRef.current?.abort()
    previewPageControllerRef.current?.abort()
    previewRequestControllerRef.current = null
    previewPageControllerRef.current = null
    previewPageActiveScopeRef.current = null
    setPreviewBusy(false)
    setPreviewPageBusy(null)
  }, [currentRequestKey])

  useEffect(() => {
    if (confirmNotice) confirmNoticeRef.current?.focus()
  }, [confirmNotice])

  useEffect(() => {
    if (retryNotice) retryNoticeRef.current?.focus()
  }, [retryNotice])

  useEffect(() => () => {
    previewGenerationRef.current += 1
    previewRequestControllerRef.current?.abort()
    previewPageControllerRef.current?.abort()
    previewPageActiveScopeRef.current = null
    exceptionSearchControllerRef.current?.abort()
    gatesGenerationRef.current += 1
    gatesRequestControllerRef.current?.abort()
    batchPageControllersRef.current.forEach((controller) => controller.abort())
    batchPageControllersRef.current.clear()
  }, [jobId])

  useEffect(() => {
    if (jobStatus !== undefined) {
      setResolvedJobStatus(jobStatus)
      setJobContextLoading(false)
      setJobContextError(null)
      return
    }

    const controller = new AbortController()
    setResolvedJobStatus(undefined)
    setJobContextLoading(true)
    setJobContextError(null)
    void fetch(jobSummaryEndpoint(jobId), {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json().catch(() => null)
        const job = data && typeof data === 'object'
          ? (data as { job?: unknown }).job
          : null
        if (!response.ok || !job || typeof job !== 'object') {
          throw new Error(responseError(data, 'Could not verify the current job status.'))
        }
        const status = (job as { status?: unknown }).status
        const title = (job as { title?: unknown }).title
        if (
          (status !== 'open' && status !== 'on_hold' && status !== 'closed') ||
          typeof title !== 'string' ||
          !title.trim()
        ) {
          throw new Error('The current job status could not be verified.')
        }
        setResolvedJobStatus(status)
        setJobTitle(title.trim())
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setResolvedJobStatus(undefined)
        setJobContextError(
          error instanceof Error
            ? error.message
            : 'Could not verify the current job status.',
        )
      })
      .finally(() => {
        if (!controller.signal.aborted) setJobContextLoading(false)
      })

    return () => controller.abort()
  }, [jobId, jobStatus])

  useEffect(() => {
    if (!selectionSnapshotId) {
      setSelectionSnapshot(null)
      setSelectionSnapshotError(null)
      setSelectionSnapshotLoading(false)
      return
    }

    const controller = new AbortController()
    setSelectionSnapshotLoading(true)
    setSelectionSnapshotError(null)
    void fetch(selectionEndpoint(jobId, selectionSnapshotId), {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json().catch(() => null)
        if (!response.ok || !data || typeof data !== 'object') {
          throw new Error(
            responseError(data, 'Could not load the candidate selection handoff.'),
          )
        }
        const source =
          data.selection && typeof data.selection === 'object'
            ? data.selection
            : data
        if (
          typeof source.selectionId !== 'string' ||
          source.selectionId !== selectionSnapshotId ||
          typeof source.count !== 'number' ||
          !Number.isInteger(source.count) ||
          source.count < 1 ||
          typeof source.expiresAt !== 'string' ||
          Number.isNaN(new Date(source.expiresAt).getTime()) ||
          typeof source.description !== 'string' ||
          !source.description.trim()
        ) {
          throw new Error('The candidate selection handoff could not be verified.')
        }
        setSelectionSnapshot({
          selectionId: source.selectionId,
          count: source.count,
          expiresAt: source.expiresAt,
          description: source.description,
        })
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setSelectionSnapshot(null)
        setSelectionSnapshotError(
          error instanceof Error
            ? error.message
            : 'Could not load the candidate selection handoff.',
        )
      })
      .finally(() => {
        if (!controller.signal.aborted) setSelectionSnapshotLoading(false)
      })

    return () => controller.abort()
  }, [jobId, selectionSnapshotId])

  useEffect(() => {
    setBrowserTimeZone(browserTimeZoneName())
  }, [])

  useEffect(() => {
    void loadGates()
  }, [loadGates])

  async function requestPreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setReviewedRequest(null)
    setConfirmAcknowledged(false)
    setPreviewError(null)
    setConfirmError(null)
    setConfirmNotice(null)
    if (!jobOpen) {
      setPreviewError('Reopen this job before creating a screening review.')
      return
    }
    if (!currentRequest) {
      setPreviewError(
        ruleResult.error ||
          (selectionSnapshotId
            ? 'Verify the candidate selection and document why it should be included before previewing.'
            : 'Fix the screening rule before previewing it.'),
      )
      return
    }

    const requestedPreview = currentRequest
    const generation = ++previewGenerationRef.current
    previewPageControllerRef.current?.abort()
    previewPageControllerRef.current = null
    previewPageActiveScopeRef.current = null
    setPreviewPageBusy(null)
    previewRequestControllerRef.current?.abort()
    const controller = new AbortController()
    previewRequestControllerRef.current = controller
    setPreviewBusy(true)
    try {
      const response = await fetch(endpoint(jobId, '/preview'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestedPreview),
        signal: controller.signal,
      })
      const data = await response.json().catch(() => null)
      if (
        controller.signal.aborted ||
        previewRequestControllerRef.current !== controller ||
        previewGenerationRef.current !== generation
      ) return
      if (!response.ok || !data || typeof data.previewFingerprint !== 'string') {
        setPreviewError(responseError(data, 'Could not build the screening preview.'))
        return
      }
      const nextPreview = data as PreviewResponse
      const nextSelectedPage = readPreviewPage(nextPreview.preview?.page, 'selected')
      if (!nextSelectedPage) {
        setPreviewError('The screening preview returned an invalid candidate page. Refresh and try again.')
        return
      }
      setPreviewState({
        ...nextPreview,
        preview: { ...nextPreview.preview, page: nextSelectedPage },
      })
      setSelectedPage(nextSelectedPage)
      setEvaluatedPage(null)
      setAttentionPage(null)
      setKnockoutPage(null)
      setPreviewPageError(null)
      setReviewedRequest(requestedPreview)
      setConfirmAcknowledged(false)
      setExceptionTargetId('')
      setExceptionNote('')
      setExceptionSearch('')
      setSelectedSearch('')
      setEvaluatedOpen(false)
      setEvaluatedSearch('')
      setAttentionOpen(false)
      setAttentionSearch('')
      setKnockoutOpen(false)
      setKnockoutSearch('')
    } catch {
      if (controller.signal.aborted) return
      setPreviewError('Something went wrong. Check your connection and try again.')
    } finally {
      if (previewRequestControllerRef.current === controller) {
        previewRequestControllerRef.current = null
        setPreviewBusy(false)
      }
    }
  }

  async function loadPreviewPage(scope: PreviewPageScope, cursor?: string) {
    const activeScope = previewPageActiveScopeRef.current
    if (activeScope && activeScope !== scope) {
      setPreviewPageError('Finish loading current review page before opening another.')
      return
    }
    setPreviewPageError(null)
    if (!previewState || !reviewedRequest || !previewIsCurrent) {
      setPreviewPageError('Refresh the preview before loading another candidate page.')
      return
    }

    const generation = previewGenerationRef.current
    const fingerprint = previewState.previewFingerprint
    previewPageControllerRef.current?.abort()
    const controller = new AbortController()
    previewPageControllerRef.current = controller
    previewPageActiveScopeRef.current = scope
    setPreviewPageBusy(scope)
    try {
      const response = await fetch(endpoint(jobId, '/preview'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...reviewedRequest,
          page: {
            scope,
            ...(cursor ? { cursor } : {}),
            expectedFingerprint: fingerprint,
          },
        }),
        signal: controller.signal,
      })
      const data = await response.json().catch(() => null)
      const page = readPreviewPage(
        data && typeof data === 'object'
          ? (data as { preview?: { page?: unknown } }).preview?.page
          : null,
        scope,
      )
      if (
        controller.signal.aborted ||
        previewPageControllerRef.current !== controller ||
        previewGenerationRef.current !== generation
      ) return
      if (
        !response.ok ||
        !data ||
        typeof data.previewFingerprint !== 'string' ||
        data.previewFingerprint !== fingerprint ||
        !page
      ) {
        setPreviewPageError(
          responseError(data, 'Could not load this screening preview page.'),
        )
        return
      }

      setPreviewPageError(null)
      if (scope === 'selected') {
        setSelectedPage(page)
        setSelectedSearch('')
      } else if (scope === 'evaluated') {
        setEvaluatedPage(page)
        setEvaluatedSearch('')
      } else if (scope === 'attention') {
        setAttentionPage(page)
        setAttentionSearch('')
      } else {
        setKnockoutPage(page)
        setKnockoutSearch('')
      }
      setExceptionTargetId('')
      setExceptionNote('')
    } catch {
      if (controller.signal.aborted) return
      setPreviewPageError('Something went wrong. Check your connection and try again.')
    } finally {
      if (previewPageControllerRef.current === controller) {
        previewPageControllerRef.current = null
        previewPageActiveScopeRef.current = null
        setPreviewPageBusy(null)
      }
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
    const candidate = exceptionCandidates.find(
      (option) => option.applicationId === applicationId,
    )
    if (candidate) {
      setExceptionCandidateLabels((previous) => ({
        ...previous,
        [applicationId]: `${candidate.candidateName} · ${candidate.candidateEmail}`,
      }))
    }
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
    if (previewBusy || previewPageBusy !== null) {
      setConfirmError('Wait for the current screening review request to finish before confirming.')
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
      setSelectedPage(null)
      setEvaluatedPage(null)
      setPreviewPageError(null)
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
  const selectedEntries = selectedPage?.rows ?? EMPTY_PREVIEW_ROWS
  const entriesByApplicationId = useMemo(
    () =>
      new Map(
        [
          ...selectedEntries,
          ...(evaluatedPage?.rows ?? EMPTY_PREVIEW_ROWS),
          ...(attentionPage?.rows ?? EMPTY_PREVIEW_ROWS),
          ...(knockoutPage?.rows ?? EMPTY_PREVIEW_ROWS),
        ].map(
          (entry) => [entry.applicationId, entry] as const,
        ),
      ),
    [attentionPage, evaluatedPage, knockoutPage, selectedEntries],
  )
  const matchingSelectedEntries = useMemo(
    () => filterPreviewEntries(selectedEntries, deferredSelectedSearch),
    [deferredSelectedSearch, selectedEntries],
  )

  return (
    <section aria-labelledby="screening-title" className="rounded-2xl border border-[#e1e8ed] bg-white p-5 space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 id="screening-title" className="text-base font-semibold text-[#0f1419]">
            {jobTitle ? `${jobTitle} screening gate` : 'Screening gate'}
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-[#536471]">
            Review the ranked queue, then explicitly authorize a planned invitation schedule. Due
            invitations are delivered in a bounded stagger; the workflow never auto-rejects people
            or changes a candidate stage.
          </p>
        </div>
        {jobContextLoading ? (
          <Badge variant="caution">checking job status</Badge>
        ) : !jobOpen ? (
          <Badge variant="caution">job is not open</Badge>
        ) : null}
      </div>

      {jobContextError ? (
        <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">
          {jobContextError} Screening commands remain disabled.
        </p>
      ) : null}

      {selectionSnapshotId ? (
        <section
          aria-labelledby="screening-selection-handoff-title"
          className="rounded-xl border border-indigo-200 bg-indigo-50 p-4"
        >
          <h3
            id="screening-selection-handoff-title"
            className="text-sm font-semibold text-indigo-950"
          >
            Candidate selection handoff
          </h3>
          {selectionSnapshotLoading ? (
            <p className="mt-2 text-sm text-indigo-900" role="status">
              Verifying the server-owned selection…
            </p>
          ) : selectionSnapshotError ? (
            <p className="mt-2 text-sm text-red-800" role="alert">
              {selectionSnapshotError}
            </p>
          ) : selectionSnapshot ? (
            <div className="mt-2 space-y-3">
              <p className="text-sm text-indigo-950">
                <span className="font-semibold">
                  {selectionSnapshot.count}{' '}
                  {selectionSnapshot.count === 1 ? 'candidate' : 'candidates'}
                </span>{' '}
                · {selectionSnapshot.description}
              </p>
              <p className="text-xs text-indigo-900">
                This immutable selection expires {displayDate(selectionSnapshot.expiresAt)}.
                The server will revalidate job scope, privacy state, and live candidate
                availability before confirmation.
              </p>
              <label className="block max-w-2xl text-sm font-medium text-indigo-950">
                Inclusion rationale
                <textarea
                  value={selectionNote}
                  onChange={(event) => {
                    setSelectionNote(event.target.value)
                    setConfirmAcknowledged(false)
                  }}
                  required
                  maxLength={4000}
                  rows={2}
                  placeholder="Document why this selected cohort should be included in the screening batch"
                  className="mt-1 block w-full rounded-lg border border-indigo-200 bg-white px-3 py-2 text-sm text-[#0f1419]"
                />
              </label>
              <p className="text-xs text-indigo-900">
                The rationale is stored once with the confirmed selection cohort.
                This handoff never changes a pipeline stage.
              </p>
            </div>
          ) : null}
        </section>
      ) : null}

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

        {ruleResult.error ? <p role="alert" className="text-sm text-red-800">{ruleResult.error}</p> : null}
        {previewError ? <p role="alert" className="text-sm text-red-800">{previewError}</p> : null}
        <Button type="submit" disabled={!jobOpen || previewBusy || confirmBusy || !currentRequest}>
          {previewBusy ? 'Refreshing preview…' : preview ? 'Refresh screening preview' : 'Preview screening selection'}
        </Button>
      </form>

      {confirmNotice ? (
        <p
          ref={confirmNoticeRef}
          role="status"
          tabIndex={-1}
          className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800"
        >
          {confirmNotice}
        </p>
      ) : null}

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

          {previewPageError ? (
            <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">
              {previewPageError}
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
              <dt className="text-xs text-amber-800">Stale / unscored</dt>
              <dd className="mt-1 text-lg font-semibold text-amber-900">
                {preview.scoreStateCounts.stale + preview.scoreStateCounts.unscored}
              </dd>
            </div>
            <div className="rounded-xl bg-rose-50 p-3">
              <dt className="text-xs text-rose-800">Known knockouts</dt>
              <dd className="mt-1 text-lg font-semibold text-rose-900">
                {preview.knownKnockoutCount}
              </dd>
            </div>
          </dl>

          <div className="rounded-xl border border-indigo-100 bg-indigo-50 p-3">
            <p className="text-sm font-medium text-indigo-950">{cutLineDescription(preview)}</p>
            {preview.cutLine.candidate ? (
              <div className="mt-2">
                <CandidateIdentityLine
                  candidate={preview.cutLine.candidate}
                  identityState={preview.cutLine.candidate.identityState}
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
                only this planned batch — never a candidate&apos;s pipeline stage. Search is bounded,
                job-scoped, and privacy-filtered on the server.
              </p>
            </div>
            <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_10rem_minmax(0,1fr)_auto] md:items-end">
              <div className="space-y-2">
                <label className="block text-sm text-[#0f1419]">
                  Find application
                  <input
                    aria-label="Search exception applications"
                    aria-describedby="exception-search-status"
                    aria-busy={exceptionSearchBusy}
                    type="search"
                    maxLength={120}
                    value={exceptionSearch}
                    onChange={(event) => {
                      setExceptionSearch(event.target.value)
                      setExceptionTargetId('')
                      setExceptionNote('')
                    }}
                    placeholder="Search this job by candidate name or email"
                    className="mt-1 block h-9 w-full rounded-lg border border-[#e1e8ed] px-3 text-sm"
                  />
                </label>
                <label className="block text-sm text-[#0f1419]">
                  Application
                  <select
                    aria-label="Exception application"
                    value={exceptionTargetId}
                    disabled={exceptionSearchBusy || exceptionCandidates.length === 0}
                    onChange={(event) => {
                      setExceptionTargetId(event.target.value)
                      setExceptionNote('')
                    }}
                    className="mt-1 block h-9 w-full rounded-lg border border-[#e1e8ed] bg-white px-3 text-sm"
                  >
                    <option value="">Choose an application</option>
                    {exceptionCandidates.map((candidate) => (
                      <option key={candidate.applicationId} value={candidate.applicationId}>
                        {candidate.candidateName} · {candidate.candidateEmail}
                      </option>
                    ))}
                  </select>
                </label>
                <p
                  ref={exceptionSearchStatusRef}
                  id="exception-search-status"
                  className="text-xs text-[#71767b]"
                  aria-live="polite"
                  tabIndex={-1}
                >
                  {!exceptionSearch.trim()
                    ? 'Enter a candidate name or email to search this job.'
                    : exceptionSearch.trim().length < 2
                      ? 'Enter at least 2 characters to search this job.'
                    : exceptionSearchBusy
                      ? 'Searching candidates…'
                      : exceptionCandidates.length
                        ? `Showing ${exceptionCandidates.length} bounded results · search page ${exceptionSearchPage}.`
                        : 'No candidates match this search.'}
                </p>
                {exceptionSearchError ? (
                  <p role="alert" className="text-xs text-red-800">
                    {exceptionSearchError}
                  </p>
                ) : null}
                {exceptionSearchPage > 1 || exceptionSearchCursor ? (
                  <div className="flex items-center gap-2 flex-wrap">
                    {exceptionSearchPage > 1 ? (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={exceptionSearchBusy}
                        onClick={() => void loadExceptionCandidatePage(
                          exceptionSearch.trim(),
                          exceptionSearchPageCursors[exceptionSearchPage - 2],
                          exceptionSearchGenerationRef.current,
                          exceptionSearchPage - 1,
                          true,
                        )}
                      >
                        Previous candidate search page
                      </Button>
                    ) : null}
                    {exceptionSearchPage > 2 ? (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={exceptionSearchBusy}
                        onClick={() => void loadExceptionCandidatePage(
                          exceptionSearch.trim(),
                          undefined,
                          exceptionSearchGenerationRef.current,
                          1,
                          true,
                        )}
                      >
                        Return to first search results
                      </Button>
                    ) : null}
                    {exceptionSearchCursor ? (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={exceptionSearchBusy}
                        onClick={() => void loadExceptionCandidatePage(
                          exceptionSearch.trim(),
                          exceptionSearchCursor,
                          exceptionSearchGenerationRef.current,
                          exceptionSearchPage + 1,
                          true,
                        )}
                      >
                        Next candidate search page
                      </Button>
                    ) : null}
                  </div>
                ) : null}
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
              <Button
                type="button"
                variant="secondary"
                onClick={addException}
                disabled={
                  !jobOpen ||
                  previewBusy ||
                  confirmBusy ||
                  exceptionSearchBusy ||
                  !exceptionTargetId
                }
              >
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
                        {entry
                          ? entryLabel(entry)
                          : exceptionCandidateLabels[exception.applicationId] ??
                            `Application ${shortId(exception.applicationId)}`}
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
                  Planned selection ({preview.selectedCount})
                </h4>
                <p className="mt-1 text-xs text-[#71767b]">
                  This server-paged list is a review only until you explicitly confirm the durable batch below.
                </p>
              </div>
              {preview.scoreStateCounts.stale ? (
                <Badge variant="caution">
                  {preview.scoreStateCounts.stale} stale score
                  {preview.scoreStateCounts.stale === 1 ? '' : 's'}
                </Badge>
              ) : null}
            </div>
            {preview.selectedCount > 0 && selectedPage ? (
              <div className="space-y-3">
                <label className="block max-w-md text-sm text-[#0f1419]">
                  Filter current selected page
                  <input
                    aria-label="Filter current selected page"
                    aria-busy={selectedSearch !== deferredSelectedSearch}
                    type="search"
                    value={selectedSearch}
                    onChange={(event) => setSelectedSearch(event.target.value)}
                    placeholder="Name, email, application or candidate ID"
                    className="mt-1 block h-9 w-full rounded-lg border border-[#e1e8ed] px-3 text-sm"
                  />
                </label>
                {matchingSelectedEntries.length ? (
                  <ul
                    aria-label="Planned selected applications"
                    className="divide-y divide-[#e1e8ed] rounded-xl border border-[#e1e8ed]"
                  >
                    {matchingSelectedEntries.map((entry) => (
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
                    {selectedSearch
                      ? `Showing ${matchingSelectedEntries.length} of ${selectedPage.rows.length} applications on this page; ${selectedPage.total} selected total.`
                      : `Showing ${pageRange(selectedPage)} selected applications.`}
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={!selectedPage.hasPrevious || previewPageBusy !== null}
                      onClick={() =>
                        void loadPreviewPage(
                          'selected',
                          selectedPage.previousCursor ?? undefined,
                        )
                      }
                    >
                      Previous selected page
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={!selectedPage.hasNext || previewPageBusy !== null}
                      onClick={() =>
                        void loadPreviewPage(
                          'selected',
                          selectedPage.nextCursor ?? undefined,
                        )
                      }
                    >
                      {previewPageBusy === 'selected'
                        ? 'Loading selected page…'
                        : 'Next selected page'}
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <p className="rounded-xl border border-dashed border-[#e1e8ed] p-4 text-sm text-[#71767b]">
                No candidates are selected by this rule. Adjust the rule or add a documented include exception.
              </p>
            )}

            <PreviewCandidatePageDisclosure
              summary={`View all ${preview.evaluatedCount} evaluated applications`}
              pageName="evaluated"
              listLabel="Evaluated applications"
              count={preview.evaluatedCount}
              page={evaluatedPage}
              open={evaluatedOpen}
              busy={previewPageBusy === 'evaluated'}
              globalBusy={previewPageBusy !== null}
              search={evaluatedSearch}
              deferredSearch={deferredEvaluatedSearch}
              onToggle={(open) => {
                if (
                  open &&
                  previewPageActiveScopeRef.current &&
                  previewPageActiveScopeRef.current !== 'evaluated'
                ) {
                  void loadPreviewPage('evaluated')
                  return
                }
                setEvaluatedOpen(open)
                if (open && !evaluatedPage && preview.evaluatedCount > 0) {
                  void loadPreviewPage('evaluated')
                }
              }}
              onSearch={setEvaluatedSearch}
              onLoad={(cursor) => void loadPreviewPage('evaluated', cursor)}
            />
            <PreviewCandidatePageDisclosure
              summary={`Review ${preview.scoreStateCounts.stale + preview.scoreStateCounts.unscored} stale or unscored applications`}
              pageName="attention"
              listLabel="Stale or unscored applications"
              count={preview.scoreStateCounts.stale + preview.scoreStateCounts.unscored}
              page={attentionPage}
              open={attentionOpen}
              busy={previewPageBusy === 'attention'}
              globalBusy={previewPageBusy !== null}
              search={attentionSearch}
              deferredSearch={deferredAttentionSearch}
              onToggle={(open) => {
                if (
                  open &&
                  previewPageActiveScopeRef.current &&
                  previewPageActiveScopeRef.current !== 'attention'
                ) {
                  void loadPreviewPage('attention')
                  return
                }
                setAttentionOpen(open)
                if (
                  open &&
                  !attentionPage &&
                  preview.scoreStateCounts.stale + preview.scoreStateCounts.unscored > 0
                ) {
                  void loadPreviewPage('attention')
                }
              }}
              onSearch={setAttentionSearch}
              onLoad={(cursor) => void loadPreviewPage('attention', cursor)}
            />
            <PreviewCandidatePageDisclosure
              summary={`Review ${preview.knownKnockoutCount} known knockout applications`}
              pageName="knockout"
              listLabel="Known knockout applications"
              count={preview.knownKnockoutCount}
              page={knockoutPage}
              open={knockoutOpen}
              busy={previewPageBusy === 'knockouts'}
              globalBusy={previewPageBusy !== null}
              search={knockoutSearch}
              deferredSearch={deferredKnockoutSearch}
              onToggle={(open) => {
                if (
                  open &&
                  previewPageActiveScopeRef.current &&
                  previewPageActiveScopeRef.current !== 'knockouts'
                ) {
                  void loadPreviewPage('knockouts')
                  return
                }
                setKnockoutOpen(open)
                if (open && !knockoutPage && preview.knownKnockoutCount > 0) {
                  void loadPreviewPage('knockouts')
                }
              }}
              onSearch={setKnockoutSearch}
              onLoad={(cursor) => void loadPreviewPage('knockouts', cursor)}
            />
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
                onChange={(event) => {
                  setSendAfter(event.target.value)
                  setConfirmAcknowledged(false)
                }}
                disabled={
                  !jobOpen ||
                  confirmBusy ||
                  previewBusy ||
                  previewPageBusy !== null ||
                  !previewIsCurrent
                }
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
                disabled={
                  !jobOpen ||
                  confirmBusy ||
                  previewBusy ||
                  previewPageBusy !== null ||
                  !previewIsCurrent ||
                  preview.selectedCount < 1
                }
                onChange={(event) => setConfirmAcknowledged(event.target.checked)}
                className="mt-1"
              />
              <span>
                I reviewed the deterministic cut line, known knockouts, unknown/stale scores, and
                every exception, and authorize staggered invitation delivery at the planned time.
              </span>
            </label>
            {confirmError ? <p role="alert" className="text-sm text-red-800">{confirmError}</p> : null}
            <Button
              type="button"
              onClick={() => void confirmPreview()}
              disabled={
                !jobOpen ||
                confirmBusy ||
                previewBusy ||
                previewPageBusy !== null ||
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
            <p
              ref={gatePageStatusRef}
              className="mt-1 text-xs text-[#71767b]"
              tabIndex={-1}
              aria-live="polite"
            >
              Durable gates and invitation-batch progress for this job only · page {gatePageNumber}.
            </p>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void loadGates(undefined, 1, true)}
            disabled={gatesLoading}
          >
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
          <p
            ref={retryNoticeRef}
            role="status"
            tabIndex={-1}
            className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800"
          >
            {retryNotice}
          </p>
        ) : null}
        {retryError ? (
          <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">
            {retryError}
          </p>
        ) : null}
        {batchPageError ? (
          <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">
            {batchPageError}
          </p>
        ) : null}

        {gatesError ? (
          <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            <p>{gatesError}</p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="mt-2"
              onClick={() => void loadGates(undefined, 1, true)}
            >
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
            {gate.exceptionCount ? (
              <p className="text-xs text-[#536471]">
                {gate.exceptionCount} documented {gate.exceptionCount === 1 ? 'exception' : 'exceptions'}
              </p>
            ) : null}
            {gate.selectionHandoff ? (
              <p className="text-xs text-[#536471]">
                Candidate-selection handoff by {gate.selectionHandoff.actorName}: {gate.selectionHandoff.note}
              </p>
            ) : null}
            {gate.cancelNote ? <p className="text-xs text-red-800">Cancellation note: {gate.cancelNote}</p> : null}
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
                    {batch.lastError ? <p className="mt-1 text-xs text-red-800">Latest delivery issue: {batch.lastError}</p> : null}
                    <RecipientDeliveryLedger
                      jobId={jobId}
                      batchId={batch.id}
                      historyRevision={historyRevision}
                    />
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
            {(batchPageNumbers[gate.id] ?? 1) > 1 || gate.batchPageInfo.hasNextPage ? (
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <p
                  ref={(element) => {
                    batchPageStatusRefs.current[gate.id] = element
                  }}
                  className="text-xs text-[#71767b]"
                  aria-live="polite"
                  tabIndex={-1}
                >
                  Invitation wave page {batchPageNumbers[gate.id] ?? 1} · up to{' '}
                  {gate.batchPageInfo.limit} waves shown
                </p>
                <div className="flex items-center gap-2 flex-wrap">
                  {(batchPageNumbers[gate.id] ?? 1) > 1 ? (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={batchPageBusyGateId !== null}
                      onClick={() => void loadGateBatchPage(
                        gate,
                        batchPageCursors[gate.id]?.[
                          (batchPageNumbers[gate.id] ?? 1) - 2
                        ],
                        (batchPageNumbers[gate.id] ?? 1) - 1,
                      )}
                    >
                      Previous wave page
                    </Button>
                  ) : null}
                  {(batchPageNumbers[gate.id] ?? 1) > 2 ? (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={batchPageBusyGateId !== null}
                      onClick={() => void loadGateBatchPage(gate)}
                    >
                      Return to latest waves
                    </Button>
                  ) : null}
                  {gate.batchPageInfo.hasNextPage && gate.batchPageInfo.nextCursor ? (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={batchPageBusyGateId !== null}
                      onClick={() => void loadGateBatchPage(
                        gate,
                        gate.batchPageInfo.nextCursor ?? undefined,
                        (batchPageNumbers[gate.id] ?? 1) + 1,
                      )}
                    >
                      {batchPageBusyGateId === gate.id
                        ? 'Loading wave page…'
                        : 'View older waves'}
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}

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
        {gates && (gatePageNumber > 1 || gatePageInfo.hasNextPage) ? (
          <div className="flex items-center gap-2 flex-wrap">
            {gatePageNumber > 1 ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={gatesLoading}
                onClick={() => void loadGates(
                  gatePageCursors[gatePageNumber - 2],
                  gatePageNumber - 1,
                  true,
                )}
              >
                Previous confirmed-batch page
              </Button>
            ) : null}
            {gatePageNumber > 2 ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={gatesLoading}
                onClick={() => void loadGates(undefined, 1, true)}
              >
                Return to newest batches
              </Button>
            ) : null}
            {gatePageInfo.hasNextPage && gatePageInfo.nextCursor ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={gatesLoading}
                onClick={() => void loadGates(
                  gatePageInfo.nextCursor ?? undefined,
                  gatePageNumber + 1,
                  true,
                )}
              >
                {gatesLoading ? 'Loading next batch page…' : 'Next page of confirmed batches'}
              </Button>
            ) : null}
          </div>
        ) : null}
      </section>
    </section>
  )
}

export const __screeningPanelTestUtils = {
  ruleFromDraft,
}
