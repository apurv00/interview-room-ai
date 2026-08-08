import mongoose from 'mongoose'
import { describe, expect, it, vi } from 'vitest'
import type {
  FinancialCreditNoteCreateFields,
  FinancialDocumentStore,
  FinancialInvoiceCreateFields,
} from '@financial-ledger'
import type {
  ApprovedFinancialPolicyInput,
} from '../services/chargeFulfillmentRecoveryService'
import {
  calculateInclusiveGst,
  issueApprovedGstInvoice,
  resolveGstSellerPolicy,
  type GstInvoicePolicyPersistence,
} from '../services/approvedGstInvoicePolicyService'
import {
  issueApprovedGstCreditNote,
  type GstCreditNoteRecoveryPersistence,
} from '../services/approvedGstCreditNoteRecoveryService'

const fulfillmentId = new mongoose.Types.ObjectId().toString()
const userId = new mongoose.Types.ObjectId().toString()
const checkoutIntentId = new mongoose.Types.ObjectId().toString()
const invoiceId = new mongoose.Types.ObjectId()
const issuedAt = new Date('2026-08-07T10:00:00.000Z')
const claimedAt = new Date('2026-08-07T10:01:00.000Z')

const request: ApprovedFinancialPolicyInput = {
  fulfillmentId,
  providerMode: 'live',
  userId,
  kind: 'single_interview',
  razorpayPaymentId: 'pay_TestPayment123',
  razorpayOrderId: 'order_TestOrder123',
  verifiedAmountPaise: 6_900,
  verifiedCurrency: 'INR',
  expectedStatus: 'entitlement_applied',
  invoiceOperationKey: 'live:pay_TestPayment123:invoice',
  invoiceStepStatus: 'pending',
}

const environment = {
  PAYMENT_GST_SELLER_LEGAL_NAME: 'InterviewPrepGuru Legal Name',
  PAYMENT_GST_SELLER_ADDRESS: 'Ranchi, Jharkhand, India',
  PAYMENT_GST_SELLER_STATE_CODE: '20',
  PAYMENT_GST_SELLER_GSTIN: '20ABCDE1234F1Z5',
  PAYMENT_GST_SERVICE_SAC: '998313',
}

function persistence(
  overrides: Partial<GstInvoicePolicyPersistence> = {},
): GstInvoicePolicyPersistence {
  return {
    claimInvoiceStep: vi.fn(async () => ({
      outcome: 'claimed' as const,
      fence: claimedAt.toISOString(),
    })),
    loadInvoiceEvidence: vi.fn(async () => ({
      checkoutIntentId,
      buyerSnapshot: {
        name: 'Buyer',
        email: 'buyer@example.com',
        billingProfileVersion: 1,
        billingProfileContentHash: 'a'.repeat(64),
        placeOfSupply: { stateCode: '20', countryCode: 'IN' },
      },
      buyerStateCode: '20',
      issuedAt,
      description: 'InterviewPrepGuru interview unlock (up to 30 minutes)',
    })),
    completeInvoiceStep: vi.fn(async () => true),
    failInvoiceStep: vi.fn(async () => undefined),
    ...overrides,
  }
}

function documentStore(input?: {
  existing?: Record<string, unknown> | null
}): FinancialDocumentStore & {
  createInvoice: ReturnType<typeof vi.fn>
} {
  const createInvoice = vi.fn(async (fields: FinancialInvoiceCreateFields) => ({
    _id: invoiceId,
    ...fields,
  }))
  return {
    reserveSequence: vi.fn(async () => 1),
    findInvoiceByPaymentKey: vi.fn(async () =>
      (input?.existing ?? null) as never,
    ),
    findCreditNoteByRefundKey: vi.fn(async () => null),
    findInvoiceById: vi.fn(async () => null),
    findRefundRecordById: vi.fn(async () => null),
    createInvoice,
    createCreditNote: vi.fn(async () => {
      throw new Error('not used')
    }),
  }
}

