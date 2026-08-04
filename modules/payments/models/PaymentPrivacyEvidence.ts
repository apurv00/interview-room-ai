import mongoose, {
  Document,
  Model,
  Schema,
} from 'mongoose'
import {
  PROVIDER_MODES,
  type ProviderMode,
} from '../types/catalog'

/**
 * Persistence is intentionally inert until legal, finance, privacy, and
 * security owners approve the registry and retention policies.
 */
export const PR6_PAYMENT_PRIVACY_EVIDENCE_WRITES_READY = false as const

export const RETAINED_PAYMENT_EVIDENCE_KINDS = [
  'payment_attempt',
  'invoice',
  'credit_note',
  'refund_record',
  'payment_webhook_event',
  'admin_audit_log',
  'coupon_redemption',
] as const
export type RetainedPaymentEvidenceKind =
  (typeof RETAINED_PAYMENT_EVIDENCE_KINDS)[number]

export const RETAINED_PAYMENT_SOURCE_MODELS = [
  'PaymentAttempt',
  'Invoice',
  'CreditNote',
  'RefundRecord',
  'PaymentWebhookEvent',
  'AdminAuditLog',
  'CouponRedemption',
] as const
export type RetainedPaymentSourceModel =
  (typeof RETAINED_PAYMENT_SOURCE_MODELS)[number]

export const PAYMENT_RETENTION_PURPOSES = [
  'tax_compliance',
  'financial_accounting',
  'payment_dispute_defence',
  'fraud_and_security',
  'provider_obligation',
  'audit_integrity',
] as const
export type PaymentRetentionPurpose =
  (typeof PAYMENT_RETENTION_PURPOSES)[number]

export const PAYMENT_RETENTION_LAWFUL_BASES = [
  'legal_obligation',
  'contract',
  'legitimate_interests',
] as const
export type PaymentRetentionLawfulBasis =
  (typeof PAYMENT_RETENTION_LAWFUL_BASES)[number]

export const RETAINED_PAYLOAD_STORAGE_STRATEGIES = [
  'inline_ciphertext',
  'restricted_object_store',
] as const
export type RetainedPayloadStorageStrategy =
  (typeof RETAINED_PAYLOAD_STORAGE_STRATEGIES)[number]

export const PAYMENT_LEGAL_HOLD_STATUSES = [
  'none',
  'active',
  'released',
] as const
export type PaymentLegalHoldStatus =
  (typeof PAYMENT_LEGAL_HOLD_STATUSES)[number]

export const PRIVACY_DISPOSITION_MODELS = [
  'CustomerBillingProfile',
  'RazorpayCustomer',
  'CheckoutIntent',
  'PaymentAttempt',
  'Subscription',
  'SubscriptionCycle',
  'Invoice',
  'CreditNote',
  'RefundRecord',
  'PaymentWebhookEvent',
  'AdminAuditLog',
  'CouponReservation',
  'CouponRedemption',
  'PaidInterviewUnlock',
  'ResumeEntitlement',
  'InterviewUsage',
] as const
export type PrivacyDispositionModel =
  (typeof PRIVACY_DISPOSITION_MODELS)[number]

export const PRIVACY_DISPOSITION_ACTIONS = [
  'deleted',
  'pseudonymized',
  'retained_statutory',
  'retained_operational',
  'unchanged_non_personal',
  'not_present',
] as const
export type PrivacyDispositionAction =
  (typeof PRIVACY_DISPOSITION_ACTIONS)[number]

export const EXTERNAL_PROVIDER_DISPOSITION_ACTIONS = [
  'no_customer_or_mandate',
  'mandates_confirmed_terminal',
  'customer_reference_pseudonymized',
  'provider_data_erasure_requested',
  'provider_data_erasure_confirmed',
  'review_required',
] as const
export type ExternalProviderDispositionAction =
  (typeof EXTERNAL_PROVIDER_DISPOSITION_ACTIONS)[number]

export const PRIVACY_DISPOSITION_RECEIPT_STATUSES = [
  'completed',
  'review_required',
  'review_resolved',
] as const
export type PrivacyDispositionReceiptStatus =
  (typeof PRIVACY_DISPOSITION_RECEIPT_STATUSES)[number]

export const PRIVACY_REVIEW_STATES = [
  'not_required',
  'open',
  'resolved',
] as const
export type PrivacyReviewState =
  (typeof PRIVACY_REVIEW_STATES)[number]

export interface IHmacPseudonymousReference {
  algorithm: 'hmac-sha256'
  context:
    | 'payment-retention-subject-v1'
    | 'razorpay-reference-v1'
    | 'privacy-reviewer-v1'
  keyVersion: string
  digest: string
}

