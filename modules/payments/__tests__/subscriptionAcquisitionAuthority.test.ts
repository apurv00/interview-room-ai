import { describe, expect, it } from 'vitest'
import {
  canAcceptInitialSubscriptionAcquisition,
} from '../services/subscriptionAcquisitionAuthority'

describe('initial subscription acquisition authority', () => {
  it('accepts an exact canonical v2 Free projection', () => {
    expect(canAcceptInitialSubscriptionAcquisition({
      plan: 'free',
      planVocabularyVersion: 2,
      entitlementSource: 'free',
      usagePeriodKey: 'basic:2026-08',
      entitlementVersion: 1,
    })).toBe(true)
  })

  it('accepts an untouched legacy personal Free account after exact payment capture', () => {
    expect(canAcceptInitialSubscriptionAcquisition({
      plan: 'free',
      role: 'platform_admin',
    })).toBe(true)
    expect(canAcceptInitialSubscriptionAcquisition({
      plan: 'free',
      role: 'candidate',
      organizationId: null,
    })).toBe(true)
    expect(canAcceptInitialSubscriptionAcquisition({})).toBe(true)
  })

  it('rejects partial, paid, organization, and deleting authority shapes', () => {
    expect(canAcceptInitialSubscriptionAcquisition({
      plan: 'free',
      entitlementSource: 'free',
    })).toBe(false)
    expect(canAcceptInitialSubscriptionAcquisition({
      plan: 'plus',
    })).toBe(false)
    expect(canAcceptInitialSubscriptionAcquisition({
      role: 'org_admin',
      organizationId: 'organization',
    })).toBe(false)
    expect(canAcceptInitialSubscriptionAcquisition({
      plan: 'free',
      planVocabularyVersion: 2,
      entitlementSource: 'free',
      usagePeriodKey: 'basic:2026-08',
      entitlementVersion: 1,
      role: 'org_admin',
      organizationId: 'organization',
    })).toBe(false)
    expect(canAcceptInitialSubscriptionAcquisition({
      plan: 'free',
      planVocabularyVersion: 2,
      entitlementSource: 'free',
      usagePeriodKey: 'basic:2026-08',
      entitlementVersion: 1,
      role: 'recruiter',
    })).toBe(false)
    expect(canAcceptInitialSubscriptionAcquisition({
      plan: 'free',
      buyerState: 'deletion_pending',
    })).toBe(false)
    expect(canAcceptInitialSubscriptionAcquisition({
      plan: 'free',
      accountState: 'deleting',
    })).toBe(false)
  })
})
