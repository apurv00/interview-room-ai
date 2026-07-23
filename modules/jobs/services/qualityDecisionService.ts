import { createHash } from 'crypto'
import mongoose, { type ClientSession, type Types } from 'mongoose'
import { connectDB } from '@shared/db/connection'
import {
  JobQualityDecision,
  type IJobQualityEvidence,
  type IJobQualityReviewOverlay,
  type IJobQualitySourceRevision,
  type JobQualityDecisionAction,
  type JobQualityDecisionDomain,
  type JobQualityReviewAction,
  type JobQualityReviewStatus,
  type JobQualityServiceActor,
} from '@shared/db/models/JobQualityDecision'
import { JobSourceConfig } from '@shared/db/models/JobSourceConfig'
import type { NormalizedJob } from '../adapters/types'
import { stripRecruiterPii } from '../config/verdictPrompt'
import { controlRevisionFilter, operationalRevisionFilter } from './sourceControl'

const SHA256 = /^[a-f0-9]{64}$/
const OBJECT_ID = /^[a-f0-9]{24}$/
// JobPosting.sourceIds is deliberately monotonic/non-evicting. Keep a high
// safety bound without rejecting legitimate long-lived dedupe lineage.
const MAX_SOURCES = 128
const MAX_REASON_CODES = 16
const MAX_APPLY_HOSTS = 8
const MAX_EVIDENCE_BYTES = 16_384
const MAX_REVIEW_OVERLAY_BYTES = 32_768
const MAX_DESCRIPTION_EXCERPT = 4_000
const MAX_OVERLAY_SCAN_CHARACTERS = 16_384
const URL_TOKEN = /\b(?:https?:\/\/|www\.)[^\s<>()\[\]{}"']+/gi
const BARE_DOMAIN_TOKEN = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?:\/[^\s<>()\[\]{}"']*)?/gi
const SPACED_RECRUITER_PHONE = /(\+91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b/g
const INTERNATIONAL_PHONE_CANDIDATE = /\+?\d[\d\s().-]{5,}\d/g
const CONTACT_HANDLE_TOKEN = /(^|[^a-z0-9_])@[a-z0-9][a-z0-9_.-]{1,63}\b/gi
const MESSAGING_CONTACT_TOKEN = /\b(?:whats?app|telegram|signal|wechat|skype)\s*(?:id|handle)?\s*[:=-]?\s*[a-z0-9@._-]{2,64}\b/gi

const TRANSACTION_OPTIONS = {
  readConcern: { level: 'snapshot' as const },
  writeConcern: { w: 'majority' as const },
  readPreference: 'primary' as const,
}

export interface QualityDecisionSourceRevision {
  sourceId: string
  controlRevision: number
  operationalRevision: number
}

interface QualityDecisionIdentityBase {
  subjectKey: string
  inputHash: string
  policyRevision: string
  sourceRevisions: QualityDecisionSourceRevision[]
}

export interface HardDropQualityDecisionIdentity extends QualityDecisionIdentityBase {
  domain: 'hard-drop'
  action: 'drop'
  postingId?: never
  configRevision?: never
}

export interface LlmQualityDecisionIdentity extends QualityDecisionIdentityBase {
  domain: 'llm-verdict'
  action: 'close' | 'reopen'
  postingId: string | Types.ObjectId
  configRevision: number
}

export interface ApplyLinkQualityDecisionIdentity extends QualityDecisionIdentityBase {
  domain: 'apply-link'
  action: 'demote' | 'restore' | 'close' | 'reopen'
  postingId: string | Types.ObjectId
  serviceActor: 'jobs-link-check' | 'jobs-link-quorum'
  configRevision?: number
}

export type QualityDecisionIdentityInput =
  | HardDropQualityDecisionIdentity
  | LlmQualityDecisionIdentity
  | ApplyLinkQualityDecisionIdentity

export interface HardDropQualityEvidence {
  kind: 'hard-drop'
  reasonCodes: string[]
  bodyLength: number
  applyHosts: string[]
  massRepostCompanyCount?: number
}

export interface LlmQualityEvidence {
  kind: 'llm-verdict'
  verdict: 'genuine' | 'suspicious' | 'fraud'
  reasonCodes: string[]
  genuineness: number
  model: string
  promptVersion: string
  epoch: string
}

export interface ApplyLinkMachineQualityEvidence {
  kind: 'apply-link'
  basis: 'machine'
  outcome: 'dead' | 'alive'
  generation: string
  observedAt: Date
  /** Required for the two-observation posting close/reopen decisions; absent
   * for the first machine demotion/restoration observation. */
  priorObservedAt?: Date
  checkedOptionCount: number
}

export interface ApplyLinkCrowdQualityEvidence {
  kind: 'apply-link'
  basis: 'crowd'
  generation: string
  reportCount: number
  quorum: number
}

export type ApplyLinkQualityEvidence =
  | ApplyLinkMachineQualityEvidence
  | ApplyLinkCrowdQualityEvidence

export type AutomaticQualityDecisionInput =
  | (HardDropQualityDecisionIdentity & {
      occurredAt: Date
      evidence: HardDropQualityEvidence
      reviewOverlay: NormalizedJob
    })
  | (LlmQualityDecisionIdentity & {
      occurredAt: Date
      evidence: LlmQualityEvidence
      reviewOverlay?: never
    })
  | (ApplyLinkQualityDecisionIdentity & {
      occurredAt: Date
      evidence: ApplyLinkQualityEvidence
      reviewOverlay?: never
    })

export interface RecordedAutomaticQualityDecision {
  decisionKey: string
  inserted: boolean
}

export interface QualityDecisionListItem {
  id: string
  decisionKey: string
  domain: JobQualityDecisionDomain
  action: JobQualityDecisionAction
  postingId?: string
  inputHash: string
  policyRevision: string
  configRevision?: number
  sourceRevisions: IJobQualitySourceRevision[]
  evidence: IJobQualityEvidence
  reviewOverlay?: IJobQualityReviewOverlay
  serviceActor: JobQualityServiceActor
  reviewStatus: JobQualityReviewStatus
  reviewRevision: number
  seenCount: number
  occurredAt: Date
  lastSeenAt: Date
}

export interface QualityDecisionPageCursor {
  occurredAt: Date
  id: string | Types.ObjectId
}

export interface ListQualityDecisionPageOptions {
  reviewStatuses: JobQualityReviewStatus[]
  limit?: number
  before?: QualityDecisionPageCursor
}

export interface QualityDecisionPage {
  items: QualityDecisionListItem[]
  nextCursor?: { occurredAt: Date; id: string }
}

export interface QualityDecisionReviewHistoryItem {
  id: string
  operationId: string
  action: JobQualityReviewAction
  actorUserId: string
  reason: string
  fromReviewStatus: JobQualityReviewStatus
  toReviewStatus: JobQualityReviewStatus
  previousReviewRevision: number
  resultingReviewRevision: number
  occurredAt: Date
}

/** Automatic root exposed only inside the transaction-owned review callback. */
export interface QualityDecisionReviewRoot extends QualityDecisionListItem {
  subjectKeyHash: string
}

export interface ReviewQualityDecisionCommand {
  operationId: string
  decisionId: string | Types.ObjectId
  action: JobQualityReviewAction
  expectedReviewRevision: number
  actorUserId: string | Types.ObjectId
  reason: string
}

export interface ReviewQualityDecisionResult {
  decisionId: string
  decisionKey: string
  domain: JobQualityDecisionDomain
  reviewStatus: JobQualityReviewStatus
  reviewRevision: number
  operationId: string
  idempotent: boolean
}

export interface QualityDecisionReviewTransition {
  decisionId: string
  decisionKey: string
  domain: JobQualityDecisionDomain
  action: JobQualityReviewAction
  fromReviewStatus: JobQualityReviewStatus
  toReviewStatus: JobQualityReviewStatus
  previousReviewRevision: number
  reviewRevision: number
}

export type QualityDecisionBeforeReviewCommit = (
  transition: QualityDecisionReviewTransition,
  session: ClientSession,
  root: QualityDecisionReviewRoot,
) => Promise<void>

export class QualityDecisionValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QualityDecisionValidationError'
  }
}

export class QualityDecisionNotFoundError extends Error {
  constructor(public readonly decisionId: string) {
    super(`quality decision not found: ${decisionId}`)
    this.name = 'QualityDecisionNotFoundError'
  }
}

export class QualityDecisionConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QualityDecisionConflictError'
  }
}