export interface IRetainedPaymentSource {
  model: RetainedPaymentSourceModel
  providerMode: ProviderMode
  count: number
  sourceHash: string
  capturedAt: Date
}

export interface IRestrictedStatutoryPayload {
  storageStrategy: RetainedPayloadStorageStrategy
  inlineCiphertext?: string
  opaqueObjectKey?: string
  encryptionAlgorithm: 'aes-256-gcm'
  keyVersion: string
  initializationVector: string
  authenticationTag: string
  additionalAuthenticatedDataHash: string
  ciphertextHash: string
  plaintextSchemaVersion: string
  plaintextByteLength: number
  mediaType: 'application/json'
  accessPolicyId: string
  accessPolicyVersion: string
}

export interface IPaymentRetentionPolicySnapshot {
  registryVersion: string
  policyId: string
  policyVersion: string
  privacyPolicyVersion: string
  purpose: PaymentRetentionPurpose
  lawfulBasis: PaymentRetentionLawfulBasis
  retentionStartedAt: Date
  retentionEndsAt: Date
  approvedAt: Date
  approvalContentHash: string
}

export interface IPaymentLegalHoldSnapshot {
  status: PaymentLegalHoldStatus
  holdReferenceHash?: string
  reasonCode?: string
  placedAt?: Date
  releasedAt?: Date
}

export interface IRetainedPaymentEvidence extends Document {
  idempotencyKeyHash: string
  subjectRef: IHmacPseudonymousReference
  evidenceKind: RetainedPaymentEvidenceKind
  source: IRetainedPaymentSource
  statutoryPayload: IRestrictedStatutoryPayload
  policy: IPaymentRetentionPolicySnapshot
  legalHold: IPaymentLegalHoldSnapshot
  status: 'finalized'
  finalizedAt: Date
  createdAt: Date
}

export interface IPrivacyModelDisposition {
  model: PrivacyDispositionModel
  action: PrivacyDispositionAction
  sourceCount: number
  resultCount: number
  retainedEvidenceCount: number
  sourceHash: string
  resultHash: string
  retainedEvidenceManifestHash?: string
  completedAt: Date
}

export interface IExternalProviderDispositionEvidence {
  provider: 'razorpay'
  providerMode: ProviderMode
  action: ExternalProviderDispositionAction
  providerReferenceRef?: IHmacPseudonymousReference
  sourceCount: number
  evidenceHash: string
  observedAt: Date
}

export interface IPrivacyDispositionRegistrySnapshot {
  modelRegistryId: 'payment-privacy-disposition'
  modelRegistryVersion: string
  retentionPolicyId: string
  retentionPolicyVersion: string
  privacyPolicyId: string
  privacyPolicyVersion: string
  approvalContentHash: string
  approvedAt: Date
}

export interface IPrivacyDispositionReview {
  state: PrivacyReviewState
  reasonCode?: string
  openedAt?: Date
  resolutionCode?: string
  resolvedAt?: Date
  reviewerRef?: IHmacPseudonymousReference
}

export interface IPrivacyDispositionReceipt extends Document {
  idempotencyKeyHash: string
  subjectRef: IHmacPseudonymousReference
  sourceSnapshotHash: string
  registry: IPrivacyDispositionRegistrySnapshot
  modelDispositions: IPrivacyModelDisposition[]
  externalProviderEvidence: IExternalProviderDispositionEvidence[]
  status: PrivacyDispositionReceiptStatus
  review: IPrivacyDispositionReview
  supersedesReceiptHash?: string
  workflowStartedAt: Date
  finalizedAt: Date
  completedAt?: Date
  createdAt: Date
}

const strictSubdocumentOptions = {
  _id: false,
  strict: 'throw' as const,
}

const sha256Hex = /^[a-f0-9]{64}$/
const opaqueToken = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const reasonCode = /^[a-z][a-z0-9_]{2,99}$/

const nonNegativeSafeIntegerValidator = {
  validator: (value: number) => (
    Number.isSafeInteger(value) && value >= 0
  ),
  message: '{PATH} must be a non-negative safe integer',
}

const positiveSafeIntegerValidator = {
  validator: (value: number) => (
    Number.isSafeInteger(value) && value > 0
  ),
  message: '{PATH} must be a positive safe integer',
}

