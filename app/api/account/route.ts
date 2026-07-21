import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import {
  AccountDeletionForbiddenError,
  AccountDeletionIncompleteError,
  AccountDeletionNotFoundError,
  deleteUserAccount,
} from '@shared/services/accountDeletion'
import { logger } from '@shared/logger'

export const dynamic = 'force-dynamic'

/**
 * DELETE /api/account
 *
 * Permanently deletes the authenticated user's account and every
 * piece of personal data associated with them. This is the backing
 * implementation for the deletion promise in /privacy and /terms.
 *
 * The client calls `signOut()` after success for immediate UI cleanup.
 * NextAuth uses stateless JWT sessions, so adapter-session deletion alone
 * does not revoke an already-issued cookie; the durable account write fence
 * is the server-side authority after deletion begins.
 */
export async function DELETE() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    // The service loads current email/role from Mongo while claiming the
    // deletion lifecycle. JWT snapshots are not privacy authority.
    const result = await deleteUserAccount(session.user.id)
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    if (err instanceof AccountDeletionForbiddenError) {
      return NextResponse.json(
        { error: 'Platform admins cannot self-delete via this endpoint. Contact support.' },
        { status: 403 },
      )
    }
    if (err instanceof AccountDeletionNotFoundError) {
      // Defensive fallback: deleteUserAccount normally converts a missing
      // User into a compensating userId-keyed sweep. Never claim completion
      // if that verification path was bypassed or regressed.
      logger.error(
        {
          err,
          event: 'account_deletion_unverified_missing_user',
          code: 'ACCOUNT_DELETION_UNVERIFIED',
          userId: session.user.id,
        },
        'Account deletion could not be verified after User disappeared',
      )
      return NextResponse.json(
        {
          error: 'Your account record is gone, but cleanup could not be verified. Please retry or contact support.',
          code: 'ACCOUNT_DELETION_UNVERIFIED',
        },
        { status: 503 },
      )
    }
    if (err instanceof AccountDeletionIncompleteError) {
      logger.error(
        {
          err,
          event: 'account_deletion_incomplete',
          code: 'ACCOUNT_DELETION_INCOMPLETE',
          userId: session.user.id,
          failedCollections: err.failedCollections,
        },
        'Account deletion incomplete',
      )
      return NextResponse.json(
        {
          error: 'We started deleting your account but could not finish. Please try again or contact support.',
          code: 'ACCOUNT_DELETION_INCOMPLETE',
        },
        { status: 503 },
      )
    }
    logger.error({ err, userId: session.user.id }, 'Account deletion failed')
    return NextResponse.json(
      { error: 'Failed to delete account. Please try again or contact support.' },
      { status: 500 }
    )
  }
}
