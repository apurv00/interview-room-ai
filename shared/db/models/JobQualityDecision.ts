import mongoose, { Schema, type Document, type Model } from 'mongoose'

export const JOB_QUALITY_DECISION_DOMAINS = [
  'hard-drop',
  'llm-verdict',
  'apply-link',
] as const

export type JobQualityDecisionDomain = typeof JOB_QUALITY_DECISION_DOMAINS[number]

export const JOB_QUALITY_DECISION_ACTIONS = [
  'drop',
  'demote',
  'restore',
  'close',
  'reopen',
] as const

export type JobQualityDecisionAction = typeof JOB_QUALITY_DECISION_ACTIONS[number]

export const JOB_QUALITY_SERVICE_ACTORS = [
  'jobs-ingest',
  'jobs-verdict',
  'jobs-link-check',
  'jobs-link-quorum',
] as const

export type JobQualityServiceActor = typeof JOB_QUALITY_SERVICE_ACTORS[number]

export const JOB_QUALITY_REVIEW_STATUSES = [
  'unreviewed',
  'upheld',
  'restored',
] as const

export type JobQualityReviewStatus = typeof JOB_QUALITY_REVIEW_STATUSES[number]

export const JOB_QUALITY_REVIEW_ACTIONS = ['uphold', 'restore'] as const
export type JobQualityReviewAction = typeof JOB_QUALITY_REVIEW_ACTIONS[number]

export interface IJobQualitySourceRevision {
  sourceId: string
  controlRevision: number
  operationalRevision: number
}

export interface IJobQualityEvidence {
  kind: JobQualityDecisionDomain
  reasonCodes?: string[]
  bodyLength?: number
  applyHosts?: string[]
  massRepostCompanyCount?: number
  verdict?: 'genuine' | 'suspicious' | 'fraud'
  genuineness?: number
  model?: string
  promptVersion?: string
  epoch?: string
  basis?: 'machine' | 'crowd'
  outcome?: 'dead' | 'alive'
  generation?: string
  observedAt?: Date
  priorObservedAt?: Date
  checkedOptionCount?: number
  reportCount?: number
  quorum?: number
}

/** Bounded, URL-free projection retained so an operator can review a hard
 * drop without permanently duplicating an entire provider payload or JD. */
export interface IJobQualityReviewOverlay {
  title: string
  company: string
  city: string
  isRemote: boolean
  descriptionExcerpt: string
  viaSite: string
  domainHint?: string
}

/** One collection carries automatic roots and append-only human review rows.
 * Automatic roots retain immutable decision inputs/evidence plus the smallest
 * mutable projection needed for a review queue and exact restored override. */
export interface IJobQualityDecision extends Document {
  _id: mongoose.Types.ObjectId
  recordType: 'automatic' | 'review'

  // Automatic root fields.
  decisionKey?: string
  domain: JobQualityDecisionDomain
  automaticAction?: JobQualityDecisionAction
  subjectKeyHash?: string
  postingId?: mongoose.Types.ObjectId
  inputHash?: string
  policyRevision?: string
  configRevision?: number
  sourceRevisions?: IJobQualitySourceRevision[]
  evidence?: IJobQualityEvidence
  reviewOverlay?: IJobQualityReviewOverlay
  serviceActor?: JobQualityServiceActor
  reviewStatus?: JobQualityReviewStatus
  reviewRevision?: number
  seenCount?: number
  lastSeenAt?: Date

  // Immutable review child fields.
  operationId?: string
  commandHash?: string
  rootDecisionId?: mongoose.Types.ObjectId
  rootDecisionKey?: string
  reviewAction?: JobQualityReviewAction
  actorUserId?: mongoose.Types.ObjectId
  reason?: string
  fromReviewStatus?: JobQualityReviewStatus
  toReviewStatus?: JobQualityReviewStatus
  previousReviewRevision?: number
  resultingReviewRevision?: number

  occurredAt: Date
  createdAt: Date
}

