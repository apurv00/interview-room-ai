import {
  capturedCommercialAnalyticsProducer,
} from '@modules/payment-commercial-analytics-producers'
import {
  persistServerFetchedCapturedCheckout,
  verifyCapturedCheckout,
  type CapturedCheckoutVerificationInput,
  type PersistServerFetchedCapturedCheckoutInput,
} from '@payments/services/capturedCheckoutVerificationService'
import {
  createOrReuseCheckoutIntent,
  type TrustedCheckoutIntentInput,
} from '@payments/services/checkoutIntentService'
import {
  persistPaymentProviderObservation,
  persistPaymentState,
  type PaymentProviderObservationInput,
  type PaymentStatePersistenceDependencies,
} from '@payments/services/paymentStatePersistenceService'
import type {
  PaymentStateEffectInput,
} from '@payments/services/webhookDomainDispatchService'

export const capturedCheckoutCommercialAnalyticsDependencies =
  Object.freeze({
    commercialAnalyticsProducer:
      capturedCommercialAnalyticsProducer,
  })

export const paymentStateCommercialAnalyticsDependencies =
  Object.freeze({
    commercialAnalyticsProducer:
      capturedCommercialAnalyticsProducer,
  }) satisfies PaymentStatePersistenceDependencies

export function createCheckoutIntentWithCommercialAnalytics(
  input: TrustedCheckoutIntentInput,
) {
  return createOrReuseCheckoutIntent(
    input,
    undefined,
    capturedCommercialAnalyticsProducer,
  )
}

export function persistPaymentStateWithCommercialAnalytics(
  input: PaymentStateEffectInput,
) {
  return persistPaymentState(
    input,
    paymentStateCommercialAnalyticsDependencies,
  )
}

export function persistPaymentProviderObservationWithCommercialAnalytics(
  input: PaymentProviderObservationInput,
) {
  return persistPaymentProviderObservation(
    input,
    paymentStateCommercialAnalyticsDependencies,
  )
}

export function verifyCapturedCheckoutWithCommercialAnalytics(
  input: CapturedCheckoutVerificationInput,
) {
  return verifyCapturedCheckout(
    input,
    capturedCheckoutCommercialAnalyticsDependencies,
  )
}

export function persistCapturedCheckoutWithCommercialAnalytics(
  input: PersistServerFetchedCapturedCheckoutInput,
) {
  return persistServerFetchedCapturedCheckout(
    input,
    capturedCheckoutCommercialAnalyticsDependencies,
  )
}
