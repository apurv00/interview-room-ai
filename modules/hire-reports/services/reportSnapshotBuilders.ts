import {
  HIRE_REPORT_AGING_BUCKETS,
  HIRE_REPORT_BLOCKER_KINDS,
  HIRE_REPORT_MAX_CLOSEOUT_HIRES,
  HIRE_REPORT_MAX_COUNT,
  HIRE_REPORT_MAX_PIPELINE_JOBS,
  HIRE_REPORT_MAX_TIME_TO_CLOSE_HOURS,
  HIRE_REPORT_PIPELINE_STAGES,
  HIRE_REPORT_RECOMMENDATIONS,
  type HireJobCloseoutHiredCandidateInput,
  type HireJobCloseoutReportSnapshot,
  type HireJobCloseoutReportSnapshotInput,
  type HirePipelineStatusReportJobSnapshot,
  type HirePipelineStatusReportSnapshot,
  type HirePipelineStatusReportSnapshotInput,
  type HireReportDepartmentSnapshot,
  type HireReportAgingBucket,
  type HireReportAgingCount,
  type HireReportBlockerCount,
  type HireReportBlockerKind,
  type HireReportEvidenceSummary,
  type HireReportPipelineStage,
  type HireReportRecommendation,
  type HireReportRecommendationTally,
  type HireReportSnapshotBuildResult,
  type HireReportStageCount,
  type HireReportScope,
} from '../types'

const OBJECT_ID = /^[a-f0-9]{24}$/i
const MAX_JOB_TITLE_LENGTH = 200
const MAX_DEPARTMENT_NAME_LENGTH = 120
const MAX_CANDIDATE_NAME_LENGTH = 120
const MAX_DECISION_NOTE_LENGTH = 4_000
const HOUR_MS = 60 * 60 * 1000

/** A malformed source projection must stop report generation rather than be silently guessed. */
export class HireReportSnapshotValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HireReportSnapshotValidationError'
  }
}

