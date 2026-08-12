import type { Metadata } from 'next'
import CandidateEntry from './CandidateEntry'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Your interview — IPG Hire',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}

export default async function CandidateLandingPage({
  params,
}: {
  params: Promise<{ roundId: string }>
}) {
  const { roundId } = await params
  return <CandidateEntry roundId={roundId} />
}
