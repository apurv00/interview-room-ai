import fs from 'node:fs'
import path from 'node:path'
import mongoose from 'mongoose'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChargeFulfillment } from '../models/ChargeFulfillment'
import { CheckoutIntent } from '../models/CheckoutIntent'
import { DisputeRecord } from '../models/DisputeRecord'
import { PaidInterviewUnlock } from '../models/PaidInterviewUnlock'
import { PaymentAttempt } from '../models/PaymentAttempt'
import { RefundRecord } from '../models/RefundRecord'
import {
  RazorpayDisputeDtoSchema,
  RazorpayOrderDtoSchema,
  RazorpayPaymentDtoSchema,
  RazorpayRefundDtoSchema,
} from '../providers/razorpayServerAdapter'
import {
  FinancialReversalPersistenceError,
  mongoFinancialReversalPersistenceStore,
  persistDisputeWebhookEffect,
  persistRefundWebhookEffect,
  type DisputePersistenceRequest,
  type FinancialReversalCommercialAnalyticsEvidence,
  type FinancialReversalPersistenceStore,
  type RefundPersistenceRequest,
} from '../services/financialReversalPersistenceService'
import type {
  DisputeEffectInput,
  RefundEffectInput,
  TrustedOneTimeWebhookIntent,
} from '../services/webhookDomainDispatchService'

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn(async () => undefined),
}))

const inboxEventId = '64b64c3f3fc0475f0ca47f01'
const paymentId = 'pay_00000000000001'
const orderId = 'order_00000000000001'
const refundId = 'rfnd_00000000000001'
const disputeId = 'disp_00000000000001'
const userId =
  new mongoose.Types.ObjectId('507f1f77bcf86cd799439011')
const checkoutIntentId =
  new mongoose.Types.ObjectId('507f1f77bcf86cd799439012')
const fulfillmentId =
  new mongoose.Types.ObjectId('507f1f77bcf86cd799439013')
const attemptId =
  new mongoose.Types.ObjectId('507f1f77bcf86cd799439014')
const observedAt = new Date('2026-07-24T12:00:00.000Z')

function payment(
  overrides: Record<string, unknown> = {},
) {
  return RazorpayPaymentDtoSchema.parse({
    providerMode: 'test',
    id: paymentId,
    orderId,
    amountPaise: 6_900,
    amountRefundedPaise: 6_900,
    currency: 'INR',
    status: 'refunded',
    captured: true,
    method: 'upi',
    notes: {},
    createdAtEpochSeconds: 1_721_779_202,
    ...overrides,
  })
}

function order() {
  return RazorpayOrderDtoSchema.parse({
    providerMode: 'test',
    id: orderId,
    amountPaise: 6_900,
    amountPaidPaise: 6_900,
    amountDuePaise: 0,
    currency: 'INR',
    receipt: 'intent-receipt-0001',
    status: 'paid',
    attempts: 1,
    notes: {},
    createdAtEpochSeconds: 1_721_779_200,
  })
}

function intent(): TrustedOneTimeWebhookIntent {
  return {
    _id: checkoutIntentId,
    userId,
    kind: 'single_interview',
    providerMode: 'test',
    status: 'fulfilled',
    payablePaise: 6_900,
    currency: 'INR',
    razorpayOrderId: orderId,
    receipt: 'intent-receipt-0001',
  }
}

function refund(
  status: 'pending' | 'processed' | 'failed' = 'processed',
  overrides: Record<string, unknown> = {},
) {
  return RazorpayRefundDtoSchema.parse({
    providerMode: 'test',
    id: refundId,
    paymentId,
    amountPaise: 6_900,
    currency: 'INR',
    status,
    createdAtEpochSeconds: 1_721_779_203,
    ...overrides,
  })
}

function dispute(
  status: 'open' | 'under_review' | 'won' | 'lost' | 'closed' =
    'open',
  overrides: Record<string, unknown> = {},
) {
  return RazorpayDisputeDtoSchema.parse({
    providerMode: 'test',
    id: disputeId,
    paymentId,
    amountPaise: 6_900,
    amountDeductedPaise:
      status === 'won' ? 0 : 6_900,
    currency: 'INR',
    reasonCode: 'pre_arbitration',
    respondByEpochSeconds: 1_724_371_200,
    status,
    phase: 'pre_arbitration',
    createdAtEpochSeconds: 1_721_779_204,
    ...overrides,
  })
}

function refundInput(
  status: 'pending' | 'processed' | 'failed' = 'processed',
  overrides: Partial<RefundEffectInput> = {},
): RefundEffectInput {
  return {
    inboxEventId,
    providerMode: 'test',
    eventType:
      status === 'failed'
        ? 'refund.failed'
        : status === 'processed'
          ? 'refund.processed'
          : 'refund.created',
    razorpayRefundId: refundId,
    razorpayPaymentId: paymentId,
    refund: refund(status),
    payment: payment({
      status: status === 'processed' ? 'refunded' : 'captured',
      amountRefundedPaise: status === 'processed' ? 6_900 : 0,
    }),
    target: {
      kind: 'one_time_checkout',
      intent: intent(),
      order: order(),
    },
    ...overrides,
  }
}

