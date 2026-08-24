export interface SubscriptionAcquisitionUserAuthority {
  plan?: 'free' | 'plus' | 'pro' | 'enterprise'
  planVocabularyVersion?: 1 | 2
  planExpiresAt?: Date
  entitlementSource?: 'free' | 'subscription' | 'admin_grant'
  usagePeriodKey?: string
  interviewsUsed?: number
  interviewLimit?: number
  premiumResumesUsed?: number
  premiumResumeLimit?: number
  entitlementVersion?: number
  buyerState?: string
  accountState?: 'active' | 'deleting'
  role?: string
  organizationId?: unknown
}

function canonicalFreeAuthority(
  user: SubscriptionAcquisitionUserAuthority,
): boolean {
  return (
    user.plan === 'free' &&
    user.planVocabularyVersion === 2 &&
    user.planExpiresAt === undefined &&
    user.entitlementSource === 'free' &&
    typeof user.usagePeriodKey === 'string' &&
    user.usagePeriodKey.trim().length > 0 &&
    Number.isSafeInteger(user.entitlementVersion) &&
    (user.entitlementVersion ?? -1) >= 0
  )
}

/**
 * Legacy personal accounts predate the v2 projection fields. A captured,
 * exactly-bound acquisition payment is sufficient authority to replace this
 * empty Free shape with the first paid-cycle projection. Any partial v2
 * authority, paid/admin authority, organization account, or deleting account
 * remains fail-closed for manual review. Legacy monthly counters and the one
 * Basic-resume identity are intentionally preserved as non-authority fields.
 */
export function canAcceptInitialSubscriptionAcquisition(
  user: SubscriptionAcquisitionUserAuthority,
): boolean {
  const personalRole =
    user.role === undefined ||
    user.role === 'candidate' ||
    user.role === 'platform_admin'
  const personalAccountAuthority =
    user.buyerState !== 'deletion_pending' &&
    user.accountState !== 'deleting' &&
    personalRole &&
    (user.organizationId === undefined || user.organizationId === null)
  if (!personalAccountAuthority) return false
  if (canonicalFreeAuthority(user)) return true

  return (
    (user.plan === undefined || user.plan === 'free') &&
    user.planVocabularyVersion === undefined &&
    user.planExpiresAt === undefined &&
    user.entitlementSource === undefined &&
    user.usagePeriodKey === undefined &&
    user.interviewsUsed === undefined &&
    user.interviewLimit === undefined &&
    user.premiumResumesUsed === undefined &&
    user.premiumResumeLimit === undefined &&
    user.entitlementVersion === undefined
  )
}
