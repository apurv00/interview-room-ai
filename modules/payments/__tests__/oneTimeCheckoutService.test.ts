import mongoose from 'mongoose'
import { describe, expect, it, vi } from 'vitest'
import {
  savedResumeRepository,
} from '@shared/services/savedResumeRepository'
import { sha256CanonicalJson } from '../lib/canonicalJson'
import type {
  ICheckoutQuoteSnapshot,
} from '../models/CheckoutIntent'
import type {
  ResolvedCustomerBillingQuote,
} from '../services/customerBillingQuoteService'
import {
  CheckoutIntentIdempotencyConflictError,
  checkoutIntentRequestHash,
  type TrustedCheckoutIntentInput,
} from '../services/checkoutIntentService'
import {
  createOneTimeCheckout,
  OneTimeCheckoutError,
  PR7_ONE_TIME_CHECKOUT_READY,
  type OneTimeCheckoutDependencies,
  type OneTimeCheckoutInput,
  type OneTimeCheckoutSku,
  type StoredOneTimeCheckoutIntent,
} from '../services/oneTimeCheckoutService'

const userId = new mongoose.Types.ObjectId().toHexString()
const intentId = new mongoose.Types.ObjectId().toHexString()
const resumeId = 'd904c8db-5ad8-4bbf-9648-8f13baaeaca9'
const otherResumeId = '2a1c8b28-f76f-44fa-a94d-e46207a9eaac'
const buyerSnapshot = {
  name: 'Buyer',
  email: 'buyer@example.com',
  billingProfileVersion: 1,
  billingProfileContentHash: 'a'.repeat(64),
  placeOfSupply: {
    stateCode: '27' as const,
    countryCode: 'IN' as const,
  },
}

function resolvedQuote(
  sku: OneTimeCheckoutSku,
): ResolvedCustomerBillingQuote {
  const oneTimeProducts = {
    single_interview: {
      key: 'single_interview' as const,
      displayName: 'Additional interview',
      listPricePaise: 6_900,
      billing: 'one_time' as const,
      couponEligible: false as const,
      entitlement: {
        interviews: 1 as const,
        maxDurationMinutes: 30 as const,
        supportedDurationsMinutes: [10, 20, 30] as const,
        validityDaysBeforeUse: 30,
        analysisAndReplayIncluded: true as const,
      },
    },
    premium_resume: {
      key: 'premium_resume' as const,
      displayName: 'Premium resume unlock',
      listPricePaise: 2_900,
      billing: 'one_time' as const,
      couponEligible: false as const,
      entitlement: {
        premiumSavedResumeVersions: 1 as const,
        revisionWindowDays: 7,
        revisionWindowStartsAt: 'first_successful_render' as const,
      },
    },
  }
  const product = oneTimeProducts[sku]
  const catalog = {
    version: 'consumer-inr-v1',
    status: 'published',
    contentHash: 'b'.repeat(64),
    content: {
      schemaVersion: 1,
      entitlementPolicyVersion: 'consumer-v1',
      currency: 'INR' as const,
      gstInclusive: true as const,
      gstRatePercent: 18 as const,
      plans: {
        free: {} as never,
        plus: {} as never,
        pro: {} as never,
      },
      oneTimeProducts,
      existingSubscriptionTreatment: 'grandfather' as const,
    },
    validation: {
      contentHash: 'b'.repeat(64),
      errors: [],
      warnings: [],
      validatedBy: userId,
      validatedAt: new Date('2026-07-25T00:00:00.000Z'),
    },
    approval: {
      contentHash: 'b'.repeat(64),
      approvedBy: userId,
      approvedAt: new Date('2026-07-25T00:00:00.000Z'),
    },
  }
  return {
    quote: {
      quoteId: `quote-${sku}`,
      expiresAt: '2026-07-25T00:05:00.000Z',
      catalogVersion: catalog.version,
      currency: 'INR',
      gstInclusive: true,
      gstRatePercent: 18,
      sku,
      listPricePaise: product.listPricePaise,
      discountPaise: 0,
      payablePaise: product.listPricePaise,
      disclosure: {
        summary: `₹${product.listPricePaise / 100} one-time. GST included.`,
        why: 'One-time products are not coupon eligible.',
        gst: 'GST included.',
      },
      entitlementSummary: {
        kind: sku,
        displayName: product.displayName,
        entitlement: product.entitlement,
      },
    },
    context: {
      buyerExists: true,
      activeCatalogVersion: catalog.version,
      sellingMode: 'qa',
      couponMode: 'off',
      qaUserIds: [userId],
      catalog,
    },
    catalog,
    providerMode: 'test',
  }
}