function disputeInput(
  status: 'open' | 'under_review' | 'won' | 'lost' | 'closed' =
    'open',
  overrides: Partial<DisputeEffectInput> = {},
): DisputeEffectInput {
  return {
    inboxEventId,
    providerMode: 'test',
    eventType: status === 'lost'
      ? 'payment.dispute.lost'
      : status === 'won'
        ? 'payment.dispute.won'
        : status === 'closed'
          ? 'payment.dispute.closed'
          : status === 'under_review'
            ? 'payment.dispute.under_review'
            : 'payment.dispute.created',
    razorpayDisputeId: disputeId,
    razorpayPaymentId: paymentId,
    dispute: dispute(status),
    payment: payment({
      status: 'captured',
      amountRefundedPaise: 0,
    }),
    target: {
      kind: 'one_time_checkout',
      intent: intent(),
      order: order(),
    },
    ...overrides,
  }
}

function storeHarness() {
  const persistRefund = vi.fn(async (input: RefundPersistenceRequest) => ({
    operationKey: input.operationKey,
    reused: false,
  }))
  const persistDispute = vi.fn(async (input) => ({
    operationKey: input.operationKey,
    reused: false,
  }))
  const store: FinancialReversalPersistenceStore = {
    persistRefund,
    persistDispute,
  }
  return { store, persistRefund, persistDispute }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('financial reversal webhook boundaries', () => {
  it('classifies a processed refund as a grant-fencing reversal', async () => {
    const harness = storeHarness()

    await expect(persistRefundWebhookEffect(
      refundInput('processed'),
      {
        store: harness.store,
        now: () => observedAt,
      },
    )).resolves.toEqual({
      outcome: 'handled',
      operationKey:
        `test:refund:${refundId}:${inboxEventId}`,
    })

    expect(harness.persistRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        financialOutcome: 'reversed',
        requiresEntitlementFence: true,
        originalCapturedPaise: 6_900,
        userId,
        checkoutIntentId,
      }),
    )
  })

  it.each([
    ['pending', 'pending', false],
    ['failed', 'failed', false],
  ] as const)(
    'does not treat a %s refund as a financial reversal',
    async (status, financialOutcome, requiresEntitlementFence) => {
      const harness = storeHarness()
      await persistRefundWebhookEffect(refundInput(status), {
        store: harness.store,
        now: () => observedAt,
      })
      expect(harness.persistRefund).toHaveBeenCalledWith(
        expect.objectContaining({
          financialOutcome,
          requiresEntitlementFence,
        }),
      )
    },
  )

  it('passes the analytics producer only through verified dispute persistence', async () => {
    const harness = storeHarness()
    const commercialAnalyticsProducer = {
      appendReversalInSession: vi.fn(),
    }
    await persistDisputeWebhookEffect(disputeInput('open'), {
      store: harness.store,
      now: () => observedAt,
      commercialAnalyticsProducer,
    })

    expect(harness.persistDispute).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'payment.dispute.created',
        razorpayDisputeId: disputeId,
      }),
      commercialAnalyticsProducer,
    )
  })

  it.each([
    ['open', 'adverse_pending', true],
    ['under_review', 'adverse_pending', true],
    ['lost', 'reversed', true],
    ['won', 'favorable', false],
    ['closed', 'closed', false],
  ] as const)(
    'classifies dispute state %s without silently restoring access',
    async (status, financialOutcome, requiresEntitlementFence) => {
      const harness = storeHarness()
      await expect(persistDisputeWebhookEffect(
        disputeInput(status),
        {
          store: harness.store,
          now: () => observedAt,
        },
      )).resolves.toMatchObject({ outcome: 'handled' })
      expect(harness.persistDispute).toHaveBeenCalledWith(
        expect.objectContaining({
          financialOutcome,
          requiresEntitlementFence,
        }),
      )
    },
  )

  it('rejects a reduced webhook entity that was not normalized by the reader', async () => {
    const harness = storeHarness()
    const input = refundInput('processed')
    input.refund = {
      providerMode: 'test',
      id: refundId,
      paymentId,
      amountPaise: 6_900,
      currency: 'INR',
      status: 'processed',
    }

    await expect(persistRefundWebhookEffect(input, {
      store: harness.store,
      now: () => observedAt,
    })).rejects.toMatchObject({ code: 'input_invalid' })
    expect(harness.persistRefund).not.toHaveBeenCalled()
  })

  it('rejects a processed refund absent from the fetched payment total', async () => {
    const harness = storeHarness()
    const input = refundInput('processed', {
      payment: payment({
        status: 'captured',
        amountRefundedPaise: 0,
      }),
    })

    await expect(persistRefundWebhookEffect(input, {
      store: harness.store,
      now: () => observedAt,
    })).rejects.toMatchObject({ code: 'context_conflict' })
    expect(harness.persistRefund).not.toHaveBeenCalled()
  })

  it('rejects a local target that belongs to a different user context', async () => {
    const harness = storeHarness()
    const input = refundInput('processed')
    input.target = {
      kind: 'one_time_checkout',
      intent: {
        ...intent(),
        providerMode: 'live',
      },
      order: order(),
    }

    await expect(persistRefundWebhookEffect(input, {
      store: harness.store,
      now: () => observedAt,
    })).rejects.toMatchObject({ code: 'context_conflict' })
    expect(harness.persistRefund).not.toHaveBeenCalled()
  })

  it('sanitizes unexpected store failures behind the domain error', async () => {
    const harness = storeHarness()
    harness.persistRefund.mockRejectedValueOnce(
      new Error('database topology details'),
    )

    await expect(persistRefundWebhookEffect(
      refundInput('processed'),
      {
        store: harness.store,
        now: () => observedAt,
      },
    )).rejects.toEqual(expect.objectContaining({
      code: 'persistence_conflict',
      message: 'Financial reversal could not be persisted coherently',
    }))
  })
})

