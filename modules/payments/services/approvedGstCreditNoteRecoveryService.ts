import { createHash } from 'node:crypto'
import mongoose from 'mongoose'
import {
  FinancialDocumentService,
  MongooseFinancialDocumentStore,
  RefundRecord,
  type ApprovedFinancialSnapshot,
  type FinancialDocumentStore,
  type FinancialSnapshotVerificationInput,
  type FinancialTaxCalculationSnapshot,
} from '@financial-ledger'
import { connectDB } from '@shared/db/connection'
import type { ProviderMode } from '../types/catalog'
import { calculateInclusiveGst } from './approvedGstInvoicePolicyService'

const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/
const CREDIT_NOTE_POLICY_ID = 'interviewprepguru_consumer_gst_credit_note'
const CREDIT_NOTE_POLICY_VERSION = '1'
const CREDIT_NOTE_CLAIM_STALE_MS = 15 * 60_000
const CREDIT_NOTE_RETRY_DELAY_MS = 5 * 60_000

interface ClaimedRefundEvidence {
  refundRecordId: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  providerMode: ProviderMode
  razorpayRefundId: string
  razorpayPaymentId: string
  razorpayInvoiceId?: string
  razorpayOrderId?: string
  razorpaySubscriptionId?: string
  originalCapturedPaise: number
  refundedPaise: number
  issuedAt: Date
  fence: number
  attemptedAt: Date
}

type CreditNoteClaim =
  | { outcome: 'claimed'; evidence: ClaimedRefundEvidence }
  | { outcome: 'completed'; creditNoteReferenceId: string }
  | { outcome: 'contended' }

export interface GstCreditNoteRecoveryPersistence {
  claim(input: {
    refundRecordId: mongoose.Types.ObjectId
    providerMode: ProviderMode
    claimedAt: Date
  }): Promise<CreditNoteClaim>
  complete(input: {
    evidence: ClaimedRefundEvidence
    creditNoteReferenceId: mongoose.Types.ObjectId
    completedAt: Date
  }): Promise<boolean>
  fail(input: {
    evidence: ClaimedRefundEvidence
    retryAt: Date
    reason: string
  }): Promise<void>
}

export interface ApprovedGstCreditNoteRecoveryDependencies {
  persistence?: GstCreditNoteRecoveryPersistence
  documentStore?: FinancialDocumentStore
  now?: () => Date
}

export type ApprovedGstCreditNoteRecoveryResult =
  | {
      disposition: 'issued' | 'already_issued'
      creditNoteReferenceId: string
    }
  | { disposition: 'deferred'; reason: string }