const HmacPseudonymousReferenceSchema =
  new Schema<IHmacPseudonymousReference>(
    {
      algorithm: {
        type: String,
        enum: ['hmac-sha256'],
        required: true,
        immutable: true,
      },
      context: {
        type: String,
        enum: [
          'payment-retention-subject-v1',
          'razorpay-reference-v1',
          'privacy-reviewer-v1',
        ],
        required: true,
        immutable: true,
      },
      keyVersion: {
        type: String,
        required: true,
        trim: true,
        minlength: 1,
        maxlength: 100,
        match: opaqueToken,
        immutable: true,
      },
      digest: {
        type: String,
        required: true,
        lowercase: true,
        match: sha256Hex,
        immutable: true,
      },
    },
    strictSubdocumentOptions,
  )

const RetainedPaymentSourceSchema =
  new Schema<IRetainedPaymentSource>(
    {
      model: {
        type: String,
        enum: RETAINED_PAYMENT_SOURCE_MODELS,
        required: true,
        immutable: true,
      },
      providerMode: {
        type: String,
        enum: PROVIDER_MODES,
        required: true,
        immutable: true,
      },
      count: {
        type: Number,
        required: true,
        immutable: true,
        validate: positiveSafeIntegerValidator,
      },
      sourceHash: {
        type: String,
        required: true,
        lowercase: true,
        match: sha256Hex,
        immutable: true,
      },
      capturedAt: {
        type: Date,
        required: true,
        immutable: true,
      },
    },
    strictSubdocumentOptions,
  )

const RestrictedStatutoryPayloadSchema =
  new Schema<IRestrictedStatutoryPayload>(
    {
      storageStrategy: {
        type: String,
        enum: RETAINED_PAYLOAD_STORAGE_STRATEGIES,
        required: true,
        immutable: true,
      },
      inlineCiphertext: {
        type: String,
        minlength: 24,
        maxlength: 8_000_000,
        match: /^[A-Za-z0-9+/_=-]+$/,
        immutable: true,
      },
      opaqueObjectKey: {
        type: String,
        lowercase: true,
        match: sha256Hex,
        immutable: true,
      },
      encryptionAlgorithm: {
        type: String,
        enum: ['aes-256-gcm'],
        required: true,
        immutable: true,
      },
      keyVersion: {
        type: String,
        required: true,
        trim: true,
        minlength: 1,
        maxlength: 100,
        match: opaqueToken,
        immutable: true,
      },
      initializationVector: {
        type: String,
        required: true,
        minlength: 16,
        maxlength: 32,
        match: /^[A-Za-z0-9+/_=-]+$/,
        immutable: true,
      },
      authenticationTag: {
        type: String,
        required: true,
        minlength: 16,
        maxlength: 64,
        match: /^[A-Za-z0-9+/_=-]+$/,
        immutable: true,
      },
      additionalAuthenticatedDataHash: {
        type: String,
        required: true,
        lowercase: true,
        match: sha256Hex,
        immutable: true,
      },
      ciphertextHash: {
        type: String,
        required: true,
        lowercase: true,
        match: sha256Hex,
        immutable: true,
      },
      plaintextSchemaVersion: {
        type: String,
        required: true,
        trim: true,
        minlength: 1,
        maxlength: 100,
        match: opaqueToken,
        immutable: true,
      },
      plaintextByteLength: {
        type: Number,
        required: true,
        immutable: true,
        validate: nonNegativeSafeIntegerValidator,
      },
      mediaType: {
        type: String,
        enum: ['application/json'],
        required: true,
        immutable: true,
      },
      accessPolicyId: {
        type: String,
        required: true,
        trim: true,
        minlength: 1,
        maxlength: 200,
        match: opaqueToken,
        immutable: true,
      },
      accessPolicyVersion: {
        type: String,
        required: true,
        trim: true,
        minlength: 1,
        maxlength: 100,
        match: opaqueToken,
        immutable: true,
      },
    },
    strictSubdocumentOptions,
  )

RestrictedStatutoryPayloadSchema.pre(
  'validate',
  function validateStorageDiscriminator() {
    if (this.storageStrategy === 'inline_ciphertext') {
      if (!this.inlineCiphertext) {
        this.invalidate(
          'inlineCiphertext',
          'Inline payload storage requires ciphertext',
        )
      }
      if (this.opaqueObjectKey) {
        this.invalidate(
          'opaqueObjectKey',
          'Inline payload storage cannot include an object key',
        )
      }
      return
    }

    if (this.storageStrategy === 'restricted_object_store') {
      if (!this.opaqueObjectKey) {
        this.invalidate(
          'opaqueObjectKey',
          'Restricted object storage requires an opaque object key',
        )
      }
      if (this.inlineCiphertext) {
        this.invalidate(
          'inlineCiphertext',
          'Restricted object storage cannot include inline ciphertext',
        )
      }
    }
  },
)