function sessionLean<T>(value: T) {
  const lean = vi.fn(async () => value)
  const session = vi.fn(() => ({ lean }))
  return { session, lean }
}

function selectSessionLean<T>(value: T) {
  const chain = sessionLean(value)
  return {
    select: vi.fn(() => ({ session: chain.session })),
    ...chain,
  }
}

function refundPersistenceRequest(): RefundPersistenceRequest {
  return {
    kind: 'refund',
    operationKey:
      `test:refund:${refundId}:${inboxEventId}`,
    inboxEventId,
    providerMode: 'test',
    userId,
    checkoutIntentId,
    razorpayPaymentId: paymentId,
    razorpayOrderId: orderId,
    originalCapturedPaise: 6_900,
    currency: 'INR',
    payment: payment(),
    observedAt,
    requiresEntitlementFence: true,
    eventType: 'refund.processed',
    razorpayRefundId: refundId,
    refund: refund(),
    financialOutcome: 'reversed',
  }
}

function mongoContext(entitlementApplied = false) {
  return {
    attempt: {
      _id: attemptId,
      checkoutIntentId,
      providerMode: 'test' as const,
      razorpayPaymentId: paymentId,
      razorpayOrderId: orderId,
      userId,
      status: 'captured' as const,
      amountPaise: 6_900,
      currency: 'INR',
      lastSyncedAt: new Date('2026-07-24T11:00:00.000Z'),
    },
    fulfillment: {
      _id: fulfillmentId,
      providerMode: 'test' as const,
      razorpayPaymentId: paymentId,
      razorpayOrderId: orderId,
      userId,
      status: entitlementApplied
        ? 'entitlement_applied' as const
        : 'verified' as const,
      verifiedAmountPaise: 6_900,
      verifiedCurrency: 'INR',
      steps: {
        verification: {
          status: 'complete' as const,
          operationKey: `test:${paymentId}:verification`,
          completedAt: new Date('2026-07-24T11:00:00.000Z'),
          referenceId: paymentId,
        },
        entitlement: entitlementApplied
          ? {
              status: 'complete' as const,
              operationKey: `test:${paymentId}:entitlement`,
              completedAt:
                new Date('2026-07-24T11:05:00.000Z'),
              referenceId: 'entitlement-record-id',
            }
          : {
              status: 'pending' as const,
              operationKey: `test:${paymentId}:entitlement`,
            },
        invoice: {
          status: 'pending' as const,
          operationKey: `test:${paymentId}:invoice`,
        },
        notification: {
          status: 'pending' as const,
          operationKey: `test:${paymentId}:notification`,
        },
      },
    },
  }
}

function mockMongoTransaction(entitlementApplied = false) {
  const context = mongoContext(entitlementApplied)
  const withTransaction = vi.fn(async (work, options) => {
    await work()
    return options
  })
  const endSession = vi.fn(async () => undefined)
  vi.spyOn(mongoose, 'startSession').mockResolvedValue({
    withTransaction,
    endSession,
  } as unknown as mongoose.ClientSession)
  vi.spyOn(PaymentAttempt, 'findOne').mockReturnValue(
    sessionLean(context.attempt) as never,
  )
  vi.spyOn(ChargeFulfillment, 'findOne').mockReturnValue(
    sessionLean(context.fulfillment) as never,
  )
  const fence = vi.spyOn(
    ChargeFulfillment,
    'findOneAndUpdate',
  ).mockReturnValue({
    lean: vi.fn(async () => ({
      _id: fulfillmentId,
      status: 'review',
    })),
  } as never)
  const attemptUpdate = vi.spyOn(
    PaymentAttempt,
    'updateOne',
  ).mockResolvedValue({ matchedCount: 1 } as never)
  vi.spyOn(RefundRecord, 'findOne').mockReturnValue(
    sessionLean(null) as never,
  )
  const createRefund = vi.spyOn(
    RefundRecord,
    'create',
  ).mockResolvedValue([] as never)
  const accessDecisionUpdate = entitlementApplied
    ? vi.spyOn(RefundRecord, 'updateOne')
        .mockResolvedValue({ matchedCount: 1 } as never)
    : undefined
  const unlockUpdate = entitlementApplied
    ? vi.spyOn(PaidInterviewUnlock, 'updateOne')
        .mockResolvedValue({ modifiedCount: 1 } as never)
    : undefined
  if (entitlementApplied) {
    vi.spyOn(CheckoutIntent, 'findOne').mockReturnValue(
      selectSessionLean({
        _id: checkoutIntentId,
        userId,
        kind: 'single_interview' as const,
        providerMode: 'test' as const,
        status: 'fulfilled',
        razorpayOrderId: orderId,
      }) as never,
    )
    vi.spyOn(PaidInterviewUnlock, 'findOne').mockReturnValue(
      sessionLean({
        _id: new mongoose.Types.ObjectId(
          '507f1f77bcf86cd799439016',
        ),
        status: 'available' as const,
      }) as never,
    )
  }
  return {
    withTransaction,
    endSession,
    fence,
    attemptUpdate,
    createRefund,
    accessDecisionUpdate,
    unlockUpdate,
  }
}