export class QualityDecisionTransactionsRequiredError extends Error {
  constructor() {
    super('quality decision review requires MongoDB replica-set transactions')
    this.name = 'QualityDecisionTransactionsRequiredError'
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function boundedString(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') throw new QualityDecisionValidationError(`${label} must be a string`)
  const normalized = value.trim()
  if (!normalized || normalized.length > max) {
    throw new QualityDecisionValidationError(`${label} must contain 1-${max} characters`)
  }
  return normalized
}

/** Permanent review overlays are deliberately lossy. Bound input before regex
 * work, remove markup, recruiter PII, and URL-like tokens, then normalize and
 * truncate. Empty results remain valid because missing identity fields can be
 * the hard-drop evidence. */
function sanitizedOverlayString(
  value: unknown,
  label: string,
  max: number,
  preserveLines = false,
): string {
  if (typeof value !== 'string') {
    throw new QualityDecisionValidationError(`${label} must be a string`)
  }
  const bounded = value.slice(0, Math.max(max * 4, MAX_OVERLAY_SCAN_CHARACTERS))
  const redacted = stripRecruiterPii(bounded)
    .replace(SPACED_RECRUITER_PHONE, '[phone removed]')
    .replace(INTERNATIONAL_PHONE_CANDIDATE, (candidate) => {
      const digits = candidate.replace(/\D/g, '').length
      return digits >= 7 && digits <= 15 ? '[phone removed]' : candidate
    })
    .replace(MESSAGING_CONTACT_TOKEN, '[contact removed]')
    .replace(CONTACT_HANDLE_TOKEN, '$1[handle removed]')
    .replace(URL_TOKEN, '[url removed]')
    .replace(BARE_DOMAIN_TOKEN, '[url removed]')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\r\n?/g, '\n')
  const normalized = preserveLines
    ? redacted
        .replace(/[^\S\n]+/g, ' ')
        .replace(/ ?\n ?/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    : redacted.replace(/\s+/g, ' ').trim()
  return normalized.slice(0, max)
}

function nonnegativeInteger(value: unknown, label: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) {
    throw new QualityDecisionValidationError(`${label} must be a nonnegative safe integer`)
  }
  return value as number
}

function positiveInteger(value: unknown, label: string, max: number): number {
  const normalized = nonnegativeInteger(value, label, max)
  if (normalized === 0) throw new QualityDecisionValidationError(`${label} must be positive`)
  return normalized
}

function validDate(value: unknown, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new QualityDecisionValidationError(`${label} must be a valid Date`)
  }
  return new Date(value)
}

