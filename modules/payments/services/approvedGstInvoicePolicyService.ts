import { createHash } from 'node:crypto'
import mongoose from 'mongoose'
import {
  FinancialDocumentService,
  MongooseFinancialDocumentStore,
  type ApprovedFinancialSnapshot,
  type FinancialDocumentStore,
  type FinancialSnapshotVerificationInput,
  type FinancialTaxCalculationSnapshot,
} from '@financial-ledger'
import { connectDB } from '@shared/db/connection'
import { CheckoutIntent } from '../models/CheckoutIntent'
import { ChargeFulfillment } from '../models/ChargeFulfillment'
import { PaymentAttempt } from '../models/PaymentAttempt'
import { INDIA_GST_RATE_BPS, inrPaise } from '../lib/money'
import type {
  ApprovedFinancialPolicyHandler,
  ApprovedFinancialPolicyInput,
  ApprovedFinancialPolicyResult,
} from './chargeFulfillmentRecoveryService'

const POLICY_ID = 'interviewprepguru_consumer_gst_invoice'
const POLICY_VERSION = '1'
const POLICY_APPROVED_AT = new Date('2026-08-07T00:00:00.000Z')
const RETRY_DELAY_MS = 5 * 60_000
const GSTIN_PATTERN =
  /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
const INDIAN_STATE_CODE_PATTERN = /^(0[1-9]|[1-3][0-9]|9[7-9])$/

export const GST_INVOICE_POLICY_ENV_KEYS = Object.freeze([
  'PAYMENT_GST_SELLER_LEGAL_NAME',
  'PAYMENT_GST_SELLER_ADDRESS',
  'PAYMENT_GST_SELLER_STATE_CODE',
  'PAYMENT_GST_SELLER_GSTIN',
  'PAYMENT_GST_SERVICE_SAC',
] as const)

interface SellerPolicy extends Record<string, unknown> {
  legalName: string
  tradeName: 'InterviewPrepGuru'
  address: string
  stateCode: string
  countryCode: 'IN'
  gstin: string
  sac: string
}

interface InvoiceEvidence {
  checkoutIntentId: string
  buyerSnapshot: Record<string, unknown>
  buyerStateCode: string
  issuedAt: Date
  description: string
}

type InvoiceStepClaim =
  | { outcome: 'claimed'; fence: string }
  | { outcome: 'completed'; invoiceReferenceId: string }
  | { outcome: 'contended' }

export interface GstInvoicePolicyPersistence {
  claimInvoiceStep(
    input: Readonly<ApprovedFinancialPolicyInput>,
    claimedAt: Date,
  ): Promise<InvoiceStepClaim>
  loadInvoiceEvidence(
    input: Readonly<ApprovedFinancialPolicyInput>,
    fence: string,
  ): Promise<InvoiceEvidence>
  completeInvoiceStep(
    input: Readonly<ApprovedFinancialPolicyInput>,
    fence: string,
    invoiceReferenceId: string,
    completedAt: Date,
  ): Promise<boolean>
  failInvoiceStep(
    input: Readonly<ApprovedFinancialPolicyInput>,
    fence: string,
    retryAt: Date,
    reason: string,
  ): Promise<void>
}

export interface GstInvoicePolicyDependencies {
  environment?: Readonly<Record<string, string | undefined>>
  persistence?: GstInvoicePolicyPersistence
  documentStore?: FinancialDocumentStore
  now?: () => Date
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function canonicalValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalValue(nested)]),
  )
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value))
}

function contentHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function approvedSnapshot<T>(
  value: T,
  approvalId: string,
  approvedAt: Date,
): ApprovedFinancialSnapshot<T> {
  return {
    approval: {
      policyId: POLICY_ID,
      policyVersion: POLICY_VERSION,
      approvalId,
      approvedBy: 'server_financial_policy',
      approvedAt: new Date(approvedAt.getTime()),
      contentHash: contentHash(value),
    },
    value: structuredClone(value),
  }
}

function requiredEnvironmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  key: (typeof GST_INVOICE_POLICY_ENV_KEYS)[number],
  maxLength: number,
): string | null {
  const value = environment[key]?.trim()
  return value && value.length <= maxLength ? value : null
}

export function resolveGstSellerPolicy(
  environment: Readonly<Record<string, string | undefined>>,
): SellerPolicy | null {
  const legalName = requiredEnvironmentValue(
    environment,
    'PAYMENT_GST_SELLER_LEGAL_NAME',
    200,
  )
  const address = requiredEnvironmentValue(
    environment,
    'PAYMENT_GST_SELLER_ADDRESS',
    500,
  )
  const stateCode = requiredEnvironmentValue(
    environment,
    'PAYMENT_GST_SELLER_STATE_CODE',
    2,
  )
  const gstin = requiredEnvironmentValue(
    environment,
    'PAYMENT_GST_SELLER_GSTIN',
    15,
  )?.toUpperCase() ?? null
  const sac = requiredEnvironmentValue(
    environment,
    'PAYMENT_GST_SERVICE_SAC',
    6,
  )
  if (
    !legalName ||
    !address ||
    !stateCode ||
    !gstin ||
    !sac ||
    !INDIAN_STATE_CODE_PATTERN.test(stateCode) ||
    !GSTIN_PATTERN.test(gstin) ||
    !gstin.startsWith(stateCode) ||
    !/^\d{6}$/.test(sac)
  ) {
    return null
  }
  return {
    legalName,
    tradeName: 'InterviewPrepGuru',
    address,
    stateCode,
    countryCode: 'IN',
    gstin,
    sac,
  }
}

export function calculateInclusiveGst(
  grossPaise: number,
  componentAllocation: 'intra_state' | 'inter_state',
): FinancialTaxCalculationSnapshot {
  if (!Number.isSafeInteger(grossPaise) || grossPaise <= 0) {
    throw new Error('Invoice gross must be positive integer paise')
  }
  const rateDenominator = BigInt(10_000 + INDIA_GST_RATE_BPS)
  const taxablePaise = Number(
    (BigInt(grossPaise) * BigInt(10_000) +
      rateDenominator / BigInt(2)) /
      rateDenominator,
  )
  const gstPaise = grossPaise - taxablePaise
  if (componentAllocation === 'inter_state') {
    return {
      gstRateBps: INDIA_GST_RATE_BPS,
      taxablePaise,
      gstPaise,
      grossPaise,
      componentAllocation,
      igstPaise: gstPaise,
    }
  }
  const cgstPaise = Math.floor(gstPaise / 2)
  return {
    gstRateBps: INDIA_GST_RATE_BPS,
    taxablePaise,
    gstPaise,
    grossPaise,
    componentAllocation,
    cgstPaise,
    sgstPaise: gstPaise - cgstPaise,
  }
}

function exactIdentityFilter(
  input: Readonly<ApprovedFinancialPolicyInput>,
): Record<string, unknown> {
  return {
    _id: new mongoose.Types.ObjectId(input.fulfillmentId),
    providerMode: input.providerMode,
    userId: new mongoose.Types.ObjectId(input.userId),
    kind: input.kind,
    razorpayPaymentId: input.razorpayPaymentId,
    razorpayInvoiceId: input.razorpayInvoiceId ?? { $exists: false },
    razorpaySubscriptionId:
      input.razorpaySubscriptionId ?? { $exists: false },
    razorpayOrderId: input.razorpayOrderId ?? { $exists: false },
    verifiedAmountPaise: input.verifiedAmountPaise,
    verifiedCurrency: input.verifiedCurrency,
    'steps.invoice.operationKey': input.invoiceOperationKey,
  }
}

function dateAt(value: string | undefined): Date | { $exists: false } {
  return value === undefined ? { $exists: false } : new Date(value)
}

