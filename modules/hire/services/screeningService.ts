/**
 * Phase-2 screening policy is deliberately pure. Route/worker code supplies
 * workspace-scoped application DTOs, renders this preview, and only then
 * persists a confirmation. Keeping ranking here side-effect free prevents an
 * AI score, an unknown profile field, or a preview refresh from moving a
 * human pipeline stage.
 */

export const SCREENING_SELECTION_MODES = ['top_n', 'above_threshold'] as const
export type ScreeningSelectionMode = (typeof SCREENING_SELECTION_MODES)[number]

export const SCREENING_SCORE_STATES = ['scored', 'stale', 'unscored'] as const
export type ScreeningScoreState = (typeof SCREENING_SCORE_STATES)[number]

export const SCREENING_KNOCKOUT_REASONS = ['location', 'experience'] as const
export type ScreeningKnockoutReason = (typeof SCREENING_KNOCKOUT_REASONS)[number]

export const SCREENING_SELECTION_REASONS = [
  'top_n',
  'above_threshold',
  'below_cut_line',
  'below_threshold',
  'stale_or_unscored',
  'knockout',
  'manual_include',
  'manual_exclude',
] as const
export type ScreeningSelectionReason = (typeof SCREENING_SELECTION_REASONS)[number]

export const SCREENING_EXCEPTION_ACTIONS = ['include', 'exclude'] as const
export type ScreeningExceptionAction = (typeof SCREENING_EXCEPTION_ACTIONS)[number]

/** Strings, ObjectIds, and other values with stable `toString()` all work. */
export type ScreeningId = string | { toString(): string }

export interface ScreeningKnockoutSettings {
  /** Exact normalized location match. Empty/missing means no location rule. */
  location?: string
  /** A known lower experience value is a knockout; an unknown value is not. */
  experienceFloorYears?: number
}

export interface ScreeningGateRule {
  mode: ScreeningSelectionMode
  topN?: number
  scoreThreshold?: number
  knockoutSettings?: ScreeningKnockoutSettings
}

/** Plain profile DTO: it is intentionally not a candidate database model. */
export interface ScreeningCandidateInfo {
  location?: string | null
  experienceYears?: number | null
}

/** Plain match DTO supplied by the queue/pipeline adapter. */
export interface ScreeningRankingInput {
  score?: number | null
  stale?: boolean
}

/** One application to consider. All scope fields are mandatory by design. */
export interface ScreeningApplicationInput {
  workspaceId: ScreeningId
  jobId: ScreeningId
  applicationId: ScreeningId
  candidateId: ScreeningId
  createdAt: Date | string | number
  candidateInfo?: ScreeningCandidateInfo | null
  ranking?: ScreeningRankingInput | null
}

export interface ScreeningExceptionInput {
  applicationId: ScreeningId
  action: ScreeningExceptionAction
  actorMemberId: ScreeningId
  actorName: string
  note: string
  at?: Date | string | number
}

export interface ScreeningActor {
  memberId: ScreeningId
  name: string
}

export interface ScreeningCutLine {
  mode: ScreeningSelectionMode
  requestedTopN?: number
  scoreThreshold?: number
  applicationId?: string
  rank?: number
  score?: number | null
}

export interface ScreeningPreviewEntry {
  applicationId: string
  candidateId: string
  applicationCreatedAt: Date
  /** Eligible entries are ranked; known knockouts intentionally have no rank. */
  rank?: number
  score: number | null
  scoreState: ScreeningScoreState
  knockoutReasons: ScreeningKnockoutReason[]
  automaticallySelected: boolean
  selected: boolean
  selectionReason: ScreeningSelectionReason
}

export interface ScreeningException extends Omit<ScreeningExceptionInput, 'applicationId' | 'actorMemberId' | 'at'> {
  applicationId: string
  actorMemberId: string
  at: Date
}

