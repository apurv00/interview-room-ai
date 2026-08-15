import type { Metadata } from 'next'
import CandidateStatusEntry from './CandidateStatusEntry'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Application status — IPG Hire',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}

/** The full possession capability stays in the fragment, never this request. */
export default async function CandidateStatusPage({
  params,
}: {
  params: Promise<{ linkId: string }>
}) {
  const { linkId } = await params
  return <CandidateStatusEntry linkId={linkId} />
}
