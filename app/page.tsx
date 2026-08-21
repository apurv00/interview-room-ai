import MarketingHomepage from '@/modules/marketing/components/MarketingHomepage'
import { readHomepagePricingCatalogSnapshot } from '@/modules/marketing/server/homepagePricingCatalog'
import { PathwayStatusBanner } from '@learn'

export const dynamic = 'force-dynamic'

export default async function HomePage() {
  const initialBillingCatalog = await readHomepagePricingCatalogSnapshot()

  return (
    <>
      <PathwayStatusBanner />
      <MarketingHomepage initialBillingCatalog={initialBillingCatalog} />
    </>
  )
}
