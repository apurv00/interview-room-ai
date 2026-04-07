'use client'

/**
 * Auth-aware "start an interview" CTA link.
 *
 * Sends authenticated users to /interview/setup and unauthenticated users
 * to /signup, so we don't bounce logged-in users back through the sign-up
 * page they don't need. This is the single source of truth — every
 * marketing/footer/pricing CTA that means "start practicing" should use
 * this component instead of hardcoding `/signup`.
 *
 * Safe to render inside server components: the component is `'use client'`,
 * but the parent stays a server component. SSR initial HTML uses the
 * unauthenticated href (`/signup`), and after hydration the link silently
 * flips to `/interview/setup` for authenticated users.
 */

import Link from 'next/link'
import { useSession } from 'next-auth/react'

interface StartCtaProps {
  children: React.ReactNode
  className?: string
  /** Override the destination for authenticated users. */
  authedHref?: string
  /** Override the destination for unauthenticated users. */
  unauthedHref?: string
}

export default function StartCta({
  children,
  className,
  authedHref = '/interview/setup',
  unauthedHref = '/signup',
}: StartCtaProps) {
  const { status } = useSession()
  const href = status === 'authenticated' ? authedHref : unauthedHref
  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  )
}
