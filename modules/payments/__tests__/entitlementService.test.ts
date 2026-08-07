import { beforeEach, describe, expect, it, vi } from 'vitest'

const modelMocks = vi.hoisted(() => ({
  updateOne: vi.fn(),
}))

vi.mock('@shared/db/models/User', () => ({
  User: { updateOne: modelMocks.updateOne },
}))

import {
  commitUserEntitlementProjectionUpdateInSession,
  EntitlementProjectionWriteBoundaryError,
} from '../services/entitlementService'

const session = {
  inTransaction: () => true,
} as never

function legacyFilter() {
  const missing = { $exists: false as const }
  return {
    _id: 'legacy-user',
    plan: 'free',
    planVocabularyVersion: missing,
    planExpiresAt: missing,
    entitlementSource: missing,
    usagePeriodKey: missing,
    interviewsUsed: missing,
    interviewLimit: missing,
    premiumResumesUsed: missing,
    premiumResumeLimit: missing,
    entitlementVersion: missing,
    buyerState: missing,
  }
}

function paidProjection() {
  const periodEnd = new Date('2026-09-08T17:59:23.000Z')
  return {
    $set: {
      plan: 'plus' as const,
      planVocabularyVersion: 2 as const,
      planExpiresAt: periodEnd,
      entitlementSource: 'subscription' as const,
      usagePeriodKey: 'paid:sub_example:1:2',
      interviewsUsed: 0,
      interviewLimit: 10,
      premiumResumesUsed: 0,
      premiumResumeLimit: 5,
      usageResetAt: periodEnd,
    },
    $inc: { entitlementVersion: 1 },
  }
}

describe('entitlement projection write boundary', () => {
  beforeEach(() => {
    modelMocks.updateOne.mockReset()
    modelMocks.updateOne.mockResolvedValue({ matchedCount: 1 })
  })

  it('allows the exact missing-version legacy-to-paid acquisition', async () => {
    await commitUserEntitlementProjectionUpdateInSession(
      'subscription_initial_acquisition',
      legacyFilter(),
      paidProjection(),
      session,
    )

    expect(modelMocks.updateOne).toHaveBeenCalledOnce()
  })

  it('does not broaden ordinary subscription-cycle writes to missing versions', () => {
    expect(() => commitUserEntitlementProjectionUpdateInSession(
      'subscription_cycle',
      legacyFilter(),
      paidProjection(),
      session,
    )).toThrowError(EntitlementProjectionWriteBoundaryError)
    expect(modelMocks.updateOne).not.toHaveBeenCalled()
  })

  it('rejects a partial legacy authority even for initial acquisition', () => {
    expect(() => commitUserEntitlementProjectionUpdateInSession(
      'subscription_initial_acquisition',
      {
        ...legacyFilter(),
        entitlementSource: 'free',
      },
      paidProjection(),
      session,
    )).toThrowError(EntitlementProjectionWriteBoundaryError)
    expect(modelMocks.updateOne).not.toHaveBeenCalled()
  })
})
