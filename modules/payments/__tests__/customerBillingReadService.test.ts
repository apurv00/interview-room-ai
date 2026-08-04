import mongoose from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const dbMocks = vi.hoisted(() => ({
  connectDB: vi.fn(),
}))

const accountDeletionMocks = vi.hoisted(() => ({
  withPersonalDataWriteTransaction: vi.fn(),
}))

const modelMocks = vi.hoisted(() => ({
  billingConfigFindOne: vi.fn(),
  checkoutIntentFindOne: vi.fn(),
  couponReservationFindOne: vi.fn(),
  couponRevisionFindOne: vi.fn(),
  creditNoteFind: vi.fn(),
  profileCreate: vi.fn(),
  profileFindOne: vi.fn(),
  profileFindOneAndUpdate: vi.fn(),
  invoiceFind: vi.fn(),
  invoiceFindOne: vi.fn(),
  paidUnlockAggregate: vi.fn(),
  catalogFindOne: vi.fn(),
  planChangeFind: vi.fn(),
  resumeAggregate: vi.fn(),
  subscriptionFind: vi.fn(),
  subscriptionCycleFind: vi.fn(),
  userFindById: vi.fn(),
}))

const gateMocks = vi.hoisted(() => ({
  evaluatePaymentSaleGate: vi.fn(),
}))

vi.mock('@shared/db/connection', () => dbMocks)
vi.mock('@shared/db/models/User', () => ({
  User: {
    findById: modelMocks.userFindById,
  },
}))
vi.mock('@shared/services/accountDeletion', () => accountDeletionMocks)
vi.mock('../models/BillingConfig', () => ({
  BillingConfig: {
    findOne: modelMocks.billingConfigFindOne,
  },
}))
vi.mock('../models/CheckoutIntent', () => ({
  CheckoutIntent: {
    findOne: modelMocks.checkoutIntentFindOne,
  },
}))
vi.mock('../models/CouponCampaignRevision', () => ({
  CouponCampaignRevision: {
    findOne: modelMocks.couponRevisionFindOne,
  },
}))
vi.mock('../models/CouponReservation', () => ({
  CouponReservation: {
    findOne: modelMocks.couponReservationFindOne,
  },
}))
vi.mock('../models/CreditNote', () => ({
  CreditNote: {
    find: modelMocks.creditNoteFind,
  },
}))
vi.mock('@financial-ledger/models/CreditNote', () => ({
  CreditNote: {
    find: modelMocks.creditNoteFind,
  },
}))
vi.mock('../models/CustomerBillingProfile', () => ({
  CustomerBillingProfile: {
    create: modelMocks.profileCreate,
    findOne: modelMocks.profileFindOne,
    findOneAndUpdate: modelMocks.profileFindOneAndUpdate,
  },
}))
vi.mock('../models/Invoice', () => ({
  Invoice: {
    find: modelMocks.invoiceFind,
    findOne: modelMocks.invoiceFindOne,
  },
}))
vi.mock('@financial-ledger/models/Invoice', () => ({
  Invoice: {
    find: modelMocks.invoiceFind,
    findOne: modelMocks.invoiceFindOne,
  },
}))
vi.mock('../models/PaidInterviewUnlock', () => ({
  PaidInterviewUnlock: {
    aggregate: modelMocks.paidUnlockAggregate,
  },
}))
vi.mock('../models/PlanCatalogVersion', () => ({
  PlanCatalogVersion: {
    findOne: modelMocks.catalogFindOne,
  },
}))
vi.mock('../models/PlanChangeRequest', () => ({
  PLAN_CHANGE_REQUEST_STATUSES: [
    'requested',
    'authorization_pending',
    'old_cancellation_pending',
    'reconciling',
    'scheduled',
    'applying',
    'compensating',
    'applied',
    'cancelled',
    'failed',
    'review',
  ],
  PlanChangeRequest: {
    find: modelMocks.planChangeFind,
  },
}))
vi.mock('../models/ResumeEntitlement', () => ({
  ResumeEntitlement: {
    aggregate: modelMocks.resumeAggregate,
  },
}))
vi.mock('../models/Subscription', () => ({
  SUBSCRIPTION_STATUSES: [
    'created',
    'authenticated',
    'activation_pending',
    'active',
    'past_due',
    'halted',
    'paused',
    'cancelled',
    'completed',
    'expired',
  ],
  Subscription: {
    find: modelMocks.subscriptionFind,
  },
}))
vi.mock('../models/SubscriptionCycle', () => ({
  SubscriptionCycle: {
    find: modelMocks.subscriptionCycleFind,
  },
}))
vi.mock('../services/paymentRuntimeGate', () => ({
  evaluatePaymentSaleGate: gateMocks.evaluatePaymentSaleGate,
}))

import { sha256CanonicalJson } from '../lib/canonicalJson'
import { CouponRevisionTermsSchema } from '../validators/coupon'
import {
  CustomerBillingProfileConflictError,
  CustomerBillingUnavailableError,
  CustomerFinancialDocumentNotFoundError,
  PR6_BILLING_PROFILE_WRITES_READY,
  PR6_CUSTOMER_BILLING_UI_READY,
  PR6_FINANCIAL_PDF_READY,
  listCustomerFinancialDocuments,
  readCustomerBillingSummary,
  readCustomerInvoiceDetail,
  readPublicBillingCatalog,
  upsertCustomerBillingProfile,
} from '@customer-billing'
import { buildInitialCatalogContent } from '../services/catalogValidation'

const querySessionSpies: Array<ReturnType<typeof vi.fn>> = []
const aggregateSessionSpies: Array<ReturnType<typeof vi.fn>> = []
const summarySession = {
  endSession: vi.fn(),
}
const startSessionSpy = vi.spyOn(mongoose, 'startSession')

function queryResult<T>(value: T) {
  const query = {
    select: vi.fn(),
    sort: vi.fn(),
    limit: vi.fn(),
    session: vi.fn(),
    lean: vi.fn(),
  }
  query.select.mockReturnValue(query)
  query.sort.mockReturnValue(query)
  query.limit.mockReturnValue(query)
  query.session.mockReturnValue(query)
  query.lean.mockResolvedValue(value)
  querySessionSpies.push(query.session)
  return query
}

function aggregateResult<T>(value: T) {
  const aggregate = {
    session: vi.fn(),
  }
  aggregate.session.mockResolvedValue(value)
  aggregateSessionSpies.push(aggregate.session)
  return aggregate
}