function objectIdString(value: unknown, label: string): string {
  const normalized = typeof value === 'string'
    ? value.toLowerCase()
    : value instanceof mongoose.Types.ObjectId
      ? value.toHexString()
      : ''
  if (!OBJECT_ID.test(normalized)) {
    throw new QualityDecisionValidationError(`${label} must be a 24-character ObjectId`)
  }
  return normalized
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function digestJson(value: unknown): string {
  return sha256(JSON.stringify(value))
}

function ensureByteBound(value: unknown, label: string, max: number): void {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > max) {
    throw new QualityDecisionValidationError(`${label} exceeds ${max} bytes`)
  }
}

function normalizedStringSet(
  value: unknown,
  label: string,
  maxItems: number,
  maxLength: number,
): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new QualityDecisionValidationError(`${label} must contain at most ${maxItems} entries`)
  }
  return Array.from(new Set(
    value.map((entry, index) => boundedString(entry, `${label}[${index}]`, maxLength)),
  )).sort()
}

function normalizedHostSet(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const safeHosts = value.slice(0, 256).flatMap((entry) => {
    if (typeof entry !== 'string') return []
    const hostname = entry.trim().toLowerCase()
    if (!hostname || hostname.length > 253 || !/^[a-z0-9.-]+$/.test(hostname)) return []
    return [hostname]
  })
  return Array.from(new Set(safeHosts)).sort().slice(0, MAX_APPLY_HOSTS)
}

function normalizeSourceRevisions(value: unknown): IJobQualitySourceRevision[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SOURCES) {
    throw new QualityDecisionValidationError(`sourceRevisions must contain 1-${MAX_SOURCES} entries`)
  }
  const revisions = value.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new QualityDecisionValidationError(`sourceRevisions[${index}] must be an object`)
    }
    return {
      sourceId: boundedString(entry.sourceId, `sourceRevisions[${index}].sourceId`, 100),
      controlRevision: nonnegativeInteger(entry.controlRevision, `sourceRevisions[${index}].controlRevision`),
      operationalRevision: nonnegativeInteger(entry.operationalRevision, `sourceRevisions[${index}].operationalRevision`),
    }
  }).sort((left, right) => left.sourceId.localeCompare(right.sourceId))
  if (new Set(revisions.map((revision) => revision.sourceId)).size !== revisions.length) {
    throw new QualityDecisionValidationError('sourceRevisions cannot contain duplicate sourceId values')
  }
  return revisions
}

/** Acquire the same source-document write order used by source control before
 * a serving mutation commits. Snapshot reads alone do not conflict with a
 * concurrent revoke/settings write; this physical CAS touch does. */
export async function fenceQualityDecisionSources(
  value: QualityDecisionSourceRevision[],
  session: ClientSession,
  options: { requireVerdictEligibility?: boolean } = {},
): Promise<void> {
  const revisions = normalizeSourceRevisions(value)
  for (const revision of revisions) {
    const write = await JobSourceConfig.updateOne(
      {
        sourceId: revision.sourceId,
        health: { $ne: 'revoked' },
        ...(options.requireVerdictEligibility
          ? { llmVerdictOptOut: { $ne: true } }
          : {}),
        $and: [
          controlRevisionFilter(revision.controlRevision),
          operationalRevisionFilter(revision.operationalRevision),
          {
            $or: [
              { ingestWriteSeq: { $lt: Number.MAX_SAFE_INTEGER } },
              { ingestWriteSeq: { $exists: false } },
            ],
          },
        ],
      },
      { $inc: { ingestWriteSeq: 1 } },
      { session, timestamps: false },
    )
    if ((write.matchedCount ?? 0) !== 1) {
      throw new QualityDecisionConflictError(
        `source authority changed before quality decision commit: ${revision.sourceId}`,
      )
    }
  }
}

interface NormalizedIdentity {
  domain: JobQualityDecisionDomain
  action: JobQualityDecisionAction
  subjectKeyHash: string
  postingId?: string
  inputHash: string
  policyRevision: string
  configRevision?: number
  sourceRevisions: IJobQualitySourceRevision[]
  serviceActor: JobQualityServiceActor
}

