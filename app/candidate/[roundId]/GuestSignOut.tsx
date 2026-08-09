'use client'

/**
 * Renders nothing; ends a lingering SYNTHETIC-guest session on terminal
 * candidate screens (completed / invalid link). A guest who revisits their
 * invite after finishing must end up logged out (founder ruling 2026-08-09)
 * — the thank-you flow handles the normal completion path, this covers
 * revisits and dead links. Real users who merely open an invite link while
 * signed in are NEVER touched.
 *
 * SCOPED to this round's own synthetic identity: with 2+ invites in one
 * browser, an OLDER round's terminal page must never end a NEWER round's
 * live session — unscoped sign-out stranded a mid-flow candidate at the
 * B2C sign-in modal (founder-hit bug, 2026-08-09).
 */

import { useEffect, useRef } from 'react'
import { signOut, useSession } from 'next-auth/react'
import { isGuestEmailForRound } from '@shared/auth/guestScope'

export default function GuestSignOut({ roundId }: { roundId: string }) {
  const { data: session, status } = useSession()
  const firedRef = useRef(false)

  useEffect(() => {
    if (firedRef.current || status !== 'authenticated') return
    if (isGuestEmailForRound(session?.user?.email, roundId)) {
      firedRef.current = true
      void signOut({ redirect: false })
    }
  }, [status, session?.user?.email, roundId])

  return null
}
