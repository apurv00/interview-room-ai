import mongoose, { Document, Model, Schema } from 'mongoose'

export const ADMIN_AUDIT_ACTIONS = [
  'billing_config_updated',
  'catalog_draft_created',
  'catalog_draft_updated',
  'catalog_validated',
  'catalog_approved',
  'catalog_published',
  'catalog_archived',
  'coupon_created',
  'coupon_updated',
  'coupon_approved',
  'coupon_activated',
  'coupon_paused',
  'coupon_expired',
  'entitlement_granted',
  'entitlement_extended',
  'entitlement_revoked',
  'entitlement_counter_reset',
  'tier_change_scheduled',
  'tier_cancellation_requested',
  'tier_resubscribe_requested',
  'tier_replacement_cancelled',
  'reconciliation_requested',
  'reconciliation_approved',
  'reconciliation_completed',
  'invoice_issued',
  'refund_requested',
  'refund_approved',
  'refund_recorded',
  'credit_note_issued',
  'access_reversal_decided',
  'dispute_recorded',
  'financial_document_reconciled',
  'interview_cost_allocation_requested',
  'interview_cost_allocation_approved',
  'interview_cost_allocation_rejected',
  'interview_cost_allocation_applied',
  'interview_cost_snapshot_created',
  'interview_cost_snapshot_approved',
] as const

export type AdminAuditAction = (typeof ADMIN_AUDIT_ACTIONS)[number]

export interface IAdminAuditLog extends Document {
  mutationId: string
  actorUserId: mongoose.Types.ObjectId
  actorEmailSnapshot: string
  actorRoleSnapshot: string
  action: AdminAuditAction
  targetType: string
  targetId: string
  reason: string
  beforeSnapshot?: unknown
  afterSnapshot?: unknown
  correlationId: string
  requestId?: string
  createdAt: Date
}

const AdminAuditLogSchema = new Schema<IAdminAuditLog>(
  {
    mutationId: { type: String, required: true, trim: true },
    actorUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    actorEmailSnapshot: { type: String, required: true },
    actorRoleSnapshot: { type: String, required: true },
    action: {
      type: String,
      enum: ADMIN_AUDIT_ACTIONS,
      required: true,
    },
    targetType: { type: String, required: true },
    targetId: { type: String, required: true },
    reason: { type: String, required: true, minlength: 10, maxlength: 2000 },
    beforeSnapshot: { type: Schema.Types.Mixed },
    afterSnapshot: { type: Schema.Types.Mixed },
    correlationId: { type: String, required: true },
    requestId: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
)

AdminAuditLogSchema.index({ mutationId: 1 }, { unique: true })
AdminAuditLogSchema.index({ createdAt: -1 })
AdminAuditLogSchema.index({ actorUserId: 1, createdAt: -1 })
AdminAuditLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 })
AdminAuditLogSchema.index({ correlationId: 1, createdAt: 1 })
AdminAuditLogSchema.index({ action: 1, targetType: 1, _id: 1 })

const rejectAuditMutation = function rejectAuditMutation(): never {
  throw new Error('AdminAuditLog is append-only')
}

AdminAuditLogSchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate'],
  { query: true, document: false },
  rejectAuditMutation,
)
AdminAuditLogSchema.pre(
  ['replaceOne', 'findOneAndReplace'],
  { query: true, document: false },
  rejectAuditMutation,
)
AdminAuditLogSchema.pre(
  ['deleteOne', 'deleteMany', 'findOneAndDelete'],
  { query: true, document: false },
  rejectAuditMutation,
)
AdminAuditLogSchema.pre(
  'updateOne',
  { query: false, document: true },
  rejectAuditMutation,
)
AdminAuditLogSchema.pre(
  'deleteOne',
  { query: false, document: true },
  rejectAuditMutation,
)
AdminAuditLogSchema.pre('save', function rejectExistingAuditSave() {
  if (!this.isNew) rejectAuditMutation()
})

export const AdminAuditLog: Model<IAdminAuditLog> =
  mongoose.models.AdminAuditLog ||
  mongoose.model<IAdminAuditLog>('AdminAuditLog', AdminAuditLogSchema)