function normalizeIdentity(input: QualityDecisionIdentityInput): NormalizedIdentity {
  const subjectKey = boundedString(input.subjectKey, 'subjectKey', 512)
  const inputHash = boundedString(input.inputHash, 'inputHash', 64)
  if (!SHA256.test(inputHash)) throw new QualityDecisionValidationError('inputHash must be a lowercase SHA-256 digest')
  const policyRevision = boundedString(input.policyRevision, 'policyRevision', 160)
  const sourceRevisions = normalizeSourceRevisions(input.sourceRevisions)

  if (input.domain === 'hard-drop') {
    if (input.action !== 'drop') throw new QualityDecisionValidationError('hard-drop decisions must use action drop')
    if ('serviceActor' in input) throw new QualityDecisionValidationError('hard-drop service actor is derived internally')
    return {
      domain: input.domain,
      action: input.action,
      subjectKeyHash: sha256(subjectKey),
      inputHash,
      policyRevision,
      sourceRevisions,
      serviceActor: 'jobs-ingest',
    }
  }

  const postingId = objectIdString(input.postingId, 'postingId')
  if (input.domain === 'llm-verdict') {
    if (input.action !== 'close' && input.action !== 'reopen') {
      throw new QualityDecisionValidationError('llm-verdict decisions must close or reopen')
    }
    if ('serviceActor' in input) throw new QualityDecisionValidationError('llm-verdict service actor is derived internally')
    return {
      domain: input.domain,
      action: input.action,
      subjectKeyHash: sha256(subjectKey),
      postingId,
      inputHash,
      policyRevision,
      configRevision: nonnegativeInteger(input.configRevision, 'configRevision'),
      sourceRevisions,
      serviceActor: 'jobs-verdict',
    }
  }

  if (!['demote', 'restore', 'close', 'reopen'].includes(input.action)) {
    throw new QualityDecisionValidationError('apply-link decisions must demote, restore, close, or reopen')
  }
  if (input.serviceActor !== 'jobs-link-check' && input.serviceActor !== 'jobs-link-quorum') {
    throw new QualityDecisionValidationError('apply-link service actor must be jobs-link-check or jobs-link-quorum')
  }
  if (input.serviceActor === 'jobs-link-quorum' && input.action !== 'demote') {
    throw new QualityDecisionValidationError('jobs-link-quorum may record only crowd demotion decisions')
  }
  return {
    domain: input.domain,
    action: input.action,
    subjectKeyHash: sha256(subjectKey),
    postingId,
    inputHash,
    policyRevision,
    ...(input.configRevision === undefined
      ? {}
      : { configRevision: nonnegativeInteger(input.configRevision, 'configRevision') }),
    sourceRevisions,
    serviceActor: input.serviceActor,
  }
}

function normalizeEvidence(
  identity: NormalizedIdentity,
  value: HardDropQualityEvidence | LlmQualityEvidence | ApplyLinkQualityEvidence,
): IJobQualityEvidence {
  if (identity.domain === 'hard-drop') {
    if (value.kind !== 'hard-drop') throw new QualityDecisionValidationError('hard-drop evidence kind does not match domain')
    const reasonCodes = normalizedStringSet(value.reasonCodes, 'reasonCodes', MAX_REASON_CODES, 64)
    if (!reasonCodes.length) throw new QualityDecisionValidationError('hard-drop evidence requires at least one reason code')
    const applyHosts = normalizedHostSet(value.applyHosts)
    const evidence: IJobQualityEvidence = {
      kind: value.kind,
      reasonCodes,
      bodyLength: nonnegativeInteger(value.bodyLength, 'bodyLength'),
      applyHosts,
      ...(value.massRepostCompanyCount === undefined
        ? {}
        : { massRepostCompanyCount: nonnegativeInteger(value.massRepostCompanyCount, 'massRepostCompanyCount', 1_000_000) }),
    }
    ensureByteBound(evidence, 'hard-drop evidence', MAX_EVIDENCE_BYTES)
    return evidence
  }

  if (identity.domain === 'llm-verdict') {
    if (value.kind !== 'llm-verdict') throw new QualityDecisionValidationError('llm-verdict evidence kind does not match domain')
    if (!['genuine', 'suspicious', 'fraud'].includes(value.verdict)) {
      throw new QualityDecisionValidationError('llm-verdict evidence has an invalid verdict')
    }
    if (typeof value.genuineness !== 'number' || !Number.isFinite(value.genuineness) || value.genuineness < 0 || value.genuineness > 1) {
      throw new QualityDecisionValidationError('genuineness must be a finite number from 0 to 1')
    }
    const evidence: IJobQualityEvidence = {
      kind: value.kind,
      verdict: value.verdict,
      reasonCodes: normalizedStringSet(value.reasonCodes, 'reasonCodes', MAX_REASON_CODES, 64),
      genuineness: value.genuineness,
      model: boundedString(value.model, 'model', 200),
      promptVersion: boundedString(value.promptVersion, 'promptVersion', 200),
      epoch: boundedString(value.epoch, 'epoch', 300),
    }
    ensureByteBound(evidence, 'llm-verdict evidence', MAX_EVIDENCE_BYTES)
    return evidence
  }

  if (identity.serviceActor === 'jobs-link-quorum') {
    if (value.kind !== 'apply-link' || value.basis !== 'crowd') {
      throw new QualityDecisionValidationError('jobs-link-quorum requires crowd apply-link evidence')
    }
    const reportCount = positiveInteger(value.reportCount, 'reportCount', 1_000_000)
    const quorum = positiveInteger(value.quorum, 'quorum', 1_000_000)
    if (reportCount < quorum) {
      throw new QualityDecisionValidationError('crowd demotion requires reportCount greater than or equal to quorum')
    }
    const evidence: IJobQualityEvidence = {
      kind: value.kind,
      basis: value.basis,
      generation: boundedString(value.generation, 'generation', 64),
      reportCount,
      quorum,
    }
    ensureByteBound(evidence, 'apply-link crowd evidence', MAX_EVIDENCE_BYTES)
    return evidence
  }

  if (value.kind !== 'apply-link' || value.basis !== 'machine') {
    throw new QualityDecisionValidationError('jobs-link-check requires machine apply-link evidence')
  }
  const expectedOutcome = identity.action === 'demote' || identity.action === 'close' ? 'dead' : 'alive'
  if (value.outcome !== expectedOutcome) {
    throw new QualityDecisionValidationError(`${identity.action} requires ${expectedOutcome} apply-link evidence`)
  }
  const observedAt = validDate(value.observedAt, 'observedAt')
  const priorObservedAt = value.priorObservedAt === undefined
    ? undefined
    : validDate(value.priorObservedAt, 'priorObservedAt')
  if ((identity.action === 'close' || identity.action === 'reopen') && !priorObservedAt) {
    throw new QualityDecisionValidationError(`${identity.action} requires prior apply-link evidence`)
  }
  if (priorObservedAt && priorObservedAt.getTime() > observedAt.getTime()) {
    throw new QualityDecisionValidationError('priorObservedAt cannot be after observedAt')
  }
  const evidence: IJobQualityEvidence = {
    kind: value.kind,
    basis: value.basis,
    outcome: value.outcome,
    generation: boundedString(value.generation, 'generation', 64),
    observedAt,
    ...(priorObservedAt ? { priorObservedAt } : {}),
    checkedOptionCount: positiveInteger(value.checkedOptionCount, 'checkedOptionCount', 100),
  }
  ensureByteBound(evidence, 'apply-link evidence', MAX_EVIDENCE_BYTES)
  return evidence
}