function expectedSnapshot(
  sku: OneTimeCheckoutSku,
  targetResumeId = resumeId,
): ICheckoutQuoteSnapshot['entitlementSnapshot'] {
  return sku === 'single_interview'
    ? {
        sku: 'single_interview',
        maxInterviewDurationMinutes: 30,
        validityDaysBeforeUse: 30,
      }
    : {
        sku: 'premium_resume',
        resumeId: targetResumeId,
        revisionWindowDays: 7,
      }
}

function successfulDependencies(
  sku: OneTimeCheckoutSku,
  options: {
    localReused?: boolean
    remoteReused?: boolean
    storedResumeId?: string
    postRemoteOrderId?: string
  } = {},
) {
  let trustedInput: TrustedCheckoutIntentInput | undefined
  let remoteCreated = false
  const receipt = `ipr_t_${intentId}`
  const createIntent = vi.fn(
    async (input: TrustedCheckoutIntentInput) => {
      trustedInput = input
      return {
        intentId,
        receipt,
        requestHash: checkoutIntentRequestHash(input),
        status: options.localReused ? 'remote_created' : 'created',
        reused: options.localReused ?? false,
      }
    },
  )
  const loadIntent = vi.fn(
    async (): Promise<StoredOneTimeCheckoutIntent> => {
      if (!trustedInput) throw new Error('Intent was not created')
      const quote = structuredClone(
        trustedInput.quoteSnapshot,
      ) as ICheckoutQuoteSnapshot
      if (sku === 'premium_resume' && options.storedResumeId) {
        quote.entitlementSnapshot =
          expectedSnapshot('premium_resume', options.storedResumeId)
      }
      const orderId = options.postRemoteOrderId ??
        (remoteCreated || options.localReused
          ? 'order_checkout1'
          : undefined)
      return {
        id: new mongoose.Types.ObjectId(intentId),
        userId: new mongoose.Types.ObjectId(userId),
        kind: sku,
        providerMode: 'test',
        status: orderId ? 'remote_created' : 'created',
        sku,
        catalogVersion: trustedInput.catalogVersion,
        idempotencyKey: trustedInput.idempotencyKey,
        requestHash: checkoutIntentRequestHash(trustedInput),
        receipt,
        quote,
        buyerSnapshot,
        ...(orderId ? { razorpayOrderId: orderId } : {}),
      }
    },
  )
  const createRemote = vi.fn(async () => {
    remoteCreated = true
    return {
      intentId,
      providerMode: 'test' as const,
      kind: sku,
      remoteId: 'order_checkout1',
      source: options.remoteReused
        ? 'existing' as const
        : 'created' as const,
      reused: options.remoteReused ?? false,
    }
  })
  const dependencies = {
    oneTimeCheckoutReady: true,
    premiumResumeSaleReady: true,
    resolveSaleContext: vi.fn(async () => ({
      providerMode: 'test' as const,
      buyerSnapshot,
    })),
    resolveQuote: vi.fn(async () => resolvedQuote(sku)),
    ownsResume: vi.fn(async () => true),
    createIntent,
    loadIntent,
    createRemote,
    loadKeyId: vi.fn(() => 'rzp_test_public'),
  } satisfies OneTimeCheckoutDependencies
  return {
    dependencies,
    createIntent,
    loadIntent,
    createRemote,
  }
}

function checkoutInput(
  sku: OneTimeCheckoutSku,
): OneTimeCheckoutInput {
  return sku === 'single_interview'
    ? {
        userId,
        idempotencyKey: 'one-time:attempt-1',
        request: { sku },
      }
    : {
        userId,
        idempotencyKey: 'one-time:attempt-1',
        request: { sku, resumeId },
      }
}