const PaymentRetentionPolicySnapshotSchema =
  new Schema<IPaymentRetentionPolicySnapshot>(
    {
      registryVersion: {
        type: String,
        required: true,
        trim: true,
        minlength: 1,
        maxlength: 100,
        match: opaqueToken,
        immutable: true,
      },
      policyId: {
        type: String,
        required: true,
        trim: true,
        minlength: 1,
        maxlength: 200,
        match: opaqueToken,
        immutable: true,
      },
      policyVersion: {
        type: String,
        required: true,
        trim: true,
        minlength: 1,
        maxlength: 100,
        match: opaqueToken,
        immutable: true,
      },
      privacyPolicyVersion: {
        type: String,
        required: true,
        trim: true,
        minlength: 1,
        maxlength: 100,
        match: opaqueToken,
        immutable: true,
      },
      purpose: {
        type: String,
        enum: PAYMENT_RETENTION_PURPOSES,
        required: true,
        immutable: true,
      },
      lawfulBasis: {
        type: String,
        enum: PAYMENT_RETENTION_LAWFUL_BASES,
        required: true,
        immutable: true,
      },
      retentionStartedAt: {
        type: Date,
        required: true,
        immutable: true,
      },
      retentionEndsAt: {
        type: Date,
        required: true,
        immutable: true,
      },
      approvedAt: {
        type: Date,
        required: true,
        immutable: true,
      },
      approvalContentHash: {
        type: String,
        required: true,
        lowercase: true,
        match: sha256Hex,
        immutable: true,
      },
    },
    strictSubdocumentOptions,
  )

PaymentRetentionPolicySnapshotSchema.pre(
  'validate',
  function validateRetentionWindow() {
    if (this.retentionEndsAt <= this.retentionStartedAt) {
      this.invalidate(
        'retentionEndsAt',
        'Retention end must be after retention start',
      )
    }
    if (this.approvedAt > this.retentionStartedAt) {
      this.invalidate(
        'approvedAt',
        'Retention policy must be approved before retention starts',
      )
    }
  },
)

const PaymentLegalHoldSnapshotSchema =
  new Schema<IPaymentLegalHoldSnapshot>(
    {
      status: {
        type: String,
        enum: PAYMENT_LEGAL_HOLD_STATUSES,
        required: true,
        immutable: true,
      },
      holdReferenceHash: {
        type: String,
        lowercase: true,
        match: sha256Hex,
        immutable: true,
      },
      reasonCode: {
        type: String,
        trim: true,
        lowercase: true,
        match: reasonCode,
        immutable: true,
      },
      placedAt: { type: Date, immutable: true },
      releasedAt: { type: Date, immutable: true },
    },
    strictSubdocumentOptions,
  )

PaymentLegalHoldSnapshotSchema.pre(
  'validate',
  function validateLegalHold() {
    const hasHoldMetadata = Boolean(
      this.holdReferenceHash || this.reasonCode || this.placedAt,
    )

    if (this.status === 'none') {
      if (hasHoldMetadata || this.releasedAt) {
        this.invalidate(
          'status',
          'A no-hold snapshot cannot include hold metadata',
        )
      }
      return
    }

    if (
      !this.holdReferenceHash ||
      !this.reasonCode ||
      !this.placedAt
    ) {
      this.invalidate(
        'holdReferenceHash',
        'Active or released legal hold requires reference, reason, and placement date',
      )
    }
    if (this.status === 'active' && this.releasedAt) {
      this.invalidate(
        'releasedAt',
        'Active legal hold cannot have a release date',
      )
    }
    if (this.status === 'released') {
      if (!this.releasedAt) {
        this.invalidate(
          'releasedAt',
          'Released legal hold requires a release date',
        )
      } else if (this.placedAt && this.releasedAt < this.placedAt) {
        this.invalidate(
          'releasedAt',
          'Legal hold cannot be released before it is placed',
        )
      }
    }
  },
)