describe('mongo reversal transaction fence', () => {
  it('serializes exact-context reads on the Mongo transaction session', () => {
    const source = fs.readFileSync(
      path.join(
        process.cwd(),
        'modules/payments/services/financialReversalPersistenceService.ts',
      ),
      'utf8',
    )
    const exactContext = source.slice(
      source.indexOf('async function loadExactReversalContext'),
      source.indexOf('function nextPaymentAttemptStatus'),
    )

    expect(exactContext).not.toContain('Promise.all')
  })

  it('CASes the exact entitlement operation before recording a refund', async () => {
    const harness = mockMongoTransaction()
    await expect(
      mongoFinancialReversalPersistenceStore.persistRefund(
        refundPersistenceRequest(),
      ),
    ).resolves.toMatchObject({
      operationKey:
        `test:refund:${refundId}:${inboxEventId}`,
      reused: false,
    })

    expect(harness.withTransaction).toHaveBeenCalledWith(
      expect.any(Function),
      {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
        readPreference: 'primary',
      },
    )
    expect(harness.fence).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: fulfillmentId,
        status: 'verified',
        'steps.entitlement.status': 'pending',
        'steps.entitlement.operationKey':
          `test:${paymentId}:entitlement`,
      }),
      {
        $set: expect.objectContaining({ status: 'review' }),
      },
      expect.objectContaining({ session: expect.anything() }),
    )
    expect(harness.attemptUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: attemptId, status: 'captured' }),
      {
        $set: expect.objectContaining({ status: 'refunded' }),
      },
      expect.objectContaining({ session: expect.anything() }),
    )
    expect(harness.createRefund).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          razorpayRefundId: refundId,
          creditNoteDecision: expect.objectContaining({
            status: 'not_required',
            reason:
              'individual_purchase_financial_document_not_issued',
          }),
          accessReversalDecision: expect.objectContaining({
            status: 'not_required',
            reason: 'entitlement_grant_fenced',
          }),
        }),
      ],
      expect.objectContaining({ session: expect.anything() }),
    )
    expect(harness.endSession).toHaveBeenCalledOnce()
  })

  it('revokes unused paid-interview access after a full refund', async () => {
    const harness = mockMongoTransaction(true)
    await mongoFinancialReversalPersistenceStore.persistRefund(
      refundPersistenceRequest(),
    )

    expect(harness.fence).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'entitlement_applied',
        'steps.entitlement.status': 'complete',
        'steps.entitlement.referenceId': 'entitlement-record-id',
      }),
      {
        $set: expect.objectContaining({ status: 'review' }),
      },
      expect.any(Object),
    )
    expect(harness.createRefund).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          accessReversalDecision: expect.objectContaining({
            status: 'pending_review',
            reason: 'entitlement_already_applied',
          }),
        }),
      ],
      expect.any(Object),
    )
    expect(harness.unlockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'available' }),
      { $set: { status: 'expired' } },
      expect.objectContaining({ session: expect.anything() }),
    )
    expect(harness.accessDecisionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        providerMode: 'test',
        razorpayRefundId: refundId,
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          'accessReversalDecision.status': 'completed',
          'accessReversalDecision.reason':
            'unused_paid_interview_access_expired',
        }),
      }),
      expect.objectContaining({ session: expect.anything() }),
    )
  })

  it('fences a skipped entitlement for review without treating it as a grant', async () => {
    const harness = mockMongoTransaction()
    const context = mongoContext()
    const skippedFulfillment = {
      ...context.fulfillment,
      status: 'entitlement_skipped' as const,
      steps: {
        ...context.fulfillment.steps,
        entitlement: {
          status: 'skipped' as const,
          operationKey: `test:${paymentId}:entitlement`,
          completedAt: new Date('2026-07-24T11:05:00.000Z'),
          lastAttemptAt: new Date('2026-07-24T11:05:00.000Z'),
          referenceId: 'entitlement-not-required',
        },
      },
    }
    vi.mocked(ChargeFulfillment.findOne).mockReturnValue(
      sessionLean(skippedFulfillment) as never,
    )

    await mongoFinancialReversalPersistenceStore.persistRefund(
      refundPersistenceRequest(),
    )

    expect(harness.fence).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'entitlement_skipped',
        'steps.entitlement.status': 'skipped',
        'steps.entitlement.operationKey':
          `test:${paymentId}:entitlement`,
        'steps.entitlement.referenceId':
          'entitlement-not-required',
      }),
      {
        $set: expect.objectContaining({ status: 'review' }),
      },
      expect.any(Object),
    )
    expect(harness.createRefund).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          accessReversalDecision: expect.objectContaining({
            status: 'not_required',
            reason: 'entitlement_grant_fenced',
          }),
        }),
      ],
      expect.any(Object),
    )
  })

  it('puts a processed partial refund in review while still fencing the grant', async () => {
    const harness = mockMongoTransaction()
    const request = refundPersistenceRequest()
    request.refund = refund('processed', { amountPaise: 3_000 })
    request.payment = payment({
      status: 'captured',
      amountRefundedPaise: 3_000,
    })

    await mongoFinancialReversalPersistenceStore.persistRefund(request)

    expect(harness.fence).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: fulfillmentId,
        status: 'verified',
        'steps.entitlement.operationKey':
          `test:${paymentId}:entitlement`,
      }),
      {
        $set: expect.objectContaining({ status: 'review' }),
      },
      expect.any(Object),
    )
    expect(harness.attemptUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: attemptId, status: 'captured' }),
      {
        $set: expect.objectContaining({ status: 'review' }),
      },
      expect.any(Object),
    )
    expect(harness.createRefund).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          originalCapturedPaise: 6_900,
          refundedPaise: 3_000,
          status: 'review_required',
        }),
      ],
      expect.any(Object),
    )
  })

  it('rolls back as a conflict when the grant wins the CAS race', async () => {
    const harness = mockMongoTransaction()
    harness.fence.mockReturnValueOnce({
      lean: vi.fn(async () => null),
    } as never)

    await expect(
      mongoFinancialReversalPersistenceStore.persistRefund(
        refundPersistenceRequest(),
      ),
    ).rejects.toEqual(expect.objectContaining({
      code: 'persistence_conflict',
      message:
        'Entitlement grant raced with the financial reversal fence',
    }))
    expect(harness.createRefund).not.toHaveBeenCalled()
  })

  it('records a failed refund without fencing or financial-reversal state', async () => {
    const harness = mockMongoTransaction()
    const request = refundPersistenceRequest()
    request.refund = refund('failed')
    request.payment = payment({
      status: 'captured',
      amountRefundedPaise: 0,
    })
    request.eventType = 'refund.failed'
    request.financialOutcome = 'failed'
    request.requiresEntitlementFence = false

    await mongoFinancialReversalPersistenceStore.persistRefund(request)

    expect(harness.fence).not.toHaveBeenCalled()
    const created = harness.createRefund.mock.calls[0]?.[0]?.[0]
    expect(created).toMatchObject({
      status: 'failed',
      lastError: 'Razorpay reported the refund as failed',
      creditNoteDecision: {
        idempotencyKey: `test:${refundId}:credit-note`,
        status: 'not_required',
        decidedAt: observedAt,
        reason: 'provider_refund_failed',
      },
      accessReversalDecision: {
        idempotencyKey: `test:${refundId}:access`,
        status: 'not_required',
        decidedAt: observedAt,
        reason: 'provider_refund_failed',
      },
    })
    await expect(
      new RefundRecord(created).validate(),
    ).resolves.toBeUndefined()
  })

  it('finalizes a pending refund decision when the provider definitively fails it', async () => {
    const harness = mockMongoTransaction()
    const pendingSyncedAt =
      new Date('2026-07-24T11:30:00.000Z')
    const existing = {
      _id: new mongoose.Types.ObjectId(
        '507f1f77bcf86cd799439015',
      ),
      providerMode: 'test' as const,
      userId,
      razorpayRefundId: refundId,
      razorpayPaymentId: paymentId,
      razorpayOrderId: orderId,
      originalCapturedPaise: 6_900,
      refundedPaise: 6_900,
      currency: 'INR',
      status: 'received' as const,
      creditNoteDecision: {
        idempotencyKey: `test:${refundId}:credit-note`,
        status: 'pending_review' as const,
        reason: 'provider_refund_pending',
      },
      accessReversalDecision: {
        idempotencyKey: `test:${refundId}:access`,
        status: 'pending_review' as const,
        reason: 'provider_refund_pending',
      },
      originalProviderSnapshot: {},
      lastProviderSnapshot: {},
      receivedAt: pendingSyncedAt,
      lastSyncedAt: pendingSyncedAt,
      attempts: 1,
    }
    vi.mocked(RefundRecord.findOne).mockReturnValue(
      sessionLean(existing) as never,
    )
    const updateRefund = vi.spyOn(
      RefundRecord,
      'updateOne',
    ).mockResolvedValue({ matchedCount: 1 } as never)
    const request = refundPersistenceRequest()
    request.refund = refund('failed')
    request.payment = payment({
      status: 'captured',
      amountRefundedPaise: 0,
    })
    request.eventType = 'refund.failed'
    request.financialOutcome = 'failed'
    request.requiresEntitlementFence = false

    await mongoFinancialReversalPersistenceStore.persistRefund(request)

    expect(harness.fence).not.toHaveBeenCalled()
    expect(harness.attemptUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'captured' }),
      {
        $set: expect.objectContaining({ status: 'captured' }),
      },
      expect.any(Object),
    )
    expect(updateRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: existing._id,
        status: 'received',
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'failed',
          creditNoteDecision: expect.objectContaining({
            status: 'not_required',
            reason: 'provider_refund_failed',
          }),
          accessReversalDecision: expect.objectContaining({
            status: 'not_required',
            decidedAt: observedAt,
            reason: 'provider_refund_failed',
          }),
        }),
      }),
      expect.any(Object),
    )
    expect(harness.createRefund).not.toHaveBeenCalled()
  })
})

