import { Suspense } from 'react'
import JobOverview from './JobOverview'

export default async function JobOverviewPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params
  return (
    <Suspense fallback={<div className="h-48 animate-pulse rounded-2xl bg-white" aria-label="Loading job overview" />}>
      <JobOverview jobId={jobId} />
    </Suspense>
  )
}