const RetainedPaymentEvidenceSchema =
  new Schema<IRetainedPaymentEvidence>(
    {
      idempotencyKeyHash: {
        type: String,
        required: true,
        lowercase: true,
        match: sha256Hex,
        immutable: true,
      },
      subjectRef: {
        type: HmacPseudonymousReferenceSchema,
        required: true,
        immutable: true,
      },
      evidenceKind: {
        type: String,
        enum: RETAINED_PAYMENT_EVIDENCE_KINDS,
        required: true,
        immutable: true,
      },
      source: {
        type: RetainedPaymentSourceSchema,
        required: true,
        immutable: true,
      },
      statutoryPayload: {
        type: RestrictedStatutoryPayloadSchema,
        required: true,
        immutable: true,
      },
      policy: {
        type: PaymentRetentionPolicySnapshotSchema,
        required: true,
        immutable: true,
      },
      legalHold: {
        type: PaymentLegalHoldSnapshotSchema,
        required: true,
        immutable: true,
      },
      status: {
        type: String,
        enum: ['finalized'],
        required: true,
        immutable: true,
      },
      finalizedAt: {
        type: Date,
        required: true,
        immutable: true,
      },
    },
    {
      timestamps: { createdAt: true, updatedAt: false },
      strict: 'throw',
    },
  )

const expectedSourceModelByKind:
Record<RetainedPaymentEvidenceKind, RetainedPaymentSourceModel> = {
  payment_attempt: 'PaymentAttempt',
  invoice: 'Invoice',
  credit_note: 'CreditNote',
  refund_record: 'RefundRecord',
  payment_webhook_event: 'PaymentWebhookEvent',
  admin_audit_log: 'AdminAuditLog',
  coupon_redemption: 'CouponRedemption',
}

RetainedPaymentEvidenceSchema.pre(
  'validate',
  function validateFinalizedEvidence() {
    if (this.subjectRef?.context !== 'payment-retention-subject-v1') {
      this.invalidate(
        'subjectRef.context',
        'Retained evidence requires the payment-retention subject context',
      )
    }

    const expectedSourceModel =
      expectedSourceModelByKind[this.evidenceKind]
    if (this.source?.model !== expectedSourceModel) {
      this.invalidate(
        'source.model',
        'Evidence kind does not match its registered source model',
      )
    }

    if (this.source && this.finalizedAt < this.source.capturedAt) {
      this.invalidate(
        'finalizedAt',
        'Evidence cannot be finalized before source capture',
      )
    }
  },
)

RetainedPaymentEvidenceSchema.index(
  { idempotencyKeyHash: 1 },
  { unique: true },
)
RetainedPaymentEvidenceSchema.index(
  {
    'subjectRef.keyVersion': 1,
    'subjectRef.digest': 1,
    evidenceKind: 1,
    'source.sourceHash': 1,
    'policy.policyVersion': 1,
  },
  { unique: true },
)
RetainedPaymentEvidenceSchema.index({
  'policy.retentionEndsAt': 1,
  'legalHold.status': 1,
  status: 1,
})
RetainedPaymentEvidenceSchema.index({
  'subjectRef.keyVersion': 1,
  'subjectRef.digest': 1,
  finalizedAt: -1,
})

const PrivacyModelDispositionSchema =
  new Schema<IPrivacyModelDisposition>(
    {
      model: {
        type: String,
        enum: PRIVACY_DISPOSITION_MODELS,
        required: true,
        immutable: true,
      },
      action: {
        type: String,
        enum: PRIVACY_DISPOSITION_ACTIONS,
        required: true,
        immutable: true,
      },
      sourceCount: {
        type: Number,
        required: true,
        immutable: true,
        validate: nonNegativeSafeIntegerValidator,
      },
      resultCount: {
        type: Number,
        required: true,
        immutable: true,
        validate: nonNegativeSafeIntegerValidator,
      },
      retainedEvidenceCount: {
        type: Number,
        required: true,
        immutable: true,
        validate: nonNegativeSafeIntegerValidator,
      },
      sourceHash: {
        type: String,
        required: true,
        lowercase: true,
        match: sha256Hex,
        immutable: true,
      },
      resultHash: {
        type: String,
        required: true,
        lowercase: true,
        match: sha256Hex,
        immutable: true,
      },
      retainedEvidenceManifestHash: {
        type: String,
        lowercase: true,
        match: sha256Hex,
        immutable: true,
      },
      completedAt: {
        type: Date,
        required: true,
        immutable: true,
      },
    },
    strictSubdocumentOptions,
  )

