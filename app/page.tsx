import { getServerSession } from 'next-auth'
import { authOptions } from '@shared/auth/authOptions'
import AuthenticatedHome from './AuthenticatedHome'
import HeroBlock from '@/shared/blocks/Hero'
import HowItWorksBlock from '@/shared/blocks/HowItWorks'
import FeaturesBlock from '@/shared/blocks/Features'
import DomainShowcaseBlock from '@/shared/blocks/DomainShowcase'
import StatsBlock from '@/shared/blocks/Stats'
import PricingBlock from '@/shared/blocks/Pricing'
import CTABlock from '@/shared/blocks/CTA'
import ResourceLinks from '@learn/components/ResourceLinks'

export default async function HomePage() {
  const session = await getServerSession(authOptions)

  if (session?.user) {
    return <AuthenticatedHome />
  }

  return (
    <main className="min-h-screen">
      <HeroBlock />
      <HowItWorksBlock />
      <DomainShowcaseBlock />
      <StatsBlock />
      <FeaturesBlock />
      <ResourceLinks />
      <PricingBlock />
      <CTABlock />
    </main>
  )
}