function referenceIdOf(value: unknown): string | null {
  return typeof value === 'string' && /^[a-f0-9]{24}$/.test(value)
    ? value
    : null
}

async function inspectInvoiceStep(
  input: Readonly<ApprovedFinancialPolicyInput>,
): Promise<InvoiceStepClaim> {
  const row = await ChargeFulfillment.findOne(exactIdentityFilter(input))
    .select('status steps.invoice')
    .lean()
    .exec()
  const invoiceStep = row?.steps?.invoice
  const referenceId = referenceIdOf(invoiceStep?.referenceId)
  if (
    row?.status === 'invoiced' &&
    invoiceStep?.status === 'complete' &&
    referenceId
  ) {
    return { outcome: 'completed', invoiceReferenceId: referenceId }
  }
  const observedFence = invoiceStep?.lastAttemptAt
  if (
    row?.status === input.expectedStatus &&
    invoiceStep?.status === 'running' &&
    observedFence instanceof Date &&
    observedFence.toISOString() === input.invoiceAttemptFence
  ) {
    return { outcome: 'claimed', fence: observedFence.toISOString() }
  }
  return { outcome: 'contended' }
}

function sameOptional(left: string | undefined, right: string | undefined) {
  return left === right
}

function buyerSnapshotOf(value: unknown): {
  value: Record<string, unknown>
  stateCode: string
} {
  if (!isRecord(value) || !isRecord(value.placeOfSupply)) {
    throw new Error('Checkout buyer snapshot is unavailable')
  }
  const stateCode = value.placeOfSupply.stateCode
  const countryCode = value.placeOfSupply.countryCode
  const profileHash = value.billingProfileContentHash
  if (
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    typeof value.email !== 'string' ||
    !value.email.trim() ||
    !Number.isSafeInteger(value.billingProfileVersion) ||
    (value.billingProfileVersion as number) < 1 ||
    typeof profileHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(profileHash) ||
    typeof stateCode !== 'string' ||
    !INDIAN_STATE_CODE_PATTERN.test(stateCode) ||
    countryCode !== 'IN' ||
    contentHash({ placeOfSupply: { stateCode, countryCode } }) !== profileHash
  ) {
    throw new Error('Checkout buyer snapshot failed integrity verification')
  }
  return { value: structuredClone(value), stateCode }
}

function descriptionForIntent(intent: {
  kind: string
  planKey?: string
}): string {
  if (intent.kind === 'subscription') {
    if (intent.planKey !== 'plus' && intent.planKey !== 'pro') {
      throw new Error('Subscription invoice has no exact plan')
    }
    return `InterviewPrepGuru ${
      intent.planKey === 'plus' ? 'Plus' : 'Pro'
    } monthly subscription`
  }
  if (intent.kind === 'single_interview') {
    return 'InterviewPrepGuru interview unlock (up to 30 minutes)'
  }
  if (intent.kind === 'premium_resume') {
    return 'InterviewPrepGuru premium resume unlock'
  }
  throw new Error('Checkout kind is not invoiceable')
}