PrivacyModelDispositionSchema.pre(
  'validate',
  function validateDispositionCounts() {
    if (
      (this.action === 'not_present') &&
      (
        this.sourceCount !== 0 ||
        this.resultCount !== 0 ||
        this.retainedEvidenceCount !== 0
      )
    ) {
      this.invalidate(
        'sourceCount',
        'Not-present disposition requires zero counts',
      )
    }
    if (this.action === 'deleted' && this.resultCount !== 0) {
      this.invalidate(
        'resultCount',
        'Deleted disposition requires zero result rows',
      )
    }
    if (
      (
        this.action === 'pseudonymized' ||
        this.action === 'unchanged_non_personal'
      ) &&
      this.resultCount !== this.sourceCount
    ) {
      this.invalidate(
        'resultCount',
        'Pseudonymized or non-personal rows must preserve source count',
      )
    }
    if (
      (
        this.action === 'retained_statutory' ||
        this.action === 'retained_operational'
      ) &&
      (
        this.resultCount !== this.sourceCount ||
        this.retainedEvidenceCount !== this.resultCount
      )
    ) {
      this.invalidate(
        'retainedEvidenceCount',
        'Retained rows require matching source, result, and evidence counts',
      )
    }
    if (
      (this.retainedEvidenceCount > 0) !==
      Boolean(this.retainedEvidenceManifestHash)
    ) {
      this.invalidate(
        'retainedEvidenceManifestHash',
        'Retained evidence count and manifest hash must be present together',
      )
    }
  },
)

const ExternalProviderDispositionEvidenceSchema =
  new Schema<IExternalProviderDispositionEvidence>(
    {
      provider: {
        type: String,
        enum: ['razorpay'],
        required: true,
        immutable: true,
      },
      providerMode: {
        type: String,
        enum: PROVIDER_MODES,
        required: true,
        immutable: true,
      },
      action: {
        type: String,
        enum: EXTERNAL_PROVIDER_DISPOSITION_ACTIONS,
        required: true,
        immutable: true,
      },
      providerReferenceRef: {
        type: HmacPseudonymousReferenceSchema,
        immutable: true,
      },
      sourceCount: {
        type: Number,
        required: true,
        immutable: true,
        validate: nonNegativeSafeIntegerValidator,
      },
      evidenceHash: {
        type: String,
        required: true,
        lowercase: true,
        match: sha256Hex,
        immutable: true,
      },
      observedAt: {
        type: Date,
        required: true,
        immutable: true,
      },
    },
    strictSubdocumentOptions,
  )

ExternalProviderDispositionEvidenceSchema.pre(
  'validate',
  function validateProviderReference() {
    if (this.action === 'no_customer_or_mandate') {
      if (this.sourceCount !== 0 || this.providerReferenceRef) {
        this.invalidate(
          'sourceCount',
          'No-provider-object evidence requires zero count and no reference',
        )
      }
      return
    }

    if (
      this.action !== 'review_required' &&
      !this.providerReferenceRef
    ) {
      this.invalidate(
        'providerReferenceRef',
        'Verified provider action requires an HMAC reference',
      )
    }
    if (
      this.providerReferenceRef &&
      this.providerReferenceRef.context !== 'razorpay-reference-v1'
    ) {
      this.invalidate(
        'providerReferenceRef.context',
        'Provider evidence requires the Razorpay reference context',
      )
    }
  },
)

const PrivacyDispositionRegistrySnapshotSchema =
  new Schema<IPrivacyDispositionRegistrySnapshot>(
    {
      modelRegistryId: {
        type: String,
        enum: ['payment-privacy-disposition'],
        required: true,
        immutable: true,
      },
      modelRegistryVersion: {
        type: String,
        required: true,
        trim: true,
        minlength: 1,
        maxlength: 100,
        match: opaqueToken,
        immutable: true,
      },
      retentionPolicyId: {
        type: String,
        required: true,
        trim: true,
        minlength: 1,
        maxlength: 200,
        match: opaqueToken,
        immutable: true,
      },
      retentionPolicyVersion: {
        type: String,
        required: true,
        trim: true,
        minlength: 1,
        maxlength: 100,
        match: opaqueToken,
        immutable: true,
      },
      privacyPolicyId: {
        type: String,
        required: true,
        trim: true,
        minlength: 1,
        maxlength: 200,
        match: opaqueToken,
        immutable: true,
      },
      privacyPolicyVersion: {
        type: String,
        required: true,
        trim: true,
        minlength: 1,
        maxlength: 100,
        match: opaqueToken,
        immutable: true,
      },
      approvalContentHash: {
        type: String,
        required: true,
        lowercase: true,
        match: sha256Hex,
        immutable: true,
      },
      approvedAt: {
        type: Date,
        required: true,
        immutable: true,
      },
    },
    strictSubdocumentOptions,
  )

const PrivacyDispositionReviewSchema =
  new Schema<IPrivacyDispositionReview>(
    {
      state: {
        type: String,
        enum: PRIVACY_REVIEW_STATES,
        required: true,
        immutable: true,
      },
      reasonCode: {
        type: String,
        trim: true,
        lowercase: true,
        match: reasonCode,
        immutable: true,
      },
      openedAt: { type: Date, immutable: true },
      resolutionCode: {
        type: String,
        trim: true,
        lowercase: true,
        match: reasonCode,
        immutable: true,
      },
      resolvedAt: { type: Date, immutable: true },
      reviewerRef: {
        type: HmacPseudonymousReferenceSchema,
        immutable: true,
      },
    },
    strictSubdocumentOptions,
  )