export interface ScreeningGatePreview {
  workspaceId: string
  jobId: string
  rule: Required<Pick<ScreeningGateRule, 'mode'>> &
    Pick<ScreeningGateRule, 'topN' | 'scoreThreshold'> & {
      knockoutSettings: ScreeningKnockoutSettings
    }
  generatedAt: Date
  evaluatedCount: number
  eligibleCount: number
  automaticallySelectedCount: number
  selectedCount: number
  cutLine: ScreeningCutLine
  rankedApplications: ScreeningPreviewEntry[]
  exceptions: ScreeningException[]
  selectedApplicationIds: string[]
}

/** A normalized, persistence-ready DTO; no database work happens here. */
export interface ScreeningGateConfirmation {
  workspaceId: string
  jobId: string
  status: 'confirmed'
  selectionMode: ScreeningSelectionMode
  topN?: number
  scoreThreshold?: number
  knockoutSettings: ScreeningKnockoutSettings
  cutLine: ScreeningCutLine
  evaluatedCount: number
  eligibleCount: number
  automaticallySelectedCount: number
  selectedCount: number
  rankedApplications: ScreeningPreviewEntry[]
  exceptions: ScreeningException[]
  confirmedByMemberId: string
  confirmedByName: string
  confirmedAt: Date
}

/** The selected, non-PII fields a future batch writer needs. */
export interface InvitationBatchItemPlan {
  applicationId: string
  candidateId: string
  rank?: number
  score: number | null
  scoreState: ScreeningScoreState
  selectionReason: Extract<
    ScreeningSelectionReason,
    'top_n' | 'above_threshold' | 'manual_include'
  >
}

export class ScreeningPreviewError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ScreeningPreviewError'
    this.code = code
  }
}

export class ScreeningScopeError extends ScreeningPreviewError {
  constructor(message: string) {
    super('SCREENING_SCOPE_MISMATCH', message)
    this.name = 'ScreeningScopeError'
  }
}

interface NormalizedRule {
  mode: ScreeningSelectionMode
  topN?: number
  scoreThreshold?: number
  knockoutSettings: ScreeningKnockoutSettings
}

interface InternalEntry extends ScreeningPreviewEntry {
  createdAtMs: number
}

function stableId(value: ScreeningId, field: string): string {
  if (value === null || value === undefined) {
    throw new ScreeningPreviewError('SCREENING_INVALID_ID', `${field} is required`)
  }
  const id = String(value).trim()
  if (!id || id === '[object Object]') {
    throw new ScreeningPreviewError('SCREENING_INVALID_ID', `${field} must be a stable identifier`)
  }
  return id
}

function dateValue(value: Date | string | number | undefined, field: string): Date {
  if (value === undefined) {
    throw new ScreeningPreviewError('SCREENING_INVALID_DATE', `${field} is required`)
  }
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new ScreeningPreviewError('SCREENING_INVALID_DATE', `${field} must be a valid date`)
  }
  return date
}

function nonBlank(value: string, field: string, maxLength: number): string {
  const normalized = value.trim()
  if (!normalized) {
    throw new ScreeningPreviewError('SCREENING_INVALID_VALUE', `${field} is required`)
  }
  if (normalized.length > maxLength) {
    throw new ScreeningPreviewError('SCREENING_INVALID_VALUE', `${field} is too long`)
  }
  return normalized
}

function normalizeLocation(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().replace(/\s+/g, ' ').toLowerCase()
  return normalized || undefined
}

function normalizeKnockoutSettings(
  settings: ScreeningKnockoutSettings | undefined,
): ScreeningKnockoutSettings {
  const location = normalizeLocation(settings?.location)
  if (settings?.location !== undefined && !location) {
    throw new ScreeningPreviewError('SCREENING_INVALID_RULE', 'knockout location cannot be blank')
  }
  if (location && location.length > 160) {
    throw new ScreeningPreviewError('SCREENING_INVALID_RULE', 'knockout location is too long')
  }

  const floor = settings?.experienceFloorYears
  if (
    floor !== undefined &&
    (!Number.isFinite(floor) || floor < 0 || floor > 50)
  ) {
    throw new ScreeningPreviewError(
      'SCREENING_INVALID_RULE',
      'experienceFloorYears must be between 0 and 50',
    )
  }

  return {
    ...(location ? { location } : {}),
    ...(floor !== undefined ? { experienceFloorYears: floor } : {}),
  }
}