function disputePersistenceRequest(input: {
  status: 'open' | 'under_review' | 'won' | 'lost' | 'closed'
  eventType: DisputePersistenceRequest['eventType']
  operationInboxEventId: string
  requestObservedAt: Date
}): DisputePersistenceRequest {
  const financialOutcome = input.status === 'lost'
    ? 'reversed' as const
    : input.status === 'won'
      ? 'favorable' as const
      : input.status === 'closed'
        ? 'closed' as const
        : 'adverse_pending' as const
  return {
    kind: 'dispute',
    operationKey:
      `test:dispute:${disputeId}:` +
      input.operationInboxEventId,
    inboxEventId: input.operationInboxEventId,
    providerMode: 'test',
    userId,
    checkoutIntentId,
    razorpayPaymentId: paymentId,
    razorpayOrderId: orderId,
    originalCapturedPaise: 6_900,
    currency: 'INR',
    payment: payment({
      status: 'captured',
      amountRefundedPaise: 0,
    }),
    observedAt: input.requestObservedAt,
    requiresEntitlementFence:
      financialOutcome === 'adverse_pending' ||
      financialOutcome === 'reversed',
    eventType: input.eventType,
    razorpayDisputeId: disputeId,
    dispute: dispute(input.status),
    financialOutcome,
  }
}