const SourceRevisionSchema = new Schema<IJobQualitySourceRevision>(
  {
    sourceId: { type: String, required: true, maxlength: 100, immutable: true },
    controlRevision: { type: Number, required: true, min: 0, immutable: true },
    operationalRevision: { type: Number, required: true, min: 0, immutable: true },
  },
  { _id: false, strict: 'throw' },
)

const QualityEvidenceSchema = new Schema<IJobQualityEvidence>(
  {
    kind: { type: String, enum: JOB_QUALITY_DECISION_DOMAINS, required: true, immutable: true },
    reasonCodes: { type: [String], default: undefined, immutable: true },
    bodyLength: { type: Number, min: 0, immutable: true },
    applyHosts: { type: [String], default: undefined, immutable: true },
    massRepostCompanyCount: { type: Number, min: 0, immutable: true },
    verdict: { type: String, enum: ['genuine', 'suspicious', 'fraud'], immutable: true },
    genuineness: { type: Number, min: 0, max: 1, immutable: true },
    model: { type: String, maxlength: 200, immutable: true },
    promptVersion: { type: String, maxlength: 200, immutable: true },
    epoch: { type: String, maxlength: 300, immutable: true },
    basis: { type: String, enum: ['machine', 'crowd'], immutable: true },
    outcome: { type: String, enum: ['dead', 'alive'], immutable: true },
    generation: { type: String, maxlength: 64, immutable: true },
    observedAt: { type: Date, immutable: true },
    priorObservedAt: { type: Date, immutable: true },
    checkedOptionCount: { type: Number, min: 1, immutable: true },
    reportCount: { type: Number, min: 1, immutable: true },
    quorum: { type: Number, min: 1, immutable: true },
  },
  { _id: false, strict: 'throw' },
)

const ReviewOverlaySchema = new Schema<IJobQualityReviewOverlay>(
  {
    title: { type: String, maxlength: 500, immutable: true },
    company: { type: String, maxlength: 500, immutable: true },
    city: { type: String, maxlength: 300, immutable: true },
    isRemote: { type: Boolean, required: true, immutable: true },
    descriptionExcerpt: { type: String, maxlength: 4000, immutable: true },
    viaSite: { type: String, maxlength: 200, immutable: true },
    domainHint: { type: String, maxlength: 100, immutable: true },
  },
  { _id: false, strict: 'throw' },
)

const immutableString = (maxlength: number) => ({
  type: String,
  maxlength,
  immutable: true,
})

const JobQualityDecisionSchema = new Schema<IJobQualityDecision>(
  {
    recordType: {
      type: String,
      enum: ['automatic', 'review'],
      required: true,
      immutable: true,
    },
    decisionKey: immutableString(96),
    domain: {
      type: String,
      enum: JOB_QUALITY_DECISION_DOMAINS,
      required: true,
      immutable: true,
    },
    automaticAction: {
      type: String,
      enum: JOB_QUALITY_DECISION_ACTIONS,
      immutable: true,
    },
    subjectKeyHash: {
      type: String,
      match: /^[a-f0-9]{64}$/,
      immutable: true,
    },
    postingId: { type: Schema.Types.ObjectId, ref: 'JobPosting', immutable: true },
    inputHash: {
      type: String,
      match: /^[a-f0-9]{64}$/,
      immutable: true,
    },
    policyRevision: immutableString(160),
    configRevision: { type: Number, min: 0, immutable: true },
    sourceRevisions: { type: [SourceRevisionSchema], default: undefined, immutable: true },
    evidence: { type: QualityEvidenceSchema, immutable: true },
    reviewOverlay: { type: ReviewOverlaySchema, immutable: true },
    serviceActor: {
      type: String,
      enum: JOB_QUALITY_SERVICE_ACTORS,
      immutable: true,
    },
    reviewStatus: { type: String, enum: JOB_QUALITY_REVIEW_STATUSES },
    reviewRevision: { type: Number, min: 0 },
    seenCount: { type: Number, min: 1 },
    lastSeenAt: { type: Date },

    operationId: immutableString(128),
    commandHash: {
      type: String,
      match: /^[a-f0-9]{64}$/,
      immutable: true,
    },
    rootDecisionId: { type: Schema.Types.ObjectId, ref: 'JobQualityDecision', immutable: true },
    rootDecisionKey: immutableString(96),
    reviewAction: { type: String, enum: JOB_QUALITY_REVIEW_ACTIONS, immutable: true },
    actorUserId: { type: Schema.Types.ObjectId, ref: 'User', immutable: true },
    reason: { type: String, maxlength: 1000, immutable: true },
    fromReviewStatus: { type: String, enum: JOB_QUALITY_REVIEW_STATUSES, immutable: true },
    toReviewStatus: { type: String, enum: JOB_QUALITY_REVIEW_STATUSES, immutable: true },
    previousReviewRevision: { type: Number, min: 0, immutable: true },
    resultingReviewRevision: { type: Number, min: 1, immutable: true },
    occurredAt: { type: Date, required: true, immutable: true },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    strict: 'throw',
  },
)

