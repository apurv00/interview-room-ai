import mongoose from 'mongoose'
import {
  HireApplication,
  HIRE_HUMAN_KIT_MAX_ATTEMPTS,
  HireHumanKitDelivery,
  HireHumanRound,
} from '@hire-decision-boundary'
import { HireExternalVerdict } from '../models/HireExternalVerdict'
import {
  HIRE_EXTERNAL_VERDICT_RECOMMENDATIONS,
  type HireDecisionActionContext,
  type HireDecisionActionInbox,
  type HireDecisionActionInboxItem,
  type HireDecisionComparison,
  type HireDecisionView,
  type HireExternalVerdictRecommendation,
} from '../types'
import {
  buildHireDecisionView,
  HireDecisionError,
} from './decisionAggregateService'
import { connectHireDecisionDB } from './hireDecisionBoundary'

export const HIRE_DECISION_INBOX_DEFAULT_LIMIT = 50
export const HIRE_DECISION_INBOX_MAX_LIMIT = 100

export interface ReadHireDecisionActionInboxInput {
  workspaceId: string
  jobId?: string
  applicationId?: string
  /** A caller-provided last-seen watermark for only newly submitted verdicts. */
  externalVerdictsSince?: Date
  limit?: number
}

export interface CompareHireDecisionApplicationsInput {
  workspaceId: string
  jobId: string
  applicationIds: string[]
}

type ScopedCoordinates = {
  workspaceId: mongoose.Types.ObjectId
  jobId?: mongoose.Types.ObjectId
  applicationId?: mongoose.Types.ObjectId
}

type InboxRecord = {
  applicationId: mongoose.Types.ObjectId | string
  jobId: mongoose.Types.ObjectId | string
  candidateId: mongoose.Types.ObjectId | string
}

function objectId(value: string, label: string): mongoose.Types.ObjectId {
  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw new HireDecisionError(`Invalid ${label}`, 'DECISION_INVALID_SCOPE', 400)
  }
  return new mongoose.Types.ObjectId(value)
}

function readScope(input: ReadHireDecisionActionInboxInput): ScopedCoordinates {
  return {
    workspaceId: objectId(input.workspaceId, 'workspace id'),
    ...(input.jobId ? { jobId: objectId(input.jobId, 'job id') } : {}),
    ...(input.applicationId ? { applicationId: objectId(input.applicationId, 'application id') } : {}),
  }
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return HIRE_DECISION_INBOX_DEFAULT_LIMIT
  if (!Number.isInteger(value) || value < 1 || value > HIRE_DECISION_INBOX_MAX_LIMIT) {
    throw new HireDecisionError(
      `Inbox limit must be 1-${HIRE_DECISION_INBOX_MAX_LIMIT}`,
      'DECISION_INVALID_SCOPE',
      400,
    )
  }
  return value
}

function stringId(value: mongoose.Types.ObjectId | string): string {
  return value.toString()
}

function safeDate(value: Date): Date {
  return new Date(value.getTime())
}