function disputeSnapshot(
  request: DisputePersistenceRequest,
) {
  return {
    operationKey: request.operationKey,
    inboxEventId: request.inboxEventId,
    eventType: request.eventType,
    dispute: request.dispute,
  }
}

function existingDisputeRecord(
  adverseRequest: DisputePersistenceRequest,
) {
  const snapshot = disputeSnapshot(adverseRequest)
  return {
    _id: new mongoose.Types.ObjectId(
      '507f1f77bcf86cd799439016',
    ),
    providerMode: 'test' as const,
    userId,
    razorpayDisputeId: disputeId,
    razorpayPaymentId: paymentId,
    razorpayOrderId: orderId,
    originalCapturedPaise: 6_900,
    disputedPaise: 6_900,
    amountDeductedPaise:
      adverseRequest.dispute.amountDeductedPaise,
    currency: 'INR',
    status: adverseRequest.dispute.status,
    creditNoteDecision: {
      idempotencyKey: `test:${disputeId}:credit-note`,
      status: 'pending_review' as const,
      reason: 'provider_dispute_pending',
    },
    accessReversalDecision: {
      idempotencyKey: `test:${disputeId}:access`,
      status: 'pending_review' as const,
      reason: 'provider_dispute_pending',
    },
    originalProviderSnapshot: snapshot,
    lastProviderSnapshot: snapshot,
    history: [{
      operationKey: adverseRequest.operationKey,
      inboxEventId: adverseRequest.inboxEventId,
      eventType: adverseRequest.eventType,
      providerStatus: adverseRequest.dispute.status,
      amountDeductedPaise:
        adverseRequest.dispute.amountDeductedPaise,
      providerSnapshot: snapshot,
      observedAt: adverseRequest.observedAt,
    }],
    receivedAt: adverseRequest.observedAt,
    lastSyncedAt: adverseRequest.observedAt,
    attempts: 1,
  }
}

function mockMongoDisputeTransaction(
  existing: ReturnType<typeof existingDisputeRecord>,
) {
  const base = mongoContext()
  const attempt = {
    ...base.attempt,
    status: 'disputed' as const,
    lastSyncedAt: existing.lastSyncedAt,
  }
  const fulfillment = {
    ...base.fulfillment,
    status: 'review' as const,
  }
  const withTransaction = vi.fn(async (work, options) => {
    await work()
    return options
  })
  const endSession = vi.fn(async () => undefined)
  vi.spyOn(mongoose, 'startSession').mockResolvedValue({
    withTransaction,
    endSession,
  } as unknown as mongoose.ClientSession)
  vi.spyOn(PaymentAttempt, 'findOne').mockReturnValue(
    sessionLean(attempt) as never,
  )
  vi.spyOn(ChargeFulfillment, 'findOne').mockReturnValue(
    sessionLean(fulfillment) as never,
  )
  const fence = vi.spyOn(
    ChargeFulfillment,
    'findOneAndUpdate',
  ).mockReturnValue({
    lean: vi.fn(async () => ({
      _id: fulfillmentId,
      status: 'review',
    })),
  } as never)
  const attemptUpdate = vi.spyOn(
    PaymentAttempt,
    'updateOne',
  ).mockResolvedValue({ matchedCount: 1 } as never)
  vi.spyOn(DisputeRecord, 'findOne').mockReturnValue(
    sessionLean(existing) as never,
  )
  const updateDispute = vi.spyOn(
    DisputeRecord,
    'updateOne',
  ).mockResolvedValue({ matchedCount: 1 } as never)
  const createDispute = vi.spyOn(
    DisputeRecord,
    'create',
  ).mockResolvedValue([] as never)
  return {
    withTransaction,
    endSession,
    fence,
    attemptUpdate,
    updateDispute,
    createDispute,
  }
}