function normalizeReviewOverlay(value: unknown): IJobQualityReviewOverlay {
  if (!isPlainObject(value)) throw new QualityDecisionValidationError('reviewOverlay must be an object')
  if (typeof value.isRemote !== 'boolean') throw new QualityDecisionValidationError('reviewOverlay.isRemote must be boolean')
  const overlay: IJobQualityReviewOverlay = {
    title: sanitizedOverlayString(value.title, 'reviewOverlay.title', 500),
    company: sanitizedOverlayString(value.company, 'reviewOverlay.company', 500),
    city: sanitizedOverlayString(value.city, 'reviewOverlay.city', 300),
    isRemote: value.isRemote,
    descriptionExcerpt: sanitizedOverlayString(
      value.description,
      'reviewOverlay.description',
      MAX_DESCRIPTION_EXCERPT,
      true,
    ),
    viaSite: sanitizedOverlayString(value.viaSite, 'reviewOverlay.viaSite', 200),
    ...(value.domainHint === undefined
      ? {}
      : { domainHint: sanitizedOverlayString(value.domainHint, 'reviewOverlay.domainHint', 100) }),
  }
  ensureByteBound(overlay, 'reviewOverlay', MAX_REVIEW_OVERLAY_BYTES)
  return overlay
}

function decisionKeyOf(identity: NormalizedIdentity): string {
  // configRevision remains persisted audit context, but is intentionally not
  // restoration authority: notes/price/config-row churn cannot invalidate a
  // human review when policy, input, and source authority are unchanged.
  return `quality:v1:${digestJson({
    domain: identity.domain,
    action: identity.action,
    subjectKeyHash: identity.subjectKeyHash,
    postingId: identity.postingId ?? null,
    inputHash: identity.inputHash,
    policyRevision: identity.policyRevision,
    sourceRevisions: identity.sourceRevisions,
    serviceActor: identity.serviceActor,
  })}`
}

export async function recordAutomaticQualityDecision(
  input: AutomaticQualityDecisionInput,
  session?: ClientSession,
): Promise<RecordedAutomaticQualityDecision> {
  await connectDB()
  const identity = normalizeIdentity(input)
  const evidence = normalizeEvidence(identity, input.evidence)
  const occurredAt = validDate(input.occurredAt, 'occurredAt')
  const reviewOverlay = identity.domain === 'hard-drop'
    ? normalizeReviewOverlay(input.reviewOverlay)
    : undefined
  const decisionKey = decisionKeyOf(identity)

  const write = await JobQualityDecision.updateOne(
    { recordType: 'automatic', decisionKey },
    {
      $setOnInsert: {
        recordType: 'automatic',
        decisionKey,
        domain: identity.domain,
        automaticAction: identity.action,
        subjectKeyHash: identity.subjectKeyHash,
        ...(identity.postingId ? { postingId: new mongoose.Types.ObjectId(identity.postingId) } : {}),
        inputHash: identity.inputHash,
        policyRevision: identity.policyRevision,
        ...(identity.configRevision === undefined ? {} : { configRevision: identity.configRevision }),
        sourceRevisions: identity.sourceRevisions,
        evidence,
        ...(reviewOverlay ? { reviewOverlay } : {}),
        serviceActor: identity.serviceActor,
        reviewStatus: 'unreviewed',
        reviewRevision: 0,
        occurredAt,
      },
      $max: { lastSeenAt: occurredAt },
      $inc: { seenCount: 1 },
    },
    {
      upsert: true,
      runValidators: true,
      setDefaultsOnInsert: true,
      ...(session ? { session } : {}),
    },
  )

  return {
    decisionKey,
    inserted: (write.upsertedCount ?? 0) === 1 || !!write.upsertedId,
  }
}

