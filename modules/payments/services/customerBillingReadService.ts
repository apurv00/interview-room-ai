import type { ProviderMode } from '../types/catalog'

/**
 * Narrow payment-authority entrypoint for the customer-billing read plane.
 *
 * The customer-facing readers live in `modules/customer-billing`. Payment
 * persistence, policy, and the canonical error identities remain here so the
 * dependency direction is always customer-billing -> payments.
 */
export { PR6_CUSTOMER_BILLING_UI_READY } from '@shared/services/planConfig'
export const PR6_BILLING_PROFILE_WRITES_READY = true
export const PR6_FINANCIAL_PDF_READY = false

export class CustomerBillingUnavailableError extends Error {
  readonly code:
    | 'catalog_unavailable'
    | 'customer_unavailable'
    | 'financial_integrity_review'
    | 'invalid_cursor'
    | 'test_mode_unavailable'

  constructor(code: CustomerBillingUnavailableError['code']) {
    super('Customer billing information is temporarily unavailable')
    this.name = 'CustomerBillingUnavailableError'
    this.code = code
  }
}

export class CustomerBillingProfileConflictError extends Error {
  constructor() {
    super('Customer billing profile changed concurrently')
    this.name = 'CustomerBillingProfileConflictError'
  }
}

export class CustomerBillingProfileWritesUnavailableError extends Error {
  constructor() {
    super('Customer billing profile writes are not ready')
    this.name = 'CustomerBillingProfileWritesUnavailableError'
  }
}

export class CustomerFinancialDocumentNotFoundError extends Error {
  constructor() {
    super('Financial document was not found')
    this.name = 'CustomerFinancialDocumentNotFoundError'
  }
}

export const EXACT_LOCAL_REFUND_EVIDENCE_READ_POLICY = Object.freeze({
  consistency: 'snapshot_session',
  totalReadBudgetMs: 5_000,
  perQueryMaxTimeMs: 750,
  exactMatchLimit: 2,
  refundRecordLimit: 50,
  providerReadsAllowed: false,
} as const)

type ExactRefundNotFoundCode =
  | 'target_not_found'
  | 'payment_not_found'
  | 'invoice_not_found'
  | 'fulfillment_not_found'

type ExactRefundConflictCode =
  | 'ambiguous_local_evidence'
  | 'financial_evidence_conflict'
  | 'fulfillment_evidence_conflict'
  | 'refund_total_conflict'

export class ExactLocalRefundEvidenceNotFoundError extends Error {
  constructor(readonly code: ExactRefundNotFoundCode) {
    super('Exact local refund evidence was not found')
    this.name = 'ExactLocalRefundEvidenceNotFoundError'
  }
}

export class ExactLocalRefundEvidenceConflictError extends Error {
  constructor(readonly code: ExactRefundConflictCode) {
    super('Exact local refund evidence conflicts')
    this.name = 'ExactLocalRefundEvidenceConflictError'
  }
}

export class ExactLocalRefundEvidenceUnavailableError extends Error {
  readonly code = 'exact_local_refund_evidence_unavailable' as const

  constructor() {
    super('Exact local refund evidence is temporarily unavailable')
    this.name = 'ExactLocalRefundEvidenceUnavailableError'
  }
}

export interface ExactLocalRefundEvidenceInput {
  readonly targetUserId: string
  readonly paymentAttemptId: string
  readonly providerMode: ProviderMode
  readonly razorpayPaymentId: string
  readonly invoiceId: string
  readonly evidencePurpose: 'undelivered_refund_preview'
  readonly now?: Date
}

export interface ExactLocalRefundEvidence {
  readonly evidenceReadAt: string
  readonly consistency: 'snapshot_session'
  readonly evidencePurpose: 'undelivered_refund_preview'
  readonly target: {
    readonly userId: string
    readonly deletionPending: boolean
  }
  readonly lookup: {
    readonly targetMatches: 1
    readonly paymentMatches: 1
    readonly invoiceMatches: 1
    readonly refundRecordMatches: number
    readonly fulfillmentMatches: 1
    readonly accessMatches: 0
  }
  readonly payment: {
    readonly paymentAttemptId: string
    readonly userId: string
    readonly providerMode: ProviderMode
    readonly razorpayPaymentId: string
    readonly status: 'captured'
    readonly capturedAmountPaise: number
    readonly currency: 'INR'
    readonly invoiceId: string
    readonly capturedAt: string
  }
  readonly invoice: {
    readonly invoiceId: string
    readonly userId: string
    readonly providerMode: ProviderMode
    readonly razorpayPaymentId: string
    readonly status: 'issued'
    readonly currency: 'INR'
    readonly grossAmountPaise: number
    readonly version: 1
    readonly contentHash: string
    readonly issuedAt: string
  }
  readonly aggregate: {
    readonly existingRefundTotalPaise: number
    readonly pendingRequestTotalPaise: 0
    readonly remainingRefundablePaise: number
    readonly version: number
    readonly contentHash: string
  }
  readonly fulfillment: {
    readonly fulfillmentId: string
    readonly productKind:
      | 'single_interview'
      | 'premium_resume'
      | 'subscription'
    readonly deliveryStatus: 'not_delivered'
    readonly accessState: 'none'
    readonly version: number
    readonly evidenceHash: string
  }
  readonly exceptionEvidence: {
    readonly kind: 'undelivered'
    readonly reference: string
    readonly evidenceHash: string
    readonly confirmedAt: string
  }
  readonly queryBounds: {
    readonly totalReadBudgetMs: 5_000
    readonly perQueryMaxTimeMs: 750
    readonly exactMatchLimit: 2
    readonly refundRecordLimit: 50
    readonly providerReadsPerformed: false
  }
}

export { sha256CanonicalJson } from '../lib/canonicalJson'
export {
  addInrPaise,
  inrPaise,
  isInrPaise,
  subtractInrPaise,
  type InrPaise,
} from '../lib/money'
export { BillingConfig } from '../models/BillingConfig'
export { CheckoutIntent } from '../models/CheckoutIntent'
export {
  CouponCampaignRevision,
} from '../models/CouponCampaignRevision'
export { CouponReservation } from '../models/CouponReservation'
export {
  CustomerBillingProfile,
  type ICustomerPlaceOfSupply,
} from '../models/CustomerBillingProfile'
export { PaidInterviewUnlock } from '../models/PaidInterviewUnlock'
export { PlanCatalogVersion } from '../models/PlanCatalogVersion'
export {
  PLAN_CHANGE_REQUEST_STATUSES,
  PlanChangeRequest,
  type ConsumerPlanKey,
  type PlanChangeRequestStatus,
} from '../models/PlanChangeRequest'
export { ResumeEntitlement } from '../models/ResumeEntitlement'
export {
  SUBSCRIPTION_STATUSES,
  Subscription,
  type SubscriptionStatus,
} from '../models/Subscription'
export { SubscriptionCycle } from '../models/SubscriptionCycle'
export type {
  CatalogContent,
  CatalogPlanTerms,
  CouponCampaignMode,
  CouponRevisionStatus,
  ProviderMode,
} from '../types/catalog'
export { CouponRevisionTermsSchema } from '../validators/coupon'
export {
  CustomerBillingProfileUpsertSchema,
  type CustomerBillingProfileUpsertInput,
} from '../validators/customerBillingProfile'
export {
  validateCatalogContent,
} from './catalogValidation'
export {
  evaluatePaymentSaleGate,
} from './paymentRuntimeGate'
export type {
  BillingConfigView,
} from './billingConfigService'