function normalizeRule(rule: ScreeningGateRule): NormalizedRule {
  if (rule.mode !== 'top_n' && rule.mode !== 'above_threshold') {
    throw new ScreeningPreviewError('SCREENING_INVALID_RULE', 'Unsupported selection mode')
  }
  const knockoutSettings = normalizeKnockoutSettings(rule.knockoutSettings)
  if (rule.mode === 'top_n') {
    if (!Number.isInteger(rule.topN) || (rule.topN ?? 0) < 1 || (rule.topN ?? 0) > 5000) {
      throw new ScreeningPreviewError('SCREENING_INVALID_RULE', 'topN must be an integer from 1 to 5000')
    }
    if (rule.scoreThreshold !== undefined) {
      throw new ScreeningPreviewError(
        'SCREENING_INVALID_RULE',
        'scoreThreshold is only valid for above_threshold',
      )
    }
    return { mode: rule.mode, topN: rule.topN, knockoutSettings }
  }

  if (
    typeof rule.scoreThreshold !== 'number' ||
    !Number.isFinite(rule.scoreThreshold) ||
    rule.scoreThreshold < 0 ||
    rule.scoreThreshold > 100
  ) {
    throw new ScreeningPreviewError(
      'SCREENING_INVALID_RULE',
      'scoreThreshold must be a number from 0 to 100',
    )
  }
  if (rule.topN !== undefined) {
    throw new ScreeningPreviewError('SCREENING_INVALID_RULE', 'topN is only valid for top_n')
  }
  return { mode: rule.mode, scoreThreshold: rule.scoreThreshold, knockoutSettings }
}

function normalizeScore(ranking: ScreeningRankingInput | null | undefined): {
  score: number | null
  scoreState: ScreeningScoreState
} {
  const candidateScore = ranking?.score
  const validScore =
    typeof candidateScore === 'number' &&
    Number.isFinite(candidateScore) &&
    candidateScore >= 0 &&
    candidateScore <= 100

  if (ranking?.stale === true) {
    return { score: validScore ? candidateScore : null, scoreState: 'stale' }
  }
  return validScore
    ? { score: candidateScore, scoreState: 'scored' }
    : { score: null, scoreState: 'unscored' }
}

function knockoutReasons(
  candidateInfo: ScreeningCandidateInfo | null | undefined,
  settings: ScreeningKnockoutSettings,
): ScreeningKnockoutReason[] {
  const reasons: ScreeningKnockoutReason[] = []
  const requiredLocation = normalizeLocation(settings.location)
  const candidateLocation = normalizeLocation(candidateInfo?.location)

  // Missing/blank profile information is UNKNOWN, not a failed filter.
  if (requiredLocation && candidateLocation && candidateLocation !== requiredLocation) {
    reasons.push('location')
  }

  const experience = candidateInfo?.experienceYears
  if (
    settings.experienceFloorYears !== undefined &&
    typeof experience === 'number' &&
    Number.isFinite(experience) &&
    experience >= 0 &&
    experience < settings.experienceFloorYears
  ) {
    reasons.push('experience')
  }
  return reasons
}

function compareIds(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1
}

