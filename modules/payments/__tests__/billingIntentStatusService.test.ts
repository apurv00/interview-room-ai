import mongoose from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connectDB: vi.fn(),
  intentFindOne: vi.fn(),
  attemptFind: vi.fn(),
  fulfillmentFindOne: vi.fn(),
}))

vi.mock('@shared/db/connection', () => ({
  connectDB: mocks.connectDB,
}))
vi.mock('../models/CheckoutIntent', () => ({
  CheckoutIntent: { findOne: mocks.intentFindOne },
}))
vi.mock('../models/PaymentAttempt', () => ({
  PaymentAttempt: { find: mocks.attemptFind },
}))
vi.mock('../models/ChargeFulfillment', () => ({
  ChargeFulfillment: { findOne: mocks.fulfillmentFindOne },
}))

import {
  mongoBillingIntentStatusStore,
  readBillingIntentStatus,
} from '../services/billingIntentStatusService'

const intentId = new mongoose.Types.ObjectId()
const userId = new mongoose.Types.ObjectId()
const intentUpdatedAt = new Date('2026-08-08T01:00:00.000Z')

function intentQuery(status: 'payment_captured' | 'fulfilled' = 'payment_captured') {
  return {
    select: vi.fn(() => ({
      lean: vi.fn(async () => ({
        _id: intentId,
        kind: 'subscription',
        providerMode: 'live',
        status,
        updatedAt: intentUpdatedAt,
      })),
    })),
  }
}

function attemptQuery(attempts: Array<{
  razorpayPaymentId: string
  status: 'captured' | 'review' | 'refunded' | 'disputed'
  updatedAt: Date
}>) {
  return {
    sort: vi.fn(() => ({
      limit: vi.fn(() => ({
        select: vi.fn(() => ({
          lean: vi.fn(async () => attempts),
        })),
      })),
    })),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.intentFindOne.mockReturnValue(intentQuery())
})

describe('public billing intent status authority', () => {
  it('returns a fulfilled subscription intent without scanning recurring payment attempts', async () => {
    mocks.intentFindOne.mockReturnValue(intentQuery('fulfilled'))
    mocks.attemptFind.mockReturnValue(attemptQuery([
      {
        razorpayPaymentId: 'pay_renewal',
        status: 'captured',
        updatedAt: new Date('2026-09-08T01:00:00.000Z'),
      },
      {
        razorpayPaymentId: 'pay_initial',
        status: 'captured',
        updatedAt: new Date('2026-08-08T01:00:00.000Z'),
      },
    ]))

    const record = await mongoBillingIntentStatusStore.loadForUser({
      intentId,
      userId,
    })
    const status = await readBillingIntentStatus({
      intentId: intentId.toHexString(),
      userId: userId.toHexString(),
    }, {
      store: { loadForUser: vi.fn(async () => record) },
    })

    expect(mocks.attemptFind).not.toHaveBeenCalled()
    expect(mocks.fulfillmentFindOne).not.toHaveBeenCalled()
    expect(status).toEqual({
      intentId: intentId.toHexString(),
      kind: 'subscription',
      status: 'completed',
      terminal: true,
      updatedAt: intentUpdatedAt.toISOString(),
    })
  })

  it('surfaces a reviewed payment attempt as terminal manual review', async () => {
    const reviewedAt = new Date('2026-08-08T01:02:00.000Z')
    mocks.attemptFind.mockReturnValue(attemptQuery([{
      razorpayPaymentId: 'pay_reviewed',
      status: 'review',
      updatedAt: reviewedAt,
    }]))

    const record = await mongoBillingIntentStatusStore.loadForUser({
      intentId,
      userId,
    })
    const status = await readBillingIntentStatus({
      intentId: intentId.toHexString(),
      userId: userId.toHexString(),
    }, {
      store: { loadForUser: vi.fn(async () => record) },
    })

    expect(mocks.attemptFind).toHaveBeenCalledWith({
      checkoutIntentId: intentId,
      userId,
      providerMode: 'live',
      status: {
        $in: ['captured', 'review', 'refunded', 'disputed'],
      },
    })
    expect(mocks.fulfillmentFindOne).not.toHaveBeenCalled()
    expect(status).toMatchObject({
      status: 'manual_review',
      terminal: true,
      updatedAt: reviewedAt.toISOString(),
    })
  })

  it.each(['refunded', 'disputed'] as const)(
    'surfaces one %s payment attempt as terminal manual review',
    async (attemptStatus) => {
      const terminalAt = new Date('2026-08-08T01:02:30.000Z')
      mocks.attemptFind.mockReturnValue(attemptQuery([{
        razorpayPaymentId: `pay_${attemptStatus}`,
        status: attemptStatus,
        updatedAt: terminalAt,
      }]))

      const record = await mongoBillingIntentStatusStore.loadForUser({
        intentId,
        userId,
      })
      const status = await readBillingIntentStatus({
        intentId: intentId.toHexString(),
        userId: userId.toHexString(),
      }, {
        store: { loadForUser: vi.fn(async () => record) },
      })

      expect(mocks.fulfillmentFindOne).not.toHaveBeenCalled()
      expect(status).toMatchObject({
        status: 'manual_review',
        terminal: true,
        updatedAt: terminalAt.toISOString(),
      })
    },
  )

  it('fails closed when more than one authoritative attempt exists', async () => {
    const latestAt = new Date('2026-08-08T01:03:00.000Z')
    mocks.attemptFind.mockReturnValue(attemptQuery([
      {
        razorpayPaymentId: 'pay_second',
        status: 'captured',
        updatedAt: latestAt,
      },
      {
        razorpayPaymentId: 'pay_first',
        status: 'captured',
        updatedAt: new Date('2026-08-08T01:01:00.000Z'),
      },
    ]))

    const record = await mongoBillingIntentStatusStore.loadForUser({
      intentId,
      userId,
    })

    expect(record?.fulfillmentStatus).toBe('review')
    expect(record?.updatedAt).toEqual(latestAt)
    expect(mocks.fulfillmentFindOne).not.toHaveBeenCalled()
  })

  it('loads fulfillment for one exact captured attempt', async () => {
    const capturedAt = new Date('2026-08-08T01:02:00.000Z')
    const fulfilledAt = new Date('2026-08-08T01:04:00.000Z')
    mocks.attemptFind.mockReturnValue(attemptQuery([{
      razorpayPaymentId: 'pay_captured',
      status: 'captured',
      updatedAt: capturedAt,
    }]))
    mocks.fulfillmentFindOne.mockReturnValue({
      select: vi.fn(() => ({
        lean: vi.fn(async () => ({
          status: 'done',
          updatedAt: fulfilledAt,
        })),
      })),
    })

    const record = await mongoBillingIntentStatusStore.loadForUser({
      intentId,
      userId,
    })

    expect(mocks.fulfillmentFindOne).toHaveBeenCalledWith({
      providerMode: 'live',
      razorpayPaymentId: 'pay_captured',
      userId,
    })
    expect(record).toMatchObject({
      fulfillmentStatus: 'done',
      updatedAt: fulfilledAt,
    })
  })
})
