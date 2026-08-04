export const CMS_ADMIN_ROLES = [
  'platform_admin',
  'billing_admin',
  'support_agent',
] as const

export type CmsAdminRole = (typeof CMS_ADMIN_ROLES)[number]

export const CMS_CAPABILITIES = [
  'platform:manage',
  'billing:read',
  'billing:catalog:read',
  'billing:catalog:write',
  'billing:catalog:publish',
  'billing:coupons:read',
  'billing:coupons:write',
  'billing:coupons:activate',
  'billing:operations:read',
  'billing:operations:write',
  'billing:payments:read',
  'billing:payments:recover',
  'billing:payments:reconcile',
  'billing:refunds:write',
  'billing:audit:read',
  'billing:users:read',
  'billing:entitlements:grant',
  'billing:tiers:write',
] as const

export type CmsCapability = (typeof CMS_CAPABILITIES)[number]

const PLATFORM_CAPABILITIES = new Set<CmsCapability>(CMS_CAPABILITIES)
const BILLING_ADMIN_CAPABILITIES = new Set<CmsCapability>([
  'billing:read',
  'billing:catalog:read',
  'billing:catalog:write',
  'billing:catalog:publish',
  'billing:coupons:read',
  'billing:coupons:write',
  'billing:coupons:activate',
  'billing:operations:read',
  'billing:payments:read',
  'billing:payments:recover',
  'billing:payments:reconcile',
  'billing:refunds:write',
  'billing:audit:read',
  'billing:users:read',
  'billing:entitlements:grant',
  'billing:tiers:write',
])
const SUPPORT_CAPABILITIES = new Set<CmsCapability>([
  'billing:read',
  'billing:operations:read',
  'billing:users:read',
  'billing:entitlements:grant',
])

export function hasCmsCapability(
  role: string,
  capability: CmsCapability,
): role is CmsAdminRole {
  if (role === 'platform_admin') return PLATFORM_CAPABILITIES.has(capability)
  if (role === 'billing_admin') return BILLING_ADMIN_CAPABILITIES.has(capability)
  if (role === 'support_agent') return SUPPORT_CAPABILITIES.has(capability)
  return false
}

export interface CmsAuditActor {
  userId: string
  email: string
  role: CmsAdminRole
}
