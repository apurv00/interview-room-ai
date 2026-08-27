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
  /** Internal keyset coordinate decoded and scope-checked by the member API. */
  cursor?: HireDecisionActionInboxCursor
}

export interface HireDecisionActionInboxCursor {
  occurredAt: Date
  kind: HireDecisionActionInboxItem['kind']
  applicationId: string
  sourceId: string
}

export interface HireDecisionActionInboxPage extends HireDecisionActionInbox {
  limit: number
  nextCursor: HireDecisionActionInboxCursor | null
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

type InboxCoordinate = {
  record: InboxRecord
  sourceId: string
  occurredAt: Date
  kind: HireDecisionActionInboxItem['kind']
  item(context: HireDecisionActionContext): HireDecisionActionInboxItem
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

function normalizedCursor(
  value: HireDecisionActionInboxCursor | undefined,
): HireDecisionActionInboxCursor | null {
  if (value === undefined) return null
  const occurredAt = new Date(value.occurredAt)
  if (
    Number.isNaN(occurredAt.getTime()) ||
    ![
      'pending_human_scorecard',
      'terminal_human_kit_delivery_failure',
      'external_verdict_submitted',
    ].includes(value.kind) ||
    !mongoose.Types.ObjectId.isValid(value.applicationId) ||
    !mongoose.Types.ObjectId.isValid(value.sourceId)
  ) {
    throw new HireDecisionError(
      'Inbox cursor is invalid',
      'DECISION_INVALID_SCOPE',
      400,
    )
  }
  return {
    occurredAt,
    kind: value.kind,
    applicationId: value.applicationId.toLowerCase(),
    sourceId: value.sourceId.toLowerCase(),
  }
}

function beforeCursorFilter(
  dateField: 'createdAt' | 'updatedAt' | 'submittedAt',
  kind: HireDecisionActionInboxItem['kind'],
  cursor: HireDecisionActionInboxCursor | null,
): Record<string, unknown> {
  if (!cursor) return {}

  const sameTimeKindOrder = kind.localeCompare(cursor.kind)
  return {
    $or: [
      { [dateField]: { $lt: cursor.occurredAt } },
      ...(sameTimeKindOrder > 0
        ? [{ [dateField]: cursor.occurredAt }]
        : sameTimeKindOrder === 0
          ? [
              {
                [dateField]: cursor.occurredAt,
                $or: [
                  {
                    applicationId: {
                      $gt: new mongoose.Types.ObjectId(cursor.applicationId),
                    },
                  },
                  {
                    applicationId: new mongoose.Types.ObjectId(
                      cursor.applicationId,
                    ),
                    _id: { $gt: new mongoose.Types.ObjectId(cursor.sourceId) },
                  },
                ],
              },
            ]
          : []),
    ],
  }
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
): Promise<HireDecisionActionInboxPage> {
  const scope = readScope(input)
  const limit = boundedLimit(input.limit)
  const cursor = normalizedCursor(input.cursor)
  const sourceLimit = limit + 1
  await connectHireDecisionDB()
  const base = inScopeFilter(scope)

  const [pendingRounds, failedDeliveries, externalVerdicts] = await Promise.all([
    HireHumanRound.find({
      ...base,
      status: 'pending_scorecard',
      revokedAt: { $exists: false },
      privacyRedactedAt: { $exists: false },
      ...beforeCursorFilter('createdAt', 'pending_human_scorecard', cursor),
    })
      .sort({ createdAt: -1, applicationId: 1, _id: 1 })
      .limit(sourceLimit),
    HireHumanKitDelivery.find({
      ...base,
      status: 'failed',
      privacyRedactedAt: { $exists: false },
      // `failed` is retryable until the durable delivery row reaches its
      // bounded attempt cap. The inbox must not present an automatically
      // recoverable provider blip as a recruiter action.
      attempts: { $gte: HIRE_HUMAN_KIT_MAX_ATTEMPTS },
      ...beforeCursorFilter(
        'updatedAt',
        'terminal_human_kit_delivery_failure',
        cursor,
      ),
    })
      .sort({ updatedAt: -1, applicationId: 1, _id: 1 })
      .limit(sourceLimit),
    HireExternalVerdict.find({
      ...base,
      privacyRedactedAt: { $exists: false },
      ...(input.externalVerdictsSince && cursor
        ? {
            $and: [
              { submittedAt: { $gt: input.externalVerdictsSince } },
              beforeCursorFilter(
                'submittedAt',
                'external_verdict_submitted',
                cursor,
              ),
            ],
          }
        : {
            ...(input.externalVerdictsSince
              ? { submittedAt: { $gt: input.externalVerdictsSince } }
              : {}),
            ...beforeCursorFilter(
              'submittedAt',
              'external_verdict_submitted',
              cursor,
            ),
          }),
    })
      .sort({ submittedAt: -1, applicationId: 1, _id: 1 })
      .limit(sourceLimit),
  ])

  const coordinates: InboxCoordinate[] = pendingRounds.map((round) => ({
    record: round,
    sourceId: round._id?.toString() ?? round.applicationId.toString(),
    occurredAt: safeDate(round.createdAt),
    kind: 'pending_human_scorecard',
    item: (context) => ({
      kind: 'pending_human_scorecard',
      occurredAt: safeDate(round.createdAt),
      humanRoundMode: round.mode,
      decision: context,
    }),
  }))
  const visibleFailedDeliveries = failedDeliveries.filter(
    (delivery) =>
      !(delivery as typeof delivery & { privacyRedactedAt?: Date })
        .privacyRedactedAt,
  )
  coordinates.push(...visibleFailedDeliveries.map((delivery) => ({
    record: delivery,
    sourceId: delivery._id?.toString() ?? delivery.applicationId.toString(),
    occurredAt: safeDate(delivery.updatedAt),
    kind: 'terminal_human_kit_delivery_failure' as const,
    item: (context: HireDecisionActionContext) => ({
      kind: 'terminal_human_kit_delivery_failure' as const,
      occurredAt: safeDate(delivery.updatedAt),
      deliveryPurpose: delivery.purpose,
      attempts: safeAttempts(delivery.attempts),
      decision: context,
    }),
  })))
  coordinates.push(...externalVerdicts.flatMap((verdict): InboxCoordinate[] => {
    if (!isExternalRecommendation(verdict.recommendation)) return []
    return [{
      record: verdict,
      sourceId: verdict._id?.toString() ?? verdict.applicationId.toString(),
      occurredAt: safeDate(verdict.submittedAt),
      kind: 'external_verdict_submitted',
      item: (context) => ({
        kind: 'external_verdict_submitted',
        occurredAt: safeDate(verdict.submittedAt),
        recommendation: verdict.recommendation as HireExternalVerdictRecommendation,
        decision: context,
      }),
    }]
  }))

  // Sort lightweight source coordinates before loading any evidence. In the
  // ordinary case only the visible page plus one look-ahead coordinate is
  // hydrated, even though each of the three source queries is independently
  // bounded for correct global keyset merging.
  coordinates.sort((left, right) => {
    const delta = right.occurredAt.getTime() - left.occurredAt.getTime()
    if (delta !== 0) return delta
    return left.kind.localeCompare(right.kind) ||
      stringId(left.record.applicationId).localeCompare(
        stringId(right.record.applicationId),
      ) || left.sourceId.localeCompare(right.sourceId)
  })

  const contexts = new Map<string, HireDecisionActionContext>()
  const attemptedContextKeys = new Set<string>()
  const hydrated: Array<{
    coordinate: InboxCoordinate
    item: HireDecisionActionInboxItem
  }> = []
  let coordinateOffset = 0
  let lastExamined: InboxCoordinate | null = null

  // A concurrent privacy deletion can invalidate a coordinate after its
  // source query. Backfill from the next globally sorted coordinate until a
  // full page plus look-ahead is available or this bounded source window is
  // exhausted. Each unique candidate context is attempted at most once.
  while (hydrated.length < limit + 1 && coordinateOffset < coordinates.length) {
    const take = limit + 1 - hydrated.length
    const chunk = coordinates.slice(coordinateOffset, coordinateOffset + take)
    coordinateOffset += chunk.length
    lastExamined = chunk.at(-1) ?? lastExamined
    const missingRecords = chunk
      .map((coordinate) => coordinate.record)
      .filter((record) => !attemptedContextKeys.has(coordinateKey(record)))
    for (const record of missingRecords) {
      attemptedContextKeys.add(coordinateKey(record))
    }
    const loaded = await loadActionContexts(input.workspaceId, missingRecords)
    loaded.forEach((context, key) => contexts.set(key, context))
    for (const coordinate of chunk) {
      const context = contexts.get(coordinateKey(coordinate.record))
      if (!context) continue
      hydrated.push({
        coordinate,
        item: coordinate.item(context),
      })
    }
  }

  const pageItems = hydrated.slice(0, limit)
  const lastVisible = pageItems.at(-1)?.coordinate ?? null
  const sourceWindowMayContinue = [
    pendingRounds,
    failedDeliveries,
    externalVerdicts,
  ].some((records) => records.length === sourceLimit)
  const cursorCoordinate = hydrated.length > limit
    ? lastVisible
    : sourceWindowMayContinue
      ? lastExamined
      : null

  return {
    items: pageItems.map(({ item }) => item),
    limit,
    nextCursor: cursorCoordinate
      ? {
          occurredAt: safeDate(cursorCoordinate.occurredAt),
          kind: cursorCoordinate.kind,
          applicationId: stringId(cursorCoordinate.record.applicationId),
          sourceId: cursorCoordinate.sourceId,
        }
      : null,
  }
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
