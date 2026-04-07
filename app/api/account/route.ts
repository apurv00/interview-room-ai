import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { deleteUserAccount } from '@shared/services/accountDeletion'
import { logger } from '@shared/logger'

export const dynamic = 'force-dynamic'

/**
 * DELETE /api/account
 *
 * Permanently deletes the authenticated user's account and every
 * piece of personal data associated with them. This is the backing
 * implementation for the deletion promise in /privacy and /terms.
 *
 * The client is expected to call NextAuth's `signOut()` immediately
 * after this returns 200; the server-side cascade also drops the
 * NextAuth session collection so the cookie will fail to validate
 * on the next request anyway, but a client-side signOut gives the
 * user immediate UI feedback.
 */
export async function DELETE() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id || !session.user.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Platform admins must not be able to delete themselves via this
  // endpoint — they need a separate flow that hands off ownership of
  // any orgs they administer. For now we just refuse and surface a
  // clear error.
  if (session.user.role === 'platform_admin') {
    return NextResponse.json(
      { error: 'Platform admins cannot self-delete via this endpoint. Contact support.' },
      { status: 403 }
    )
  }

  try {
    const result = await deleteUserAccount(session.user.id, session.user.email)
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    logger.error({ err, userId: session.user.id }, 'Account deletion failed')
    return NextResponse.json(
      { error: 'Failed to delete account. Please try again or contact support.' },
      { status: 500 }
    )
  }
}
