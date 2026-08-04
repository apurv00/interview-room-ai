import type { CouponMode } from '../models/BillingConfig'
import { getBillingConfig } from './billingConfigService'

/**
 * PR4 may verify remote Offer terms, but campaign activation belongs to PR5.
 * Keep this explicit code readiness false until the PR5 quote/reservation path
 * and its rollout tests land.
 */
export const PR5_COUPON_ACTIVATION_READY = true

export interface CouponActivationGate {
  pr5Ready: boolean
  couponMode: CouponMode
}

export async function readCouponActivationGate(): Promise<CouponActivationGate> {
  const config = await getBillingConfig()
  return {
    pr5Ready: PR5_COUPON_ACTIVATION_READY,
    couponMode: config.couponMode,
  }
}