const userId = '507f1f77bcf86cd799439011'
const otherUserId = '507f191e810c19729de860ea'
const invoiceId = new mongoose.Types.ObjectId('507f1f77bcf86cd799439012')
const creditNoteId = new mongoose.Types.ObjectId('507f1f77bcf86cd799439013')
const fixedNow = new Date('2026-07-24T12:00:00.000Z')
const issuedAt = new Date('2026-07-20T10:30:00.000Z')
const profileWriteTestOptions = {
  allowWhenReadinessDisabledForTests: true,
}

function immutableCouponTerms() {
  return CouponRevisionTermsSchema.parse({
    discountPaise: 10_000,
    applicablePlanKeys: ['plus'],
    discountedBillingCycles: 3,
    razorpayOfferIdByMode: {
      live: 'offer_Launch100',
    },
    startsAt: new Date('2026-06-01T00:00:00.000Z'),
    endsAt: new Date('2026-09-01T00:00:00.000Z'),
    priority: 100,
    eligibility: {
      newCustomerOnly: true,
      userIds: [],
      segments: [],
      acquisitionSources: [],
      upgradesEligible: false,
    },
    maxRedemptionsPerUser: 1,
    minPayablePaiseByPlan: {
      plus: 39_900,
    },
    reservationTtlHours: 24,
    visibility: ['pricing', 'checkout'],
    bannerText: 'Launch offer: ₹100 off',
    termsText:
      '₹100 off the first three billing cycles, then renews at ₹599 per month.',
  })
}

function publishedCatalog(overrides: Record<string, unknown> = {}) {
  const content = buildInitialCatalogContent()
  const contentHash = sha256CanonicalJson(content)
  return {
    version: 'consumer-inr-20260724120000-a1b2c3d4',
    status: 'published',
    effectiveAt: new Date('2026-07-24T10:00:00.000Z'),
    content,
    contentHash,
    validation: {
      contentHash,
      errors: [],
      warnings: [],
      internalReviewNotes: 'must not become public',
    },
    approval: {
      contentHash,
      approvedBy: new mongoose.Types.ObjectId(),
    },
    providerVerification: {
      normalizedTermsHash: contentHash,
      remotePlanIds: ['plan_private'],
    },
    ...overrides,
  }
}

function taxSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    gstRateBps: 1_800,
    taxablePaise: 50_763,
    gstPaise: 9_137,
    grossPaise: 59_900,
    componentAllocation: 'intra_state',
    cgstPaise: 4_569,
    sgstPaise: 4_568,
    ...overrides,
  }
}

function invoiceRow(overrides: Record<string, unknown> = {}) {
  return {
    _id: invoiceId,
    providerMode: 'live',
    userId: new mongoose.Types.ObjectId(userId),
    chargeKind: 'subscription_cycle',
    capturedPaise: 59_900,
    currency: 'INR',
    numberSnapshot: {
      formattedNumber: 'IPG/2026-27/000001',
      internalSequence: 1,
    },
    taxSnapshot: taxSnapshot(),
    descriptionSnapshot: 'Plus monthly subscription',
    issuedAt,
    razorpayPaymentId: 'pay_private',
    providerPayload: { secret: true },
    ...overrides,
  }
}

function creditNoteRow(overrides: Record<string, unknown> = {}) {
  return {
    _id: creditNoteId,
    providerMode: 'live',
    userId: new mongoose.Types.ObjectId(userId),
    invoiceId,
    originalInvoiceNumberSnapshot: 'IPG/2026-27/000001',
    refundedPaise: 5_900,
    currency: 'INR',
    numberSnapshot: {
      formattedNumber: 'CN/2026-27/000001',
      internalSequence: 1,
    },
    taxSnapshot: taxSnapshot({
      taxablePaise: 5_000,
      gstPaise: 900,
      grossPaise: 5_900,
      cgstPaise: 450,
      sgstPaise: 450,
    }),
    reasonSnapshot: 'Partial refund',
    issuedAt,
    razorpayRefundId: 'rfnd_private',
    providerPayload: { secret: true },
    ...overrides,
  }
}

function mockSummaryReads(input: {
  subscriptions: Array<Record<string, unknown>>
  cycles: Array<Record<string, unknown>>
  user?: Record<string, unknown>
}) {
  modelMocks.userFindById.mockReturnValue(
    queryResult({
      _id: new mongoose.Types.ObjectId(userId),
      plan: 'plus',
      entitlementSource: 'subscription',
      usagePeriodKey: 'sub:2026-07',
      interviewsUsed: 0,
      interviewLimit: 10,
      premiumResumesUsed: 0,
      premiumResumeLimit: 5,
      entitlementVersion: 2,
      buyerState: 'active',
      ...input.user,
    }),
  )
  modelMocks.subscriptionFind.mockReturnValue(queryResult(input.subscriptions))
  modelMocks.subscriptionCycleFind.mockReturnValue(queryResult(input.cycles))
  modelMocks.planChangeFind.mockReturnValue(queryResult([]))
  modelMocks.paidUnlockAggregate.mockReturnValue(aggregateResult([]))
  modelMocks.resumeAggregate.mockReturnValue(aggregateResult([]))
  modelMocks.profileFindOne.mockReturnValue(queryResult(null))
  modelMocks.billingConfigFindOne.mockReturnValue(
    queryResult({
      revision: 1,
      sellingMode: 'off',
      enforcementMode: 'off',
      couponMode: 'off',
      qaUserIds: [],
      newUserRolloutPercent: 0,
      autoCouponRequired: true,
      webhookProcessingEnabled: false,
      reconciliationEnabled: false,
    }),
  )
}

describe('PR6 customer billing readiness', () => {
  it('enables customer UI and profile writes while keeping financial PDFs dark', () => {
    expect(PR6_CUSTOMER_BILLING_UI_READY).toBe(true)
    expect(PR6_BILLING_PROFILE_WRITES_READY).toBe(true)
    expect(PR6_FINANCIAL_PDF_READY).toBe(false)
  })
})