export const BILLING_CATALOG_CACHE_INVALIDATION_RECEIPT_COLLECTION =
  'billing_catalog_cache_invalidation_receipts' as const

export const BILLING_CATALOG_CACHE_INVALIDATION_PATHS = [
  '/pricing',
  '/api/billing/catalog',
] as const

export interface IBillingCatalogCacheInvalidationReceipt
  extends Document<string> {
  _id: string
  schemaVersion: 1
  sourceAuditId: mongoose.Types.ObjectId
  sourceMutationId: string
  catalogVersion: string
  contentHash: string
  publishedAt: Date
  invalidatedPaths:
    typeof BILLING_CATALOG_CACHE_INVALIDATION_PATHS
  invalidatedAt: Date
  createdAt: Date
}

const BillingCatalogCacheInvalidationReceiptSchema =
  new Schema<IBillingCatalogCacheInvalidationReceipt>(
    {
      _id: {
        type: String,
        required: true,
        immutable: true,
        match: /^[a-f0-9]{64}$/,
      },
      schemaVersion: {
        type: Number,
        enum: [1],
        required: true,
        immutable: true,
      },
      sourceAuditId: {
        type: Schema.Types.ObjectId,
        ref: 'AdminAuditLog',
        required: true,
        immutable: true,
      },
      sourceMutationId: {
        type: String,
        required: true,
        trim: true,
        maxlength: 200,
        immutable: true,
      },
      catalogVersion: {
        type: String,
        required: true,
        trim: true,
        maxlength: 200,
        immutable: true,
      },
      contentHash: {
        type: String,
        required: true,
        match: /^[a-f0-9]{64}$/,
        immutable: true,
      },
      publishedAt: {
        type: Date,
        required: true,
        immutable: true,
      },
      invalidatedPaths: {
        type: [{
          type: String,
          enum: BILLING_CATALOG_CACHE_INVALIDATION_PATHS,
        }],
        required: true,
        immutable: true,
        validate: {
          validator: (paths: readonly string[]) => (
            paths.length ===
              BILLING_CATALOG_CACHE_INVALIDATION_PATHS.length &&
            paths.every((path, index) => (
              path === BILLING_CATALOG_CACHE_INVALIDATION_PATHS[index]
            ))
          ),
          message: 'Catalog cache invalidation paths must be exact',
        },
      },
      invalidatedAt: {
        type: Date,
        required: true,
        immutable: true,
      },
    },
    {
      collection:
        BILLING_CATALOG_CACHE_INVALIDATION_RECEIPT_COLLECTION,
      autoIndex: false,
      timestamps: { createdAt: true, updatedAt: false },
    },
  )

BillingCatalogCacheInvalidationReceiptSchema.index(
  { sourceAuditId: 1 },
  { unique: true },
)
BillingCatalogCacheInvalidationReceiptSchema.index(
  { sourceMutationId: 1 },
  { unique: true },
)

const rejectCacheReceiptMutation =
  function rejectCacheReceiptMutation(): never {
    throw new Error(
      'BillingCatalogCacheInvalidationReceipt is append-only',
    )
  }

BillingCatalogCacheInvalidationReceiptSchema.pre(
  [
    'updateOne',
    'updateMany',
    'findOneAndUpdate',
    'replaceOne',
    'findOneAndReplace',
    'deleteOne',
    'deleteMany',
    'findOneAndDelete',
  ],
  { query: true, document: false },
  rejectCacheReceiptMutation,
)
BillingCatalogCacheInvalidationReceiptSchema.pre(
  'deleteOne',
  { query: false, document: true },
  rejectCacheReceiptMutation,
)
BillingCatalogCacheInvalidationReceiptSchema.pre(
  'save',
  function rejectExistingCacheReceiptSave() {
    if (!this.isNew) rejectCacheReceiptMutation()
  },
)

export const BillingCatalogCacheInvalidationReceipt:
Model<IBillingCatalogCacheInvalidationReceipt> =
  mongoose.models.BillingCatalogCacheInvalidationReceipt ||
  mongoose.model<IBillingCatalogCacheInvalidationReceipt>(
    'BillingCatalogCacheInvalidationReceipt',
    BillingCatalogCacheInvalidationReceiptSchema,
  )
