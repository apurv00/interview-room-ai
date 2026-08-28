'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import Button from '@shared/ui/Button'
import StateView from '@shared/ui/StateView'
import type { HireCandidateBulkReasonCode } from '@/modules/hire-candidate-actions'
import BulkUploadPanel from '../BulkUploadPanel'
import JobSubnav from '../JobSubnav'
import JobWorkspaceHeader from '../JobWorkspaceHeader'
import PoolSuggestionPanel from '../PoolSuggestionPanel'
import CandidateFilters, { type CandidateFilterState } from './CandidateFilters'
import CandidateBulkActionPanel from './CandidateBulkActionPanel'
import CandidateIntakePanel from './CandidateIntakePanel'
import { CandidateBoard, CandidateTable } from './CandidateListPresentations'
import {
  CANDIDATE_SORTS,
  CANDIDATE_STAGE_LABEL,
  CANDIDATE_STAGES,
  DEFAULT_COLUMNS,
  OPTIONAL_COLUMNS,
  SAVED_VIEWS,
  type CandidateColumn,
  type CandidateListResponse,
  type CandidateListRow,
  type CandidateSavedView,
  type CandidateSelectionSnapshot,
  type CandidateSort,
  type CandidateStage,
  type CandidateSummaryResponse,
} from './candidateWorkspaceTypes'

const API_QUERY_KEYS = [
  'view', 'q', 'stage', 'source', 'appliedFrom', 'appliedTo', 'scoreState',
  'scoreMin', 'scoreMax', 'humanReview', 'aiInterview', 'history', 'sort',
  'direction', 'cursor',
] as const
const CLIENT_PANEL_VALUES = new Set(['add', 'import', 'suggestions'])
const SAVED_VIEW_IDS = new Set(SAVED_VIEWS.map((view) => view.id))
const SORT_IDS = new Set(CANDIDATE_SORTS.map((sort) => sort.id))
const COLUMN_IDS = new Set(OPTIONAL_COLUMNS.map((column) => column.id))
const ASCENDING_SORTS = new Set<CandidateSort>(['oldest', 'name', 'stage', 'rank'])
const CANDIDATE_NAVIGATION_STORAGE_KEY = 'hire:candidate-navigation:v1'
const CANDIDATE_NAVIGATION_VERSION = 1
const CANDIDATE_NAVIGATION_TTL_MS = 30 * 60 * 1_000
const CANDIDATE_NAVIGATION_MAX_RECORDS = 8
const CANDIDATE_NAVIGATION_MAX_DEPTH = 24
const CANDIDATE_NAVIGATION_MAX_CURSOR_LENGTH = 4_096

interface CandidateNavigationRecord {
  version: typeof CANDIDATE_NAVIGATION_VERSION
  jobId: string
  scope: string
  cursor: string | null
  previous: Array<string | null>
  updatedAt: number
  expiresAt: number
}

interface ExplicitSelection {
  mode: 'explicit'
  ids: Set<string>
}

interface SnapshotSelection extends CandidateSelectionSnapshot {
  mode: 'snapshot'
}

type CandidateSelection = ExplicitSelection | SnapshotSelection
type StageAction = 'advance' | 'reject' | 'withdraw' | 'offer_declined'

const STAGE_REASON_OPTIONS: Array<{ value: HireCandidateBulkReasonCode; label: string }> = [
  { value: 'requirements_mismatch', label: 'Requirements mismatch' },
  { value: 'position_closed', label: 'Position closed' },
  { value: 'duplicate_application', label: 'Duplicate application' },
  { value: 'candidate_withdrew', label: 'Candidate withdrew' },
  { value: 'role_filled', label: 'Role filled' },
]

function reasonOptionsForStageAction(action: StageAction) {
  if (action === 'withdraw' || action === 'offer_declined') {
    return STAGE_REASON_OPTIONS.filter((option) => option.value === 'candidate_withdrew')
  }
  if (action === 'reject') {
    return STAGE_REASON_OPTIONS.filter((option) => option.value !== 'candidate_withdrew')
  }
  return []
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function isStage(value: unknown): value is CandidateStage {
  return typeof value === 'string' && CANDIDATE_STAGES.includes(value as CandidateStage)
}

function readRow(value: unknown): CandidateListRow | null {
  const row = objectValue(value)
  if (!row) return null
  const candidate = objectValue(row.candidate)
  const jdMatch = objectValue(row.jdMatch)
  const humanReview = objectValue(row.humanReview)
  const aiInterview = objectValue(row.aiInterview)
  const workspaceHistory = objectValue(row.workspaceHistory)
  const applicationId = stringValue(row.applicationId)
  const candidateId = stringValue(row?.candidateId) ?? stringValue(candidate?.id)
  const name = stringValue(row?.name) ?? stringValue(candidate?.name)
  const stage = row.stage
  const appliedAt = stringValue(row.appliedAt)
  const lastActivityAt = stringValue(row.lastActivityAt) ?? appliedAt
  if (!applicationId || !candidateId || !name || !isStage(stage) || !appliedAt || !lastActivityAt) return null

  const rawMatchState = stringValue(jdMatch?.state) ?? stringValue(row.scoreState)
  const matchState: CandidateListRow['jdMatch']['state'] =
    rawMatchState === 'fresh' || rawMatchState === 'stale' || rawMatchState === 'pending'
      ? rawMatchState
      : 'unscored'
  const rawHumanState = stringValue(humanReview?.state)
  const humanState: CandidateListRow['humanReview']['state'] =
    rawHumanState === 'pending' || rawHumanState === 'complete' || rawHumanState === 'mixed'
      ? rawHumanState
      : 'none'
  const rawAiState = stringValue(aiInterview?.state)
  const aiState: CandidateListRow['aiInterview']['state'] =
    rawAiState === 'invited' || rawAiState === 'in_progress' || rawAiState === 'completed' || rawAiState === 'revoked'
      ? rawAiState
      : 'not_invited'

  const source = stringValue(row.source)
  const sourceHistory = Array.isArray(row.sourceHistory)
    ? row.sourceHistory.filter((item): item is string => typeof item === 'string')
    : []
  if (source && !sourceHistory.includes(source)) sourceHistory.unshift(source)

  return {
    applicationId,
    candidateId,
    name,
    email: stringValue(row.email) ?? stringValue(candidate?.email),
    stage,
    appliedAt,
    source,
    sourceHistory,
    lastActivityAt,
    attention: Array.isArray(row.attention)
      ? row.attention.filter((item): item is string => typeof item === 'string')
      : [],
    jdMatch: {
      state: matchState,
      score: typeof jdMatch?.score === 'number' ? jdMatch.score : null,
      rank: typeof jdMatch?.rank === 'number' ? jdMatch.rank : null,
      denominator: numberValue(jdMatch?.denominator),
    },
    humanReview: {
      state: humanState,
      recommendations: Object.fromEntries(
        Object.entries(objectValue(humanReview?.recommendations) ?? {})
          .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])),
      ),
      submitted: numberValue(humanReview?.submitted),
      pending: numberValue(humanReview?.pending),
      total: numberValue(humanReview?.total),
      disagreement: humanReview?.disagreement === true,
    },
    aiInterview: {
      state: aiState,
      score: typeof aiInterview?.overallScore === 'number' ? aiInterview.overallScore : null,
    },
    workspaceHistory: {
      previousApplications: numberValue(workspaceHistory?.previousApplications),
    },
  }
}

function countRecord<T extends string>(
  raw: unknown,
  keys: readonly T[],
): Record<T, number> {
  const value = objectValue(raw)
  return Object.fromEntries(keys.map((key) => [key, numberValue(value?.[key])])) as Record<T, number>
}

