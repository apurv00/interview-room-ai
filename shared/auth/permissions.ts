export function canViewSession(
  session: { userId: string; organizationId?: string },
  requestingUser: { id: string; role: string; organizationId?: string }
): boolean {
  if (session.userId === requestingUser.id) return true
  return requestingUser.role === 'platform_admin'
}

/**
 * Session writes are restricted to the owner or a platform administrator.
 */
export function canEditSession(
  session: { userId: string; organizationId?: string },
  requestingUser: { id: string; role: string; organizationId?: string }
): boolean {
  if (session.userId === requestingUser.id) return true
  return requestingUser.role === 'platform_admin'
}