export async function hasRestoredQualityDecision(
  input: QualityDecisionIdentityInput,
  session?: ClientSession,
): Promise<boolean> {
  await connectDB()
  const decisionKey = decisionKeyOf(normalizeIdentity(input))
  let query = JobQualityDecision.exists({
    recordType: 'automatic',
    decisionKey,
    reviewStatus: 'restored',
  })
  if (session) query = query.session(session)
  return !!(await query)
}

function isTransactionUnsupported(error: unknown): boolean {
  const candidate = error as { code?: number; codeName?: string; message?: string }
  return candidate?.code === 20 ||
    candidate?.codeName === 'IllegalOperation' ||
    /transaction numbers are only allowed/i.test(candidate?.message ?? '')
}

export async function withQualityDecisionTransaction<T>(
  work: (session: ClientSession) => Promise<T>,
): Promise<T> {
  await connectDB()
  const session = await mongoose.startSession()
  let result: T | undefined
  let completed = false
  try {
    await session.withTransaction(async () => {
      result = await work(session)
      completed = true
    }, TRANSACTION_OPTIONS)
  } catch (error) {
    if (isTransactionUnsupported(error)) throw new QualityDecisionTransactionsRequiredError()
    throw error
  } finally {
    await session.endSession()
  }
  if (!completed) throw new Error('quality decision transaction completed without a result')
  return result as T
}

const QUALITY_DECISION_LIST_PROJECTION = {
  decisionKey: 1,
  domain: 1,
  automaticAction: 1,
  postingId: 1,
  inputHash: 1,
  policyRevision: 1,
  configRevision: 1,
  sourceRevisions: 1,
  evidence: 1,
  reviewOverlay: 1,
  serviceActor: 1,
  reviewStatus: 1,
  reviewRevision: 1,
  seenCount: 1,
  occurredAt: 1,
  lastSeenAt: 1,
} as const

function qualityDecisionListItemOf(doc: Record<string, unknown>): QualityDecisionListItem {
  return {
    id: String(doc._id),
    decisionKey: String(doc.decisionKey),
    domain: doc.domain as JobQualityDecisionDomain,
    action: doc.automaticAction as JobQualityDecisionAction,
    ...(doc.postingId ? { postingId: String(doc.postingId) } : {}),
    inputHash: String(doc.inputHash),
    policyRevision: String(doc.policyRevision),
    ...(doc.configRevision === undefined ? {} : { configRevision: Number(doc.configRevision) }),
    sourceRevisions: doc.sourceRevisions as IJobQualitySourceRevision[],
    evidence: doc.evidence as IJobQualityEvidence,
    ...(doc.reviewOverlay ? { reviewOverlay: doc.reviewOverlay as IJobQualityReviewOverlay } : {}),
    serviceActor: doc.serviceActor as JobQualityServiceActor,
    reviewStatus: doc.reviewStatus as JobQualityReviewStatus,
    reviewRevision: Number(doc.reviewRevision),
    seenCount: Number(doc.seenCount),
    occurredAt: new Date(doc.occurredAt as Date),
    lastSeenAt: new Date(doc.lastSeenAt as Date),
  }
}

function normalizedReviewStatuses(value: JobQualityReviewStatus[]): JobQualityReviewStatus[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new QualityDecisionValidationError('reviewStatuses must not be empty')
  }
  const allowed = new Set<JobQualityReviewStatus>(['unreviewed', 'upheld', 'restored'])
  if (value.some((status) => !allowed.has(status))) {
    throw new QualityDecisionValidationError('reviewStatuses contains an invalid value')
  }
  return Array.from(new Set(value))
}