function readCandidateList(value: unknown): CandidateListResponse | null {
  const response = objectValue(value)
  const job = objectValue(response?.job)
  const pageInfo = objectValue(response?.pageInfo)
  const rows = Array.isArray(response?.rows) ? response.rows.slice(0, 50).map(readRow) : []
  const jobId = stringValue(job?.id) ?? stringValue(job?.jobId)
  const title = stringValue(job?.title)
  const status = job?.status
  const asOf = stringValue(response?.asOf) ?? stringValue(pageInfo?.snapshotAt)
  if (
    !jobId || !title || (status !== 'open' && status !== 'on_hold' && status !== 'closed') ||
    !asOf || !Array.isArray(response?.rows) || rows.some((row) => row === null)
  ) return null

  return {
    asOf,
    job: {
      id: jobId,
      title,
      status,
    },
    rows: rows as CandidateListRow[],
    pageInfo: {
      limit: numberValue(pageInfo?.limit, 50),
      nextCursor: stringValue(pageInfo?.nextCursor),
      hasNextPage: pageInfo?.hasNextPage === true || typeof pageInfo?.nextCursor === 'string',
      snapshotAt: stringValue(pageInfo?.snapshotAt) ?? asOf,
      refreshAvailable: pageInfo?.refreshAvailable === true,
    },
  }
}

function readCandidateSummary(value: unknown): CandidateSummaryResponse | null {
  const response = objectValue(value)
  const job = objectValue(response?.job)
  const counts = objectValue(response?.counts)
  const rankContext = objectValue(response?.rankContext)
  const jobId = stringValue(job?.id) ?? stringValue(job?.jobId)
  const title = stringValue(job?.title)
  const status = job?.status
  const asOf = stringValue(response?.asOf)
  if (!jobId || !title || !asOf || (status !== 'open' && status !== 'on_hold' && status !== 'closed')) return null

  return {
    asOf,
    job: { id: jobId, title, status },
    counts: {
      total: numberValue(counts?.total),
      matching: numberValue(counts?.matching),
      savedViews: countRecord(counts?.savedViews, SAVED_VIEWS.map((view) => view.id)),
      stages: countRecord(counts?.stages, CANDIDATE_STAGES),
      jdMatch: Object.fromEntries(
        ['fresh', 'stale', 'pending', 'unscored'].map((key) => [key, numberValue(objectValue(counts?.jdMatch)?.[key])]),
      ),
    },
    rankContext: {
      freshScoredTotal: numberValue(rankContext?.freshScoredTotal),
      stale: numberValue(rankContext?.stale),
      pending: numberValue(rankContext?.pending),
      unscored: numberValue(rankContext?.unscored),
    },
  }
}

function readSnapshot(value: unknown): CandidateSelectionSnapshot | null {
  const response = objectValue(value)
  const snapshot = objectValue(response?.snapshot) ?? response
  const selectionId = stringValue(snapshot?.selectionId)
  const expiresAt = stringValue(snapshot?.expiresAt)
  const homogeneousStage = snapshot?.homogeneousStage
  if (!selectionId || !expiresAt || (homogeneousStage !== null && !isStage(homogeneousStage))) return null
  return {
    selectionId,
    expiresAt,
    count: numberValue(snapshot?.count),
    description: stringValue(snapshot?.description) ?? 'Selected candidates',
    homogeneousStage,
  }
}

function readFreshness(value: unknown): boolean | null {
  const response = objectValue(value)
  return typeof response?.hasNewerResults === 'boolean' ? response.hasNewerResults : null
}

function normalizedFilters(searchParams: URLSearchParams): CandidateFilterState {
  const rawView = searchParams.get('view')
  const rawSort = searchParams.get('sort')
  const sort = SORT_IDS.has(rawSort as CandidateSort) ? rawSort as CandidateSort : 'attention'
  const rawDirection = searchParams.get('direction')
  const direction = sort === 'newest'
    ? 'desc'
    : sort === 'oldest'
      ? 'asc'
      : rawDirection === 'asc' || rawDirection === 'desc'
        ? rawDirection
        : ASCENDING_SORTS.has(sort) ? 'asc' : 'desc'
  return {
    view: SAVED_VIEW_IDS.has(rawView as CandidateSavedView) ? rawView as CandidateSavedView : 'all',
    q: searchParams.get('q') ?? '',
    stage: searchParams.get('stage') ?? '',
    source: searchParams.get('source') ?? '',
    appliedFrom: searchParams.get('appliedFrom') ?? '',
    appliedTo: searchParams.get('appliedTo') ?? '',
    scoreState: searchParams.get('scoreState') ?? '',
    scoreMin: searchParams.get('scoreMin') ?? '',
    scoreMax: searchParams.get('scoreMax') ?? '',
    humanReview: searchParams.get('humanReview') ?? '',
    aiInterview: searchParams.get('aiInterview') ?? '',
    history: searchParams.get('history') ?? '',
    sort,
    direction,
  }
}

function selectedColumns(searchParams: URLSearchParams): Set<CandidateColumn> {
  const encoded = searchParams.get('columns')
  const optional = encoded === null
    ? DEFAULT_COLUMNS.filter((column) => COLUMN_IDS.has(column))
    : encoded === 'none'
      ? []
      : encoded.split(',').filter((column): column is CandidateColumn => COLUMN_IDS.has(column as CandidateColumn))
  return new Set<CandidateColumn>(['candidate', 'stage', 'actions', ...optional])
}

function apiQuery(searchParams: URLSearchParams): URLSearchParams {
  const result = new URLSearchParams()
  for (const key of API_QUERY_KEYS) {
    const value = searchParams.get(key)
    if (value) result.set(key, value)
  }
  const filters = normalizedFilters(searchParams)
  result.set('sort', filters.sort)
  result.set('direction', filters.direction)
  result.set('limit', '50')
  return result
}

/**
 * Produces a stable non-PII coordinate for the server-bound list query. Search
 * text may contain a name or email, so even the hash input redacts its value;
 * the session record stores only this coordinate and opaque server cursors.
 */
function candidateNavigationScope(jobId: string, searchParams: URLSearchParams): string {
  const query = apiQuery(searchParams)
  query.delete('cursor')
  if (query.has('q')) query.set('q', 'search-applied')
  query.sort()
  const value = `${jobId}\0${query.toString()}`
  let first = 0xdeadbeef ^ value.length
  let second = 0x41c6ce57 ^ value.length
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    first = Math.imul(first ^ code, 2_654_435_761)
    second = Math.imul(second ^ code, 1_597_334_677)
  }
  first = Math.imul(first ^ (first >>> 16), 2_246_822_507) ^ Math.imul(second ^ (second >>> 13), 3_266_489_909)
  second = Math.imul(second ^ (second >>> 16), 2_246_822_507) ^ Math.imul(first ^ (first >>> 13), 3_266_489_909)
  return `${(second >>> 0).toString(16).padStart(8, '0')}${(first >>> 0).toString(16).padStart(8, '0')}`
}

function cursorValue(value: unknown): string | null | undefined {
  if (value === null) return null
  return typeof value === 'string' && value.length > 0 && value.length <= CANDIDATE_NAVIGATION_MAX_CURSOR_LENGTH
    ? value
    : undefined
}

