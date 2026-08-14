import type { Metadata } from 'next'
import InterviewKitEntry from './InterviewKitEntry'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Interview kit — IPG Hire',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}

/**
 * The authority for this page stays in the URL fragment. Fragments are never
 * sent with the initial request, leaving this route safe to render without a
 * session or a request-target credential.
 */
export default async function InterviewKitPage({
  params,
}: {
  params: Promise<{ kitId: string }>
}) {
  const { kitId } = await params
  return <InterviewKitEntry kitId={kitId} />
}
