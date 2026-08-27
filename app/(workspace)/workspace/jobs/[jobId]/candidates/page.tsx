import { Suspense } from 'react'
import CandidateWorkspace from './CandidateWorkspace'

export default async function JobCandidatesPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params
  return (
    <Suspense fallback={<div className="h-48 animate-pulse rounded-2xl bg-white" aria-label="Loading candidates" />}>
      <CandidateWorkspace jobId={jobId} />
    </Suspense>
  )
}
