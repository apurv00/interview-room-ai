import mongoose from 'mongoose'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChargeFulfillment } from '../models/ChargeFulfillment'
import {
  completeIndividualFinancialDocumentPolicy,
  INDIVIDUAL_FINANCIAL_DOCUMENT_NOT_REQUIRED_REFERENCE,
  mongoIndividualFinancialDocumentPolicyPersistence,
} from '../services/individualFinancialDocumentPolicyService'
import type {
  ApprovedFinancialPolicyInput,
} from '../services/chargeFulfillmentRecoveryService'

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn(async () => undefined),
}))

const attemptedAt = new Date('2026-08-08T05:00:00.000Z')
const completedAt = new Date('2026-08-08T05:05:00.000Z')

function input(
  invoiceStepStatus: ApprovedFinancialPolicyInput['invoiceStepStatus'] =
    'failed',
): ApprovedFinancialPolicyInput {
  return {
    fulfillmentId: '507f1f77bcf86cd799439011',
    providerMode: 'live',
    userId: '507f1f77bcf86cd799439012',
    kind: 'subscription_cycle',
    razorpayPaymentId: 'pay_livePayment1',
    razorpayInvoiceId: 'inv_liveInvoice1',
    razorpaySubscriptionId: 'sub_liveSubscription1',
    razorpayOrderId: 'order_liveOrder1',
    verifiedAmountPaise: 49_900,
    verifiedCurrency: 'INR',
    expectedStatus: 'entitlement_applied',
    invoiceOperationKey: 'live:pay_livePayment1:invoice',
    invoiceStepStatus,
    invoiceAttemptFence: attemptedAt.toISOString(),
  }
}

function queryResult(value: unknown) {
  return {
    select: vi.fn(() => ({
      lean: vi.fn(() => ({
        exec: vi.fn(async () => value),
      })),
    })),
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('individual financial-document policy', () => {
  it('heals a failed invoice step with durable not-required evidence', async () => {
    const update = vi.spyOn(ChargeFulfillment, 'findOneAndUpdate')
      .mockReturnValue(queryResult({ _id: new mongoose.Types.ObjectId() }) as never)

    await expect(
      mongoIndividualFinancialDocumentPolicyPersistence.completeNotRequired(
        input('failed'),
        completedAt,
      ),
    ).resolves.toBe('completed')

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'entitlement_applied',
        'steps.invoice.status': 'failed',
        'steps.invoice.lastAttemptAt': attemptedAt,
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'invoiced',
          'steps.invoice.status': 'complete',
          'steps.invoice.referenceId':
            INDIVIDUAL_FINANCIAL_DOCUMENT_NOT_REQUIRED_REFERENCE,
        }),
        $unset: { lastError: 1, nextAttemptAt: 1 },
      }),
      { new: true, runValidators: true },
    )
  })

  it('returns a completed recovery disposition without creating an invoice', async () => {
    const completeNotRequired = vi.fn(async () => 'already_completed' as const)

    await expect(completeIndividualFinancialDocumentPolicy(input(), {
      persistence: { completeNotRequired },
      now: () => completedAt,
    })).resolves.toEqual({
      disposition: 'already_invoiced',
      invoiceReferenceId:
        INDIVIDUAL_FINANCIAL_DOCUMENT_NOT_REQUIRED_REFERENCE,
    })
    expect(completeNotRequired).toHaveBeenCalledWith(input(), completedAt)
  })
})
