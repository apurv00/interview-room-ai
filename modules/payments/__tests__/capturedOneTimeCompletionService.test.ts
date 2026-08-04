import mongoose from 'mongoose'
import { describe, expect, it, vi } from 'vitest'
import type {
  CapturedCheckoutVerificationInput,
  CapturedCheckoutVerificationResult,
} from '../services/capturedCheckoutVerificationService'
import {
  PR7_CAPTURED_ONE_TIME_COMPLETION_READY,
  verifyAndCompleteCapturedOneTimeCheckout,
} from '../services/capturedOneTimeCompletionService'

vi.mock('@shared/logger', () => ({
  logger: {
    child: () => ({
      error: vi.fn(),
    }),
  },
}))

const fulfillmentId = new mongoose.Types.ObjectId().toString()
const input: CapturedCheckoutVerificationInput = {
  userId: new mongoose.Types.ObjectId().toString(),
  intentId: new mongoose.Types.ObjectId().toString(),
  razorpayPaymentId: 'pay_TestPayment123',
  signature: 'a'.repeat(64),
  expectedKind: 'order',
}
const verified: CapturedCheckoutVerificationResult = {
  intentId: input.intentId,
  providerMode: 'test',
  razorpayPaymentId: input.razorpayPaymentId,
  checkoutKind: 'order',
  fulfillmentKind: 'single_interview',
  intentStatus: 'payment_captured',
  fulfillmentId,
  fulfillmentStatus: 'verified',
  reused: false,
}

describe('captured one-time checkout completion', () => {
  it('supports an explicit dark override and stops before recovery', async () => {
    const verify = vi.fn().mockResolvedValue(verified)
    const recover = vi.fn()

    expect(
      PR7_CAPTURED_ONE_TIME_COMPLETION_READY,
    ).toBe(true)
    await expect(
      verifyAndCompleteCapturedOneTimeCheckout(
        input,
        { completionReady: false, verify, recover },
      ),
    ).resolves.toEqual(verified)
    expect(verify).toHaveBeenCalledWith(input)
    expect(recover).not.toHaveBeenCalled()
  })

  it('maps an idempotently applied entitlement to a fulfilled intent', async () => {
    const recover = vi.fn().mockResolvedValue({
      fulfillmentId,
      providerMode: 'test',
      kind: 'single_interview',
      outcome: 'one_time_entitlement_processed',
      currentStatus: 'verified',
      nextStep: 'invoice',
      terminal: false,
      entitlement: {
        fulfillmentId,
        checkoutIntentId: input.intentId,
        entitlementId:
          new mongoose.Types.ObjectId().toString(),
        kind: 'single_interview',
        fulfillmentStatus: 'entitlement_applied',
        reused: true,
      },
    })

    await expect(
      verifyAndCompleteCapturedOneTimeCheckout(
        input,
        {
          completionReady: true,
          verify: vi.fn().mockResolvedValue(verified),
          recover,
        },
      ),
    ).resolves.toEqual({
      ...verified,
      intentStatus: 'fulfilled',
      fulfillmentStatus: 'entitlement_applied',
      reused: true,
    })
    expect(recover).toHaveBeenCalledWith({
      fulfillmentId,
      providerMode: 'test',
    })
  })

  it.each([
    {
      ...verified,
      intentStatus: 'fulfilled' as const,
      fulfillmentStatus: 'entitlement_applied' as const,
    },
    {
      ...verified,
      fulfillmentStatus: 'review' as const,
    },
  ])('does not replay a non-verified fulfillment', async (current) => {
    const recover = vi.fn()
    await expect(
      verifyAndCompleteCapturedOneTimeCheckout(
        input,
        {
          completionReady: true,
          verify: vi.fn().mockResolvedValue(current),
          recover,
        },
      ),
    ).resolves.toEqual(current)
    expect(recover).not.toHaveBeenCalled()
  })

  it('returns the durable captured state when recovery is deferred', async () => {
    const recover = vi.fn().mockRejectedValue(
      new Error('temporary database outage'),
    )
    await expect(
      verifyAndCompleteCapturedOneTimeCheckout(
        input,
        {
          completionReady: true,
          verify: vi.fn().mockResolvedValue(verified),
          recover,
        },
      ),
    ).resolves.toEqual(verified)
  })

  it('rejects an incoherent verified target before recovery', async () => {
    const recover = vi.fn()
    await expect(
      verifyAndCompleteCapturedOneTimeCheckout(
        input,
        {
          completionReady: true,
          verify: vi.fn().mockResolvedValue({
            ...verified,
            checkoutKind: 'subscription',
            fulfillmentKind: 'subscription_cycle',
          }),
          recover,
        },
      ),
    ).resolves.toMatchObject({
      checkoutKind: 'subscription',
      fulfillmentKind: 'subscription_cycle',
    })
    expect(recover).not.toHaveBeenCalled()
  })
})