function fail(message: string): never {
  throw new HireReportSnapshotValidationError(message)
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`)
  return value
}

function safeDate(value: unknown, label: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    fail(`${label} must be a valid Date`)
  }
  return new Date(value.getTime())
}

function boundedText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') fail(`${label} must be text`)
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > maxLength) {
    fail(`${label} must be between 1 and ${maxLength} characters`)
  }
  return trimmed
}

/**
 * Keep only the immutable display coordinate that a report is allowed to
 * retain. The enclosing report snapshot is immutable; this builder also
 * copies the value so later catalog changes cannot rewrite historical output.
 */
function buildDepartmentSnapshot(
  value: unknown,
  label: string,
): HireReportDepartmentSnapshot | undefined {
  if (value === undefined) return undefined
  const source = record(value, label)
  if (typeof source.id !== 'string' || !OBJECT_ID.test(source.id)) {
    fail(`${label} id is invalid`)
  }
  return {
    id: source.id.toLowerCase(),
    name: boundedText(source.name, `${label} name`, MAX_DEPARTMENT_NAME_LENGTH),
  }
}

function boundedCount(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > HIRE_REPORT_MAX_COUNT) {
    fail(`${label} must be a bounded non-negative integer`)
  }
  return value as number
}

function exactEntries<T extends string>(input: unknown, options: {
  label: string
  allowed: readonly T[]
  field: 'stage' | 'bucket' | 'kind'
}): Array<{ key: T; count: number }> {
  const entries = array(input, options.label)
  if (entries.length !== options.allowed.length) {
    fail(`${options.label} must contain each fixed category exactly once`)
  }
  const seen = new Set<T>()
  const values = new Map<T, number>()
  for (const item of entries) {
    const row = record(item, `${options.label} entry`)
    const key = row[options.field]
    if (typeof key !== 'string' || !options.allowed.includes(key as T) || seen.has(key as T)) {
      fail(`${options.label} contains an unsupported or duplicate category`)
    }
    seen.add(key as T)
    values.set(key as T, boundedCount(row.count, `${options.label}.${key}`))
  }
  return options.allowed.map((key) => ({ key, count: values.get(key) ?? 0 }))
}

function buildStageCounts(value: unknown): HireReportStageCount[] {
  return exactEntries(value, {
    label: 'stageCounts',
    allowed: HIRE_REPORT_PIPELINE_STAGES,
    field: 'stage',
  }).map(({ key: stage, count }) => ({ stage, count }))
}

function buildAging(value: unknown): HireReportAgingCount[] {
  return exactEntries(value, {
    label: 'aging',
    allowed: HIRE_REPORT_AGING_BUCKETS,
    field: 'bucket',
  }).map(({ key: bucket, count }) => ({ bucket, count }))
}

function buildBlockers(value: unknown): HireReportBlockerCount[] {
  return exactEntries(value, {
    label: 'blockers',
    allowed: HIRE_REPORT_BLOCKER_KINDS,
    field: 'kind',
  }).map(({ key: kind, count }) => ({ kind, count }))
}

function buildRecommendationTally(value: unknown, label: string): HireReportRecommendationTally {
  const source = record(value, label)
  const tally = {} as HireReportRecommendationTally
  for (const recommendation of HIRE_REPORT_RECOMMENDATIONS) {
    tally[recommendation] = boundedCount(source[recommendation], `${label}.${recommendation}`)
  }
  return tally
}

function tallyTotal(tally: HireReportRecommendationTally): number {
  return HIRE_REPORT_RECOMMENDATIONS.reduce((total, key) => total + tally[key], 0)
}

function buildEvidenceSource(value: unknown, label: string): {
  submittedCount: number
  recommendations: HireReportRecommendationTally
} {
  const source = record(value, label)
  const submittedCount = boundedCount(source.submittedCount, `${label}.submittedCount`)
  const recommendations = buildRecommendationTally(source.recommendations, `${label}.recommendations`)
  if (tallyTotal(recommendations) !== submittedCount) {
    fail(`${label}.submittedCount must equal its recommendation tally`)
  }
  return { submittedCount, recommendations }
}

/** Deep, explicit allowlist for report evidence. No source can enter a composite score. */
function buildEvidence(value: unknown): HireReportEvidenceSummary {
  const source = record(value, 'evidence')
  const aiAssessments = record(source.aiAssessments, 'evidence.aiAssessments')
  const humanScorecards = record(source.humanScorecards, 'evidence.humanScorecards')
  const externalVerdicts = buildEvidenceSource(source.externalVerdicts, 'evidence.externalVerdicts')

  return {
    aiAssessments: {
      completedCount: boundedCount(aiAssessments.completedCount, 'evidence.aiAssessments.completedCount'),
    },
    humanScorecards: {
      member: buildEvidenceSource(humanScorecards.member, 'evidence.humanScorecards.member'),
      kit: buildEvidenceSource(humanScorecards.kit, 'evidence.humanScorecards.kit'),
    },
    externalVerdicts,
  }
}

function buildPipelineJob(value: unknown): HirePipelineStatusReportJobSnapshot {
  const source = record(value, 'pipeline job')
  const jobStatus = source.jobStatus
  if (jobStatus !== 'open' && jobStatus !== 'on_hold' && jobStatus !== 'closed') {
    fail('pipeline job status is unsupported')
  }
  const department = buildDepartmentSnapshot(source.department, 'pipeline job department')
  return {
    jobTitle: boundedText(source.jobTitle, 'pipeline job title', MAX_JOB_TITLE_LENGTH),
    ...(department ? { department } : {}),
    jobStatus,
    openedAt: safeDate(source.openedAt, 'pipeline job openedAt'),
    stageCounts: buildStageCounts(source.stageCounts),
    aging: buildAging(source.aging),
    blockers: buildBlockers(source.blockers),
    evidence: buildEvidence(source.evidence),
  }
}

function reportScope(value: unknown): HireReportScope {
  if (value !== 'workspace' && value !== 'job') fail('pipeline report scope is unsupported')
  return value
}

/**
 * Build a report-only projection for one job or a collection of independent
 * jobs. Extra source fields are deliberately ignored at every nesting level.
 */
export function buildHirePipelineStatusReportSnapshot(
  input: HirePipelineStatusReportSnapshotInput,
): HireReportSnapshotBuildResult<HirePipelineStatusReportSnapshot> {
  const source = record(input, 'pipeline report')
  const scope = reportScope(source.scope)
  const jobs = array(source.jobs, 'pipeline report jobs')
  if (jobs.length === 0 || jobs.length > HIRE_REPORT_MAX_PIPELINE_JOBS) {
    fail(`pipeline report jobs must contain 1 to ${HIRE_REPORT_MAX_PIPELINE_JOBS} rows`)
  }
  if (scope === 'job' && jobs.length !== 1) {
    fail('a job-scoped pipeline report must contain exactly one job')
  }
  return {
    snapshot: {
      version: 1,
      kind: 'pipeline_status',
      scope,
      asOf: safeDate(source.asOf, 'pipeline report asOf'),
      jobs: jobs.map(buildPipelineJob),
    },
    // Pipeline reports contain aggregate values only, so they do not retain
    // a candidate coordinate that could expand report disclosure later.
    affectedCandidateIds: [],
  }
}

function buildHiredCandidate(value: unknown): {
  candidateId: string
  snapshot: { candidateName: string; hiredAt: Date }
} {
  const source = record(value, 'hired candidate') as Record<keyof HireJobCloseoutHiredCandidateInput, unknown>
  if (typeof source.candidateId !== 'string' || !OBJECT_ID.test(source.candidateId)) {
    fail('hired candidate id is invalid')
  }
  return {
    candidateId: source.candidateId.toLowerCase(),
    snapshot: {
      candidateName: boundedText(source.candidateName, 'hired candidate name', MAX_CANDIDATE_NAME_LENGTH),
      hiredAt: safeDate(source.hiredAt, 'hired candidate hiredAt'),
    },
  }
}

/**
 * Build the immutable close-out report value. The duration is derived here,
 * and candidate IDs are intentionally returned outside the rendered snapshot
 * for later privacy/lifecycle fencing.
 */
export function buildHireJobCloseoutReportSnapshot(
  input: HireJobCloseoutReportSnapshotInput,
): HireReportSnapshotBuildResult<HireJobCloseoutReportSnapshot> {
  const source = record(input, 'job closeout report')
  const department = buildDepartmentSnapshot(source.department, 'job closeout department')
  const openedAt = safeDate(source.openedAt, 'job closeout openedAt')
  const closedAt = safeDate(source.closedAt, 'job closeout closedAt')
  const elapsedMs = closedAt.getTime() - openedAt.getTime()
  if (elapsedMs < 0) fail('job closeout closedAt cannot precede openedAt')
  const timeToCloseHours = Math.floor(elapsedMs / HOUR_MS)
  if (timeToCloseHours > HIRE_REPORT_MAX_TIME_TO_CLOSE_HOURS) {
    fail('job closeout duration is outside the supported range')
  }

  const rawHires = array(source.hiredCandidates, 'job closeout hiredCandidates')
  if (rawHires.length > HIRE_REPORT_MAX_CLOSEOUT_HIRES) {
    fail(`job closeout hiredCandidates cannot exceed ${HIRE_REPORT_MAX_CLOSEOUT_HIRES}`)
  }
  const hires = rawHires.map(buildHiredCandidate)
  const candidateIds = new Set<string>()
  for (const hire of hires) {
    if (candidateIds.has(hire.candidateId)) fail('job closeout hiredCandidates must be unique')
    candidateIds.add(hire.candidateId)
    if (hire.snapshot.hiredAt.getTime() < openedAt.getTime() || hire.snapshot.hiredAt.getTime() > closedAt.getTime()) {
      fail('hired candidate timestamp must fall within the job lifecycle')
    }
  }

  return {
    snapshot: {
      version: 1,
      kind: 'job_closeout',
      asOf: safeDate(source.asOf, 'job closeout asOf'),
      jobTitle: boundedText(source.jobTitle, 'job closeout title', MAX_JOB_TITLE_LENGTH),
      ...(department ? { department } : {}),
      openedAt,
      closedAt,
      timeToCloseHours,
      stageCounts: buildStageCounts(source.stageCounts),
      evidence: buildEvidence(source.evidence),
      hiredCandidates: hires.map((hire) => ({
        candidateName: hire.snapshot.candidateName,
        hiredAt: new Date(hire.snapshot.hiredAt.getTime()),
      })),
      decisionNote: boundedText(source.decisionNote, 'job closeout decisionNote', MAX_DECISION_NOTE_LENGTH),
    },
    affectedCandidateIds: Array.from(candidateIds),
  }
}

/** A small helper for renderers that want a readable canonical stage label. */
export function formatHireReportStage(stage: HireReportPipelineStage): string {
  return stage.replace(/_/g, ' ')
}

/** A small helper for renderers that want a readable fixed blocker label. */
export function formatHireReportBlocker(kind: HireReportBlockerKind): string {
  return kind.replace(/_/g, ' ')
}

/** Kept exported for precise type-safe render iteration without a composite. */
export function hireReportRecommendationKeys(): readonly HireReportRecommendation[] {
  return HIRE_REPORT_RECOMMENDATIONS
}