describe('customer billing profile replacement', () => {
  const session = { id: 'profile-transaction-session' }
  const userObjectId = new mongoose.Types.ObjectId(userId)
  const mutationId = 'profile-remove-optional-001'
  const placeOfSupply = {
    stateCode: '27',
    countryCode: 'IN' as const,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    accountDeletionMocks.withPersonalDataWriteTransaction.mockImplementation(
      async (
        _userId: string,
        work: (
          transactionSession: typeof session,
          transactionUserId: mongoose.Types.ObjectId,
        ) => Promise<unknown>,
      ) => work(session, userObjectId),
    )
  })

  it('fails closed unless billing-profile writes are explicitly ready', async () => {
    vi.resetModules()
    vi.doMock(
      '@payments/customer-billing-authority',
      async (importOriginal) => ({
        ...await importOriginal<
          typeof import('../services/customerBillingReadService')
        >(),
        PR6_BILLING_PROFILE_WRITES_READY: false,
      }),
    )
    const darkCustomerBilling = await import('@customer-billing')

    await expect(
      darkCustomerBilling.upsertCustomerBillingProfile(userId, {
        expectedVersion: 0,
        mutationId,
        placeOfSupply,
      }),
    ).rejects.toBeInstanceOf(
      darkCustomerBilling.CustomerBillingProfileWritesUnavailableError,
    )
    expect(
      accountDeletionMocks.withPersonalDataWriteTransaction,
    ).not.toHaveBeenCalled()
    vi.doUnmock('@payments/customer-billing-authority')
    vi.resetModules()
  })

  it('replaces only place of supply and replays the exact mutation', async () => {
    modelMocks.profileFindOne.mockReturnValueOnce(
      queryResult({
        userId: userObjectId,
        version: 2,
        placeOfSupply: {
          stateCode: '29',
          countryCode: 'IN',
        },
        contentHash: 'a'.repeat(64),
        lastMutationId: 'profile-older-mutation-001',
        createdAt: fixedNow,
        updatedAt: fixedNow,
      }),
    )
    const updated = {
      userId: userObjectId,
      version: 3,
      placeOfSupply,
      contentHash: '',
      lastMutationId: mutationId,
      createdAt: fixedNow,
      updatedAt: fixedNow,
    }
    modelMocks.profileFindOneAndUpdate.mockReturnValue(queryResult(updated))

    const input = {
      expectedVersion: 2,
      mutationId,
      placeOfSupply,
    }
    const first = await upsertCustomerBillingProfile(
      userId,
      input,
      profileWriteTestOptions,
    )
    const update = modelMocks.profileFindOneAndUpdate.mock.calls[0]?.[1]

    expect(update).toMatchObject({
      $set: {
        placeOfSupply,
        lastMutationId: mutationId,
      },
      $inc: { version: 1 },
    })
    expect(update).not.toHaveProperty('$unset')
    expect(first).toMatchObject({
      configured: true,
      version: 3,
      placeOfSupply,
    })

    const contentHash = update.$set.contentHash as string
    modelMocks.profileFindOne.mockReturnValueOnce(
      queryResult({
        ...updated,
        contentHash,
      }),
    )
    const replay = await upsertCustomerBillingProfile(
      userId,
      input,
      profileWriteTestOptions,
    )

    expect(replay).toEqual(first)
    expect(modelMocks.profileFindOneAndUpdate).toHaveBeenCalledTimes(1)
  })

  it('maps only duplicate-key races to a profile conflict', async () => {
    const duplicate = Object.assign(new Error('duplicate'), {
      code: 11_000,
    })
    accountDeletionMocks.withPersonalDataWriteTransaction
      .mockRejectedValueOnce(duplicate)
      .mockRejectedValueOnce(
        Object.assign(new Error('database unavailable'), {
          name: 'MongoServerError',
          code: 91,
        }),
      )
    const input = {
      expectedVersion: 0,
      mutationId: 'profile-create-race-001',
      placeOfSupply,
    }

    await expect(
      upsertCustomerBillingProfile(userId, input, profileWriteTestOptions),
    ).rejects.toBeInstanceOf(CustomerBillingProfileConflictError)
    await expect(
      upsertCustomerBillingProfile(userId, input, profileWriteTestOptions),
    ).rejects.toMatchObject({
      name: 'MongoServerError',
      code: 91,
    })
  })
})

describe('public billing catalog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    dbMocks.connectDB.mockResolvedValue(undefined)
  })

  it('returns only effective, approved public commercial terms', async () => {
    const row = publishedCatalog()
    modelMocks.billingConfigFindOne.mockReturnValue(
      queryResult({
        activeCatalogVersion: row.version,
        sellingMode: 'test',
        internalRolloutNotes: 'private',
      }),
    )
    modelMocks.catalogFindOne.mockReturnValue(queryResult(row))

    const result = await readPublicBillingCatalog(fixedNow)
    const serialized = JSON.stringify(result)

    expect(result).toMatchObject({
      schemaVersion: 1,
      catalogVersion: row.version,
      currency: 'INR',
      gstInclusive: true,
      gstRatePercent: 18,
      customerBillingUiReady: true,
      checkoutRequiresAuthentication: true,
      plans: {
        free: {
          key: 'free',
          displayName: 'Basic',
          listPricePaise: 0,
        },
        plus: {
          key: 'plus',
          displayName: 'Plus',
          listPricePaise: 59_900,
        },
        pro: {
          key: 'pro',
          displayName: 'Pro',
          listPricePaise: 99_900,
        },
      },
      oneTimeProducts: {
        single_interview: {
          listPricePaise: 6_900,
        },
        premium_resume: {
          listPricePaise: 2_900,
        },
      },
    })
    expect(serialized).not.toContain('razorpayPlanIdByMode')
    expect(serialized).not.toContain('plan_private')
    expect(serialized).not.toContain('contentHash')
    expect(serialized).not.toContain('approvedBy')
    expect(serialized).not.toContain('internalReviewNotes')
    expect(serialized).not.toContain('internalRolloutNotes')
    expect(modelMocks.catalogFindOne).toHaveBeenCalledWith({
      version: row.version,
    })
  })

  it.each([
    ['unpublished', { status: 'scheduled' }],
    ['future effective', { effectiveAt: new Date('2026-07-24T13:00:00.000Z') }],
    ['unapproved', { approval: undefined }],
    [
      'invalidated',
      {
        validation: {
          contentHash: 'a'.repeat(64),
          errors: ['invalid'],
        },
      },
    ],
    ['content hash mismatch', { contentHash: 'b'.repeat(64) }],
  ])('fails closed for a %s catalog', async (_name, overrides) => {
    const row = publishedCatalog(overrides)
    modelMocks.billingConfigFindOne.mockReturnValue(
      queryResult({
        activeCatalogVersion: row.version,
      }),
    )
    modelMocks.catalogFindOne.mockReturnValue(queryResult(row))

    await expect(readPublicBillingCatalog(fixedNow)).rejects.toMatchObject({
      code: 'catalog_unavailable',
    })
  })

  it('fails closed when no active catalog is configured', async () => {
    modelMocks.billingConfigFindOne.mockReturnValue(queryResult(null))

    await expect(readPublicBillingCatalog(fixedNow)).rejects.toBeInstanceOf(
      CustomerBillingUnavailableError,
    )
    expect(modelMocks.catalogFindOne).not.toHaveBeenCalled()
  })
})

