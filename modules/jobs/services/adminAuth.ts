import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { connectDB } from '@shared/db/connection'
import { User } from '@shared/db/models'
import { activeJobsAccountFilter } from '@shared/services/jobsAccountFence'

const ACTOR_ID_PATTERN = /^[a-f\d]{24}$/i

export type CurrentPlatformAdminResult =
  | { ok: true; actorUserId: string }
  | {
      ok: false
      status: number
      code: 'ADMIN_REQUIRED' | 'AUTHORITY_UNAVAILABLE' | 'REQUEST_BLOCKED'
      error: string
      actorUserId?: string
      cause?: unknown
      response?: Response
    }

interface CurrentPlatformAdminOptions {
  /** Runs after the authenticated actor ID is validated but before Mongo.
   * Commands use this for their abuse budget; read routes omit it. */
  beforeAuthorityLookup?: (actorUserId: string) => Promise<Response | null>
}

/**
 * Authoritative Jobs-operations guard.
 *
 * Middleware and the NextAuth JWT provide a fast navigation gate, but their
 * role is a sign-in snapshot. Every operational read and mutation re-checks
 * the current Mongo user so a demoted administrator loses access immediately.
 */
export async function requireCurrentPlatformAdmin(
  options: CurrentPlatformAdminOptions = {},
): Promise<CurrentPlatformAdminResult> {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return { ok: false, status: 401, code: 'ADMIN_REQUIRED', error: 'platform_admin required' }
  }

  const actorUserId = (session.user as { id?: string }).id
  if (!actorUserId || !ACTOR_ID_PATTERN.test(actorUserId)) {
    return { ok: false, status: 403, code: 'ADMIN_REQUIRED', error: 'platform_admin required' }
  }

  const blocked = await options.beforeAuthorityLookup?.(actorUserId)
  if (blocked) {
    return {
      ok: false,
      status: blocked.status,
      code: 'REQUEST_BLOCKED',
      error: 'request blocked',
      actorUserId,
      response: blocked,
    }
  }

  try {
    await connectDB()
    const currentAdmin = await User.findOne({
      ...activeJobsAccountFilter(actorUserId),
      role: 'platform_admin',
    }).select('_id').lean()
    if (!currentAdmin) {
      return { ok: false, status: 403, code: 'ADMIN_REQUIRED', error: 'platform_admin required' }
    }
  } catch (cause) {
    return {
      ok: false,
      status: 503,
      code: 'AUTHORITY_UNAVAILABLE',
      error: 'Jobs operations authorization is unavailable',
      actorUserId,
      cause,
    }
  }

  return { ok: true, actorUserId }
}
