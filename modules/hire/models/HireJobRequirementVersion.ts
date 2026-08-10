import mongoose, { Schema, Document, Model } from 'mongoose'

export const HIRE_WORK_MODES = ['onsite', 'hybrid', 'remote'] as const
export type HireWorkMode = (typeof HIRE_WORK_MODES)[number]

export const HIRE_REQUIREMENT_IMPORTANCE = ['must_have', 'nice_to_have'] as const
export type HireRequirementImportance = (typeof HIRE_REQUIREMENT_IMPORTANCE)[number]

export const HIRE_REQUIREMENT_VERSION_STATES = [
  'active',
  'superseded',
  'needs_review',
] as const
export type HireRequirementVersionState =
  (typeof HIRE_REQUIREMENT_VERSION_STATES)[number]

export interface IHireStructuredRequirement {
  id: string
  text: string
  importance: HireRequirementImportance
}

export interface IHireJobBuilderInput {
  role: string
  level: string
  mustHaves: string[]
  niceToHaves: string[]
  location: string
  workMode: HireWorkMode
  compensation?: string
  companyBlurb?: string
}

/**
 * Immutable scoring contract for one job revision. The prose JD is a rendered
 * artifact; `requirements` is the authority used by matching and interview
 * configuration. Edits create another document rather than mutating this one,
 * so every score and round can retain the exact contract it used.
 */
export interface IHireJobRequirementVersion extends Document {
  _id: mongoose.Types.ObjectId
  workspaceId: mongoose.Types.ObjectId
  jobId: mongoose.Types.ObjectId
  version: number
  state: HireRequirementVersionState
  input: IHireJobBuilderInput
  proseJd: string
  requirements: IHireStructuredRequirement[]
  contentHash: string
  createdByMemberId: mongoose.Types.ObjectId
  createdByName: string
  createdAt: Date
  updatedAt: Date
}

const HireStructuredRequirementSchema = new Schema<IHireStructuredRequirement>(
  {
    id: { type: String, required: true, maxlength: 80 },
    text: { type: String, required: true, trim: true, maxlength: 500 },
    importance: {
      type: String,
      enum: HIRE_REQUIREMENT_IMPORTANCE,
      required: true,
    },
  },
  { _id: false },
)

const HireJobBuilderInputSchema = new Schema<IHireJobBuilderInput>(
  {
    role: { type: String, required: true, trim: true, maxlength: 100 },
    level: { type: String, required: true, trim: true, maxlength: 80 },
    mustHaves: {
      type: [{ type: String, trim: true, maxlength: 500 }],
      required: true,
      validate: {
        validator: (items: string[]) => items.length >= 1 && items.length <= 20,
        message: 'mustHaves must contain between 1 and 20 requirements',
      },
    },
    niceToHaves: {
      type: [{ type: String, trim: true, maxlength: 500 }],
      default: [],
      validate: {
        validator: (items: string[]) => items.length <= 20,
        message: 'niceToHaves cannot contain more than 20 requirements',
      },
    },
    location: { type: String, required: true, trim: true, maxlength: 160 },
    workMode: { type: String, enum: HIRE_WORK_MODES, required: true },
    compensation: { type: String, trim: true, maxlength: 240 },
    companyBlurb: { type: String, trim: true, maxlength: 2000 },
  },
  { _id: false },
)

const HireJobRequirementVersionSchema = new Schema<IHireJobRequirementVersion>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: 'HireWorkspace',
      required: true,
      immutable: true,
    },
    jobId: {
      type: Schema.Types.ObjectId,
      ref: 'HireJob',
      required: true,
      immutable: true,
    },
    version: { type: Number, required: true, min: 1, immutable: true },
    state: {
      type: String,
      enum: HIRE_REQUIREMENT_VERSION_STATES,
      required: true,
    },
    input: { type: HireJobBuilderInputSchema, required: true, immutable: true },
    proseJd: { type: String, required: true, maxlength: 50000, immutable: true },
    requirements: {
      type: [HireStructuredRequirementSchema],
      required: true,
      immutable: true,
      validate: {
        validator: (requirements: IHireStructuredRequirement[]) => {
          const ids = requirements.map((requirement) => requirement.id)
          return requirements.length >= 1 && requirements.length <= 40 && new Set(ids).size === ids.length
        },
        message: 'requirements must contain 1-40 rows with unique ids',
      },
    },
    contentHash: {
      type: String,
      required: true,
      minlength: 64,
      maxlength: 64,
      match: /^[a-f0-9]{64}$/,
      immutable: true,
    },
    createdByMemberId: {
      type: Schema.Types.ObjectId,
      ref: 'HireWorkspaceMember',
      required: true,
      immutable: true,
    },
    createdByName: {
      type: String,
      required: true,
      maxlength: 120,
      immutable: true,
    },
  },
  { timestamps: true },
)

HireJobRequirementVersionSchema.index(
  { workspaceId: 1, jobId: 1, version: 1 },
  { unique: true },
)
HireJobRequirementVersionSchema.index(
  { workspaceId: 1, jobId: 1, state: 1 },
  { unique: true, partialFilterExpression: { state: 'active' } },
)
HireJobRequirementVersionSchema.index({ workspaceId: 1, contentHash: 1 })

export const HireJobRequirementVersion: Model<IHireJobRequirementVersion> =
  mongoose.models.HireJobRequirementVersion ||
  mongoose.model<IHireJobRequirementVersion>(
    'HireJobRequirementVersion',
    HireJobRequirementVersionSchema,
  )