interface LeanRefundClaim {
  _id: mongoose.Types.ObjectId
  userId: mongoose.Types.ObjectId
  providerMode: ProviderMode
  razorpayRefundId: string
  razorpayPaymentId: string
  razorpayInvoiceId?: string
  razorpayOrderId?: string
  razorpaySubscriptionId?: string
  originalCapturedPaise: number
  refundedPaise: number
  processedAt: Date
  creditNoteDecision: {
    status: string
    attemptedAt?: Date
    fencingToken: number
    creditNoteId?: mongoose.Types.ObjectId
  }
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

function approvedTaxSnapshot(
  value: FinancialTaxCalculationSnapshot,
  evidence: ClaimedRefundEvidence,
): ApprovedFinancialSnapshot<FinancialTaxCalculationSnapshot> {
  return {
    approval: {
      policyId: CREDIT_NOTE_POLICY_ID,
      policyVersion: CREDIT_NOTE_POLICY_VERSION,
      approvalId:
        `credit-note-tax:${evidence.providerMode}:${evidence.razorpayRefundId}`,
      approvedBy: 'server_financial_policy',
      approvedAt: new Date(evidence.issuedAt),
      contentHash: createHash('sha256')
        .update(canonicalJson(value))
        .digest('hex'),
    },
    value: structuredClone(value),
  }
}

function storedApprovedSnapshot(
  value: unknown,
  label: string,
): ApprovedFinancialSnapshot<Record<string, unknown>> {
  if (!isRecord(value) || !isRecord(value.approval) || !isRecord(value.value)) {
    throw new Error(`${label} is not an approved financial snapshot`)
  }
  return structuredClone(value) as unknown as ApprovedFinancialSnapshot<
    Record<string, unknown>
  >
}

function formatCreditNoteNumber(input: {
  providerMode: ProviderMode
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
    throw new Error('Credit-note number input is outside the approved format')
  }
  const prefix = input.providerMode === 'live' ? 'ICN' : 'TCN'
  return `${prefix}${startYear!.slice(-2)}${endYear}${String(
    input.sequenceNumber,
  ).padStart(9, '0')}`
}

function exactOptional(left: string | undefined, right: string | undefined) {
  return left === right
}

function claimedEvidence(row: LeanRefundClaim): ClaimedRefundEvidence {
  if (
    !(row._id instanceof mongoose.Types.ObjectId) ||
    !(row.userId instanceof mongoose.Types.ObjectId) ||
    !(row.processedAt instanceof Date) ||
    !(row.creditNoteDecision.attemptedAt instanceof Date) ||
    !Number.isSafeInteger(row.creditNoteDecision.fencingToken) ||
    row.creditNoteDecision.fencingToken < 1
  ) {
    throw new Error('Claimed refund credit-note evidence is invalid')
  }
  return {
    refundRecordId: row._id,
    userId: row.userId,
    providerMode: row.providerMode,
    razorpayRefundId: row.razorpayRefundId,
    razorpayPaymentId: row.razorpayPaymentId,
    razorpayInvoiceId: row.razorpayInvoiceId,
    razorpayOrderId: row.razorpayOrderId,
    razorpaySubscriptionId: row.razorpaySubscriptionId,
    originalCapturedPaise: row.originalCapturedPaise,
    refundedPaise: row.refundedPaise,
    issuedAt: new Date(row.processedAt),
    fence: row.creditNoteDecision.fencingToken,
    attemptedAt: new Date(row.creditNoteDecision.attemptedAt),
  }
}

export const mongoGstCreditNoteRecoveryPersistence:
GstCreditNoteRecoveryPersistence = {
  async claim({ refundRecordId, providerMode, claimedAt }) {
    await connectDB()
    const claimed = await RefundRecord.findOneAndUpdate(
      {
        _id: refundRecordId,
        providerMode,
        status: { $in: ['verified', 'review_required', 'resolving', 'resolved'] },
        currency: 'INR',
        processedAt: { $type: 'date' },
        refundedPaise: { $gt: 0 },
        'creditNoteDecision.status': { $in: ['required', 'failed'] },
        $and: [
          {
            $or: [
              { nextAttemptAt: { $exists: false } },
              { nextAttemptAt: null },
              { nextAttemptAt: { $lte: claimedAt } },
            ],
          },
          {
            $or: [
              { 'creditNoteDecision.attemptedAt': { $exists: false } },
              { 'creditNoteDecision.attemptedAt': null },
              {
                'creditNoteDecision.attemptedAt': {
                  $lte: new Date(
                    claimedAt.getTime() - CREDIT_NOTE_CLAIM_STALE_MS,
                  ),
                },
              },
            ],
          },
        ],
      },
      {
        $set: {
          'creditNoteDecision.status': 'required',
          'creditNoteDecision.attemptedAt': claimedAt,
        },
        $inc: { 'creditNoteDecision.fencingToken': 1 },
        $unset: {
          'creditNoteDecision.lastError': 1,
          nextAttemptAt: 1,
        },
      },
      { new: true, runValidators: true },
    ).lean<LeanRefundClaim>()
    if (claimed) return { outcome: 'claimed', evidence: claimedEvidence(claimed) }

    const current = await RefundRecord.findOne({
      _id: refundRecordId,
      providerMode,
    }).select('creditNoteDecision').lean<LeanRefundClaim>()
    const creditNoteId = current?.creditNoteDecision.creditNoteId
    if (
      current?.creditNoteDecision.status === 'completed' &&
      creditNoteId instanceof mongoose.Types.ObjectId
    ) {
      return {
        outcome: 'completed',
        creditNoteReferenceId: creditNoteId.toHexString(),
      }
    }
    return { outcome: 'contended' }
  },

  async complete({ evidence, creditNoteReferenceId, completedAt }) {
    await connectDB()
    const completed = await RefundRecord.updateOne(
      {
        _id: evidence.refundRecordId,
        providerMode: evidence.providerMode,
        'creditNoteDecision.status': 'required',
        'creditNoteDecision.fencingToken': evidence.fence,
        'creditNoteDecision.attemptedAt': evidence.attemptedAt,
      },
      {
        $set: {
          'creditNoteDecision.status': 'completed',
          'creditNoteDecision.completedAt': completedAt,
          'creditNoteDecision.creditNoteId': creditNoteReferenceId,
        },
        $unset: {
          'creditNoteDecision.lastError': 1,
          nextAttemptAt: 1,
        },
      },
      { runValidators: true },
    )
    return completed.matchedCount === 1
  },

  async fail({ evidence, retryAt, reason }) {
    await connectDB()
    await RefundRecord.updateOne(
      {
        _id: evidence.refundRecordId,
        providerMode: evidence.providerMode,
        'creditNoteDecision.status': 'required',
        'creditNoteDecision.fencingToken': evidence.fence,
        'creditNoteDecision.attemptedAt': evidence.attemptedAt,
      },
      {
        $set: {
          'creditNoteDecision.status': 'failed',
          'creditNoteDecision.lastError': reason.slice(0, 2_000),
          nextAttemptAt: retryAt,
        },
      },
      { runValidators: true },
    )
  },
}

async function failClaim(
  persistence: GstCreditNoteRecoveryPersistence,
  evidence: ClaimedRefundEvidence,
  now: Date,
): Promise<void> {
  try {
    await persistence.fail({
      evidence,
      retryAt: new Date(now.getTime() + CREDIT_NOTE_RETRY_DELAY_MS),
      reason: 'gst_credit_note_recovery_failed',
    })
  } catch {
    // The exact decision fence makes a later stale-claim recovery safe.
  }
}

export async function issueApprovedGstCreditNote(
  input: { refundRecordId: string; providerMode: ProviderMode },
  dependencies: ApprovedGstCreditNoteRecoveryDependencies = {},
): Promise<ApprovedGstCreditNoteRecoveryResult> {
  if (!OBJECT_ID_PATTERN.test(input.refundRecordId)) {
    throw new Error('refundRecordId must be a MongoDB ObjectId')
  }
  const now = dependencies.now?.() ?? new Date()
  const persistence = dependencies.persistence ??
    mongoGstCreditNoteRecoveryPersistence
  const claim = await persistence.claim({
    refundRecordId: new mongoose.Types.ObjectId(input.refundRecordId),
    providerMode: input.providerMode,
    claimedAt: now,
  })
  if (claim.outcome === 'completed') {
    return {
      disposition: 'already_issued',
      creditNoteReferenceId: claim.creditNoteReferenceId,
    }
  }
  if (claim.outcome === 'contended') {
    return { disposition: 'deferred', reason: 'credit_note_step_contended' }
  }

  const evidence = claim.evidence
  try {
    const documentStore = dependencies.documentStore ??
      new MongooseFinancialDocumentStore()
    const invoice = await documentStore.findInvoiceByPaymentKey(
      evidence.providerMode,
      evidence.razorpayPaymentId,
    )
    if (
      !invoice ||
      invoice.providerMode !== evidence.providerMode ||
      invoice.userId.toString() !== evidence.userId.toString() ||
      invoice.razorpayPaymentId !== evidence.razorpayPaymentId ||
      invoice.capturedPaise !== evidence.originalCapturedPaise ||
      !exactOptional(invoice.razorpayInvoiceId, evidence.razorpayInvoiceId) ||
      !exactOptional(invoice.razorpayOrderId, evidence.razorpayOrderId) ||
      !exactOptional(
        invoice.razorpaySubscriptionId,
        evidence.razorpaySubscriptionId,
      )
    ) {
      throw new Error('Refund has no exact issued invoice')
    }
    const sellerSnapshot = storedApprovedSnapshot(
      invoice.sellerSnapshot,
      'invoice.sellerSnapshot',
    )
    const buyerSnapshot = storedApprovedSnapshot(
      invoice.buyerSnapshot,
      'invoice.buyerSnapshot',
    )
    const allocation = invoice.taxSnapshot.componentAllocation
    const taxSnapshot = approvedTaxSnapshot(
      calculateInclusiveGst(evidence.refundedPaise, allocation),
      evidence,
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
          verification.documentType !== 'credit_note' ||
          verification.providerMode !== evidence.providerMode ||
          verification.considerationPaise !== evidence.refundedPaise ||
          verification.issuedAt.getTime() !== evidence.issuedAt.getTime() ||
          canonicalJson({
            sellerSnapshot: verification.sellerSnapshot,
            buyerSnapshot: verification.buyerSnapshot,
            taxSnapshot: verification.taxSnapshot,
          }) !== expectedBundle
        ) {
          throw new Error('Credit-note snapshot bundle was not approved')
        }
        return true
      },
      formatDocumentNumber(numberInput) {
        if (numberInput.documentType !== 'credit_note') {
          throw new Error('Only credit-note numbering is approved here')
        }
        return formatCreditNoteNumber({
          providerMode: evidence.providerMode,
          financialYear: numberInput.financialYear,
          sequenceNumber: numberInput.sequenceNumber,
        })
      },
    })
    const creditNote = await service.createCreditNote({
      providerMode: evidence.providerMode,
      userId: evidence.userId,
      invoiceId: invoice._id,
      refundRecordId: evidence.refundRecordId,
      razorpayRefundId: evidence.razorpayRefundId,
      razorpayPaymentId: evidence.razorpayPaymentId,
      refundedPaise: evidence.refundedPaise,
      sellerSnapshot,
      buyerSnapshot,
      taxSnapshot,
      reasonSnapshot: 'Razorpay refund processed',
      issuedAt: evidence.issuedAt,
    })
    const completed = await persistence.complete({
      evidence,
      creditNoteReferenceId: creditNote._id,
      completedAt: dependencies.now?.() ?? new Date(),
    })
    if (!completed) {
      return { disposition: 'deferred', reason: 'credit_note_completion_contended' }
    }
    return {
      disposition: 'issued',
      creditNoteReferenceId: creditNote._id.toString(),
    }
  } catch (error) {
    await failClaim(persistence, evidence, dependencies.now?.() ?? new Date())
    throw error
  }
}
