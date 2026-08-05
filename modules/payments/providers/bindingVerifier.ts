import type {
  CatalogContent,
  CouponRevisionTerms,
  ProviderMode,
  ProviderVerificationSnapshot,
} from '../types/catalog'

export interface CatalogBindingVerificationInput {
  mode: ProviderMode
  content: CatalogContent
  contentHash: string
}

export interface CouponBindingVerificationInput {
  mode: ProviderMode
  terms: CouponRevisionTerms
  contentHash: string
  catalogContentHash: string
  applicablePlanIds: string[]
}

export interface PaymentBindingVerifier {
  verifyCatalog(
    input: CatalogBindingVerificationInput,
  ): Promise<ProviderVerificationSnapshot>
  verifyCoupon(
    input: CouponBindingVerificationInput,
  ): Promise<ProviderVerificationSnapshot>
}

export const unavailablePaymentBindingVerifier: PaymentBindingVerifier = {
  async verifyCatalog() {
    return {
      status: 'unavailable',
      fetchedAt: new Date(),
      errors: [
        'Razorpay Plan verification is unavailable until the PR4 money core is installed',
      ],
    }
  },
  async verifyCoupon() {
    return {
      status: 'unavailable',
      fetchedAt: new Date(),
      errors: [
        'Coupon and catalog Plan binding verification is unavailable until the PR4 money core is installed',
      ],
    }
  },
}
