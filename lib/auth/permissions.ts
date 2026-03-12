export type UserRole = 'candidate' | 'recruiter' | 'org_admin' | 'platform_admin'

const ROLE_HIERARCHY: Record<UserRole, number> = {
  candidate: 0,
  recruiter: 1,
  org_admin: 2,
  platform_admin: 3,
}

export function hasRole(userRole: string, requiredRole: UserRole): boolean {
  const userLevel = ROLE_HIERARCHY[userRole as UserRole] ?? 0
  const requiredLevel = ROLE_HIERARCHY[requiredRole]
  return userLevel >= requiredLevel
}

export function canAccessOrg(
  userOrgId: string | undefined,
  targetOrgId: string,
  userRole: string
): boolean {
  if (userRole === 'platform_admin') return true
  return userOrgId === targetOrgId
}

export function canViewSession(
  session: { userId: string; organizationId?: string },
  requestingUser: { id: string; role: string; organizationId?: string }
): boolean {
  if (session.userId === requestingUser.id) return true
  if (requestingUser.role === 'platform_admin') return true
  if (
    session.organizationId &&
    requestingUser.organizationId === session.organizationId &&
    hasRole(requestingUser.role, 'recruiter')
  ) {
    return true
  }
  return false
}

/**
 * Write access is more restrictive than view access:
 * - Session owner can always edit their own session
 * - org_admin+ in the same org can edit (for admin corrections)
 * - platform_admin can edit any session
 * - Regular recruiters get READ-ONLY access to org sessions (no writes)
 */
export function canEditSession(
  session: { userId: string; organizationId?: string },
  requestingUser: { id: string; role: string; organizationId?: string }
): boolean {
  if (session.userId === requestingUser.id) return true
  if (requestingUser.role === 'platform_admin') return true
  if (
    session.organizationId &&
    requestingUser.organizationId === session.organizationId &&
    hasRole(requestingUser.role, 'org_admin')
  ) {
    return true
  }
  return false
}
