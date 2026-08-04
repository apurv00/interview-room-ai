import PricingPageClient from './PricingPageClient'
import {
  resolveProductionPricingRolloutExperience,
} from './pricingRolloutComposition'

export const dynamic = 'force-dynamic'

export default async function PricingPage() {
  const paidRolloutCopyEnabled =
    await resolveProductionPricingRolloutExperience()

  return (
    <PricingPageClient
      paidRolloutCopyEnabled={paidRolloutCopyEnabled}
    />
  )
}
