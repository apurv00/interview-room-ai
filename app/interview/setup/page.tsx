import { Suspense } from 'react'
import InterviewSetupForm from '@interview/components/InterviewSetupForm'
import HowItWorksBlock from '@/shared/blocks/HowItWorks'
import StatsBlock from '@/shared/blocks/Stats'
import ResourceLinks from '@learn/components/ResourceLinks'

export default function InterviewSetupPage() {
  return (
    <>
      {/* Suspense required because InterviewSetupForm uses useSearchParams
          to read the `?retake=<parentId>` query param. Without this
          boundary Next.js bails out of static generation for the page. */}
      <Suspense fallback={null}>
        <InterviewSetupForm />
      </Suspense>
      {/* Marketing / content blocks preserved below the setup form */}
      <HowItWorksBlock />
      <StatsBlock />
      <ResourceLinks />
    </>
  )
}
