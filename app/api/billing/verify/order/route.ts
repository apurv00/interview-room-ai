import { NextRequest } from 'next/server'
import {
  OrderCheckoutVerificationRequestSchema,
} from '@payments/validators/customerBilling'
import {
  verifyAndCompleteCapturedOneTimeCheckout,
} from '@payments/services/capturedOneTimeCompletionService'
import {
  verifyCapturedCheckoutWithCommercialAnalytics,
} from '@/app/api/_lib/paymentCommercialAnalyticsComposition'
import {
  recoverChargeFulfillmentWithCommercialAnalytics,
} from '@/app/api/_lib/entitlementCommercialAnalyticsComposition'
import { handleCheckoutVerification } from '../routeShared'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  return handleCheckoutVerification(request, {
    expectedKind: 'order',
    schema: OrderCheckoutVerificationRequestSchema,
    verify: (input) => verifyAndCompleteCapturedOneTimeCheckout(
      input,
      {
        verify: verifyCapturedCheckoutWithCommercialAnalytics,
        recover: recoverChargeFulfillmentWithCommercialAnalytics,
      },
    ),
  })
}