function compareEligibleEntries(left: InternalEntry, right: InternalEntry): number {
  const confidence = (entry: InternalEntry) => (entry.scoreState === 'scored' ? 0 : 1)
  const confidenceOrder = confidence(left) - confidence(right)
  if (confidenceOrder !== 0) return confidenceOrder

  // Stale scores are deliberately NOT used to order the low-confidence bucket.
  if (left.scoreState === 'scored' && right.scoreState === 'scored') {
    const scoreOrder = (right.score ?? -1) - (left.score ?? -1)
    if (scoreOrder !== 0) return scoreOrder
  }
  const createdOrder = left.createdAtMs - right.createdAtMs
  return createdOrder !== 0 ? createdOrder : compareIds(left.applicationId, right.applicationId)
}

function compareKnownKnockouts(left: InternalEntry, right: InternalEntry): number {
  const createdOrder = left.createdAtMs - right.createdAtMs
  return createdOrder !== 0 ? createdOrder : compareIds(left.applicationId, right.applicationId)
}

function normalizeExceptions(
  input: ScreeningExceptionInput[] | undefined,
  knownApplicationIds: Set<string>,
  now: Date,
): ScreeningException[] {
  const seen = new Set<string>()
  return (input ?? []).map((exception) => {
    const applicationId = stableId(exception.applicationId, 'exception applicationId')
    if (!knownApplicationIds.has(applicationId)) {
      throw new ScreeningPreviewError(
        'SCREENING_UNKNOWN_APPLICATION',
        'An exception must target an application in this preview',
      )
    }
    if (seen.has(applicationId)) {
      throw new ScreeningPreviewError(
        'SCREENING_DUPLICATE_EXCEPTION',
        'Only one explicit exception is allowed per application',
      )
    }
    seen.add(applicationId)
    if (exception.action !== 'include' && exception.action !== 'exclude') {
      throw new ScreeningPreviewError('SCREENING_INVALID_EXCEPTION', 'Unsupported exception action')
    }
    return {
      applicationId,
      action: exception.action,
      actorMemberId: stableId(exception.actorMemberId, 'exception actorMemberId'),
      actorName: nonBlank(exception.actorName, 'exception actorName', 120),
      note: nonBlank(exception.note, 'exception note', 4000),
      at: dateValue(exception.at ?? now, 'exception at'),
    }
  })
}

function automaticSelectionReason(
  entry: InternalEntry,
  rule: NormalizedRule,
): { selected: boolean; reason: ScreeningSelectionReason } {
  if (entry.knockoutReasons.length > 0) return { selected: false, reason: 'knockout' }

  if (rule.mode === 'top_n') {
    return (entry.rank ?? Number.MAX_SAFE_INTEGER) <= (rule.topN ?? 0)
      ? { selected: true, reason: 'top_n' }
      : { selected: false, reason: 'below_cut_line' }
  }

  if (entry.scoreState !== 'scored' || entry.score === null) {
    return { selected: false, reason: 'stale_or_unscored' }
  }
  return entry.score >= (rule.scoreThreshold ?? 101)
    ? { selected: true, reason: 'above_threshold' }
    : { selected: false, reason: 'below_threshold' }
}

function buildCutLine(
  rule: NormalizedRule,
  automaticallySelected: InternalEntry[],
): ScreeningCutLine {
  const boundary = automaticallySelected[automaticallySelected.length - 1]
  if (rule.mode === 'top_n') {
    return {
      mode: rule.mode,
      requestedTopN: rule.topN,
      ...(boundary
        ? {
            applicationId: boundary.applicationId,
            rank: boundary.rank,
            score: boundary.score,
          }
        : {}),
    }
  }
  return {
    mode: rule.mode,
    scoreThreshold: rule.scoreThreshold,
    ...(boundary
      ? {
          applicationId: boundary.applicationId,
          rank: boundary.rank,
          score: boundary.score,
        }
      : {}),
  }
}

/**
 * Produce a non-mutating ranking and proposed selection for one exact
 * workspace/job. Fresh scores sort score-desc, then application creation
 * time asc, then application id asc. Stale/unscored applications form a
 * lower bucket; known knockout failures are excluded from rank. Unknown
 * location/experience remains eligible and can therefore be selected.
 */