describe('one-time checkout orchestration', () => {
  it('supports an explicit dark override before sale, ownership, persistence, credentials, or provider I/O', async () => {
    expect(PR7_ONE_TIME_CHECKOUT_READY).toBe(false)
    const collaborators = {
      resolveSaleContext: vi.fn(),
      resolveQuote: vi.fn(),
      ownsResume: vi.fn(),
      createIntent: vi.fn(),
      loadIntent: vi.fn(),
      createRemote: vi.fn(),
      loadKeyId: vi.fn(),
    }

    await expect(createOneTimeCheckout(
      checkoutInput('premium_resume'),
      {
        oneTimeCheckoutReady: false,
        ...collaborators,
      },
    )).rejects.toMatchObject({
      name: 'OneTimeCheckoutError',
      code: 'sale_blocked',
      saleBlockReason: 'remote_creation_not_ready',
    })
    for (const dependency of Object.values(collaborators)) {
      expect(dependency).not.toHaveBeenCalled()
    }
  })

  it('blocks premium-resume sales until storage, guard, and entitlement state are ready', async () => {
    const { dependencies, createIntent } =
      successfulDependencies('premium_resume')
    dependencies.premiumResumeSaleReady = false

    await expect(createOneTimeCheckout(
      checkoutInput('premium_resume'),
      dependencies,
    )).rejects.toMatchObject({
      name: 'OneTimeCheckoutError',
      code: 'sale_blocked',
      saleBlockReason: 'remote_creation_not_ready',
    })
    expect(dependencies.resolveSaleContext).not.toHaveBeenCalled()
    expect(dependencies.ownsResume).not.toHaveBeenCalled()
    expect(dependencies.resolveQuote).not.toHaveBeenCalled()
    expect(createIntent).not.toHaveBeenCalled()
  })

  it('creates an exact ₹69 order with an empty interview target', async () => {
    const { dependencies, createIntent, loadIntent } =
      successfulDependencies('single_interview')

    const result = await createOneTimeCheckout(
      checkoutInput('single_interview'),
      dependencies,
    )

    expect(dependencies.ownsResume).not.toHaveBeenCalled()
    expect(dependencies.resolveQuote).toHaveBeenCalledWith({
      userId,
      request: {
        sku: 'single_interview',
        surface: 'checkout',
      },
    })
    expect(createIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        kind: 'single_interview',
        sku: 'single_interview',
        providerMode: 'test',
        quoteSnapshot: {
          currency: 'INR',
          listPricePaise: 6_900,
          discountPaise: 0,
          payablePaise: 6_900,
          gst: {
            inclusive: true,
            rateBps: 1_800,
            componentAllocation: 'unallocated',
          },
          entitlementSnapshot:
            expectedSnapshot('single_interview'),
        },
      }),
    )
    expect(loadIntent).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({
      providerMode: 'test',
      intentStatus: 'remote_created',
      checkout: {
        keyId: 'rzp_test_public',
        orderId: 'order_checkout1',
      },
      quote: {
        sku: 'single_interview',
        listPricePaise: 6_900,
        discountPaise: 0,
        payablePaise: 6_900,
      },
    })
  })

  it('verifies premium resume ownership and snapshots the exact resume identity', async () => {
    const { dependencies, createIntent } =
      successfulDependencies('premium_resume')

    const result = await createOneTimeCheckout(
      checkoutInput('premium_resume'),
      dependencies,
    )

    expect(dependencies.ownsResume).toHaveBeenCalledWith({
      userId,
      resumeId,
    })
    expect(createIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'premium_resume',
        sku: 'premium_resume',
        quoteSnapshot: expect.objectContaining({
          listPricePaise: 2_900,
          discountPaise: 0,
          payablePaise: 2_900,
          entitlementSnapshot:
            expectedSnapshot('premium_resume'),
        }),
      }),
    )
    expect(result.quote).toMatchObject({
      sku: 'premium_resume',
      listPricePaise: 2_900,
      discountPaise: 0,
      payablePaise: 2_900,
    })
  })

  it('requires one exact repository identity for the default ownership check', async () => {
    const inspection = vi.spyOn(
      savedResumeRepository,
      'inspectIdentity',
    )
    const premium = successfulDependencies('premium_resume')
    const defaultOwnershipDependencies = {
      ...premium.dependencies,
      ownsResume: undefined,
    }

    inspection.mockResolvedValueOnce({
      mode: 'embedded',
      libraryVersion: 3,
      collectionCount: 0,
      matchingIdentityCount: 1,
      status: 'exact',
    })
    await expect(createOneTimeCheckout(
      checkoutInput('premium_resume'),
      defaultOwnershipDependencies,
    )).resolves.toMatchObject({
      quote: { sku: 'premium_resume' },
    })
    expect(inspection).toHaveBeenCalledWith(
      userId,
      resumeId,
      { maxTimeMS: 1_000 },
    )

    for (const notExactlyOwned of [
      null,
      {
        mode: 'collection_only' as const,
        libraryVersion: 4,
        collectionCount: 0,
        matchingIdentityCount: 0,
        status: 'absent' as const,
      },
      {
        mode: 'dual_embedded_primary' as const,
        libraryVersion: 4,
        collectionCount: 2,
        matchingIdentityCount: 2,
        status: 'ambiguous' as const,
      },
    ]) {
      const unavailable =
        successfulDependencies('premium_resume')
      const defaultUnavailableDependencies = {
        ...unavailable.dependencies,
        ownsResume: undefined,
      }
      inspection.mockResolvedValueOnce(notExactlyOwned)
      await expect(createOneTimeCheckout(
        checkoutInput('premium_resume'),
        defaultUnavailableDependencies,
      )).rejects.toMatchObject({
        code: 'resume_unavailable',
      })
    }

    inspection.mockRestore()
  })

  it('rejects an interview target and an unowned resume before pricing or persistence', async () => {
    const interview = successfulDependencies('single_interview')
    await expect(createOneTimeCheckout({
      userId,
      idempotencyKey: 'one-time:invalid-target',
      request: {
        sku: 'single_interview',
        resumeId,
      },
    } as unknown as OneTimeCheckoutInput, {
      ...interview.dependencies,
    })).rejects.toMatchObject({ code: 'invalid_request' })
    expect(interview.dependencies.resolveSaleContext)
      .not.toHaveBeenCalled()

    const premium = successfulDependencies('premium_resume')
    premium.dependencies.ownsResume.mockResolvedValue(false)
    await expect(createOneTimeCheckout(
      checkoutInput('premium_resume'),
      premium.dependencies,
    )).rejects.toMatchObject({ code: 'resume_unavailable' })
    expect(premium.dependencies.resolveQuote).not.toHaveBeenCalled()
    expect(premium.createIntent).not.toHaveBeenCalled()
  })

  it('fails closed on coupon or catalog economic drift before local creation', async () => {
    const { dependencies, createIntent } =
      successfulDependencies('single_interview')
    dependencies.resolveQuote = vi.fn(async () => {
      const resolved = resolvedQuote('single_interview')
      return {
        ...resolved,
        quote: {
          ...resolved.quote,
          discountPaise: 5_000,
          payablePaise: 1_900,
        },
      }
    })

    await expect(createOneTimeCheckout(
      checkoutInput('single_interview'),
      dependencies,
    )).rejects.toMatchObject({ code: 'commercial_unavailable' })
    expect(createIntent).not.toHaveBeenCalled()
  })

  it('reuses the same idempotency key for the same target', async () => {
    const { dependencies, loadIntent, createRemote } =
      successfulDependencies('premium_resume', {
        localReused: true,
        remoteReused: true,
      })

    const result = await createOneTimeCheckout(
      checkoutInput('premium_resume'),
      dependencies,
    )

    expect(result.reused).toBe(true)
    expect(loadIntent).toHaveBeenCalledTimes(2)
    expect(createRemote).toHaveBeenCalledTimes(1)
  })

  it('conflicts when the same premium-resume key is bound to another resume', async () => {
    const { dependencies, createRemote } =
      successfulDependencies('premium_resume', {
        localReused: true,
        storedResumeId: otherResumeId,
      })

    await expect(createOneTimeCheckout(
      checkoutInput('premium_resume'),
      dependencies,
    )).rejects.toMatchObject({
      name: 'OneTimeCheckoutError',
      code: 'idempotency_conflict',
    })
    expect(createRemote).not.toHaveBeenCalled()
  })

  it('requires the persisted post-provider Order to match the remote result', async () => {
    const { dependencies } =
      successfulDependencies('single_interview', {
        postRemoteOrderId: 'order_different',
      })

    await expect(createOneTimeCheckout(
      checkoutInput('single_interview'),
      dependencies,
    )).rejects.toMatchObject({ code: 'persistence_conflict' })
    expect(dependencies.loadKeyId).not.toHaveBeenCalled()
  })

  it('maps known idempotency failures into the one-time service contract', async () => {
    const { dependencies, createRemote } =
      successfulDependencies('single_interview')
    dependencies.createIntent = vi.fn(async () => {
      throw new CheckoutIntentIdempotencyConflictError()
    })

    await expect(createOneTimeCheckout(
      checkoutInput('single_interview'),
      dependencies,
    )).rejects.toBeInstanceOf(OneTimeCheckoutError)
    await expect(createOneTimeCheckout(
      checkoutInput('single_interview'),
      dependencies,
    )).rejects.toMatchObject({ code: 'idempotency_conflict' })
    expect(createRemote).not.toHaveBeenCalled()
  })

  it('keeps the fulfillment snapshot structurally exact', async () => {
    const interview =
      successfulDependencies('single_interview')
    await createOneTimeCheckout(
      checkoutInput('single_interview'),
      interview.dependencies,
    )
    const snapshot = interview.createIntent.mock.calls[0]?.[0]
      .quoteSnapshot.entitlementSnapshot
    expect(sha256CanonicalJson(snapshot)).toBe(
      sha256CanonicalJson(expectedSnapshot('single_interview')),
    )
  })
})