JobQualityDecisionSchema.pre('validate', function validateRecordShape() {
  if (this.recordType === 'automatic') {
    const required = [
      this.decisionKey,
      this.automaticAction,
      this.subjectKeyHash,
      this.inputHash,
      this.policyRevision,
      this.serviceActor,
      this.evidence,
      this.reviewStatus,
    ]
    if (required.some((value) => value === undefined || value === null || value === '')) {
      throw new Error('automatic quality decisions require identity, evidence, actor, and review state')
    }
    if (!Number.isInteger(this.reviewRevision) || !Number.isInteger(this.seenCount)) {
      throw new Error('automatic quality decisions require integer reviewRevision and seenCount')
    }
    if (!this.sourceRevisions?.length) {
      throw new Error('automatic quality decisions require source authority revisions')
    }
    if (this.domain === 'hard-drop' && !this.reviewOverlay) {
      throw new Error('hard-drop decisions require a bounded review overlay')
    }
    if (this.domain !== 'hard-drop' && this.reviewOverlay) {
      throw new Error('only hard-drop decisions may retain a review overlay')
    }
    if (this.domain === 'llm-verdict' && !Number.isInteger(this.configRevision)) {
      throw new Error('llm-verdict decisions require a config revision')
    }
    return
  }

  const required = [
    this.operationId,
    this.commandHash,
    this.rootDecisionId,
    this.rootDecisionKey,
    this.reviewAction,
    this.actorUserId,
    this.reason,
    this.fromReviewStatus,
    this.toReviewStatus,
  ]
  if (required.some((value) => value === undefined || value === null || value === '')) {
    throw new Error('review rows require root, actor, command, reason, and transition evidence')
  }
  if (!Number.isInteger(this.previousReviewRevision) || !Number.isInteger(this.resultingReviewRevision)) {
    throw new Error('review rows require integer previous and resulting revisions')
  }
})

// Deployment-owned index preparation may materialize these exact definitions
// with auto-indexing disabled. They are declared here so local/test schemas do
// not lose the idempotency and queue contracts.
JobQualityDecisionSchema.index(
  { decisionKey: 1 },
  {
    name: 'job_quality_decision_key_uq',
    unique: true,
    partialFilterExpression: { recordType: 'automatic' },
  },
)
JobQualityDecisionSchema.index(
  { operationId: 1 },
  {
    name: 'job_quality_review_operation_uq',
    unique: true,
    partialFilterExpression: { recordType: 'review' },
  },
)
JobQualityDecisionSchema.index(
  { recordType: 1, reviewStatus: 1, occurredAt: -1, _id: -1 },
  { name: 'job_quality_review_queue' },
)
JobQualityDecisionSchema.index(
  { rootDecisionId: 1, occurredAt: 1, _id: 1 },
  { name: 'job_quality_review_history' },
)

export const JobQualityDecision: Model<IJobQualityDecision> =
  mongoose.models.JobQualityDecision ||
  mongoose.model<IJobQualityDecision>('JobQualityDecision', JobQualityDecisionSchema)