export function previewScreeningGate(input: {
  workspaceId: ScreeningId
  jobId: ScreeningId
  rule: ScreeningGateRule
  applications: ScreeningApplicationInput[]
  exceptions?: ScreeningExceptionInput[]
  now?: Date | string | number
}): ScreeningGatePreview {
  const workspaceId = stableId(input.workspaceId, 'workspaceId')
  const jobId = stableId(input.jobId, 'jobId')
  const rule = normalizeRule(input.rule)
  const generatedAt = dateValue(input.now ?? new Date(), 'now')
  const applicationIds = new Set<string>()

  const entries: InternalEntry[] = input.applications.map((application) => {
    const applicationWorkspaceId = stableId(application.workspaceId, 'application workspaceId')
    const applicationJobId = stableId(application.jobId, 'application jobId')
    if (applicationWorkspaceId !== workspaceId || applicationJobId !== jobId) {
      throw new ScreeningScopeError('Every screening application must belong to the requested workspace/job')
    }
    const applicationId = stableId(application.applicationId, 'applicationId')
    if (applicationIds.has(applicationId)) {
      throw new ScreeningPreviewError(
        'SCREENING_DUPLICATE_APPLICATION',
        'Each application can appear only once in a screening preview',
      )
    }
    applicationIds.add(applicationId)
    const applicationCreatedAt = dateValue(application.createdAt, 'application createdAt')
    const match = normalizeScore(application.ranking)
    return {
      applicationId,
      candidateId: stableId(application.candidateId, 'candidateId'),
      applicationCreatedAt,
      score: match.score,
      scoreState: match.scoreState,
      knockoutReasons: knockoutReasons(application.candidateInfo, rule.knockoutSettings),
      automaticallySelected: false,
      selected: false,
      selectionReason: 'below_cut_line',
      createdAtMs: applicationCreatedAt.getTime(),
    }
  })

  const eligible = entries.filter((entry) => entry.knockoutReasons.length === 0).sort(compareEligibleEntries)
  eligible.forEach((entry, index) => {
    entry.rank = index + 1
  })
  const knownKnockouts = entries
    .filter((entry) => entry.knockoutReasons.length > 0)
    .sort(compareKnownKnockouts)

  for (const entry of [...eligible, ...knownKnockouts]) {
    const automatic = automaticSelectionReason(entry, rule)
    entry.automaticallySelected = automatic.selected
    entry.selected = automatic.selected
    entry.selectionReason = automatic.reason
  }

  const exceptions = normalizeExceptions(input.exceptions, applicationIds, generatedAt)
  const exceptionByApplication = new Map(exceptions.map((exception) => [exception.applicationId, exception]))
  for (const entry of [...eligible, ...knownKnockouts]) {
    const exception = exceptionByApplication.get(entry.applicationId)
    if (!exception) continue
    entry.selected = exception.action === 'include'
    entry.selectionReason = exception.action === 'include' ? 'manual_include' : 'manual_exclude'
  }

  const rankedApplications = [...eligible, ...knownKnockouts].map(({ createdAtMs: _createdAtMs, ...entry }) => ({
    ...entry,
    applicationCreatedAt: new Date(entry.applicationCreatedAt.getTime()),
    knockoutReasons: [...entry.knockoutReasons],
  }))
  const automaticallySelected = [...eligible, ...knownKnockouts].filter(
    (entry) => entry.automaticallySelected,
  )
  const selected = rankedApplications.filter((entry) => entry.selected)

  return {
    workspaceId,
    jobId,
    rule,
    generatedAt,
    evaluatedCount: rankedApplications.length,
    eligibleCount: eligible.length,
    automaticallySelectedCount: automaticallySelected.length,
    selectedCount: selected.length,
    cutLine: buildCutLine(rule, automaticallySelected),
    rankedApplications,
    exceptions: exceptions.map((exception) => ({ ...exception, at: new Date(exception.at.getTime()) })),
    selectedApplicationIds: selected.map((entry) => entry.applicationId),
  }
}

