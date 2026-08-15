import mongoose, { Document, Model, Schema } from 'mongoose'

export const HIRE_HUMAN_SCORECARD_DIMENSIONS = [
  'role_capability',
  'problem_solving',
  'communication',
  'collaboration',
] as const
export type HireHumanScorecardDimensionKey =
  (typeof HIRE_HUMAN_SCORECARD_DIMENSIONS)[number]

export const HIRE_HUMAN_SCORECARD_RECOMMENDATIONS = [
  'strong_yes',
  'yes',
  'no',
  'strong_no',
] as const
export type HireHumanScorecardRecommendation =
  (typeof HIRE_HUMAN_SCORECARD_RECOMMENDATIONS)[number]

export const HIRE_HUMAN_SCORECARD_STATUSES = ['draft', 'submitted', 'cancelled'] as const
export type HireHumanScorecardStatus = (typeof HIRE_HUMAN_SCORECARD_STATUSES)[number]

export const HIRE_HUMAN_SCORECARD_REVIEWER_KINDS = ['kit', 'member'] as const
export type HireHumanScorecardReviewerKind =
  (typeof HIRE_HUMAN_SCORECARD_REVIEWER_KINDS)[number]

export interface IHireHumanScorecardDimension {
  key: HireHumanScorecardDimensionKey
  rating: number
  evidence: string
}

export interface IHireHumanScorecard extends Document {
  _id: mongoose.Types.ObjectId
  workspaceId: mongoose.Types.ObjectId
  applicationId: mongoose.Types.ObjectId
  jobId: mongoose.Types.ObjectId
  candidateId: mongoose.Types.ObjectId
  humanRoundId: mongoose.Types.ObjectId
  /** A guest kit id or member id, represented as a stable immutable key. */
  reviewerKey: string
  reviewerKind: HireHumanScorecardReviewerKind
  kitId?: mongoose.Types.ObjectId
  memberId?: mongoose.Types.ObjectId
  /** Immutable display snapshot; member records may be renamed later. */
  reviewerName: string
  status: HireHumanScorecardStatus
  dimensions?: IHireHumanScorecardDimension[]
  recommendation?: HireHumanScorecardRecommendation
  overallComment?: string
  submittedAt?: Date
  cancelledAt?: Date
  privacyRedactedAt?: Date
  createdAt: Date
  updatedAt: Date
}