describe('customer billing summary privacy boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    querySessionSpies.length = 0
    aggregateSessionSpies.length = 0
    startSessionSpy.mockResolvedValue(summarySession as never)
    dbMocks.connectDB.mockResolvedValue(undefined)
    gateMocks.evaluatePaymentSaleGate.mockReturnValue({
      allowed: true,
      providerMode: 'live',
      rollout: 'all',
    })
  })

  it('returns bounded entitlement state without provider or payment data', async () => {
    const userObjectId = new mongoose.Types.ObjectId(userId)
    const subscriptionId = new mongoose.Types.ObjectId()
    const checkoutIntentId = new mongoose.Types.ObjectId()
    const couponCampaignId = new mongoose.Types.ObjectId()
    const couponTerms = immutableCouponTerms()
    const couponContentHash = sha256CanonicalJson(couponTerms)
    const periodStart = new Date('2026-07-01T00:00:00.000Z')
    const periodEnd = new Date('2026-08-01T00:00:00.000Z')
    modelMocks.userFindById.mockReturnValue(
      queryResult({
        _id: userObjectId,
        plan: 'plus',
        entitlementSource: 'subscription',
        planExpiresAt: periodEnd,
        usagePeriodKey: 'sub:2026-07',
        interviewsUsed: 12,
        interviewLimit: 10,
        premiumResumesUsed: -2,
        premiumResumeLimit: 3,
        freeBasicResumeId: 'resume_123',
        entitlementVersion: 7,
        buyerState: 'active',
        email: 'private@example.com',
        razorpayCustomerId: 'cust_private',
        lifetimePaidPaise: 1_00_000,
      }),
    )
    modelMocks.subscriptionFind.mockReturnValue(
      queryResult([
        {
          _id: subscriptionId,
          providerMode: 'live',
          planKey: 'plus',
          catalogVersion: 'consumer-inr-v1',
          razorpaySubscriptionId: 'sub_private',
          checkoutIntentId,
          status: 'active',
          currentPeriodKey: 'sub:2026-07',
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          cancelAtPeriodEnd: false,
          couponCampaignId,
          discountedCyclesRemaining: 2,
          createdAt: new Date('2026-07-01T00:00:00.000Z'),
          updatedAt: fixedNow,
          razorpaySubscriptionId: 'sub_private',
          capturedPaise: 49_900,
          paymentMethod: 'upi',
        },
      ]),
    )
    modelMocks.subscriptionCycleFind.mockReturnValue(
      queryResult([
        {
          _id: new mongoose.Types.ObjectId(),
          providerMode: 'live',
          subscriptionId,
          planKey: 'plus',
          periodKey: 'sub:2026-07',
          periodStart,
          periodEnd,
          razorpayPaymentId: 'pay_private',
          capturedPaise: 49_900,
        },
      ]),
    )
    modelMocks.checkoutIntentFindOne.mockReturnValue(
      queryResult({
        _id: checkoutIntentId,
        providerMode: 'live',
        planKey: 'plus',
        razorpaySubscriptionId: 'sub_private',
        catalogVersion: 'consumer-inr-v1',
        createdAt: periodStart,
        quoteSnapshot: {
          currency: 'INR',
          listPricePaise: 59_900,
          discountPaise: 10_000,
          payablePaise: 49_900,
          renewalPricePaise: 59_900,
          discountedBillingCycles: 3,
          couponCampaignId,
          couponCampaignRevision: 2,
        },
        providerPayload: { secret: true },
      }),
    )
    modelMocks.couponReservationFindOne.mockReturnValue(
      queryResult({
        providerMode: 'live',
        campaignId: couponCampaignId,
        campaignRevision: 2,
        userId: userObjectId,
        checkoutIntentId,
        catalogVersion: 'consumer-inr-v1',
        planKey: 'plus',
        campaignModeSnapshot: 'automatic',
        discountPaise: 10_000,
        discountedBillingCycles: 3,
        status: 'converted',
        capacityDisposition: 'converted',
        terminalEvidenceKey: 'private-reservation-evidence',
      }),
    )
    modelMocks.couponRevisionFindOne.mockReturnValue(
      queryResult({
        campaignId: couponCampaignId,
        revision: 2,
        status: 'active',
        terms: couponTerms,
        contentHash: couponContentHash,
        validation: {
          contentHash: couponContentHash,
          errors: [],
        },
        approval: {
          contentHash: couponContentHash,
        },
        providerVerification: {
          live: {
            remoteOfferId: 'offer_private',
          },
        },
      }),
    )
    modelMocks.planChangeFind.mockReturnValue(queryResult([]))
    modelMocks.paidUnlockAggregate.mockReturnValue(
      aggregateResult([{ _id: 'available', count: 2 }]),
    )
    modelMocks.resumeAggregate.mockReturnValue(
      aggregateResult([{ _id: 'available', count: 1 }]),
    )
    modelMocks.profileFindOne.mockReturnValue(
      queryResult({
        userId: userObjectId,
        version: 2,
        placeOfSupply: {
          stateCode: '27',
          countryCode: 'IN',
        },
        contentHash: 'a'.repeat(64),
        lastMutationId: 'private-mutation-id',
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
        updatedAt: fixedNow,
        providerAddressId: 'addr_private',
      }),
    )
    modelMocks.billingConfigFindOne.mockReturnValue(
      queryResult({
        revision: 1,
        sellingMode: 'all',
        enforcementMode: 'off',
        couponMode: 'off',
        qaUserIds: [],
        newUserRolloutPercent: 0,
        autoCouponRequired: true,
        webhookProcessingEnabled: false,
        reconciliationEnabled: false,
      }),
    )

    const result = await readCustomerBillingSummary(userId, {
      now: fixedNow,
    })
    const serialized = JSON.stringify(result)

    expect(result).toMatchObject({
      schemaVersion: 1,
      environment: 'live',
      customerBillingUiReady: true,
      accountState: 'active',
      saleAvailability: 'available',
      entitlement: {
        initialized: true,
        planKey: 'plus',
        interviewsUsed: 12,
        interviewLimit: 10,
        interviewsRemaining: 0,
        premiumResumesUsed: 0,
        premiumResumeLimit: 3,
        premiumResumesRemaining: 3,
        hasFreeBasicResume: true,
        version: 7,
        environmentConsistency: 'verified',
      },
      subscription: {
        state: 'current',
        billingHealth: 'healthy',
        planKey: 'plus',
        status: 'active',
        discountedCyclesRemaining: 2,
        currentCoupon: {
          source: 'subscription_checkout',
          campaignId: couponCampaignId.toString(),
          revision: 2,
          mode: 'automatic',
          displayText: 'Launch offer: ₹100 off',
          termsText:
            '₹100 off the first three billing cycles, then renews at ₹599 per month.',
        },
        nextCharge: {
          amountPaise: 49_900,
          currency: 'INR',
          scheduledAt: '2026-08-01T00:00:00.000Z',
        },
      },
      interviewUnlocks: { available: 2 },
      resumeEntitlements: { available: 1 },
      billingProfile: {
        configured: true,
        version: 2,
      },
    })
    for (const privateValue of [
      'cust_private',
      'sub_private',
      'addr_private',
      'pay_private',
      'private@example.com',
      'private-mutation-id',
      'contentHash',
      'lifetimePaidPaise',
      'paymentMethod',
      'capturedPaise',
      'private-reservation-evidence',
      'offer_private',
    ]) {
      expect(serialized).not.toContain(privateValue)
    }
    expect(serialized).toContain(couponCampaignId.toString())
    expect(modelMocks.subscriptionFind).toHaveBeenCalledWith({
      userId: userObjectId,
      providerMode: 'live',
      status: { $in: expect.any(Array) },
    })
    expect(modelMocks.subscriptionCycleFind).toHaveBeenCalledWith({
      userId: userObjectId,
      providerMode: 'live',
      projectionDisposition: 'projected',
      periodStart: { $lte: fixedNow },
      periodEnd: { $gt: fixedNow },
    })
    expect(modelMocks.paidUnlockAggregate).toHaveBeenCalledWith([
      {
        $match: {
          userId: userObjectId,
          providerMode: 'live',
        },
      },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ])
    expect(startSessionSpy).toHaveBeenCalledWith({ snapshot: true })
    expect(querySessionSpies).toHaveLength(9)
    for (const sessionSpy of querySessionSpies) {
      expect(sessionSpy).toHaveBeenCalledWith(summarySession)
    }
    expect(aggregateSessionSpies).toHaveLength(2)
    for (const sessionSpy of aggregateSessionSpies) {
      expect(sessionSpy).toHaveBeenCalledWith(summarySession)
    }
    expect(summarySession.endSession).toHaveBeenCalledTimes(1)
  })

  it('fails closed when immutable coupon lineage is inconsistent', async () => {
    const userObjectId = new mongoose.Types.ObjectId(userId)
    const subscriptionId = new mongoose.Types.ObjectId()
    const checkoutIntentId = new mongoose.Types.ObjectId()
    const couponCampaignId = new mongoose.Types.ObjectId()
    const periodStart = new Date('2026-07-01T00:00:00.000Z')
    const periodEnd = new Date('2026-08-01T00:00:00.000Z')
    const couponTerms = immutableCouponTerms()

    mockSummaryReads({
      user: { planExpiresAt: periodEnd },
      subscriptions: [
        {
          _id: subscriptionId,
          providerMode: 'live',
          planKey: 'plus',
          catalogVersion: 'consumer-inr-v1',
          razorpaySubscriptionId: 'sub_coupon_review',
          checkoutIntentId,
          status: 'active',
          currentPeriodKey: 'sub:2026-07',
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          cancelAtPeriodEnd: false,
          couponCampaignId,
          discountedCyclesRemaining: 2,
          createdAt: periodStart,
          updatedAt: fixedNow,
        },
      ],
      cycles: [
        {
          _id: new mongoose.Types.ObjectId(),
          providerMode: 'live',
          subscriptionId,
          planKey: 'plus',
          periodKey: 'sub:2026-07',
          periodStart,
          periodEnd,
        },
      ],
    })
    modelMocks.checkoutIntentFindOne.mockReturnValue(
      queryResult({
        _id: checkoutIntentId,
        providerMode: 'live',
        planKey: 'plus',
        razorpaySubscriptionId: 'sub_coupon_review',
        catalogVersion: 'consumer-inr-v1',
        createdAt: periodStart,
        quoteSnapshot: {
          currency: 'INR',
          listPricePaise: 59_900,
          discountPaise: 10_000,
          payablePaise: 49_900,
          renewalPricePaise: 59_900,
          discountedBillingCycles: 3,
          couponCampaignId,
          couponCampaignRevision: 2,
        },
      }),
    )
    modelMocks.couponReservationFindOne.mockReturnValue(
      queryResult({
        providerMode: 'live',
        campaignId: couponCampaignId,
        campaignRevision: 2,
        userId: userObjectId,
        checkoutIntentId,
        catalogVersion: 'consumer-inr-v1',
        planKey: 'plus',
        campaignModeSnapshot: 'automatic',
        discountPaise: 10_000,
        discountedBillingCycles: 3,
        status: 'converted',
        capacityDisposition: 'converted',
      }),
    )
    modelMocks.couponRevisionFindOne.mockReturnValue(
      queryResult({
        campaignId: couponCampaignId,
        revision: 2,
        status: 'active',
        terms: couponTerms,
        contentHash: 'b'.repeat(64),
        validation: {
          contentHash: 'b'.repeat(64),
          errors: [],
        },
        approval: {
          contentHash: 'b'.repeat(64),
        },
      }),
    )

    const result = await readCustomerBillingSummary(userId, {
      now: fixedNow,
    })

    expect(result.saleAvailability).toBe('unavailable')
    expect(result.subscription).toMatchObject({
      state: 'review',
      billingHealth: 'review',
      planKey: 'plus',
      status: 'active',
    })
    expect(result.subscription).not.toHaveProperty('currentCoupon')
    expect(result.subscription).not.toHaveProperty(
      'discountedCyclesRemaining',
    )
    expect(result.subscription).not.toHaveProperty('nextCharge')
  })

  it('rejects malformed customer identifiers before touching storage', async () => {
    await expect(
      readCustomerBillingSummary('not-an-object-id', {
        now: fixedNow,
      }),
    ).rejects.toMatchObject({ code: 'customer_unavailable' })

    expect(dbMocks.connectDB).not.toHaveBeenCalled()
    expect(modelMocks.userFindById).not.toHaveBeenCalled()
    expect(startSessionSpy).not.toHaveBeenCalled()
    expect(summarySession.endSession).not.toHaveBeenCalled()
  })

  it('always closes the snapshot when the customer is missing', async () => {
    modelMocks.userFindById.mockReturnValue(queryResult(null))

    await expect(
      readCustomerBillingSummary(userId, {
        now: fixedNow,
      }),
    ).rejects.toMatchObject({ code: 'customer_unavailable' })

    expect(startSessionSpy).toHaveBeenCalledWith({ snapshot: true })
    expect(summarySession.endSession).toHaveBeenCalledTimes(1)
    expect(modelMocks.billingConfigFindOne).not.toHaveBeenCalled()
  })

  it('always closes the snapshot after a mid-read persistence failure', async () => {
    mockSummaryReads({
      user: {
        plan: 'free',
        entitlementSource: 'free',
      },
      subscriptions: [],
      cycles: [],
    })
    const failedSubscriptionQuery = queryResult([])
    failedSubscriptionQuery.lean.mockRejectedValueOnce(
      new Error('database unavailable'),
    )
    modelMocks.subscriptionFind.mockReturnValue(failedSubscriptionQuery)

    await expect(
      readCustomerBillingSummary(userId, {
        now: fixedNow,
      }),
    ).rejects.toThrow('database unavailable')

    expect(summarySession.endSession).toHaveBeenCalledTimes(1)
    expect(modelMocks.subscriptionCycleFind).not.toHaveBeenCalled()
  })

  it('reports deletion-pending accounts as restricted even while readiness is off', async () => {
    mockSummaryReads({
      user: {
        plan: 'free',
        entitlementSource: 'free',
        buyerState: 'deletion_pending',
      },
      subscriptions: [],
      cycles: [],
    })
    gateMocks.evaluatePaymentSaleGate.mockReturnValue({
      allowed: false,
      reason: 'remote_creation_not_ready',
    })

    const result = await readCustomerBillingSummary(userId, {
      now: fixedNow,
    })

    expect(result).toMatchObject({
      accountState: 'deletion_pending',
      saleAvailability: 'account_restricted',
    })
  })

  it('exposes the immutable request ID for the current plan change', async () => {
    const requestId = new mongoose.Types.ObjectId()
    mockSummaryReads({
      user: { plan: 'free', entitlementSource: 'free' },
      subscriptions: [],
      cycles: [],
    })
    modelMocks.planChangeFind.mockReturnValue(queryResult([{
      _id: requestId,
      fromPlanKey: 'plus',
      toPlanKey: 'pro',
      status: 'scheduled',
      requestedAt: fixedNow,
      requestedEffectiveAt: new Date('2026-08-01T00:00:00.000Z'),
      updatedAt: fixedNow,
    }]))

    const result = await readCustomerBillingSummary(userId, {
      now: fixedNow,
    })

    expect(result.scheduledPlanChange?.planChangeRequestId).toBe(
      requestId.toHexString(),
    )
  })

  it('moves multiple activation-pending mandates to review', async () => {
    mockSummaryReads({
      subscriptions: [
        {
          _id: new mongoose.Types.ObjectId(),
          providerMode: 'live',
          planKey: 'plus',
          razorpaySubscriptionId: 'sub_pending_one',
          status: 'created',
          cancelAtPeriodEnd: false,
          createdAt: fixedNow,
          updatedAt: fixedNow,
        },
        {
          _id: new mongoose.Types.ObjectId(),
          providerMode: 'live',
          planKey: 'pro',
          razorpaySubscriptionId: 'sub_pending_two',
          status: 'authenticated',
          cancelAtPeriodEnd: false,
          createdAt: fixedNow,
          updatedAt: fixedNow,
        },
      ],
      cycles: [],
    })

    const result = await readCustomerBillingSummary(userId, {
      now: fixedNow,
    })

    expect(result.subscription).toEqual({ state: 'review' })
    expect(modelMocks.checkoutIntentFindOne).not.toHaveBeenCalled()
  })

  it('keeps an active mandate without a paid cycle visible for review', async () => {
    mockSummaryReads({
      subscriptions: [
        {
          _id: new mongoose.Types.ObjectId(),
          providerMode: 'live',
          planKey: 'plus',
          razorpaySubscriptionId: 'sub_missing_cycle',
          status: 'active',
          cancelAtPeriodEnd: false,
          createdAt: fixedNow,
          updatedAt: fixedNow,
        },
      ],
      cycles: [],
    })

    const result = await readCustomerBillingSummary(userId, {
      now: fixedNow,
    })

    expect(result.subscription).toMatchObject({
      state: 'review',
      billingHealth: 'review',
      status: 'active',
    })
    expect(result.subscription).not.toHaveProperty('nextCharge')
  })

  it('preserves paid access but never promises renewal for an ended mandate', async () => {
    const subscriptionId = new mongoose.Types.ObjectId()
    const periodStart = new Date('2026-07-01T00:00:00.000Z')
    const periodEnd = new Date('2026-08-01T00:00:00.000Z')
    mockSummaryReads({
      user: { planExpiresAt: periodEnd },
      subscriptions: [
        {
          _id: subscriptionId,
          providerMode: 'live',
          planKey: 'plus',
          razorpaySubscriptionId: 'sub_ended',
          status: 'cancelled',
          currentPeriodKey: 'sub:2026-07',
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          cancelAtPeriodEnd: true,
          createdAt: periodStart,
          updatedAt: fixedNow,
        },
      ],
      cycles: [
        {
          _id: new mongoose.Types.ObjectId(),
          providerMode: 'live',
          subscriptionId,
          planKey: 'plus',
          periodKey: 'sub:2026-07',
          periodStart,
          periodEnd,
        },
      ],
    })

    const result = await readCustomerBillingSummary(userId, {
      now: fixedNow,
    })

    expect(result.subscription).toMatchObject({
      state: 'current',
      billingHealth: 'ended',
      status: 'cancelled',
      currentPeriodEnd: periodEnd.toISOString(),
    })
    expect(result.subscription).not.toHaveProperty('nextCharge')
    expect(modelMocks.checkoutIntentFindOne).not.toHaveBeenCalled()
  })

  it('fails closed when multiple nonterminal plan changes exist', async () => {
    mockSummaryReads({
      user: {
        plan: 'free',
        entitlementSource: 'free',
      },
      subscriptions: [],
      cycles: [],
    })
    modelMocks.planChangeFind.mockReturnValue(
      queryResult([
        {
          fromPlanKey: 'plus',
          toPlanKey: 'pro',
          status: 'requested',
          requestedAt: fixedNow,
          requestedEffectiveAt: new Date(fixedNow.getTime() + 86_400_000),
          updatedAt: fixedNow,
        },
        {
          fromPlanKey: 'pro',
          toPlanKey: 'free',
          status: 'scheduled',
          requestedAt: fixedNow,
          requestedEffectiveAt: new Date(fixedNow.getTime() + 86_400_000),
          updatedAt: fixedNow,
        },
      ]),
    )

    const result = await readCustomerBillingSummary(userId, {
      now: fixedNow,
    })

    expect(result.subscription).toEqual({ state: 'review' })
    expect(result).not.toHaveProperty('scheduledPlanChange')
  })

  it('allows an explicit, labelled test summary only for QA users', async () => {
    const userObjectId = new mongoose.Types.ObjectId(userId)
    const subscriptionId = new mongoose.Types.ObjectId()
    const periodStart = new Date('2026-07-01T00:00:00.000Z')
    const periodEnd = new Date('2026-08-01T00:00:00.000Z')
    mockSummaryReads({
      user: { planExpiresAt: periodEnd },
      subscriptions: [
        {
          _id: subscriptionId,
          providerMode: 'test',
          planKey: 'plus',
          razorpaySubscriptionId: 'sub_test',
          status: 'halted',
          currentPeriodKey: 'sub:2026-07',
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          cancelAtPeriodEnd: false,
          createdAt: periodStart,
          updatedAt: fixedNow,
        },
      ],
      cycles: [
        {
          _id: new mongoose.Types.ObjectId(),
          providerMode: 'test',
          subscriptionId,
          planKey: 'plus',
          periodKey: 'sub:2026-07',
          periodStart,
          periodEnd,
        },
      ],
    })
    modelMocks.billingConfigFindOne.mockReturnValue(
      queryResult({
        revision: 1,
        sellingMode: 'qa',
        enforcementMode: 'off',
        couponMode: 'off',
        qaUserIds: [userObjectId],
        newUserRolloutPercent: 0,
        autoCouponRequired: true,
        webhookProcessingEnabled: false,
        reconciliationEnabled: false,
      }),
    )
    gateMocks.evaluatePaymentSaleGate.mockReturnValue({
      allowed: true,
      providerMode: 'test',
      rollout: 'qa',
    })

    const result = await readCustomerBillingSummary(userId, {
      now: fixedNow,
      environment: 'test',
    })

    expect(result).toMatchObject({
      environment: 'test',
      entitlement: { environmentConsistency: 'verified' },
      subscription: {
        state: 'current',
        billingHealth: 'action_required',
        status: 'halted',
      },
    })
    expect(modelMocks.subscriptionFind).toHaveBeenCalledWith(
      expect.objectContaining({ providerMode: 'test' }),
    )

    modelMocks.billingConfigFindOne.mockReturnValue(
      queryResult({
        qaUserIds: [],
      }),
    )
    await expect(
      readCustomerBillingSummary(userId, {
        now: fixedNow,
        environment: 'test',
      }),
    ).rejects.toMatchObject({ code: 'test_mode_unavailable' })
    expect(summarySession.endSession).toHaveBeenCalledTimes(2)
  })
})