describe('mongo dispute terminal-state persistence', () => {
  const adverseObservedAt =
    new Date('2026-07-24T11:30:00.000Z')
  const terminalInboxEventId = '64b64c3f3fc0475f0ca47f02'

  it.each([
    ['won', 'payment.dispute.won'],
    ['closed', 'payment.dispute.closed'],
  ] as const)(
    'appends %s evidence after an adverse fence without restoring state',
    async (status, eventType) => {
      const adverseRequest = disputePersistenceRequest({
        status: 'open',
        eventType: 'payment.dispute.created',
        operationInboxEventId: inboxEventId,
        requestObservedAt: adverseObservedAt,
      })
      const existing = existingDisputeRecord(adverseRequest)
      const harness = mockMongoDisputeTransaction(existing)
      const terminalRequest = disputePersistenceRequest({
        status,
        eventType,
        operationInboxEventId: terminalInboxEventId,
        requestObservedAt: observedAt,
      })

      await expect(
        mongoFinancialReversalPersistenceStore.persistDispute(
          terminalRequest,
        ),
      ).resolves.toMatchObject({
        operationKey:
          `test:dispute:${disputeId}:${terminalInboxEventId}`,
        reused: false,
      })

      expect(harness.fence).not.toHaveBeenCalled()
      expect(harness.attemptUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          _id: attemptId,
          status: 'disputed',
        }),
        {
          $set: expect.objectContaining({ status: 'disputed' }),
        },
        expect.any(Object),
      )
      expect(harness.updateDispute).toHaveBeenCalledWith(
        expect.objectContaining({
          _id: existing._id,
          status: 'open',
        }),
        expect.objectContaining({
          $set: expect.objectContaining({
            status,
            accessReversalDecision: expect.objectContaining({
              status: 'pending_review',
            }),
          }),
          $push: {
            history: expect.objectContaining({
              operationKey: terminalRequest.operationKey,
              providerStatus: status,
            }),
          },
          $inc: { attempts: 1 },
        }),
        expect.any(Object),
      )
      expect(harness.createDispute).not.toHaveBeenCalled()
    },
  )

  it('does not require a credit note when no financial document was issued', async () => {
    const adverseRequest = disputePersistenceRequest({
      status: 'open',
      eventType: 'payment.dispute.created',
      operationInboxEventId: inboxEventId,
      requestObservedAt: adverseObservedAt,
    })
    const existing = existingDisputeRecord(adverseRequest)
    const harness = mockMongoDisputeTransaction(existing)
    const lostRequest = disputePersistenceRequest({
      status: 'lost',
      eventType: 'payment.dispute.lost',
      operationInboxEventId: terminalInboxEventId,
      requestObservedAt: observedAt,
    })

    await mongoFinancialReversalPersistenceStore.persistDispute(lostRequest)

    expect(harness.updateDispute).toHaveBeenCalledWith(
      expect.objectContaining({ _id: existing._id, status: 'open' }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'lost',
          creditNoteDecision: expect.objectContaining({
            status: 'not_required',
            reason:
              'individual_purchase_financial_document_not_issued',
          }),
        }),
      }),
      expect.any(Object),
    )
  })

  it('acknowledges an exact duplicate dispute without appending history twice', async () => {
    const originalRequest = disputePersistenceRequest({
      status: 'open',
      eventType: 'payment.dispute.created',
      operationInboxEventId: inboxEventId,
      requestObservedAt: adverseObservedAt,
    })
    const existing = existingDisputeRecord(originalRequest)
    const harness = mockMongoDisputeTransaction(existing)
    const replayRequest = {
      ...originalRequest,
      observedAt,
    }

    await expect(
      mongoFinancialReversalPersistenceStore.persistDispute(
        replayRequest,
      ),
    ).resolves.toEqual({
      operationKey: originalRequest.operationKey,
      reused: true,
    })

    expect(harness.fence).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: fulfillmentId,
        status: 'review',
        'steps.entitlement.operationKey':
          `test:${paymentId}:entitlement`,
      }),
      {
        $set: expect.objectContaining({ status: 'review' }),
      },
      expect.any(Object),
    )
    expect(harness.updateDispute).toHaveBeenCalledOnce()
    const update =
      harness.updateDispute.mock.calls[0]?.[1] as Record<string, unknown>
    expect(update).not.toHaveProperty('$push')
    expect(update).not.toHaveProperty('$inc')
    expect(harness.createDispute).not.toHaveBeenCalled()
  })

  it('appends only provider-created dispute analytics in the same transaction', async () => {
    const request = disputePersistenceRequest({
      status: 'open',
      eventType: 'payment.dispute.created',
      operationInboxEventId: inboxEventId,
      requestObservedAt: adverseObservedAt,
    })
    const existing = existingDisputeRecord(request)
    const harness = mockMongoDisputeTransaction(existing)
    let receivedEvidence:
      FinancialReversalCommercialAnalyticsEvidence | undefined
    let receivedSession: unknown
    const appendReversalInSession = vi.fn(
      async (factory, session) => {
        receivedEvidence = factory()
        receivedSession = session
      },
    )

    await mongoFinancialReversalPersistenceStore.persistDispute(
      request,
      { appendReversalInSession },
    )

    expect(receivedEvidence).toEqual({
      eventName: 'dispute_created',
      sourceEvidenceId: disputeId,
      correlationId: checkoutIntentId.toHexString(),
      subjectId: userId.toHexString(),
      providerMode: 'test',
      razorpayPaymentId: paymentId,
      occurredAt: new Date(1_721_779_204_000),
      originalCapturedPaise: 6_900,
      eventAmountPaise: 6_900,
    })
    expect(receivedSession).toBe(
      await vi.mocked(mongoose.startSession).mock.results[0]?.value,
    )
    expect(harness.updateDispute.mock.invocationCallOrder[0])
      .toBeLessThan(
        appendReversalInSession.mock.invocationCallOrder[0],
      )

    appendReversalInSession.mockClear()
    const terminalRequest = disputePersistenceRequest({
      status: 'won',
      eventType: 'payment.dispute.won',
      operationInboxEventId: terminalInboxEventId,
      requestObservedAt: observedAt,
    })
    await mongoFinancialReversalPersistenceStore.persistDispute(
      terminalRequest,
      { appendReversalInSession },
    )
    expect(appendReversalInSession).not.toHaveBeenCalled()
  })
})

