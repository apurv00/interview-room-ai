import mongoose, {
  Document,
  Model,
  Query,
  Schema,
} from 'mongoose'
import {
  CATALOG_STATUSES,
  type CatalogApprovalSnapshot,
  type CatalogContent,
  type CatalogStatus,
  type CatalogValidationSnapshot,
  type ProviderMode,
  type ProviderVerificationSnapshot,
} from '../types/catalog'

export interface IPlanCatalogVersion extends Document {
  version: string
  status: CatalogStatus
  editRevision: number
  effectiveAt?: Date
  content: CatalogContent
  contentHash: string
  validation?: CatalogValidationSnapshot
  approval?: CatalogApprovalSnapshot
  providerVerification?: Partial<
    Record<ProviderMode, ProviderVerificationSnapshot>
  >
  sourceVersion?: string
  createdBy: mongoose.Types.ObjectId
  publishedBy?: mongoose.Types.ObjectId
  changeReason: string
  publishedAt?: Date
  createdAt: Date
  updatedAt: Date
}

const PlanCatalogVersionSchema = new Schema<IPlanCatalogVersion>(
  {
    version: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: CATALOG_STATUSES,
      default: 'draft',
      required: true,
    },
    editRevision: { type: Number, required: true, min: 0, default: 0 },
    effectiveAt: { type: Date },
    content: { type: Schema.Types.Mixed, required: true },
    contentHash: { type: String, required: true, minlength: 64, maxlength: 64 },
    validation: { type: Schema.Types.Mixed },
    approval: { type: Schema.Types.Mixed },
    providerVerification: { type: Schema.Types.Mixed },
    sourceVersion: { type: String, trim: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    publishedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    changeReason: {
      type: String,
      required: true,
      trim: true,
      minlength: 10,
      maxlength: 2000,
    },
    publishedAt: { type: Date },
  },
  { timestamps: true },
)

PlanCatalogVersionSchema.index({ version: 1 }, { unique: true })
PlanCatalogVersionSchema.index({ status: 1, effectiveAt: 1 })
PlanCatalogVersionSchema.index({ createdAt: -1 })

function updateOnlyArchivesCatalog(update: unknown): boolean {
  if (!update || typeof update !== 'object') return false
  const record = update as Record<string, unknown>
  const set = (
    record.$set && typeof record.$set === 'object'
      ? record.$set
      : record
  ) as Record<string, unknown>
  const allowed = new Set(['status', 'updatedAt'])
  return set.status === 'archived' &&
    Object.keys(set).every((key) => allowed.has(key)) &&
    !record.$unset &&
    !record.$inc
}

async function rejectImmutableCatalogUpdate(
  this: Query<unknown, IPlanCatalogVersion>,
): Promise<void> {
  const current = await this.model
    .findOne(this.getFilter())
    .select('status')
    .lean<{ status: CatalogStatus }>()
  if (!current || current.status === 'draft') return
  if (current.status === 'published' && updateOnlyArchivesCatalog(this.getUpdate())) {
    return
  }
  const update = this.getUpdate() as Record<string, unknown> | null
  const set = update?.$set as Record<string, unknown> | undefined
  if (current.status === 'scheduled' && set?.status === 'published' &&
    set.publishedAt instanceof Date &&
    !update?.$unset && !update?.$inc &&
    Object.keys(set).every((key) =>
      ['status', 'publishedAt', 'updatedAt'].includes(key))) return
  throw new Error('Published, scheduled, and archived catalogs are immutable')
}

async function rejectImmutableCatalogDelete(
  this: Query<unknown, IPlanCatalogVersion>,
): Promise<void> {
  const current = await this.model
    .findOne(this.getFilter())
    .select('status')
    .lean<{ status: CatalogStatus }>()
  if (current && current.status !== 'draft') {
    throw new Error('Only draft catalogs can be deleted')
  }
}

PlanCatalogVersionSchema.pre('updateOne', rejectImmutableCatalogUpdate)
PlanCatalogVersionSchema.pre('findOneAndUpdate', rejectImmutableCatalogUpdate)
PlanCatalogVersionSchema.pre('replaceOne', rejectImmutableCatalogUpdate)
PlanCatalogVersionSchema.pre('updateMany', function rejectCatalogBulkUpdate() {
  throw new Error('Catalog bulk updates are not allowed')
})
PlanCatalogVersionSchema.pre('deleteOne', rejectImmutableCatalogDelete)
PlanCatalogVersionSchema.pre('findOneAndDelete', rejectImmutableCatalogDelete)
PlanCatalogVersionSchema.pre('deleteMany', function rejectCatalogBulkDelete() {
  throw new Error('Catalog bulk deletes are not allowed')
})
PlanCatalogVersionSchema.pre('save', function rejectCatalogDocumentMutation() {
  if (
    !this.isNew &&
    this.status !== 'draft' &&
    (this.isModified('content') || this.isModified('contentHash'))
  ) {
    throw new Error('Published, scheduled, and archived catalogs are immutable')
  }
})

export const PlanCatalogVersion: Model<IPlanCatalogVersion> =
  mongoose.models.PlanCatalogVersion ||
  mongoose.model<IPlanCatalogVersion>(
    'PlanCatalogVersion',
    PlanCatalogVersionSchema,
  )