export async function listQualityDecisionPage(
  options: ListQualityDecisionPageOptions,
): Promise<QualityDecisionPage> {
  await connectDB()
  const reviewStatuses = normalizedReviewStatuses(options.reviewStatuses)
  const limit = positiveInteger(options.limit ?? 50, 'limit', 100)
  const filter: Record<string, unknown> = {
    recordType: 'automatic',
    reviewStatus: { $in: reviewStatuses },
  }
  if (options.before) {
    const occurredAt = validDate(options.before.occurredAt, 'before.occurredAt')
    const id = new mongoose.Types.ObjectId(objectIdString(options.before.id, 'before.id'))
    filter.$or = [
      { occurredAt: { $lt: occurredAt } },
      { occurredAt, _id: { $lt: id } },
    ]
  }
  const docs = await JobQualityDecision.find(filter, QUALITY_DECISION_LIST_PROJECTION)
    .sort({ occurredAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean() as unknown as Array<Record<string, unknown>>
  const pageDocs = docs.slice(0, limit)
  const items = pageDocs.map(qualityDecisionListItemOf)
  const last = items[items.length - 1]
  return {
    items,
    ...(docs.length > limit && last
      ? { nextCursor: { occurredAt: last.occurredAt, id: last.id } }
      : {}),
  }
}

export async function listReviewableQualityDecisions(limit = 50): Promise<QualityDecisionListItem[]> {
  return (await listQualityDecisionPage({
    reviewStatuses: ['unreviewed', 'upheld'],
    limit,
  })).items
}

export async function getAutomaticQualityDecision(
  decisionId: string | Types.ObjectId,
): Promise<QualityDecisionListItem | null> {
  await connectDB()
  const id = new mongoose.Types.ObjectId(objectIdString(decisionId, 'decisionId'))
  const doc = await JobQualityDecision.findOne(
    { _id: id, recordType: 'automatic' },
    QUALITY_DECISION_LIST_PROJECTION,
  ).lean() as unknown as Record<string, unknown> | null
  return doc ? qualityDecisionListItemOf(doc) : null
}

export async function getQualityDecisionReviewHistory(
  decisionId: string | Types.ObjectId,
): Promise<QualityDecisionReviewHistoryItem[]> {
  await connectDB()
  const id = new mongoose.Types.ObjectId(objectIdString(decisionId, 'decisionId'))
  const docs = await JobQualityDecision.find(
    { recordType: 'review', rootDecisionId: id },
    {
      operationId: 1,
      reviewAction: 1,
      actorUserId: 1,
      reason: 1,
      fromReviewStatus: 1,
      toReviewStatus: 1,
      previousReviewRevision: 1,
      resultingReviewRevision: 1,
      occurredAt: 1,
    },
  )
    .sort({ occurredAt: 1, _id: 1 })
    .limit(100)
    .lean() as unknown as Array<Record<string, unknown>>
  return docs.map((doc) => ({
    id: String(doc._id),
    operationId: String(doc.operationId),
    action: doc.reviewAction as JobQualityReviewAction,
    actorUserId: String(doc.actorUserId),
    reason: String(doc.reason),
    fromReviewStatus: doc.fromReviewStatus as JobQualityReviewStatus,
    toReviewStatus: doc.toReviewStatus as JobQualityReviewStatus,
    previousReviewRevision: Number(doc.previousReviewRevision),
    resultingReviewRevision: Number(doc.resultingReviewRevision),
    occurredAt: new Date(doc.occurredAt as Date),
  }))
}

interface LeanReviewRow {
  operationId: string
  commandHash: string
  rootDecisionId: unknown
  rootDecisionKey: string
  domain: JobQualityDecisionDomain
  toReviewStatus: JobQualityReviewStatus
  resultingReviewRevision: number
}

interface LeanAutomaticRoot {
  _id: Types.ObjectId
  decisionKey: string
  domain: JobQualityDecisionDomain
  automaticAction: JobQualityDecisionAction
  subjectKeyHash: string
  postingId?: Types.ObjectId
  inputHash: string
  policyRevision: string
  configRevision?: number
  sourceRevisions: IJobQualitySourceRevision[]
  evidence: IJobQualityEvidence
  reviewOverlay?: IJobQualityReviewOverlay
  serviceActor: JobQualityServiceActor
  reviewStatus: JobQualityReviewStatus
  reviewRevision: number
  seenCount: number
  occurredAt: Date
  lastSeenAt: Date
}

function reviewRootOf(root: LeanAutomaticRoot): QualityDecisionReviewRoot {
  return {
    id: String(root._id),
    decisionKey: root.decisionKey,
    domain: root.domain,
    action: root.automaticAction,
    subjectKeyHash: root.subjectKeyHash,
    ...(root.postingId ? { postingId: String(root.postingId) } : {}),
    inputHash: root.inputHash,
    policyRevision: root.policyRevision,
    ...(root.configRevision === undefined ? {} : { configRevision: root.configRevision }),
    sourceRevisions: root.sourceRevisions,
    evidence: root.evidence,
    ...(root.reviewOverlay ? { reviewOverlay: root.reviewOverlay } : {}),
    serviceActor: root.serviceActor,
    reviewStatus: root.reviewStatus,
    reviewRevision: root.reviewRevision,
    seenCount: root.seenCount,
    occurredAt: new Date(root.occurredAt),
    lastSeenAt: new Date(root.lastSeenAt),
  }
}

async function findReviewByOperation(
  operationId: string,
  session?: ClientSession,
): Promise<LeanReviewRow | null> {
  let query = JobQualityDecision.findOne({ recordType: 'review', operationId })
  if (session) query = query.session(session)
  return query.lean() as unknown as Promise<LeanReviewRow | null>
}

function reviewResult(row: LeanReviewRow, idempotent: boolean): ReviewQualityDecisionResult {
  return {
    decisionId: String(row.rootDecisionId),
    decisionKey: row.rootDecisionKey,
    domain: row.domain,
    reviewStatus: row.toReviewStatus,
    reviewRevision: row.resultingReviewRevision,
    operationId: row.operationId,
    idempotent,
  }
}

function duplicateKey(error: unknown): boolean {
  return (error as { code?: number })?.code === 11000
}

interface NormalizedReviewCommand {
  operationId: string
  decisionId: string
  action: JobQualityReviewAction
  expectedReviewRevision: number
  actorUserId: string
  reason: string
  commandHash: string
}

function normalizeReviewCommand(command: ReviewQualityDecisionCommand): NormalizedReviewCommand {
  const operationId = boundedString(command.operationId, 'operationId', 128)
  const decisionId = objectIdString(command.decisionId, 'decisionId')
  const actorUserId = objectIdString(command.actorUserId, 'actorUserId')
  if (command.action !== 'uphold' && command.action !== 'restore') {
    throw new QualityDecisionValidationError('review action must be uphold or restore')
  }
  const expectedReviewRevision = nonnegativeInteger(command.expectedReviewRevision, 'expectedReviewRevision')
  const reason = boundedString(command.reason, 'reason', 1000)
  const commandHash = digestJson({
    operationId,
    decisionId,
    action: command.action,
    expectedReviewRevision,
    actorUserId,
    reason,
  })
  return {
    operationId,
    decisionId,
    action: command.action,
    expectedReviewRevision,
    actorUserId,
    reason,
    commandHash,
  }
}

/** Session-owned primitive for restore orchestration. `beforeCommit` may
 * mutate the posting/recovery signal with this same session; any failure
 * aborts the root CAS and immutable review child together. */
export async function reviewQualityDecisionInSession(
  command: ReviewQualityDecisionCommand,
  session: ClientSession,
  beforeCommit?: QualityDecisionBeforeReviewCommit,
): Promise<ReviewQualityDecisionResult> {
  const normalized = normalizeReviewCommand(command)
  const transactionReplay = await findReviewByOperation(normalized.operationId, session)
  if (transactionReplay) {
    if (transactionReplay.commandHash !== normalized.commandHash) {
      throw new QualityDecisionConflictError('operationId was already used for a different quality review')
    }
    return reviewResult(transactionReplay, true)
  }

  const occurredAt = new Date()
  let rootQuery = JobQualityDecision.findOne({
    _id: new mongoose.Types.ObjectId(normalized.decisionId),
    recordType: 'automatic',
  })
  rootQuery = rootQuery.session(session)
  const root = await rootQuery.lean() as unknown as LeanAutomaticRoot | null
  if (!root) throw new QualityDecisionNotFoundError(normalized.decisionId)
  if (root.reviewRevision !== normalized.expectedReviewRevision) {
    throw new QualityDecisionConflictError(
      `quality decision review revision changed: expected ${normalized.expectedReviewRevision}, current ${root.reviewRevision}`,
    )
  }

  const allowedFrom = normalized.action === 'uphold'
    ? ['unreviewed']
    : ['unreviewed', 'upheld']
  if (!allowedFrom.includes(root.reviewStatus)) {
    throw new QualityDecisionConflictError(
      `quality decision cannot ${normalized.action} from ${root.reviewStatus}`,
    )
  }
  const nextStatus: JobQualityReviewStatus = normalized.action === 'uphold' ? 'upheld' : 'restored'
  const nextRevision = normalized.expectedReviewRevision + 1
  const rootWrite = await JobQualityDecision.updateOne(
    {
      _id: root._id,
      recordType: 'automatic',
      reviewStatus: root.reviewStatus,
      reviewRevision: normalized.expectedReviewRevision,
    },
    {
      $set: { reviewStatus: nextStatus },
      $inc: { reviewRevision: 1 },
    },
    { session, runValidators: true },
  )
  if ((rootWrite.matchedCount ?? 0) !== 1) {
    throw new QualityDecisionConflictError('quality decision changed during review')
  }

  const transition: QualityDecisionReviewTransition = {
    decisionId: normalized.decisionId,
    decisionKey: root.decisionKey,
    domain: root.domain,
    action: normalized.action,
    fromReviewStatus: root.reviewStatus,
    toReviewStatus: nextStatus,
    previousReviewRevision: normalized.expectedReviewRevision,
    reviewRevision: nextRevision,
  }
  if (beforeCommit) await beforeCommit(transition, session, reviewRootOf(root))

  await JobQualityDecision.create([{
    recordType: 'review',
    operationId: normalized.operationId,
    commandHash: normalized.commandHash,
    rootDecisionId: root._id,
    rootDecisionKey: root.decisionKey,
    domain: root.domain,
    reviewAction: normalized.action,
    actorUserId: new mongoose.Types.ObjectId(normalized.actorUserId),
    reason: normalized.reason,
    fromReviewStatus: root.reviewStatus,
    toReviewStatus: nextStatus,
    previousReviewRevision: normalized.expectedReviewRevision,
    resultingReviewRevision: nextRevision,
    occurredAt,
  }], { session })

  return {
    decisionId: normalized.decisionId,
    decisionKey: root.decisionKey,
    domain: root.domain,
    reviewStatus: nextStatus,
    reviewRevision: nextRevision,
    operationId: normalized.operationId,
    idempotent: false,
  }
}

export async function reviewQualityDecision(
  command: ReviewQualityDecisionCommand,
): Promise<ReviewQualityDecisionResult> {
  const normalized = normalizeReviewCommand(command)
  await connectDB()
  const replay = await findReviewByOperation(normalized.operationId)
  if (replay) {
    if (replay.commandHash !== normalized.commandHash) {
      throw new QualityDecisionConflictError('operationId was already used for a different quality review')
    }
    return reviewResult(replay, true)
  }

  try {
    return await withQualityDecisionTransaction((session) =>
      reviewQualityDecisionInSession(command, session))
  } catch (error) {
    // A concurrent identical operation can win the permanent unique index.
    // Re-read its immutable row outside the aborted transaction and replay it.
    if (duplicateKey(error)) {
      const winner = await findReviewByOperation(normalized.operationId)
      if (winner && winner.commandHash === normalized.commandHash) return reviewResult(winner, true)
    }
    throw error
  }
}