PrivacyDispositionReviewSchema.pre(
  'validate',
  function validateReviewState() {
    if (this.state === 'not_required') {
      if (
        this.reasonCode ||
        this.openedAt ||
        this.resolutionCode ||
        this.resolvedAt ||
        this.reviewerRef
      ) {
        this.invalidate(
          'state',
          'No-review snapshot cannot include review metadata',
        )
      }
      return
    }

    if (!this.reasonCode || !this.openedAt) {
      this.invalidate(
        'reasonCode',
        'Open or resolved review requires a reason and openedAt',
      )
    }
    if (this.state === 'open') {
      if (this.resolutionCode || this.resolvedAt || this.reviewerRef) {
        this.invalidate(
          'state',
          'Open review cannot include resolution metadata',
        )
      }
      return
    }

    if (
      !this.resolutionCode ||
      !this.resolvedAt ||
      !this.reviewerRef
    ) {
      this.invalidate(
        'resolutionCode',
        'Resolved review requires resolution, timestamp, and reviewer reference',
      )
    }
    if (
      this.resolvedAt &&
      this.openedAt &&
      this.resolvedAt < this.openedAt
    ) {
      this.invalidate(
        'resolvedAt',
        'Review cannot resolve before it opens',
      )
    }
    if (
      this.reviewerRef &&
      this.reviewerRef.context !== 'privacy-reviewer-v1'
    ) {
      this.invalidate(
        'reviewerRef.context',
        'Reviewer reference requires the privacy-reviewer context',
      )
    }
  },
)

const PrivacyDispositionReceiptSchema =
  new Schema<IPrivacyDispositionReceipt>(
    {
      idempotencyKeyHash: {
        type: String,
        required: true,
        lowercase: true,
        match: sha256Hex,
        immutable: true,
      },
      subjectRef: {
        type: HmacPseudonymousReferenceSchema,
        required: true,
        immutable: true,
      },
      sourceSnapshotHash: {
        type: String,
        required: true,
        lowercase: true,
        match: sha256Hex,
        immutable: true,
      },
      registry: {
        type: PrivacyDispositionRegistrySnapshotSchema,
        required: true,
        immutable: true,
      },
      modelDispositions: {
        type: [PrivacyModelDispositionSchema],
        required: true,
        immutable: true,
        validate: {
          validator: (value: IPrivacyModelDisposition[]) => (
            Array.isArray(value) &&
            value.length > 0 &&
            new Set(value.map((entry) => entry.model)).size === value.length
          ),
          message: 'Disposition receipt requires unique model entries',
        },
      },
      externalProviderEvidence: {
        type: [ExternalProviderDispositionEvidenceSchema],
        required: true,
        immutable: true,
        default: [],
      },
      status: {
        type: String,
        enum: PRIVACY_DISPOSITION_RECEIPT_STATUSES,
        required: true,
        immutable: true,
      },
      review: {
        type: PrivacyDispositionReviewSchema,
        required: true,
        immutable: true,
      },
      supersedesReceiptHash: {
        type: String,
        lowercase: true,
        match: sha256Hex,
        immutable: true,
      },
      workflowStartedAt: {
        type: Date,
        required: true,
        immutable: true,
      },
      finalizedAt: {
        type: Date,
        required: true,
        immutable: true,
      },
      completedAt: { type: Date, immutable: true },
    },
    {
      timestamps: { createdAt: true, updatedAt: false },
      strict: 'throw',
    },
  )