const ScorecardDimensionSchema = new Schema<IHireHumanScorecardDimension>(
  {
    // These remain editable while a scorecard is a draft. The service changes
    // draft -> submitted with a status CAS and never permits a submitted card
    // to be edited, rather than making a member's in-progress draft immutable.
    key: { type: String, enum: HIRE_HUMAN_SCORECARD_DIMENSIONS, required: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    evidence: { type: String, required: true, trim: true, minlength: 1, maxlength: 2000 },
  },
  { _id: false },
)

type ScorecardValidationShape = Pick<
  IHireHumanScorecard,
  | 'reviewerKey'
  | 'reviewerKind'
  | 'kitId'
  | 'memberId'
  | 'status'
  | 'dimensions'
  | 'recommendation'
  | 'overallComment'
  | 'submittedAt'
  | 'cancelledAt'
>

function objectIdString(value: unknown): string | null {
  if (!value || typeof (value as { toString?: unknown }).toString !== 'function') return null
  const stringValue = (value as { toString(): string }).toString()
  return /^[a-f0-9]{24}$/i.test(stringValue) ? stringValue.toLowerCase() : null
}

function isQueryValidationContext(value: unknown): boolean {
  return typeof (value as { getUpdate?: unknown })?.getUpdate === 'function'
}

/**
 * A scorecard has one durable reviewer authority, never a polymorphic pair
 * that could drift. `reviewerKey` deliberately duplicates that coordinate for
 * a simple unique index and therefore must be exact rather than caller-chosen.
 */
function hasExactReviewerCoordinate(scorecard: ScorecardValidationShape): boolean {
  const kitId = objectIdString(scorecard.kitId)
  const memberId = objectIdString(scorecard.memberId)
  if (scorecard.reviewerKind === 'kit') {
    return Boolean(kitId) && !memberId && scorecard.reviewerKey === `kit:${kitId}`
  }
  if (scorecard.reviewerKind === 'member') {
    return Boolean(memberId) && !kitId && scorecard.reviewerKey === `member:${memberId}`
  }
  return false
}

function hasCanonicalDimensions(
  dimensions: IHireHumanScorecardDimension[] | undefined,
): boolean {
  return Boolean(
    dimensions &&
      dimensions.length === HIRE_HUMAN_SCORECARD_DIMENSIONS.length &&
      dimensions.every(
        (dimension, index) => dimension.key === HIRE_HUMAN_SCORECARD_DIMENSIONS[index],
      ),
  )
}

function hasNoSubmissionPayload(scorecard: ScorecardValidationShape): boolean {
  return (
    (!scorecard.dimensions || scorecard.dimensions.length === 0) &&
    scorecard.recommendation === undefined &&
    scorecard.overallComment === undefined &&
    scorecard.submittedAt === undefined
  )
}

function hasCompleteSubmissionPayload(scorecard: ScorecardValidationShape): boolean {
  return (
    hasCanonicalDimensions(scorecard.dimensions) &&
    Boolean(scorecard.recommendation) &&
    typeof scorecard.overallComment === 'string' &&
    scorecard.overallComment.trim().length > 0 &&
    scorecard.submittedAt instanceof Date
  )
}

/** Document-level lifecycle contract; query writes additionally use status CAS in the service. */
function hasValidScorecardState(scorecard: ScorecardValidationShape): boolean {
  if (scorecard.status === 'submitted') {
    return hasCompleteSubmissionPayload(scorecard) && scorecard.cancelledAt === undefined
  }
  if (scorecard.status === 'draft') {
    return hasNoSubmissionPayload(scorecard) && scorecard.cancelledAt === undefined
  }
  if (scorecard.status === 'cancelled') {
    return hasNoSubmissionPayload(scorecard) && scorecard.cancelledAt instanceof Date
  }
  return false
}

const HireHumanScorecardSchema = new Schema<IHireHumanScorecard>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: 'HireWorkspace', required: true, immutable: true },
    applicationId: { type: Schema.Types.ObjectId, ref: 'HireApplication', required: true, immutable: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'HireJob', required: true, immutable: true },
    candidateId: { type: Schema.Types.ObjectId, ref: 'HireCandidate', required: true, immutable: true },
    humanRoundId: { type: Schema.Types.ObjectId, ref: 'HireHumanRound', required: true, immutable: true },
    reviewerKey: { type: String, required: true, maxlength: 80, immutable: true },
    reviewerKind: {
      type: String,
      enum: HIRE_HUMAN_SCORECARD_REVIEWER_KINDS,
      required: true,
      immutable: true,
      validate: {
        validator(this: unknown) {
          // Query updates use an explicit status-CAS in the service. Document
          // validation is where all discriminator coordinates are available.
          return isQueryValidationContext(this) || hasExactReviewerCoordinate(this as ScorecardValidationShape)
        },
        message: 'reviewerKind must match exactly one reviewer coordinate and its canonical reviewerKey',
      },
    },
    kitId: { type: Schema.Types.ObjectId, ref: 'HireInterviewKit', immutable: true },
    memberId: { type: Schema.Types.ObjectId, ref: 'HireWorkspaceMember', immutable: true },
    reviewerName: { type: String, required: true, trim: true, maxlength: 120, immutable: true },
    status: {
      type: String,
      enum: HIRE_HUMAN_SCORECARD_STATUSES,
      default: 'draft',
      validate: {
        validator(this: unknown) {
          return isQueryValidationContext(this) || hasValidScorecardState(this as ScorecardValidationShape)
        },
        message: 'draft/cancelled scorecards cannot carry submitted answers; submitted scorecards require all fixed answers, recommendation, comment, and timestamp',
      },
    },
    dimensions: {
      type: [ScorecardDimensionSchema],
      default: undefined,
      validate: {
        validator(value: IHireHumanScorecardDimension[] | undefined) {
          // Empty only represents an unsubmitted draft/cancelled record. Once
          // submitted it must carry all four fixed dimensions in order.
          return !value || value.length === 0 || hasCanonicalDimensions(value)
        },
        message: 'A scorecard must contain each fixed dimension exactly once in canonical order',
      },
    },
    recommendation: { type: String, enum: HIRE_HUMAN_SCORECARD_RECOMMENDATIONS },
    overallComment: { type: String, trim: true, maxlength: 4000 },
    submittedAt: { type: Date },
    cancelledAt: { type: Date },
    privacyRedactedAt: { type: Date },
  },
  { timestamps: true },
)

// The reviewer coordinate is explicit rather than an optional polymorphic ref;
// it keeps the unique index and public-kit ownership check straightforward.
HireHumanScorecardSchema.index({ workspaceId: 1, humanRoundId: 1, reviewerKey: 1 }, { unique: true })
HireHumanScorecardSchema.index({ workspaceId: 1, applicationId: 1, status: 1, createdAt: -1 })

export const HireHumanScorecard: Model<IHireHumanScorecard> =
  mongoose.models.HireHumanScorecard ||
  mongoose.model<IHireHumanScorecard>('HireHumanScorecard', HireHumanScorecardSchema)
