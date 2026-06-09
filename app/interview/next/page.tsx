import { redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import { resolvePathwayNextHref, DEFAULT_NEXT_HREF } from '@learn/services/resolvePathwayNextHref'

/**
 * `/interview/next` — the homepage hero CTA's destination.
 *
 * This is a server-side redirect interstitial. The marketing CTA links
 * here directly (enabled at first paint, never awaiting a client fetch),
 * and the pathway destination is resolved HERE, on the server, at click
 * time — then we redirect. This replaces the old pattern where the CTA
 * sat disabled showing "Loading your next step…" until a client-side
 * `/api/learn/pathway` fetch resolved, which stalled the primary
 * conversion action on cold serverless starts.
 *
 * The page renders nothing — it always redirects. Middleware already
 * requires a token for `/interview/next` (it is not in the public
 * allowlist), so an unauthenticated request is bounced to `/signin`
 * before reaching here; the session guard below is belt-and-suspenders.
 */
export const dynamic = 'force-dynamic'

export default async function InterviewNextPage() {
  const session = await getServerSession(authOptions)
  const userId = (session?.user as { id?: string } | undefined)?.id

  if (!userId) {
    redirect('/signin?callbackUrl=/interview/next')
  }

  let href = DEFAULT_NEXT_HREF
  try {
    href = await resolvePathwayNextHref(userId)
  } catch {
    // resolvePathwayNextHref never throws, but guard anyway so a redirect
    // always happens rather than rendering a blank page.
    href = DEFAULT_NEXT_HREF
  }

  redirect(href)
}