describe('customer financial document ownership and sanitization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    dbMocks.connectDB.mockResolvedValue(undefined)
    modelMocks.billingConfigFindOne.mockReturnValue(queryResult(null))
  })

  it('scopes invoice and credit-note detail to the authenticated owner', async () => {
    modelMocks.invoiceFindOne.mockReturnValue(queryResult(invoiceRow()))
    modelMocks.creditNoteFind.mockReturnValue(queryResult([creditNoteRow()]))

    const detail = await readCustomerInvoiceDetail({
      userId,
      invoiceId: invoiceId.toString(),
    })
    const serialized = JSON.stringify(detail)

    expect(modelMocks.invoiceFindOne).toHaveBeenCalledWith({
      _id: invoiceId,
      userId: new mongoose.Types.ObjectId(userId),
      providerMode: 'live',
    })
    expect(modelMocks.creditNoteFind).toHaveBeenCalledWith({
      invoiceId,
      userId: new mongoose.Types.ObjectId(userId),
      providerMode: 'live',
    })
    expect(detail).toMatchObject({
      invoice: {
        id: invoiceId.toString(),
        kind: 'invoice',
        number: 'IPG/2026-27/000001',
        grossPaise: 59_900,
        pdfAvailable: false,
        testMode: false,
      },
      creditNotes: [
        {
          id: creditNoteId.toString(),
          kind: 'credit_note',
          invoiceId: invoiceId.toString(),
          grossPaise: 5_900,
          pdfAvailable: false,
          testMode: false,
        },
      ],
      netPaidPaise: 54_000,
      rendering: {
        pdfAvailable: false,
        reason: 'financial_policy_not_approved',
      },
    })
    for (const privateValue of [
      userId,
      'pay_private',
      'rfnd_private',
      'providerPayload',
      'internalSequence',
    ]) {
      expect(serialized).not.toContain(privateValue)
    }
  })

  it('does not reveal whether an invoice exists for another owner', async () => {
    modelMocks.invoiceFindOne.mockReturnValue(queryResult(null))

    await expect(
      readCustomerInvoiceDetail({
        userId: otherUserId,
        invoiceId: invoiceId.toString(),
      }),
    ).rejects.toBeInstanceOf(CustomerFinancialDocumentNotFoundError)

    expect(modelMocks.invoiceFindOne).toHaveBeenCalledWith({
      _id: invoiceId,
      userId: new mongoose.Types.ObjectId(otherUserId),
      providerMode: 'live',
    })
    expect(modelMocks.creditNoteFind).not.toHaveBeenCalled()
  })

  it('fails safely when refund totals exceed safe-integer money', async () => {
    modelMocks.invoiceFindOne.mockReturnValue(
      queryResult(
        invoiceRow({
          capturedPaise: Number.MAX_SAFE_INTEGER,
        }),
      ),
    )
    modelMocks.creditNoteFind.mockReturnValue(
      queryResult([
        creditNoteRow({ refundedPaise: Number.MAX_SAFE_INTEGER }),
        creditNoteRow({
          _id: new mongoose.Types.ObjectId(),
          refundedPaise: 1,
        }),
      ]),
    )

    await expect(
      readCustomerInvoiceDetail({
        userId,
        invoiceId: invoiceId.toString(),
      }),
    ).rejects.toThrow('INR paise addition overflow')
  })

  it('fails closed when credits exceed captured consideration', async () => {
    modelMocks.invoiceFindOne.mockReturnValue(
      queryResult(
        invoiceRow({
          capturedPaise: 5_000,
        }),
      ),
    )
    modelMocks.creditNoteFind.mockReturnValue(
      queryResult([creditNoteRow({ refundedPaise: 5_001 })]),
    )

    await expect(
      readCustomerInvoiceDetail({
        userId,
        invoiceId: invoiceId.toString(),
      }),
    ).rejects.toMatchObject({
      code: 'financial_integrity_review',
    })
  })

  it('isolates allowlisted QA documents and marks them as test data', async () => {
    const userObjectId = new mongoose.Types.ObjectId(userId)
    modelMocks.billingConfigFindOne.mockReturnValue(
      queryResult({
        sellingMode: 'qa',
        qaUserIds: [userObjectId],
      }),
    )
    modelMocks.invoiceFind.mockReturnValue(
      queryResult([invoiceRow({ providerMode: 'test' })]),
    )
    modelMocks.creditNoteFind.mockReturnValue(queryResult([]))

    const page = await listCustomerFinancialDocuments({
      userId,
      limit: 20,
      environment: 'test',
    })

    expect(modelMocks.invoiceFind).toHaveBeenCalledWith({
      userId: userObjectId,
      providerMode: 'test',
    })
    expect(modelMocks.creditNoteFind).toHaveBeenCalledWith({
      userId: userObjectId,
      providerMode: 'test',
    })
    expect(page.documents).toEqual([
      expect.objectContaining({
        kind: 'invoice',
        testMode: true,
      }),
    ])
  })

  it('rejects test history for users outside the QA allowlist', async () => {
    modelMocks.billingConfigFindOne.mockReturnValue(
      queryResult({
        qaUserIds: [new mongoose.Types.ObjectId(otherUserId)],
      }),
    )

    await expect(
      listCustomerFinancialDocuments({
        userId,
        environment: 'test',
      }),
    ).rejects.toMatchObject({ code: 'test_mode_unavailable' })

    expect(modelMocks.invoiceFind).not.toHaveBeenCalled()
    expect(modelMocks.creditNoteFind).not.toHaveBeenCalled()
  })

  it('paginates a sanitized merged ledger with an owner-scoped cursor', async () => {
    const invoiceQuery = queryResult([invoiceRow()])
    const creditNoteQuery = queryResult([creditNoteRow()])
    modelMocks.invoiceFind.mockReturnValue(invoiceQuery)
    modelMocks.creditNoteFind.mockReturnValue(creditNoteQuery)

    const firstPage = await listCustomerFinancialDocuments({
      userId,
      limit: 1,
    })

    expect(firstPage.documents).toHaveLength(1)
    expect(firstPage.documents[0]).toMatchObject({
      id: invoiceId.toString(),
      kind: 'invoice',
      grossPaise: 59_900,
      pdfAvailable: false,
    })
    expect(firstPage.nextCursor).toEqual(expect.any(String))
    expect(invoiceQuery.limit).toHaveBeenCalledWith(2)
    expect(creditNoteQuery.limit).toHaveBeenCalledWith(2)
    expect(JSON.stringify(firstPage)).not.toContain('pay_private')
    expect(JSON.stringify(firstPage)).not.toContain('providerPayload')

    modelMocks.invoiceFind.mockReturnValue(queryResult([]))
    modelMocks.creditNoteFind.mockReturnValue(queryResult([]))
    await listCustomerFinancialDocuments({
      userId: otherUserId,
      limit: 100,
      cursor: firstPage.nextCursor,
    })

    const invoiceFilter = modelMocks.invoiceFind.mock.calls.at(-1)?.[0]
    const creditNoteFilter = modelMocks.creditNoteFind.mock.calls.at(-1)?.[0]
    expect(invoiceFilter).toMatchObject({
      userId: new mongoose.Types.ObjectId(otherUserId),
      providerMode: 'live',
      $or: expect.any(Array),
    })
    expect(creditNoteFilter).toMatchObject({
      userId: new mongoose.Types.ObjectId(otherUserId),
      providerMode: 'live',
      $or: expect.any(Array),
    })
    const secondInvoiceQuery = modelMocks.invoiceFind.mock.results.at(-1)?.value
    const secondCreditNoteQuery =
      modelMocks.creditNoteFind.mock.results.at(-1)?.value
    expect(secondInvoiceQuery.limit).toHaveBeenCalledWith(51)
    expect(secondCreditNoteQuery.limit).toHaveBeenCalledWith(51)
  })

  it.each([
    '',
    'not-base64-json',
    Buffer.from(
      JSON.stringify({
        issuedAt: issuedAt.toISOString(),
        kind: 'invoice',
        id: invoiceId.toString(),
        userId,
      }),
    ).toString('base64url'),
    Buffer.from(
      JSON.stringify({
        issuedAt: 'not-a-date',
        kind: 'invoice',
        id: invoiceId.toString(),
      }),
    ).toString('base64url'),
    Buffer.from(
      JSON.stringify({
        issuedAt: issuedAt.toISOString(),
        kind: 'payment',
        id: invoiceId.toString(),
      }),
    ).toString('base64url'),
  ])(
    'rejects malformed or extended cursors before storage: %s',
    async (cursor) => {
      await expect(
        listCustomerFinancialDocuments({
          userId,
          cursor,
        }),
      ).rejects.toMatchObject({ code: 'invalid_cursor' })

      expect(dbMocks.connectDB).not.toHaveBeenCalled()
      expect(modelMocks.invoiceFind).not.toHaveBeenCalled()
      expect(modelMocks.creditNoteFind).not.toHaveBeenCalled()
    },
  )
})
