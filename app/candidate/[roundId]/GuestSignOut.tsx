'use client'

/**
 * Renders nothing; ends a lingering SYNTHETIC-guest session on terminal
 * candidate screens (completed / invalid link). A guest who revisits their
 * invite after finishing must end up logged out (founder ruling 2026-08-09)
 * — the thank-you flow handles the normal completion path, this covers
 * revisits and dead links. Real users who merely open an invite link while
 * signed in are NEVER touched: the sign-out fires only for the per-round
 * guest email domain.
 */

import { useEffect, useRef } from 'react'
import { signOut, useSession } from 'next-auth/react'

export default function GuestSignOut() {
  const { data: session, status } = useSession()
  const firedRef = useRef(false)

  useEffect(() => {
    if (firedRef.current || status !== 'authenticated') return
    const email = session?.user?.email ?? ''
    if (email.endsWith('@guests.interviewprep.internal')) {
      firedRef.current = true
      void signOut({ redirect: false })
    }
  }, [status, session?.user?.email])

  return null
}