export const mongoGstInvoicePolicyPersistence: GstInvoicePolicyPersistence = {
  async claimInvoiceStep(input, claimedAt) {
    await connectDB()
    if (input.invoiceStepStatus === 'running') {
      return inspectInvoiceStep(input)
    }
    const claimed = await ChargeFulfillment.findOneAndUpdate(
      {
        ...exactIdentityFilter(input),
        status: input.expectedStatus,
        'steps.invoice.status': input.invoiceStepStatus,
        'steps.invoice.lastAttemptAt': dateAt(input.invoiceAttemptFence),
      },
      {
        $set: {
          'steps.invoice.status': 'running',
          'steps.invoice.lastAttemptAt': claimedAt,
        },
        $unset: {
          'steps.invoice.completedAt': 1,
          'steps.invoice.referenceId': 1,
          lastError: 1,
          nextAttemptAt: 1,
        },
      },
      { new: true, runValidators: true },
    )
      .select('_id')
      .lean()
      .exec()
    if (claimed) {
      return { outcome: 'claimed', fence: claimedAt.toISOString() }
    }
    return inspectInvoiceStep(input)
  },

  async loadInvoiceEvidence(input, fence) {
    await connectDB()
    const fulfillment = await ChargeFulfillment.findOne({
      ...exactIdentityFilter(input),
      status: input.expectedStatus,
      'steps.invoice.status': 'running',
      'steps.invoice.lastAttemptAt': new Date(fence),
    })
      .select('steps.verification.completedAt')
      .lean()
      .exec()
    const issuedAt = fulfillment?.steps?.verification?.completedAt
    if (!(issuedAt instanceof Date) || !Number.isFinite(issuedAt.getTime())) {
      throw new Error('Fulfillment verification timestamp is unavailable')
    }
    const payment = await PaymentAttempt.findOne({
      providerMode: input.providerMode,
      razorpayPaymentId: input.razorpayPaymentId,
      userId: new mongoose.Types.ObjectId(input.userId),
      amountPaise: inrPaise(input.verifiedAmountPaise),
      currency: 'INR',
      status: { $in: ['captured', 'refunded', 'disputed'] },
    })
      .select(
        'checkoutIntentId razorpayInvoiceId razorpayOrderId razorpaySubscriptionId',
      )
      .lean()
      .exec()
    if (
      !payment ||
      !sameOptional(payment.razorpayInvoiceId, input.razorpayInvoiceId) ||
      !sameOptional(payment.razorpayOrderId, input.razorpayOrderId) ||
      !sameOptional(
        payment.razorpaySubscriptionId,
        input.razorpaySubscriptionId,
      )
    ) {
      throw new Error('Payment attempt does not match fulfillment evidence')
    }
    const intent = await CheckoutIntent.findOne({
      _id: payment.checkoutIntentId,
      userId: new mongoose.Types.ObjectId(input.userId),
      providerMode: input.providerMode,
    })
      .select('kind planKey buyerSnapshot')
      .lean()
      .exec()
    const expectedIntentKind =
      input.kind === 'subscription_cycle' ? 'subscription' : input.kind
    if (!intent || intent.kind !== expectedIntentKind) {
      throw new Error('Checkout intent does not match fulfillment kind')
    }
    const buyer = buyerSnapshotOf(intent.buyerSnapshot)
    return {
      checkoutIntentId: intent._id.toString(),
      buyerSnapshot: buyer.value,
      buyerStateCode: buyer.stateCode,
      issuedAt: new Date(issuedAt.getTime()),
      description: descriptionForIntent(intent),
    }
  },

  async completeInvoiceStep(input, fence, invoiceReferenceId, completedAt) {
    await connectDB()
    const completed = await ChargeFulfillment.findOneAndUpdate(
      {
        ...exactIdentityFilter(input),
        status: input.expectedStatus,
        'steps.invoice.status': 'running',
        'steps.invoice.lastAttemptAt': new Date(fence),
      },
      {
        $set: {
          status: input.expectedStatus === 'review' ? 'review' : 'invoiced',
          'steps.invoice.status': 'complete',
          'steps.invoice.completedAt': completedAt,
          'steps.invoice.referenceId': invoiceReferenceId,
        },
        $unset: { lastError: 1, nextAttemptAt: 1 },
      },
      { new: true, runValidators: true },
    )
      .select('_id')
      .lean()
      .exec()
    return completed !== null
  },

  async failInvoiceStep(input, fence, retryAt, reason) {
    await connectDB()
    await ChargeFulfillment.updateOne(
      {
        ...exactIdentityFilter(input),
        status: input.expectedStatus,
        'steps.invoice.status': 'running',
        'steps.invoice.lastAttemptAt': new Date(fence),
      },
      {
        $set: {
          'steps.invoice.status': 'failed',
          lastError: reason.slice(0, 2_000),
          nextAttemptAt: retryAt,
        },
        $unset: {
          'steps.invoice.completedAt': 1,
          'steps.invoice.referenceId': 1,
        },
      },
      { runValidators: true },
    ).exec()
  },
}