PrivacyDispositionReceiptSchema.pre(
  'validate',
  function validateFinalReceipt() {
    if (this.subjectRef?.context !== 'payment-retention-subject-v1') {
      this.invalidate(
        'subjectRef.context',
        'Disposition receipt requires the payment-retention subject context',
      )
    }
    if (this.finalizedAt < this.workflowStartedAt) {
      this.invalidate(
        'finalizedAt',
        'Receipt cannot finalize before the workflow starts',
      )
    }
    if (this.registry?.approvedAt > this.workflowStartedAt) {
      this.invalidate(
        'registry.approvedAt',
        'Disposition policy must be approved before the workflow starts',
      )
    }
    if (
      this.modelDispositions.some(
        (entry) => entry.completedAt > this.finalizedAt,
      )
    ) {
      this.invalidate(
        'modelDispositions',
        'Model disposition cannot complete after receipt finalization',
      )
    }
    if (
      this.externalProviderEvidence.some(
        (entry) => entry.observedAt > this.finalizedAt,
      )
    ) {
      this.invalidate(
        'externalProviderEvidence',
        'Provider evidence cannot be observed after receipt finalization',
      )
    }

    if (this.status === 'review_required') {
      if (this.review?.state !== 'open' || this.completedAt) {
        this.invalidate(
          'review.state',
          'Review-required receipt needs an open review and no completion date',
        )
      }
      return
    }

    if (!this.completedAt || this.completedAt < this.finalizedAt) {
      this.invalidate(
        'completedAt',
        'Completed receipt requires completion at or after finalization',
      )
    }
    if (
      this.status === 'completed' &&
      this.review?.state !== 'not_required'
    ) {
      this.invalidate(
        'review.state',
        'Completed receipt cannot carry a review workflow',
      )
    }
    if (
      this.status === 'review_resolved' &&
      (
        this.review?.state !== 'resolved' ||
        !this.supersedesReceiptHash
      )
    ) {
      this.invalidate(
        'review.state',
        'Resolved receipt requires resolved review and superseded receipt hash',
      )
    }
  },
)

PrivacyDispositionReceiptSchema.index(
  { idempotencyKeyHash: 1 },
  { unique: true },
)
PrivacyDispositionReceiptSchema.index(
  {
    'subjectRef.keyVersion': 1,
    'subjectRef.digest': 1,
    sourceSnapshotHash: 1,
    'registry.modelRegistryVersion': 1,
  },
  { unique: true },
)
PrivacyDispositionReceiptSchema.index({
  status: 1,
  finalizedAt: -1,
})
PrivacyDispositionReceiptSchema.index({
  'subjectRef.keyVersion': 1,
  'subjectRef.digest': 1,
  finalizedAt: -1,
})

function rejectFinalizedMutation(
  modelName: string,
): () => never {
  return function rejectMutation(): never {
    throw new Error(`${modelName} finalized records are immutable`)
  }
}

RetainedPaymentEvidenceSchema.pre(
  [
    'updateOne',
    'updateMany',
    'findOneAndUpdate',
    'replaceOne',
    'findOneAndReplace',
  ],
  { query: true, document: false },
  rejectFinalizedMutation('RetainedPaymentEvidence'),
)
PrivacyDispositionReceiptSchema.pre(
  [
    'updateOne',
    'updateMany',
    'findOneAndUpdate',
    'replaceOne',
    'findOneAndReplace',
  ],
  { query: true, document: false },
  rejectFinalizedMutation('PrivacyDispositionReceipt'),
)

RetainedPaymentEvidenceSchema.pre(
  'updateOne',
  { query: false, document: true },
  rejectFinalizedMutation('RetainedPaymentEvidence'),
)
PrivacyDispositionReceiptSchema.pre(
  'updateOne',
  { query: false, document: true },
  rejectFinalizedMutation('PrivacyDispositionReceipt'),
)

RetainedPaymentEvidenceSchema.pre(
  'save',
  function rejectExistingEvidenceSave() {
    if (!this.isNew) {
      throw new Error(
        'RetainedPaymentEvidence finalized records are immutable',
      )
    }
  },
)
PrivacyDispositionReceiptSchema.pre(
  'save',
  function rejectExistingReceiptSave() {
    if (!this.isNew) {
      throw new Error(
        'PrivacyDispositionReceipt finalized records are immutable',
      )
    }
  },
)

const rejectReceiptDeletion =
  rejectFinalizedMutation('PrivacyDispositionReceipt')

PrivacyDispositionReceiptSchema.pre(
  [
    'deleteOne',
    'deleteMany',
    'findOneAndDelete',
  ],
  { query: true, document: false },
  rejectReceiptDeletion,
)
PrivacyDispositionReceiptSchema.pre(
  'deleteOne',
  { query: false, document: true },
  rejectReceiptDeletion,
)

export const RetainedPaymentEvidence: Model<IRetainedPaymentEvidence> =
  mongoose.models.RetainedPaymentEvidence ||
  mongoose.model<IRetainedPaymentEvidence>(
    'RetainedPaymentEvidence',
    RetainedPaymentEvidenceSchema,
  )

export const PrivacyDispositionReceipt: Model<IPrivacyDispositionReceipt> =
  mongoose.models.PrivacyDispositionReceipt ||
  mongoose.model<IPrivacyDispositionReceipt>(
    'PrivacyDispositionReceipt',
    PrivacyDispositionReceiptSchema,
  )
