import mongoose from 'mongoose'
import { describe, expect, it, vi } from 'vitest'
import {
  recoverChargeFulfillment,
  type ChargeFulfillmentRecoveryStore,
} from '../services/chargeFulfillmentRecoveryService'

describe('charge fulfillment invoice recovery after reversal fencing', () => {
  it('issues the invoice while preserving a resolved-entitlement review state', async () => {
    const fulfillmentId = new mongoose.Types.ObjectId()
    const userId = new mongoose.Types.ObjectId()
    const paymentId = 'pay_ReviewInvoice123'
    const createdAt = new Date('2026-08-07T09:00:00.000Z')
    const store: ChargeFulfillmentRecoveryStore = {
      loadExact: vi.fn(async () => ({
        id: fulfillmentId,
        providerMode: 'live',
        razorpayPaymentId: paymentId,
        razorpayOrderId: 'order_ReviewInvoice123',
        userId,
        kind: 'single_interview',
        status: 'review',
        verifiedAmountPaise: 6_900,
        verifiedCurrency: 'INR',
        steps: {
          verification: {
            status: 'complete',
            operationKey: `live:${paymentId}:verification`,
            completedAt: createdAt,
            referenceId: paymentId,
          },
          entitlement: {
            status: 'complete',
            operationKey: `live:${paymentId}:entitlement`,
            completedAt: createdAt,
            referenceId: new mongoose.Types.ObjectId().toHexString(),
          },
          invoice: {
            status: 'pending',
            operationKey: `live:${paymentId}:invoice`,
          },
          notification: {
            status: 'pending',
            operationKey: `live:${paymentId}:notification`,
          },
        },
        attempts: 1,
        createdAt,
        updatedAt: createdAt,
      })),
    }
    const approvedFinancialPolicyHandler = vi.fn(async () => ({
      disposition: 'invoiced' as const,
      invoiceReferenceId: new mongoose.Types.ObjectId().toHexString(),
    }))

    await expect(recoverChargeFulfillment({
      fulfillmentId: fulfillmentId.toHexString(),
      providerMode: 'live',
    }, {
      store,
      approvedFinancialPolicyHandler,
    })).resolves.toMatchObject({
      outcome: 'financial_policy_handler_completed',
      currentStatus: 'review',
      nextStep: 'manual_review',
      terminal: true,
    })
    expect(approvedFinancialPolicyHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedStatus: 'review',
        invoiceStepStatus: 'pending',
      }),
    )
  })
})