function invoiceMatchesRequest(
  invoice: Awaited<ReturnType<FinancialDocumentStore['findInvoiceByPaymentKey']>>,
  input: Readonly<ApprovedFinancialPolicyInput>,
): boolean {
  return Boolean(
    invoice &&
      invoice.providerMode === input.providerMode &&
      invoice.userId.toString() === input.userId &&
      invoice.chargeKind === input.kind &&
      invoice.razorpayPaymentId === input.razorpayPaymentId &&
      sameOptional(invoice.razorpayInvoiceId, input.razorpayInvoiceId) &&
      sameOptional(invoice.razorpayOrderId, input.razorpayOrderId) &&
      sameOptional(
        invoice.razorpaySubscriptionId,
        input.razorpaySubscriptionId,
      ) &&
      invoice.capturedPaise === input.verifiedAmountPaise,
  )
}

function formatInvoiceNumber(input: {
  providerMode: 'test' | 'live'
  financialYear: string
  sequenceNumber: number
}): string {
  const [startYear, endYear] = input.financialYear.split('-')
  if (
    !/^\d{4}$/.test(startYear ?? '') ||
    !/^\d{2}$/.test(endYear ?? '') ||
    !Number.isSafeInteger(input.sequenceNumber) ||
    input.sequenceNumber < 1 ||
    input.sequenceNumber > 999_999_999
  ) {
    throw new Error('Invoice number input is outside the approved format')
  }
  const prefix = input.providerMode === 'live' ? 'IPG' : 'TST'
  return `${prefix}${startYear!.slice(-2)}${endYear}${String(
    input.sequenceNumber,
  ).padStart(9, '0')}`
}

async function markInvoiceFailure(
  persistence: GstInvoicePolicyPersistence,
  input: Readonly<ApprovedFinancialPolicyInput>,
  fence: string,
  now: Date,
  reason: string,
): Promise<void> {
  try {
    await persistence.failInvoiceStep(
      input,
      fence,
      new Date(now.getTime() + RETRY_DELAY_MS),
      reason,
    )
  } catch {
    // The exact step fence makes a later recovery safe even if this update lost.
  }
}