/**
 * Convert a reviewed preview into the exact immutable data a
 * `HireScreeningGate` writer can persist. The writer still has to perform
 * membership/workspace lifecycle fencing in its transaction; this helper
 * deliberately does not know about a database or B2C identity.
 */
export function buildScreeningGateConfirmation(input: {
  preview: ScreeningGatePreview
  actor: ScreeningActor
  confirmedAt?: Date | string | number
}): ScreeningGateConfirmation {
  const previewWorkspaceId = stableId(input.preview.workspaceId, 'preview workspaceId')
  const previewJobId = stableId(input.preview.jobId, 'preview jobId')
  const confirmedAt = dateValue(input.confirmedAt ?? new Date(), 'confirmedAt')
  const actorName = nonBlank(input.actor.name, 'confirmation actor name', 120)

  const applicationIds = new Set<string>()
  for (const entry of input.preview.rankedApplications) {
    const applicationId = stableId(entry.applicationId, 'preview applicationId')
    if (applicationIds.has(applicationId)) {
      throw new ScreeningPreviewError(
        'SCREENING_DUPLICATE_APPLICATION',
        'A confirmation cannot contain duplicate applications',
      )
    }
    applicationIds.add(applicationId)
  }
  if (input.preview.evaluatedCount !== input.preview.rankedApplications.length) {
    throw new ScreeningPreviewError(
      'SCREENING_INVALID_PREVIEW',
      'evaluatedCount must equal the number of ranked applications',
    )
  }

  return {
    workspaceId: previewWorkspaceId,
    jobId: previewJobId,
    status: 'confirmed',
    selectionMode: input.preview.rule.mode,
    ...(input.preview.rule.topN !== undefined ? { topN: input.preview.rule.topN } : {}),
    ...(input.preview.rule.scoreThreshold !== undefined
      ? { scoreThreshold: input.preview.rule.scoreThreshold }
      : {}),
    knockoutSettings: { ...input.preview.rule.knockoutSettings },
    cutLine: { ...input.preview.cutLine },
    evaluatedCount: input.preview.evaluatedCount,
    eligibleCount: input.preview.eligibleCount,
    automaticallySelectedCount: input.preview.automaticallySelectedCount,
    selectedCount: input.preview.selectedCount,
    rankedApplications: input.preview.rankedApplications.map((entry) => ({
      ...entry,
      applicationCreatedAt: new Date(entry.applicationCreatedAt.getTime()),
      knockoutReasons: [...entry.knockoutReasons],
    })),
    exceptions: input.preview.exceptions.map((exception) => ({
      ...exception,
      at: new Date(exception.at.getTime()),
    })),
    confirmedByMemberId: stableId(input.actor.memberId, 'confirmation actor memberId'),
    confirmedByName: actorName,
    confirmedAt,
  }
}

/** Build selected batch-item DTOs only; sending remains the future worker's job. */
export function buildInvitationBatchItemPlan(preview: ScreeningGatePreview): InvitationBatchItemPlan[] {
  return preview.rankedApplications
    .filter((entry) => entry.selected)
    .map((entry) => {
      if (
        entry.selectionReason !== 'top_n' &&
        entry.selectionReason !== 'above_threshold' &&
        entry.selectionReason !== 'manual_include'
      ) {
        throw new ScreeningPreviewError(
          'SCREENING_INVALID_SELECTION',
          'Selected applications must have an explicit invitation selection reason',
        )
      }
      return {
        applicationId: entry.applicationId,
        candidateId: entry.candidateId,
        ...(entry.rank !== undefined ? { rank: entry.rank } : {}),
        score: entry.score,
        scoreState: entry.scoreState,
        selectionReason: entry.selectionReason,
      }
    })
}
