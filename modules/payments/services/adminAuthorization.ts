import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { User } from '@shared/db/models/User'
import {
  CMS_ADMIN_ROLES,
  hasCmsCapability,
  type CmsAuditActor,
  type CmsCapability,
} from '../types/admin'

export type CmsAuthorizationResult =
  | { ok: true; actor: CmsAuditActor }
  | { ok: false; status: 401 | 403; error: string }

/**
 * Uses the session only for identity, then reloads the current role from Mongo.
 * Financial/CMS authority never comes from a potentially stale JWT claim.
 */
export async function requireCmsCapability(
  capability: CmsCapability,
): Promise<CmsAuthorizationResult> {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return { ok: false, status: 401, error: 'Authentication required' }
  }

  await connectDB()
  const user = await User.findById(session.user.id)
    .select('email role')
    .lean<{ email?: string; role?: string }>()

  if (!user || !user.role || !CMS_ADMIN_ROLES.includes(
    user.role as (typeof CMS_ADMIN_ROLES)[number],
  )) {
    return { ok: false, status: 403, error: 'CMS access denied' }
  }
  if (!hasCmsCapability(user.role, capability)) {
    return { ok: false, status: 403, error: 'Insufficient CMS capability' }
  }

  return {
    ok: true,
    actor: {
      userId: session.user.id,
      email: user.email ?? session.user.email ?? '',
      role: user.role,
    },
  }
}