export async function issueApprovedGstInvoice(
  input: ApprovedFinancialPolicyInput,
  dependencies: GstInvoicePolicyDependencies = {},
): Promise<ApprovedFinancialPolicyResult> {
  const now = dependencies.now?.() ?? new Date()
  const persistence =
    dependencies.persistence ?? mongoGstInvoicePolicyPersistence
  const claim = await persistence.claimInvoiceStep(input, now)
  if (claim.outcome === 'completed') {
    return {
      disposition: 'already_invoiced',
      invoiceReferenceId: claim.invoiceReferenceId,
    }
  }
  if (claim.outcome === 'contended') {
    return { disposition: 'deferred', reason: 'invoice_step_contended' }
  }
  const fence = claim.fence
  try {
    const documentStore =
      dependencies.documentStore ?? new MongooseFinancialDocumentStore()
    const existing = await documentStore.findInvoiceByPaymentKey(
      input.providerMode,
      input.razorpayPaymentId,
    )
    if (existing) {
      if (!invoiceMatchesRequest(existing, input)) {
        throw new Error('Existing invoice conflicts with payment evidence')
      }
      const referenceId = existing._id.toString()
      const completed = await persistence.completeInvoiceStep(
        input,
        fence,
        referenceId,
        now,
      )
      return completed
        ? { disposition: 'already_invoiced', invoiceReferenceId: referenceId }
        : { disposition: 'deferred', reason: 'invoice_completion_contended' }
    }

    const seller = resolveGstSellerPolicy(
      dependencies.environment ?? process.env,
    )
    if (!seller) {
      await markInvoiceFailure(
        persistence,
        input,
        fence,
        now,
        'gst_invoice_policy_not_configured',
      )
      return {
        disposition: 'deferred',
        reason: 'gst_invoice_policy_not_configured',
      }
    }
    const evidence = await persistence.loadInvoiceEvidence(input, fence)
    const allocation = seller.stateCode === evidence.buyerStateCode
      ? 'intra_state'
      : 'inter_state'
    const tax = calculateInclusiveGst(
      input.verifiedAmountPaise,
      allocation,
    )
    const sellerSnapshot = approvedSnapshot(
      seller,
      `seller:${contentHash(seller)}`,
      POLICY_APPROVED_AT,
    )
    const buyerSnapshot = approvedSnapshot(
      evidence.buyerSnapshot,
      `buyer:${evidence.checkoutIntentId}`,
      evidence.issuedAt,
    )
    const taxSnapshot = approvedSnapshot(
      tax,
      `tax:${input.providerMode}:${input.razorpayPaymentId}`,
      evidence.issuedAt,
    )
    const expectedBundle = canonicalJson({
      sellerSnapshot,
      buyerSnapshot,
      taxSnapshot,
    })
    const service = new FinancialDocumentService({
      store: documentStore,
      verifyApprovedSnapshots(
        verification: Readonly<FinancialSnapshotVerificationInput>,
      ) {
        if (
          verification.documentType !== 'invoice' ||
          verification.providerMode !== input.providerMode ||
          verification.considerationPaise !== input.verifiedAmountPaise ||
          verification.issuedAt.getTime() !== evidence.issuedAt.getTime() ||
          canonicalJson({
            sellerSnapshot: verification.sellerSnapshot,
            buyerSnapshot: verification.buyerSnapshot,
            taxSnapshot: verification.taxSnapshot,
          }) !== expectedBundle
        ) {
          throw new Error('Financial snapshot bundle was not approved')
        }
        return true
      },
      formatDocumentNumber(numberInput) {
        if (numberInput.documentType !== 'invoice') {
          throw new Error('Only invoice numbering is approved here')
        }
        return formatInvoiceNumber(numberInput)
      },
    })
    const invoice = await service.createInvoice({
      providerMode: input.providerMode,
      userId: input.userId,
      chargeKind: input.kind,
      razorpayPaymentId: input.razorpayPaymentId,
      razorpayInvoiceId: input.razorpayInvoiceId,
      razorpayOrderId: input.razorpayOrderId,
      razorpaySubscriptionId: input.razorpaySubscriptionId,
      capturedPaise: input.verifiedAmountPaise,
      sellerSnapshot,
      buyerSnapshot,
      taxSnapshot,
      descriptionSnapshot: evidence.description,
      issuedAt: evidence.issuedAt,
    })
    const invoiceReferenceId = invoice._id.toString()
    if (!/^[a-f0-9]{24}$/.test(invoiceReferenceId)) {
      throw new Error('Created invoice reference is invalid')
    }
    const completed = await persistence.completeInvoiceStep(
      input,
      fence,
      invoiceReferenceId,
      dependencies.now?.() ?? new Date(),
    )
    if (!completed) {
      return {
        disposition: 'deferred',
        reason: 'invoice_completion_contended',
      }
    }
    return { disposition: 'invoiced', invoiceReferenceId }
  } catch (error) {
    await markInvoiceFailure(
      persistence,
      input,
      fence,
      dependencies.now?.() ?? new Date(),
      'gst_invoice_recovery_failed',
    )
    throw error
  }
}

export const approvedGstInvoicePolicyHandler: ApprovedFinancialPolicyHandler =
  (input) => issueApprovedGstInvoice(input)