function readCandidateNavigationRecords(): CandidateNavigationRecord[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.sessionStorage.getItem(CANDIDATE_NAVIGATION_STORAGE_KEY)
    if (!raw) return []
    const parsed = objectValue(JSON.parse(raw))
    if (parsed?.version !== CANDIDATE_NAVIGATION_VERSION || !Array.isArray(parsed.records)) return []
    const now = Date.now()
    const records: CandidateNavigationRecord[] = []
    for (const value of parsed.records.slice(0, CANDIDATE_NAVIGATION_MAX_RECORDS)) {
      const source = objectValue(value)
      if (!source || source.version !== CANDIDATE_NAVIGATION_VERSION) continue
      const cursor = cursorValue(source.cursor)
      const previous = Array.isArray(source.previous)
        ? source.previous.slice(-CANDIDATE_NAVIGATION_MAX_DEPTH).map(cursorValue)
        : []
      if (
        typeof source.jobId !== 'string' || source.jobId.length === 0 || source.jobId.length > 128 ||
        typeof source.scope !== 'string' || !/^[0-9a-f]{16}$/.test(source.scope) ||
        cursor === undefined || previous.some((entry) => entry === undefined) ||
        typeof source.updatedAt !== 'number' || !Number.isFinite(source.updatedAt) ||
        typeof source.expiresAt !== 'number' || !Number.isFinite(source.expiresAt) || source.expiresAt <= now
      ) continue
      records.push({
        version: CANDIDATE_NAVIGATION_VERSION,
        jobId: source.jobId,
        scope: source.scope,
        cursor,
        previous: previous as Array<string | null>,
        updatedAt: source.updatedAt,
        expiresAt: source.expiresAt,
      })
    }
    return records
  } catch {
    // Storage can be disabled or unavailable in private browsing. Paging still
    // works from the in-memory record for the lifetime of this mounted view.
    return []
  }
}

function writeCandidateNavigationRecords(records: CandidateNavigationRecord[]) {
  if (typeof window === 'undefined') return
  try {
    if (records.length === 0) {
      window.sessionStorage.removeItem(CANDIDATE_NAVIGATION_STORAGE_KEY)
      return
    }
    window.sessionStorage.setItem(CANDIDATE_NAVIGATION_STORAGE_KEY, JSON.stringify({
      version: CANDIDATE_NAVIGATION_VERSION,
      records: records.slice(0, CANDIDATE_NAVIGATION_MAX_RECORDS),
    }))
  } catch {
    // Quota, policy, and privacy-mode failures must never block navigation.
  }
}

function saveCandidateNavigation(record: CandidateNavigationRecord) {
  const now = Date.now()
  const records = readCandidateNavigationRecords()
    .filter((entry) => entry.expiresAt > now && !(
      entry.jobId === record.jobId &&
      entry.scope === record.scope &&
      entry.cursor === record.cursor
    ))
  writeCandidateNavigationRecords([record, ...records].slice(0, CANDIDATE_NAVIGATION_MAX_RECORDS))
}

function removeCandidateNavigation(jobId: string, scope: string) {
  const now = Date.now()
  writeCandidateNavigationRecords(
    readCandidateNavigationRecords().filter(
      (entry) => entry.expiresAt > now && !(entry.jobId === jobId && entry.scope === scope),
    ),
  )
}

function summaryApiQuery(searchParams: URLSearchParams): URLSearchParams {
  const result = new URLSearchParams()
  for (const key of API_QUERY_KEYS) {
    if (key === 'cursor') continue
    const value = searchParams.get(key)
    if (value) result.set(key, value)
  }
  const filters = normalizedFilters(searchParams)
  result.set('sort', filters.sort)
  result.set('direction', filters.direction)
  return result
}

function selectionQuery(searchParams: URLSearchParams) {
  const filters = normalizedFilters(searchParams)
  const csv = (value: string) => value ? value.split(',').filter(Boolean) : []
  return {
    ...(filters.q ? { q: filters.q } : {}),
    view: filters.view,
    stage: csv(filters.stage),
    source: csv(filters.source),
    scoreState: csv(filters.scoreState),
    ...(filters.scoreMin ? { scoreMin: Number(filters.scoreMin) } : {}),
    ...(filters.scoreMax ? { scoreMax: Number(filters.scoreMax) } : {}),
    humanReview: csv(filters.humanReview),
    aiInterview: csv(filters.aiInterview),
    ...(filters.history ? { history: filters.history } : {}),
    ...(filters.appliedFrom ? { appliedFrom: filters.appliedFrom } : {}),
    ...(filters.appliedTo ? { appliedTo: filters.appliedTo } : {}),
    sort: filters.sort,
    direction: filters.direction,
  }
}

function responseError(value: unknown, fallback: string): string {
  const response = objectValue(value)
  return stringValue(response?.error) ?? fallback
}

function responseCode(value: unknown): string | null {
  return stringValue(objectValue(value)?.code)
}

