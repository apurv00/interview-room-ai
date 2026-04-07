import InterviewSetupForm from '@interview/components/InterviewSetupForm'
import HowItWorksBlock from '@/shared/blocks/HowItWorks'
import StatsBlock from '@/shared/blocks/Stats'
import ResourceLinks from '@learn/components/ResourceLinks'

export default function InterviewSetupPage() {
  return (
    <>
      <InterviewSetupForm />
      {/* Marketing / content blocks preserved below the setup form */}
      <HowItWorksBlock />
      <StatsBlock />
      <ResourceLinks />
    </>
  )
}