describe('DisputeRecord audit contract', () => {
  function disputeRecordInput(
    overrides: Record<string, unknown> = {},
  ) {
    const operationKey =
      `test:dispute:${disputeId}:${inboxEventId}`
    const snapshot = {
      operationKey,
      dispute: dispute('open'),
    }
    return {
      providerMode: 'test',
      userId,
      razorpayDisputeId: disputeId,
      razorpayPaymentId: paymentId,
      razorpayOrderId: orderId,
      originalCapturedPaise: 6_900,
      disputedPaise: 6_900,
      amountDeductedPaise: 6_900,
      currency: 'INR',
      status: 'open',
      creditNoteDecision: {
        idempotencyKey: `test:${disputeId}:credit-note`,
        status: 'pending_review',
      },
      accessReversalDecision: {
        idempotencyKey: `test:${disputeId}:access`,
        status: 'pending_review',
      },
      originalProviderSnapshot: snapshot,
      lastProviderSnapshot: snapshot,
      history: [{
        operationKey,
        inboxEventId,
        eventType: 'payment.dispute.created',
        providerStatus: 'open',
        amountDeductedPaise: 6_900,
        providerSnapshot: snapshot,
        observedAt,
      }],
      receivedAt: observedAt,
      lastSyncedAt: observedAt,
      attempts: 1,
      ...overrides,
    }
  }

  it('validates an append-auditable dispute without a refund id', async () => {
    const record = new DisputeRecord(disputeRecordInput())
    await expect(record.validate()).resolves.toBeUndefined()
    expect(record.toObject()).not.toHaveProperty('razorpayRefundId')
    expect(
      DisputeRecord.schema.indexes(),
    ).toContainEqual([
      { providerMode: 1, 'history.operationKey': 1 },
      { unique: true },
    ])
  })

  it('rejects missing, duplicate, and over-captured audit evidence', async () => {
    await expect(new DisputeRecord(
      disputeRecordInput({ history: [] }),
    ).validate()).rejects.toThrow(
      'A dispute record requires immutable observation history',
    )

    const entry = disputeRecordInput().history[0]
    await expect(new DisputeRecord(disputeRecordInput({
      history: [entry, entry],
    })).validate()).rejects.toThrow(
      'Dispute observation operation keys must be unique',
    )

    await expect(new DisputeRecord(disputeRecordInput({
      disputedPaise: 6_901,
    })).validate()).rejects.toThrow(
      'disputedPaise cannot exceed originalCapturedPaise',
    )
  })

  it('requires completion evidence for finalized manual decisions', async () => {
    await expect(new DisputeRecord(disputeRecordInput({
      accessReversalDecision: {
        idempotencyKey: `test:${disputeId}:access`,
        status: 'completed',
        decidedAt: observedAt,
        completedAt: observedAt,
      },
    })).validate()).rejects.toThrow(
      'A completed access-reversal decision requires completion evidence',
    )
  })
})

describe('typed error contract', () => {
  it('retains a stable machine-readable error code', () => {
    const error = new FinancialReversalPersistenceError(
      'state_conflict',
      'conflict',
    )
    expect(error).toMatchObject({
      name: 'FinancialReversalPersistenceError',
      code: 'state_conflict',
    })
  })
})