describe('approved GST invoice policy', () => {
  it('requires an exact GSTIN, seller state match, and six-digit SAC', () => {
    expect(resolveGstSellerPolicy(environment)).toMatchObject({
      legalName: 'InterviewPrepGuru Legal Name',
      stateCode: '20',
      gstin: '20ABCDE1234F1Z5',
      sac: '998313',
    })
    expect(resolveGstSellerPolicy({
      ...environment,
      PAYMENT_GST_SELLER_STATE_CODE: '27',
    })).toBeNull()
    expect(resolveGstSellerPolicy({
      ...environment,
      PAYMENT_GST_SERVICE_SAC: '9983',
    })).toBeNull()
  })

  it('derives exact GST-inclusive paise for intra- and inter-state invoices', () => {
    expect(calculateInclusiveGst(59_900, 'intra_state')).toEqual({
      gstRateBps: 1_800,
      taxablePaise: 50_763,
      gstPaise: 9_137,
      grossPaise: 59_900,
      componentAllocation: 'intra_state',
      cgstPaise: 4_568,
      sgstPaise: 4_569,
    })
    expect(calculateInclusiveGst(99_900, 'inter_state')).toEqual({
      gstRateBps: 1_800,
      taxablePaise: 84_661,
      gstPaise: 15_239,
      grossPaise: 99_900,
      componentAllocation: 'inter_state',
      igstPaise: 15_239,
    })
  })

  it('fails the claimed step closed when seller policy is not configured', async () => {
    const state = persistence()
    const documents = documentStore()
    const result = await issueApprovedGstInvoice(request, {
      environment: {},
      persistence: state,
      documentStore: documents,
      now: () => claimedAt,
    })

    expect(result).toEqual({
      disposition: 'deferred',
      reason: 'gst_invoice_policy_not_configured',
    })
    expect(state.failInvoiceStep).toHaveBeenCalledWith(
      request,
      claimedAt.toISOString(),
      new Date('2026-08-07T10:06:00.000Z'),
      'gst_invoice_policy_not_configured',
    )
    expect(state.loadInvoiceEvidence).not.toHaveBeenCalled()
    expect(documents.createInvoice).not.toHaveBeenCalled()
  })

  it('reattaches an existing exact invoice without requiring current seller config', async () => {
    const state = persistence()
    const documents = documentStore({
      existing: {
        _id: invoiceId,
        providerMode: request.providerMode,
        userId: new mongoose.Types.ObjectId(userId),
        chargeKind: request.kind,
        razorpayPaymentId: request.razorpayPaymentId,
        razorpayOrderId: request.razorpayOrderId,
        capturedPaise: request.verifiedAmountPaise,
      },
    })
    await expect(issueApprovedGstInvoice(request, {
      environment: {},
      persistence: state,
      documentStore: documents,
      now: () => claimedAt,
    })).resolves.toEqual({
      disposition: 'already_invoiced',
      invoiceReferenceId: invoiceId.toString(),
    })
    expect(state.completeInvoiceStep).toHaveBeenCalledWith(
      request,
      claimedAt.toISOString(),
      invoiceId.toString(),
      claimedAt,
    )
    expect(state.loadInvoiceEvidence).not.toHaveBeenCalled()
  })

  it('creates one approved invoice and completes the exact fulfillment fence', async () => {
    const state = persistence()
    const documents = documentStore()
    const result = await issueApprovedGstInvoice(request, {
      environment,
      persistence: state,
      documentStore: documents,
      now: () => claimedAt,
    })

    expect(result).toEqual({
      disposition: 'invoiced',
      invoiceReferenceId: invoiceId.toString(),
    })
    expect(documents.createInvoice).toHaveBeenCalledOnce()
    const created = documents.createInvoice.mock.calls[0]![0]
    expect(created).toMatchObject({
      providerMode: 'live',
      chargeKind: 'single_interview',
      capturedPaise: 6_900,
      descriptionSnapshot:
        'InterviewPrepGuru interview unlock (up to 30 minutes)',
      numberSnapshot: {
        documentType: 'invoice',
        financialYear: '2026-27',
        sequenceNumber: 1,
        formattedNumber: 'IPG2627000000001',
      },
      taxSnapshot: {
        gstRateBps: 1_800,
        taxablePaise: 5_847,
        gstPaise: 1_053,
        grossPaise: 6_900,
        componentAllocation: 'intra_state',
        cgstPaise: 526,
        sgstPaise: 527,
      },
    })
    expect(state.completeInvoiceStep).toHaveBeenCalledWith(
      request,
      claimedAt.toISOString(),
      invoiceId.toString(),
      claimedAt,
    )
    expect(state.failInvoiceStep).not.toHaveBeenCalled()
  })

  it('issues an idempotent approved GST credit note for a processed refund', async () => {
    const invoiceState = persistence()
    const invoiceDocuments = documentStore()
    await issueApprovedGstInvoice(request, {
      environment,
      persistence: invoiceState,
      documentStore: invoiceDocuments,
      now: () => claimedAt,
    })
    const invoiceFields = invoiceDocuments.createInvoice.mock.calls[0]![0]
    const refundRecordId = new mongoose.Types.ObjectId()
    const creditNoteId = new mongoose.Types.ObjectId()
    const creditAttemptedAt = new Date('2026-08-07T11:01:00.000Z')
    const refundProcessedAt = new Date('2026-08-07T11:00:00.000Z')
    const evidence = {
      refundRecordId,
      userId: new mongoose.Types.ObjectId(userId),
      providerMode: 'live' as const,
      razorpayRefundId: 'rfnd_TestRefund123',
      razorpayPaymentId: request.razorpayPaymentId,
      razorpayOrderId: request.razorpayOrderId,
      originalCapturedPaise: 6_900,
      refundedPaise: 3_450,
      issuedAt: refundProcessedAt,
      fence: 1,
      attemptedAt: creditAttemptedAt,
    }
    const creditPersistence: GstCreditNoteRecoveryPersistence = {
      claim: vi.fn(async () => ({ outcome: 'claimed', evidence })),
      complete: vi.fn(async () => true),
      fail: vi.fn(async () => undefined),
    }
    const createCreditNote = vi.fn(
      async (fields: FinancialCreditNoteCreateFields) => ({
        _id: creditNoteId,
        ...fields,
      }),
    )
    const invoice = {
      _id: invoiceId,
      ...invoiceFields,
    }
    const creditDocuments: FinancialDocumentStore = {
      reserveSequence: vi.fn(async () => 1),
      findInvoiceByPaymentKey: vi.fn(async () => invoice as never),
      findCreditNoteByRefundKey: vi.fn(async () => null),
      findInvoiceById: vi.fn(async () => invoice as never),
      findRefundRecordById: vi.fn(async () => ({
        _id: refundRecordId,
        providerMode: 'live',
        userId: evidence.userId,
        razorpayRefundId: evidence.razorpayRefundId,
        razorpayPaymentId: evidence.razorpayPaymentId,
        razorpayOrderId: evidence.razorpayOrderId,
        originalCapturedPaise: 6_900,
        refundedPaise: 3_450,
        creditNoteDecision: { status: 'required' },
      }) as never),
      createInvoice: vi.fn(async () => invoice as never),
      createCreditNote: createCreditNote as never,
    }

    await expect(issueApprovedGstCreditNote({
      refundRecordId: refundRecordId.toHexString(),
      providerMode: 'live',
    }, {
      persistence: creditPersistence,
      documentStore: creditDocuments,
      now: () => creditAttemptedAt,
    })).resolves.toEqual({
      disposition: 'issued',
      creditNoteReferenceId: creditNoteId.toHexString(),
    })

    expect(createCreditNote).toHaveBeenCalledWith(expect.objectContaining({
      refundedPaise: 3_450,
      numberSnapshot: expect.objectContaining({
        documentType: 'credit_note',
        formattedNumber: 'ICN2627000000001',
      }),
      taxSnapshot: expect.objectContaining({
        grossPaise: 3_450,
        componentAllocation: 'intra_state',
      }),
    }))
    expect(creditPersistence.complete).toHaveBeenCalledWith({
      evidence,
      creditNoteReferenceId: creditNoteId,
      completedAt: creditAttemptedAt,
    })
  })
})