function safeAttempts(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

function isExternalRecommendation(value: unknown): value is HireExternalVerdictRecommendation {
  return (
    typeof value === 'string' &&
    HIRE_EXTERNAL_VERDICT_RECOMMENDATIONS.includes(value as HireExternalVerdictRecommendation)
  )
}

/** A deliberate deep pick—no raw AI, contact, resume, stage, rank, note, or audit data enters the inbox. */
function toActionContext(view: HireDecisionView): HireDecisionActionContext {
  const cloneSource = (source: HireDecisionActionContext['humanScorecards']['total']) => ({
    count: source.count,
    recommendations: { ...source.recommendations },
    dimensions: source.dimensions.map((dimension) => ({ ...dimension })),
  })
  return {
    coordinates: {
      workspaceId: view.coordinates.workspaceId,
      applicationId: view.coordinates.applicationId,
      jobId: view.coordinates.jobId,
      candidateId: view.coordinates.candidateId,
    },
    candidateBrief: {
      candidateName: view.candidateBrief.candidateName,
      jobTitle: view.candidateBrief.jobTitle,
      ...(view.candidateBrief.location ? { location: view.candidateBrief.location } : {}),
      ...(view.candidateBrief.experienceYears !== undefined
        ? { experienceYears: view.candidateBrief.experienceYears }
        : {}),
    },
    humanScorecards: {
      total: cloneSource(view.humanScorecards.total),
      member: cloneSource(view.humanScorecards.member),
      kit: cloneSource(view.humanScorecards.kit),
    },
    externalVerdicts: {
      count: view.externalVerdicts.count,
      recommendations: { ...view.externalVerdicts.recommendations },
    },
  }
}

function coordinateKey(record: InboxRecord): string {
  return `${stringId(record.applicationId)}:${stringId(record.jobId)}:${stringId(record.candidateId)}`
}

async function loadActionContexts(
  workspaceId: string,
  records: readonly InboxRecord[],
): Promise<Map<string, HireDecisionActionContext>> {
  const unique = new Map<string, InboxRecord>()
  for (const record of records) unique.set(coordinateKey(record), record)

  const loaded = await Promise.all(
    Array.from(unique.entries()).map(async ([key, record]) => {
      try {
        const view = await buildHireDecisionView({
          workspaceId,
          applicationId: stringId(record.applicationId),
        })
        // The row's coordinates are deliberately re-checked after loading;
        // a stale/polymorphic source record cannot borrow another candidate's
        // evidence even if an id was malformed outside this module.
        if (
          view.coordinates.jobId !== stringId(record.jobId) ||
          view.coordinates.candidateId !== stringId(record.candidateId)
        ) {
          return null
        }
        return [key, toActionContext(view)] as const
      } catch (error) {
        // A concurrent privacy deletion can make one source action unavailable.
        // Omit it rather than returning a partial/unsafe record or failing the
        // entire inbox for other applications.
        if (error instanceof HireDecisionError && error.code === 'DECISION_SCOPE_NOT_FOUND') {
          return null
        }
        throw error
      }
    }),
  )
  return new Map(loaded.filter((entry): entry is readonly [string, HireDecisionActionContext] => entry !== null))
}

function inScopeFilter(scope: ScopedCoordinates): Record<string, unknown> {
  return {
    workspaceId: scope.workspaceId,
    ...(scope.jobId ? { jobId: scope.jobId } : {}),
    ...(scope.applicationId ? { applicationId: scope.applicationId } : {}),
  }
}

/**
 * Read the action-facing evidence queue. It has no write/stage operation and
 * intentionally excludes source record IDs, recipient info, provider errors,
 * comments, raw evidence, and any ranking or audit payload.
 */
export async function readHireDecisionActionInbox(
  input: ReadHireDecisionActionInboxInput,
): Promise<HireDecisionActionInbox> {
  const scope = readScope(input)
  const limit = boundedLimit(input.limit)
  await connectHireDecisionDB()
  const base = inScopeFilter(scope)

  const [pendingRounds, failedDeliveries, externalVerdicts] = await Promise.all([
    HireHumanRound.find({
      ...base,
      status: 'pending_scorecard',
      revokedAt: { $exists: false },
      privacyRedactedAt: { $exists: false },
    })
      .sort({ openedAt: 1, createdAt: 1 })
      .limit(limit),
    HireHumanKitDelivery.find({
      ...base,
      status: 'failed',
      // `failed` is retryable until the durable delivery row reaches its
      // bounded attempt cap. The inbox must not present an automatically
      // recoverable provider blip as a recruiter action.
      attempts: { $gte: HIRE_HUMAN_KIT_MAX_ATTEMPTS },
    })
      .sort({ updatedAt: -1 })
      .limit(limit),
    HireExternalVerdict.find({
      ...base,
      privacyRedactedAt: { $exists: false },
      ...(input.externalVerdictsSince ? { submittedAt: { $gt: input.externalVerdictsSince } } : {}),
    })
      .sort({ submittedAt: -1 })
      .limit(limit),
  ])

  const contexts = await loadActionContexts(input.workspaceId, [
    ...pendingRounds,
    ...failedDeliveries,
    ...externalVerdicts,
  ])
  const items: HireDecisionActionInboxItem[] = []

  for (const round of pendingRounds) {
    const context = contexts.get(coordinateKey(round))
    if (!context) continue
    items.push({
      kind: 'pending_human_scorecard',
      occurredAt: safeDate(round.openedAt ?? round.createdAt),
      humanRoundMode: round.mode,
      decision: context,
    })
  }
  for (const delivery of failedDeliveries) {
    const context = contexts.get(coordinateKey(delivery))
    if (!context) continue
    items.push({
      kind: 'terminal_human_kit_delivery_failure',
      occurredAt: safeDate(delivery.updatedAt),
      deliveryPurpose: delivery.purpose,
      attempts: safeAttempts(delivery.attempts),
      decision: context,
    })
  }
  for (const verdict of externalVerdicts) {
    const context = contexts.get(coordinateKey(verdict))
    if (!context || !isExternalRecommendation(verdict.recommendation)) continue
    items.push({
      kind: 'external_verdict_submitted',
      occurredAt: safeDate(verdict.submittedAt),
      recommendation: verdict.recommendation,
      decision: context,
    })
  }

  // Deterministic newest-first delivery with no implicit candidate ranking.
  items.sort((left, right) => {
    const delta = right.occurredAt.getTime() - left.occurredAt.getTime()
    if (delta !== 0) return delta
    return left.kind.localeCompare(right.kind) ||
      left.decision.coordinates.applicationId.localeCompare(right.decision.coordinates.applicationId)
  })
  return { items: items.slice(0, limit) }
}

/**
 * Compare exactly 2–3 deliberate application selections from one workspace
 * and one job. The returned list follows the caller's selection order, never
 * a score/rank ordering.
 */
export async function compareHireDecisionApplications(
  input: CompareHireDecisionApplicationsInput,
): Promise<HireDecisionComparison> {
  if (input.applicationIds.length < 2 || input.applicationIds.length > 3) {
    throw new HireDecisionError('Compare exactly 2-3 applications', 'DECISION_INVALID_SCOPE', 400)
  }
  if (new Set(input.applicationIds).size !== input.applicationIds.length) {
    throw new HireDecisionError('Compare applications must be unique', 'DECISION_INVALID_SCOPE', 400)
  }

  const workspaceId = objectId(input.workspaceId, 'workspace id')
  const jobId = objectId(input.jobId, 'job id')
  const applicationIds = input.applicationIds.map((id) => objectId(id, 'application id'))
  await connectHireDecisionDB()

  const applications = await HireApplication.find({
    workspaceId,
    jobId,
    _id: { $in: applicationIds },
  })
  if (applications.length !== applicationIds.length) {
    // The same response covers non-existent, cross-workspace, and cross-job
    // ids without revealing which coordinate failed the scope fence.
    throw new HireDecisionError('Compared applications are unavailable', 'DECISION_SCOPE_NOT_FOUND', 404)
  }

  const found = new Set(applications.map((application) => application._id.toString()))
  if (applicationIds.some((id) => !found.has(id.toString()))) {
    throw new HireDecisionError('Compared applications are unavailable', 'DECISION_SCOPE_NOT_FOUND', 404)
  }

  const views = await Promise.all(
    applicationIds.map((applicationId) =>
      buildHireDecisionView({
        workspaceId: workspaceId.toString(),
        applicationId: applicationId.toString(),
      }),
    ),
  )
  if (
    views.some(
      (view) =>
        view.coordinates.workspaceId !== workspaceId.toString() ||
        view.coordinates.jobId !== jobId.toString(),
    )
  ) {
    throw new HireDecisionError('Compared applications are unavailable', 'DECISION_SCOPE_NOT_FOUND', 404)
  }

  return {
    workspaceId: workspaceId.toString(),
    jobId: jobId.toString(),
    applications: views,
  }
}

export const __decisionInboxCompare = {
  boundedLimit,
  inScopeFilter,
  toActionContext,
}