function operationId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `candidate-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function filterDescription(filters: CandidateFilterState): string {
  const savedView = SAVED_VIEWS.find((view) => view.id === filters.view)?.label ?? 'All candidates'
  const csvLabels = (value: string, labels: Record<string, string> = {}) => value
    .split(',')
    .filter(Boolean)
    .map((item) => labels[item] ?? item.replaceAll('_', ' '))
    .join(', ')
  const advanced = [
    filters.stage ? `Recruiter decision: ${csvLabels(filters.stage, CANDIDATE_STAGE_LABEL)}` : null,
    filters.source ? `Candidate sources: ${csvLabels(filters.source)}` : null,
    filters.scoreState ? `JD states: ${csvLabels(filters.scoreState, { stale: 'needs refresh' })}` : null,
    filters.scoreMin ? `JD score at least ${filters.scoreMin}` : null,
    filters.scoreMax ? `JD score at most ${filters.scoreMax}` : null,
    filters.humanReview ? `Human review: ${csvLabels(filters.humanReview, { none: 'not requested', mixed: 'submitted and pending', disagreement: 'reviewers disagree' })}` : null,
    filters.aiInterview ? `AI interview: ${csvLabels(filters.aiInterview)}` : null,
    filters.history ? `Workspace history: ${csvLabels(filters.history)}` : null,
    filters.appliedFrom ? `Applied from ${filters.appliedFrom}` : null,
    filters.appliedTo ? `Applied through ${filters.appliedTo}` : null,
  ].filter((item): item is string => Boolean(item))
  const sortLabel = CANDIDATE_SORTS.find((sort) => sort.id === filters.sort)?.label ?? filters.sort
  return [
    savedView,
    filters.q ? `search “${filters.q}”` : null,
    ...advanced,
    `${sortLabel}, ${filters.direction === 'asc' ? 'ascending' : 'descending'}`,
  ].filter(Boolean).join(' · ')
}

function restoreStageActionFocus(
  applicationId: string,
  action: StageAction,
  preferred: HTMLElement | null,
) {
  const replacement = Array.from(document.querySelectorAll<HTMLElement>('[data-stage-action]'))
    .find((element) => element.dataset.stageAction === `${applicationId}:${action}`)
  const target = preferred?.isConnected ? preferred : replacement
  target?.focus()
}

export default function CandidateWorkspace({ jobId }: { jobId: string }) {
  const { replace: routerReplace, push: routerPush } = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const serializedParams = searchParams.toString()
  const filters = useMemo(() => normalizedFilters(new URLSearchParams(serializedParams)), [serializedParams])
  const visibleColumns = useMemo(() => selectedColumns(new URLSearchParams(serializedParams)), [serializedParams])
  const apiQueryString = useMemo(
    () => apiQuery(new URLSearchParams(serializedParams)).toString(),
    [serializedParams],
  )
  const summaryQueryString = useMemo(
    () => summaryApiQuery(new URLSearchParams(serializedParams)).toString(),
    [serializedParams],
  )
  const freshnessQueryString = useMemo(
    () => summaryApiQuery(new URLSearchParams(serializedParams)).toString(),
    [serializedParams],
  )
  const selectionFilterKey = useMemo(
    () => JSON.stringify(selectionQuery(new URLSearchParams(serializedParams))),
    [serializedParams],
  )
  const navigationScope = useMemo(
    () => candidateNavigationScope(jobId, new URLSearchParams(serializedParams)),
    [jobId, serializedParams],
  )
  const currentCursor = searchParams.get('cursor')
  const panel = CLIENT_PANEL_VALUES.has(searchParams.get('panel') ?? '') ? searchParams.get('panel') : null
  const layout = searchParams.get('layout') === 'board' ? 'board' : 'table'
  const selectionIdParam = searchParams.get('selectionId')
  const bulkOperationIdParam = searchParams.get('bulkOperationId')

  const [data, setData] = useState<CandidateListResponse | null>(null)
  const [summary, setSummary] = useState<CandidateSummaryResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [summaryLoading, setSummaryLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [stageActionError, setStageActionError] = useState<string | null>(null)
  const [pageAnnouncement, setPageAnnouncement] = useState('')
  const [cursorResetNotice, setCursorResetNotice] = useState<string | null>(null)
  const [freshnessAvailable, setFreshnessAvailable] = useState(false)
  const [cursorHistory, setCursorHistory] = useState<Array<string | null>>([])
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [selection, setSelection] = useState<CandidateSelection>({ mode: 'explicit', ids: new Set() })
  const [selectionBusy, setSelectionBusy] = useState(false)
  const [selectionError, setSelectionError] = useState<string | null>(null)
  const [busyApplicationId, setBusyApplicationId] = useState<string | null>(null)
  const [pendingStageAction, setPendingStageAction] = useState<{ row: CandidateListRow; action: StageAction } | null>(null)
  const [stageReasonCode, setStageReasonCode] = useState<HireCandidateBulkReasonCode | ''>('')
  const selectionFilterKeyRef = useRef(selectionFilterKey)
  const stageDialogRef = useRef<HTMLElement | null>(null)
  const stageActionTriggerRef = useRef<HTMLElement | null>(null)
  const candidateResultsHeadingRef = useRef<HTMLHeadingElement | null>(null)
  const bulkActionsHeadingRef = useRef<HTMLHeadingElement | null>(null)
  const pendingBulkFocusRef = useRef(false)
  const pendingPageFocusRef = useRef<'next' | 'previous' | 'first' | 'reset' | null>(null)
  const pendingRowActionRef = useRef<{ applicationId: string; name: string } | null>(null)
  const candidateNavigationRef = useRef<CandidateNavigationRecord | null>(null)
  const currentParamsRef = useRef(serializedParams)
  currentParamsRef.current = serializedParams

  const replaceParams = useCallback((updates: Record<string, string | null>, resetCursor = true) => {
    const next = new URLSearchParams(serializedParams)
    for (const [key, value] of Object.entries(updates)) {
      if (value) next.set(key, value)
      else next.delete(key)
    }
    if (resetCursor) {
      next.delete('cursor')
      next.delete('snapshotAt')
      next.delete('cursorTrail')
      candidateNavigationRef.current = null
      setCursorHistory([])
      removeCandidateNavigation(jobId, navigationScope)
    }
    routerReplace(`${pathname}${next.size > 0 ? `?${next}` : ''}`, { scroll: false })
  }, [jobId, navigationScope, pathname, routerReplace, serializedParams])

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch(
        `/api/workspace/jobs/${encodeURIComponent(jobId)}/candidates?${apiQueryString}`,
        { cache: 'no-store', signal },
      )
      const raw = await response.json().catch(() => null)
      if (!response.ok) {
        const cursorErrorCode = responseCode(raw)
        if (
          (cursorErrorCode === 'JOB_CANDIDATES_INVALID_CURSOR' || cursorErrorCode === 'JOB_CANDIDATES_CURSOR_STALE') &&
          new URLSearchParams(apiQueryString).has('cursor')
        ) {
          const cursorWasStale = cursorErrorCode === 'JOB_CANDIDATES_CURSOR_STALE'
          pendingPageFocusRef.current = 'reset'
          const pendingRowAction = pendingRowActionRef.current
          if (cursorWasStale) pendingRowActionRef.current = null
          setPageAnnouncement(cursorWasStale
            ? 'Candidate results changed while you were reviewing this page. Returning to the first page with the same filters and sort.'
            : 'The saved candidate page expired. Returning to the first page.')
          setCursorResetNotice(cursorWasStale
            ? `${pendingRowAction ? `${pendingRowAction.name} was updated. ` : ''}Candidate results changed while you were paging. Returned to the first page and kept your filters, view, and sort.`
            : null)
          const next = new URLSearchParams(currentParamsRef.current)
          next.delete('cursor')
          next.delete('snapshotAt')
          next.delete('cursorTrail')
          candidateNavigationRef.current = null
          setCursorHistory([])
          removeCandidateNavigation(jobId, navigationScope)
          routerReplace(`${pathname}${next.size > 0 ? `?${next}` : ''}`, { scroll: false })
          return
        }
        if (!signal?.aborted) setError(responseError(raw, 'Could not load candidates.'))
        return
      }
      const parsed = readCandidateList(raw)
      if (!parsed) {
        if (!signal?.aborted) setError('The candidate list response was incomplete. Refresh and try again.')
        return
      }
      if (!signal?.aborted) {
        setData(parsed)
        const pendingPageFocus = pendingPageFocusRef.current
        if (pendingPageFocus) {
          pendingPageFocusRef.current = null
          const pageName = pendingPageFocus === 'reset' || pendingPageFocus === 'first'
            ? 'first page'
            : `${pendingPageFocus} page`
          setPageAnnouncement(`Loaded ${parsed.rows.length.toLocaleString()} candidate${parsed.rows.length === 1 ? '' : 's'} on the ${pageName}. Showing 1–${parsed.rows.length.toLocaleString()} on this page.`)
          window.requestAnimationFrame(() => candidateResultsHeadingRef.current?.focus())
        }
        const pendingRowAction = pendingRowActionRef.current
        if (pendingRowAction) {
          pendingRowActionRef.current = null
          if (!parsed.rows.some((row) => row.applicationId === pendingRowAction.applicationId)) {
            setPageAnnouncement(`${pendingRowAction.name} left the current filtered view after the recruiter decision was updated.`)
            window.requestAnimationFrame(() => candidateResultsHeadingRef.current?.focus())
          }
        }
      }
    } catch {
      if (!signal?.aborted) setError('Could not load candidates. Check your connection and try again.')
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [apiQueryString, jobId, navigationScope, pathname, routerReplace])

  const loadSummary = useCallback(async (signal?: AbortSignal) => {
    setSummaryLoading(true)
    setSummary(null)
    setSummaryError(null)
    try {
      const suffix = summaryQueryString ? `?${summaryQueryString}` : ''
      const response = await fetch(
        `/api/workspace/jobs/${encodeURIComponent(jobId)}/candidates/summary${suffix}`,
        { cache: 'no-store', signal },
      )
      const raw = await response.json().catch(() => null)
      if (!response.ok) {
        if (!signal?.aborted) {
          setSummary(null)
          setSummaryError(responseError(raw, 'Aggregate candidate counts are temporarily unavailable.'))
        }
        return
      }
      const parsed = readCandidateSummary(raw)
      if (!parsed) {
        if (!signal?.aborted) {
          setSummary(null)
          setSummaryError('Aggregate candidate counts are temporarily unavailable.')
        }
        return
      }
      if (!signal?.aborted) setSummary(parsed)
    } catch {
      if (!signal?.aborted) {
        setSummary(null)
        setSummaryError('Aggregate candidate counts are temporarily unavailable.')
      }
    } finally {
      if (!signal?.aborted) setSummaryLoading(false)
    }
  }, [jobId, summaryQueryString])

  useEffect(() => {
    const requestedParams = new URLSearchParams(serializedParams)
    const requestedSort = requestedParams.get('sort')
    if (requestedSort !== 'newest' && requestedSort !== 'oldest') return
    const canonicalDirection = requestedSort === 'newest' ? 'desc' : 'asc'
    if (requestedParams.get('direction') !== canonicalDirection) {
      replaceParams({ direction: canonicalDirection })
    }
  }, [replaceParams, serializedParams])

  useEffect(() => {
    const now = Date.now()
    const inMemory = candidateNavigationRef.current
    const restored = inMemory &&
      inMemory.jobId === jobId &&
      inMemory.scope === navigationScope &&
      inMemory.cursor === currentCursor &&
      inMemory.expiresAt > now
      ? inMemory
      : readCandidateNavigationRecords().find(
        (record) => record.jobId === jobId &&
          record.scope === navigationScope &&
          record.cursor === currentCursor &&
          record.expiresAt > now,
      ) ?? null
    candidateNavigationRef.current = restored
    setCursorHistory(restored?.previous ?? [])
  }, [currentCursor, jobId, navigationScope])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load, refreshNonce])

  useEffect(() => {
    const controller = new AbortController()
    void loadSummary(controller.signal)
    return () => controller.abort()
  }, [loadSummary, refreshNonce])

  useEffect(() => {
    const snapshotAt = data?.pageInfo.snapshotAt
    if (!snapshotAt) {
      setFreshnessAvailable(false)
      return
    }
    const controller = new AbortController()
    const checkFreshness = async () => {
      try {
        const query = new URLSearchParams(freshnessQueryString)
        query.set('snapshotAt', snapshotAt)
        const response = await fetch(
          `/api/workspace/jobs/${encodeURIComponent(jobId)}/candidates/freshness?${query}`,
          { cache: 'no-store', signal: controller.signal },
        )
        const raw = await response.json().catch(() => null)
        const parsed = response.ok ? readFreshness(raw) : null
        if (parsed !== null && !controller.signal.aborted) setFreshnessAvailable(parsed)
      } catch {
        // Freshness is advisory. Candidate rows remain stable and usable.
      }
    }
    void checkFreshness()
    const interval = window.setInterval(() => void checkFreshness(), 30_000)
    return () => {
      controller.abort()
      window.clearInterval(interval)
    }
  }, [data?.pageInfo.snapshotAt, freshnessQueryString, jobId])

  useEffect(() => {
    if (selection.mode !== 'snapshot' || !pendingBulkFocusRef.current) return
    pendingBulkFocusRef.current = false
    window.requestAnimationFrame(() => bulkActionsHeadingRef.current?.focus())
  }, [selection])

  useEffect(() => {
    if (selectionFilterKeyRef.current === selectionFilterKey) return
    selectionFilterKeyRef.current = selectionFilterKey
    setSelection({ mode: 'explicit', ids: new Set() })
    setSelectionError(null)
    const next = new URLSearchParams(serializedParams)
    if (next.has('selectionId')) {
      next.delete('selectionId')
      routerReplace(`${pathname}${next.size > 0 ? `?${next}` : ''}`, { scroll: false })
    }
  }, [pathname, routerReplace, selectionFilterKey, serializedParams])

  useEffect(() => {
    if (!selectionIdParam || (selection.mode === 'snapshot' && selection.selectionId === selectionIdParam)) return
    const controller = new AbortController()
    fetch(
      `/api/workspace/jobs/${encodeURIComponent(jobId)}/candidate-selections/${encodeURIComponent(selectionIdParam)}`,
      { cache: 'no-store', signal: controller.signal },
    ).then(async (response) => ({ response, raw: await response.json().catch(() => null) }))
      .then(({ response, raw }) => {
        if (!response.ok || controller.signal.aborted) return
        const snapshot = readSnapshot(raw)
        if (snapshot) setSelection({ mode: 'snapshot', ...snapshot })
      }).catch(() => {})
    return () => controller.abort()
  }, [jobId, selection, selectionIdParam])

  useEffect(() => {
    const pending = pendingStageAction
    if (!pending) return
    const pendingApplicationId = pending.row.applicationId
    const pendingAction = pending.action
    const dialog = stageDialogRef.current
    const trigger = stageActionTriggerRef.current
    const focusable = () => Array.from(
      dialog?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), a[href]',
      ) ?? [],
    )
    window.requestAnimationFrame(() => dialog?.querySelector<HTMLElement>('select')?.focus())
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        if (busyApplicationId !== null) return
        event.preventDefault()
        setPendingStageAction(null)
        setStageReasonCode('')
        stageActionTriggerRef.current = null
        window.requestAnimationFrame(() => restoreStageActionFocus(
          pendingApplicationId,
          pendingAction,
          trigger,
        ))
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
  }, [busyApplicationId, pendingStageAction])

  function changeFilters(patch: Partial<CandidateFilterState>) {
    setCursorResetNotice(null)
    const updates: Record<string, string | null> = {}
    for (const [key, value] of Object.entries(patch)) updates[key] = value || null
    if (patch.sort && patch.direction === undefined) {
      updates.direction = ASCENDING_SORTS.has(patch.sort) ? 'asc' : 'desc'
    }
    updates.selectionId = null
    replaceParams(updates)
    setSelection({ mode: 'explicit', ids: new Set() })
  }

  function clearAdvancedFilters() {
    replaceParams({
      stage: null,
      source: null,
      appliedFrom: null,
      appliedTo: null,
      scoreState: null,
      scoreMin: null,
      scoreMax: null,
      humanReview: null,
      aiInterview: null,
      history: null,
      selectionId: null,
    })
    setSelection({ mode: 'explicit', ids: new Set() })
  }

  function toggleColumn(column: CandidateColumn, checked: boolean) {
    const next = new Set(visibleColumns)
    if (checked) next.add(column)
    else next.delete(column)
    const encoded = OPTIONAL_COLUMNS.map((item) => item.id).filter((id) => next.has(id)).join(',')
    replaceParams({ columns: encoded || 'none' }, false)
  }

  function selectOne(applicationId: string, selected: boolean) {
    const ids = new Set(selection.mode === 'explicit' ? selection.ids : [])
    if (selected && ids.size >= 100 && !ids.has(applicationId)) {
      setSelectionError('Explicit selection is limited to 100 candidates. Use Select all matching for a larger server snapshot.')
      return
    }
    if (selected) ids.add(applicationId)
    else ids.delete(applicationId)
    setSelection({ mode: 'explicit', ids })
    setSelectionError(null)
  }

  function selectPage(selected: boolean) {
    if (!data) return
    const ids = new Set(selection.mode === 'explicit' ? selection.ids : [])
    for (const row of data.rows) {
      if (selected && ids.size < 100) ids.add(row.applicationId)
      else if (!selected) ids.delete(row.applicationId)
    }
    const limitReached = selected && data.rows.some((row) => !ids.has(row.applicationId))
    setSelection({ mode: 'explicit', ids })
    setSelectionError(limitReached
      ? 'Explicit selection is limited to 100 candidates. Use Select all matching for a larger server snapshot.'
      : null)
  }

  async function createSnapshot(mode: 'explicit' | 'all_matching'): Promise<CandidateSelectionSnapshot | null> {
    if (!data || selectionBusy) return null
    const ids = selection.mode === 'explicit' ? Array.from(selection.ids) : []
    setSelectionBusy(true)
    setSelectionError(null)
    try {
      const response = await fetch(
        `/api/workspace/jobs/${encodeURIComponent(jobId)}/candidate-selections`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            mode === 'explicit'
              ? { mode, applicationIds: ids }
              : { mode, query: selectionQuery(new URLSearchParams(serializedParams)) },
          ),
        },
      )
      const raw = await response.json().catch(() => null)
      if (!response.ok) {
        setSelectionError(responseError(raw, 'Could not create a stable candidate selection.'))
        return null
      }
      const snapshot = readSnapshot(raw)
      if (!snapshot) {
        setSelectionError('The selection response was incomplete. Nothing has been changed.')
        return null
      }
      pendingBulkFocusRef.current = true
      setSelection({ mode: 'snapshot', ...snapshot })
      replaceParams({ selectionId: snapshot.selectionId }, false)
      return snapshot
    } catch {
      setSelectionError('Could not create a stable candidate selection. Check your connection.')
      return null
    } finally {
      setSelectionBusy(false)
    }
  }

  async function sendSelectionToScreening() {
    let snapshot: CandidateSelectionSnapshot | null = selection.mode === 'snapshot' ? selection : null
    if (!snapshot) snapshot = await createSnapshot('explicit')
    if (!snapshot) return
    routerPush(`/workspace/jobs/${encodeURIComponent(jobId)}/screening?selectionSnapshotId=${encodeURIComponent(snapshot.selectionId)}`)
  }

  function compareSelected() {
    if (selection.mode !== 'explicit' || selection.ids.size < 2 || selection.ids.size > 3) return
    const params = new URLSearchParams()
    for (const id of Array.from(selection.ids)) params.append('applicationId', id)
    routerPush(`/workspace/jobs/${encodeURIComponent(jobId)}/decision?${params}`)
  }

  function requestStageAction(row: CandidateListRow, action: StageAction, trigger?: HTMLElement) {
    if (action === 'advance') {
      void applyStageAction(row, action)
      return
    }
    setStageReasonCode('')
    stageActionTriggerRef.current = trigger ?? null
    setPendingStageAction({ row, action })
  }

  function closeStageDialog() {
    const trigger = stageActionTriggerRef.current
    const pending = pendingStageAction
    setPendingStageAction(null)
    setStageReasonCode('')
    stageActionTriggerRef.current = null
    if (pending) {
      window.requestAnimationFrame(() => restoreStageActionFocus(
        pending.row.applicationId,
        pending.action,
        trigger,
      ))
    }
  }

  async function applyStageAction(row: CandidateListRow, action: StageAction, reasonCode?: HireCandidateBulkReasonCode) {
    setBusyApplicationId(row.applicationId)
    setNotice(null)
    setStageActionError(null)
    try {
      const response = await fetch(`/api/workspace/applications/${encodeURIComponent(row.applicationId)}/stage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          expectedFrom: row.stage,
          operationId: operationId(),
          ...(reasonCode ? { reasonCode } : {}),
        }),
      })
      const raw = await response.json().catch(() => null)
      if (!response.ok) {
        setStageActionError(responseError(raw, `Could not ${action.replace('_', ' ')} ${row.name}.`))
        return
      }
      closeStageDialog()
      setStageActionError(null)
      setNotice(`${row.name} was updated.`)
      pendingRowActionRef.current = { applicationId: row.applicationId, name: row.name }
      setRefreshNonce((current) => current + 1)
    } catch {
      setStageActionError('Network error. Refresh before trying the stage action again.')
    } finally {
      setBusyApplicationId(null)
    }
  }

  function goToCursor(cursor: string | null) {
    if (!cursor) return
    setCursorResetNotice(null)
    pendingPageFocusRef.current = 'next'
    setPageAnnouncement('Loading the next candidate page…')
    const next = new URLSearchParams(serializedParams)
    next.set('cursor', cursor)
    next.delete('snapshotAt')
    next.delete('cursorTrail')
    const previous = [...cursorHistory, currentCursor].slice(-CANDIDATE_NAVIGATION_MAX_DEPTH)
    const record: CandidateNavigationRecord = {
      version: CANDIDATE_NAVIGATION_VERSION,
      jobId,
      scope: navigationScope,
      cursor,
      previous,
      updatedAt: Date.now(),
      expiresAt: Date.now() + CANDIDATE_NAVIGATION_TTL_MS,
    }
    candidateNavigationRef.current = record
    setCursorHistory(previous)
    saveCandidateNavigation(record)
    routerPush(`${pathname}?${next}`, { scroll: true })
  }

  function goToPreviousCursor() {
    setCursorResetNotice(null)
    if (cursorHistory.length > 0) {
      const previousCursor = cursorHistory[cursorHistory.length - 1] ?? null
      const previous = cursorHistory.slice(0, -1)
      const pageName = previousCursor === null ? 'first' : 'previous'
      pendingPageFocusRef.current = pageName
      setPageAnnouncement(`Loading the ${pageName} candidate page…`)
      const next = new URLSearchParams(serializedParams)
      if (previousCursor) next.set('cursor', previousCursor)
      else next.delete('cursor')
      next.delete('snapshotAt')
      next.delete('cursorTrail')
      const record: CandidateNavigationRecord = {
        version: CANDIDATE_NAVIGATION_VERSION,
        jobId,
        scope: navigationScope,
        cursor: previousCursor,
        previous,
        updatedAt: Date.now(),
        expiresAt: Date.now() + CANDIDATE_NAVIGATION_TTL_MS,
      }
      candidateNavigationRef.current = record
      setCursorHistory(previous)
      saveCandidateNavigation(record)
      routerPush(`${pathname}${next.size > 0 ? `?${next}` : ''}`, { scroll: true })
      return
    }
    const next = new URLSearchParams(serializedParams)
    pendingPageFocusRef.current = 'first'
    setPageAnnouncement('Loading the first candidate page…')
    next.delete('cursor')
    next.delete('snapshotAt')
    next.delete('cursorTrail')
    candidateNavigationRef.current = null
    setCursorHistory([])
    removeCandidateNavigation(jobId, navigationScope)
    routerPush(`${pathname}${next.size > 0 ? `?${next}` : ''}`, { scroll: true })
  }

  function refreshResults() {
    setCursorResetNotice(null)
    const next = new URLSearchParams(serializedParams)
    next.delete('cursor')
    next.delete('snapshotAt')
    next.delete('cursorTrail')
    candidateNavigationRef.current = null
    setCursorHistory([])
    removeCandidateNavigation(jobId, navigationScope)
    routerReplace(`${pathname}${next.size > 0 ? `?${next}` : ''}`, { scroll: false })
    setFreshnessAvailable(false)
    setRefreshNonce((current) => current + 1)
  }

  function finishBulkOperation() {
    if (selection.mode === 'snapshot') {
      void fetch(
        `/api/workspace/jobs/${encodeURIComponent(jobId)}/candidate-selections/${encodeURIComponent(selection.selectionId)}`,
        { method: 'DELETE' },
      )
    }
    setSelection({ mode: 'explicit', ids: new Set() })
    setSelectionError(null)
    const next = new URLSearchParams(serializedParams)
    next.delete('selectionId')
    next.delete('bulkOperationId')
    next.delete('cursor')
    next.delete('cursorTrail')
    next.delete('snapshotAt')
    candidateNavigationRef.current = null
    setCursorHistory([])
    removeCandidateNavigation(jobId, navigationScope)
    routerReplace(`${pathname}${next.size > 0 ? `?${next}` : ''}`, { scroll: false })
    setRefreshNonce((current) => current + 1)
    window.requestAnimationFrame(() => candidateResultsHeadingRef.current?.focus())
  }

  function clearSelection() {
    if (selection.mode === 'snapshot') {
      void fetch(
        `/api/workspace/jobs/${encodeURIComponent(jobId)}/candidate-selections/${encodeURIComponent(selection.selectionId)}`,
        { method: 'DELETE' },
      )
    }
    setSelection({ mode: 'explicit', ids: new Set() })
    setSelectionError(null)
    replaceParams({ selectionId: null }, false)
    window.requestAnimationFrame(() => candidateResultsHeadingRef.current?.focus())
  }

  function sortResults(sort: CandidateSort) {
    if (sort === 'newest' || sort === 'oldest') {
      changeFilters({ sort: sort === filters.sort ? (sort === 'newest' ? 'oldest' : 'newest') : sort })
      return
    }
    if (sort === filters.sort) {
      changeFilters({ direction: filters.direction === 'asc' ? 'desc' : 'asc' })
      return
    }
    changeFilters({ sort })
  }

  const selectedIds = selection.mode === 'explicit' ? selection.ids : new Set<string>()
  const explicitCount = selection.mode === 'explicit' ? selection.ids.size : 0
  const selectedCount = selection.mode === 'snapshot' ? selection.count : explicitCount
  const returnTo = `${pathname}${serializedParams ? `?${serializedParams}` : ''}`
  const pageSelected = Boolean(data?.rows.length) && data!.rows.every((row) => selectedIds.has(row.applicationId))

  return (
    <div className="space-y-6">
      <JobSubnav jobId={jobId} active="candidates" />
      {data ? (
        <JobWorkspaceHeader
          title={data.job.title}
          status={data.job.status}
          candidateCount={summary?.counts.total}
          actions={data.job.status === 'open' ? (
            <>
              <Button type="button" onClick={() => replaceParams({ panel: panel === 'add' ? null : 'add' }, false)}>Add candidate</Button>
              <Button type="button" variant="secondary" onClick={() => replaceParams({ panel: panel === 'import' ? null : 'import' }, false)}>Import résumés</Button>
              <Button type="button" variant="secondary" onClick={() => replaceParams({ panel: panel === 'suggestions' ? null : 'suggestions' }, false)}>Suggestions</Button>
            </>
          ) : null}
        />
      ) : (
        <header>
          <Link href="/workspace/jobs" className="text-xs font-medium text-[#71767b] hover:text-[#2563eb]">← All jobs</Link>
          <h1 className="mt-1 text-xl font-bold text-[#0f1419]">Candidates</h1>
          <p className="mt-1 text-sm text-[#536471]">{loading ? 'Loading job details…' : 'Job details are unavailable.'}</p>
        </header>
      )}

      {panel === 'add' && data?.job.status === 'open' ? (
        <CandidateIntakePanel jobId={jobId} onClose={() => replaceParams({ panel: null }, false)} onAdded={() => { setNotice('Candidate added. Refreshing this list.'); refreshResults() }} />
      ) : null}
      {panel === 'import' && data?.job.status === 'open' ? (
        <div>
          <div className="mb-2 flex justify-end"><Button type="button" variant="ghost" size="sm" onClick={() => replaceParams({ panel: null }, false)}>Close import</Button></div>
          <BulkUploadPanel jobId={jobId} onSettled={refreshResults} />
        </div>
      ) : null}
      {panel === 'suggestions' && data ? <PoolSuggestionPanel jobId={jobId} jobStatus={data.job.status} /> : null}

      <CandidateFilters value={filters} viewCounts={summary?.counts.savedViews ?? null} disabled={loading} onChange={changeFilters} onClear={clearAdvancedFilters} />

      {summaryError ? (
        <p role="status" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {summaryError} The candidates on this page remain available.
        </p>
      ) : null}

      {cursorResetNotice ? (
        <p role="status" className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
          {cursorResetNotice}
        </p>
      ) : null}

      {data?.pageInfo.refreshAvailable || freshnessAvailable ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900" role="status">
          <span>New applications are available. Your current review page has not been reordered.</span>
          <Button type="button" variant="secondary" size="sm" onClick={refreshResults}>Refresh list</Button>
        </div>
      ) : null}
      {notice ? <p role="status" className="rounded-xl bg-[#f0fdf4] px-4 py-3 text-sm text-[#166534]">{notice}</p> : null}
      {stageActionError && !pendingStageAction ? <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{stageActionError}</p> : null}
      {selectionError ? <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{selectionError}</p> : null}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {selectedCount > 0
          ? `${selectedCount.toLocaleString()} candidate${selectedCount === 1 ? '' : 's'} selected in ${selection.mode === 'snapshot' ? 'a stable server snapshot' : 'an explicit selection'}.`
          : 'No candidates selected.'}
      </p>
      <p className="sr-only" aria-live="polite" aria-atomic="true">{pageAnnouncement}</p>

      {selectedCount > 0 ? (
        <section aria-label="Selected candidate actions" className="sticky top-2 z-20 rounded-2xl border border-indigo-200 bg-indigo-50 p-4 shadow-sm">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
            <p className="font-semibold text-indigo-950">{selectedCount.toLocaleString()} candidate{selectedCount === 1 ? '' : 's'} selected</p>
            <p className="text-xs text-indigo-800">
              {selection.mode === 'snapshot'
                ? `${selection.description} · stable until ${new Date(selection.expiresAt).toLocaleTimeString()}`
                : `${pageSelected ? 'This page is selected' : 'Explicit selection across pages'} · ${filterDescription(filters)}. A stable server snapshot is created before a bulk handoff.`}
            </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {selection.mode === 'explicit' && explicitCount >= 2 && explicitCount <= 3 ? <Button type="button" variant="secondary" size="sm" onClick={compareSelected}>Compare selected</Button> : null}
              {data?.job.status === 'open' && selection.mode === 'explicit' ? <Button type="button" variant="secondary" size="sm" disabled={selectionBusy} onClick={() => void createSnapshot('explicit')}>{selectionBusy ? 'Preparing…' : 'Prepare bulk actions'}</Button> : null}
              {data?.job.status === 'open' ? <Button type="button" size="sm" disabled={selectionBusy} onClick={() => void sendSelectionToScreening()}>{selectionBusy ? 'Preparing…' : 'Send to screening'}</Button> : null}
              <Button type="button" variant="ghost" size="sm" onClick={clearSelection}>Clear selection</Button>
            </div>
          </div>
          {data?.job.status !== 'open' ? <p className="mt-3 text-sm text-indigo-900">This job is {data?.job.status === 'on_hold' ? 'on hold' : 'closed'} and is read-only. Reopen it to prepare bulk actions or send candidates to screening.</p> : null}
        </section>
      ) : null}

      {selection.mode === 'snapshot' ? (
        <section aria-labelledby="stable-selection-bulk-actions" className="rounded-2xl border border-indigo-200 bg-indigo-50 p-4">
          <h3 ref={bulkActionsHeadingRef} id="stable-selection-bulk-actions" tabIndex={-1} className="font-semibold text-indigo-950">Bulk actions for stable selection</h3>
          <CandidateBulkActionPanel
            jobId={jobId}
            selection={selection}
            expectedStage={selection.homogeneousStage}
            initialOperationId={bulkOperationIdParam}
            canStartActions={data?.job.status === 'open'}
            returnTo={returnTo}
            onOperationAccepted={(bulkOperationId) => replaceParams({ bulkOperationId }, false)}
            onFinish={finishBulkOperation}
            onSettled={refreshResults}
          />
        </section>
      ) : null}

      {bulkOperationIdParam && selection.mode !== 'snapshot' ? (
        <section aria-labelledby="bulk-operation-status-title" className="rounded-2xl border border-indigo-200 bg-indigo-50 p-4">
          <h2 id="bulk-operation-status-title" className="font-semibold text-indigo-950">Bulk operation status</h2>
          <p className="mt-1 text-xs text-indigo-800">This durable operation remains inspectable even when its original selection snapshot has expired or been cleared.</p>
          <CandidateBulkActionPanel
            jobId={jobId}
            selection={null}
            expectedStage={null}
            initialOperationId={bulkOperationIdParam}
            canStartActions={false}
            returnTo={returnTo}
            onFinish={finishBulkOperation}
            onSettled={refreshResults}
          />
        </section>
      ) : null}

      {error ? <StateView state="error" error={error} onRetry={() => void load()} /> : null}
      {loading && !data ? <StateView state="loading" skeletonLayout="list" skeletonCount={8} /> : null}
      {data && !error ? (
        <section aria-labelledby="candidate-results-title" aria-busy={loading} className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 ref={candidateResultsHeadingRef} id="candidate-results-title" tabIndex={-1} className="text-base font-semibold text-[#0f1419]">
                {summary
                  ? `${summary.counts.matching.toLocaleString()} matching candidate${summary.counts.matching === 1 ? '' : 's'}`
                  : `${data.rows.length.toLocaleString()} candidate${data.rows.length === 1 ? '' : 's'} on this page`}
              </h2>
              <p className="text-xs text-[#536471]">
                {summary
                  ? `${data.rows.length.toLocaleString()} on this page · ${summary.rankContext.freshScoredTotal.toLocaleString()} freshly scored · ${summary.rankContext.stale.toLocaleString()} stale · ${summary.rankContext.pending.toLocaleString()} pending · ${summary.rankContext.unscored.toLocaleString()} unscored`
                  : summaryLoading
                    ? `${data.rows.length.toLocaleString()} on this page · loading aggregate counts…`
                    : `${data.rows.length.toLocaleString()} on this page · aggregate counts unavailable`}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {selection.mode === 'explicit' && data.rows.length > 0 ? (
                <Button type="button" variant="secondary" size="sm" onClick={() => selectPage(!pageSelected)}>
                  {pageSelected ? 'Clear this page' : 'Select this page'}
                </Button>
              ) : null}
              {data.job.status === 'open' && selection.mode === 'explicit' && summary && summary.counts.matching > data.rows.length && data.rows.length > 0 ? (
                <Button type="button" variant="secondary" size="sm" disabled={selectionBusy} onClick={() => void createSnapshot('all_matching')}>
                  Select all {summary.counts.matching.toLocaleString()} matching
                </Button>
              ) : null}
              <div role="group" aria-label="Candidate presentation" className="flex rounded-lg border border-[#dbe4ea] bg-white p-0.5">
                <button type="button" aria-pressed={layout === 'table'} onClick={() => replaceParams({ layout: null }, false)} className={`rounded-md px-3 py-1.5 text-sm ${layout === 'table' ? 'bg-[#eff3f4] font-medium text-[#0f1419]' : 'text-[#536471]'}`}>Table</button>
                <button type="button" aria-pressed={layout === 'board'} onClick={() => replaceParams({ layout: 'board' }, false)} className={`rounded-md px-3 py-1.5 text-sm ${layout === 'board' ? 'bg-[#eff3f4] font-medium text-[#0f1419]' : 'text-[#536471]'}`}>Board</button>
              </div>
              <details className="relative">
                <summary className="flex h-9 cursor-pointer list-none items-center rounded-lg border border-[#dbe4ea] bg-white px-3 text-sm font-medium text-[#0f1419] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">Columns</summary>
                <fieldset className="absolute right-0 z-30 mt-2 w-56 space-y-2 rounded-xl border border-[#dbe4ea] bg-white p-4 shadow-xl">
                  <legend className="mb-2 text-sm font-semibold text-[#0f1419]">Visible columns</legend>
                  <p className="text-xs text-[#71767b]">Candidate, recruiter decision, and actions always remain visible.</p>
                  {OPTIONAL_COLUMNS.map((column) => (
                    <label key={column.id} className="flex items-center gap-2 text-sm text-[#0f1419]">
                      <input type="checkbox" checked={visibleColumns.has(column.id)} onChange={(event) => toggleColumn(column.id, event.target.checked)} />
                      {column.label}
                    </label>
                  ))}
                </fieldset>
              </details>
              <Button type="button" variant="ghost" size="sm" onClick={refreshResults}>Refresh</Button>
            </div>
          </div>

          {data.rows.length === 0 ? (
            <div className="rounded-2xl border border-[#dbe4ea] bg-white"><StateView state="empty" title="No candidates match this view" description="Change or clear the filters to widen the result set." /></div>
          ) : layout === 'board' ? (
            <CandidateBoard rows={data.rows} stageCounts={summary?.counts.stages ?? null} selectedIds={selectedIds} visibleColumns={visibleColumns} currentSort={filters.sort} currentDirection={filters.direction} returnTo={returnTo} jobOpen={data.job.status === 'open'} busyApplicationId={busyApplicationId} onSelect={selectOne} onSelectPage={selectPage} onSort={sortResults} onStageAction={requestStageAction} />
          ) : (
            <CandidateTable rows={data.rows} stageCounts={summary?.counts.stages ?? null} selectedIds={selectedIds} visibleColumns={visibleColumns} currentSort={filters.sort} currentDirection={filters.direction} returnTo={returnTo} jobOpen={data.job.status === 'open'} busyApplicationId={busyApplicationId} onSelect={selectOne} onSelectPage={selectPage} onSort={sortResults} onStageAction={requestStageAction} />
          )}

          <nav aria-label="Candidate result pages" className="grid grid-cols-1 gap-3 border-t border-[#dbe4ea] pt-4 sm:grid-cols-[auto_1fr_auto] sm:items-center">
            <Button type="button" variant="secondary" disabled={!searchParams.get('cursor') || loading} onClick={goToPreviousCursor}>
              {cursorHistory.length > 0 ? 'Previous page' : 'First page'}
            </Button>
            <span className="text-center text-xs text-[#536471]">Up to {data.pageInfo.limit} candidates per page</span>
            <Button type="button" variant="secondary" disabled={!data.pageInfo.hasNextPage || !data.pageInfo.nextCursor || loading} onClick={() => goToCursor(data.pageInfo.nextCursor)}>Next page</Button>
          </nav>
        </section>
      ) : null}

      {pendingStageAction ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/35 p-4" role="presentation">
          <section ref={stageDialogRef} role="dialog" aria-modal="true" aria-labelledby="stage-action-title" aria-describedby="stage-action-description" className="w-full max-w-lg rounded-2xl border border-[#dbe4ea] bg-white p-6 shadow-xl">
            <h2 id="stage-action-title" className="break-words text-lg font-semibold text-[#0f1419]">
              {pendingStageAction.action === 'reject'
                ? `Reject ${pendingStageAction.row.name}?`
                : pendingStageAction.action === 'offer_declined'
                  ? `Record offer declined for ${pendingStageAction.row.name}?`
                  : `Mark ${pendingStageAction.row.name} as withdrawn?`}
            </h2>
            <p id="stage-action-description" className="mt-2 text-sm text-[#536471]">This changes one candidate’s recruiter decision. Choose a neutral structured reason; this workflow stores no unrestricted candidate notes.</p>
            <label htmlFor="candidate-stage-reason" className="mt-4 block text-sm font-medium text-[#0f1419]">Structured reason</label>
            <select
              id="candidate-stage-reason"
              value={stageReasonCode}
              onChange={(event) => setStageReasonCode(event.target.value as HireCandidateBulkReasonCode | '')}
              className="mt-1 h-10 w-full rounded-xl border border-[#dbe4ea] bg-[#f8fafc] px-3 text-sm focus:border-[#2563eb] focus:outline-none"
            >
              <option value="">Choose a reason</option>
              {reasonOptionsForStageAction(pendingStageAction.action).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            {stageActionError ? <p role="alert" className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{stageActionError}</p> : null}
            <div className="mt-4 flex justify-end gap-2">
              <Button type="button" variant="secondary" disabled={busyApplicationId !== null} onClick={closeStageDialog}>Cancel</Button>
              <Button type="button" variant={pendingStageAction.action === 'reject' ? 'danger' : 'primary'} disabled={!stageReasonCode || busyApplicationId !== null} onClick={() => void applyStageAction(pendingStageAction.row, pendingStageAction.action, stageReasonCode || undefined)}>{busyApplicationId !== null ? 'Confirming…' : 'Confirm'}</Button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  )
}
