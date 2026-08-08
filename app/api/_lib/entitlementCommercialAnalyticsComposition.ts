import {
  entitlementActivatedCommercialAnalyticsProducer,
  subscriptionLifecycleCommercialAnalyticsProducer,
} from '@modules/payment-commercial-analytics-producers'
import {
  recoverChargeFulfillment,
} from '@payments/services/chargeFulfillmentRecoveryService'
import {
  individualFinancialDocumentPolicyHandler,
} from '@payments/services/individualFinancialDocumentPolicyService'
import {
  fulfillOneTimeEntitlement,
} from '@payments/services/oneTimeEntitlementFulfillmentService'
import {
  fulfillSubscriptionCycle,
  fulfillSubscriptionCycleProviderObservation,
  fulfillSubscriptionUpfrontCycle,
  type FulfillSubscriptionCycleInput,
  type FulfillSubscriptionUpfrontCycleInput,
  type SubscriptionCycleProviderObservationInput,
} from '@payments/services/subscriptionCycleFulfillmentService'
import {
  productionSubscriptionDunningGraceInterviewPort,
} from './subscriptionDunningGraceInterviewComposition'

export const entitlementActivatedCommercialAnalyticsDependencies =
  Object.freeze({
    commercialAnalyticsProducer:
      entitlementActivatedCommercialAnalyticsProducer,
    subscriptionRenewedAnalyticsProducer:
      subscriptionLifecycleCommercialAnalyticsProducer,
    ...(productionSubscriptionDunningGraceInterviewPort
      ? {
          subscriptionGraceSettlementPort:
            productionSubscriptionDunningGraceInterviewPort,
        }
      : {}),
  })

export function fulfillOneTimeEntitlementWithCommercialAnalytics(
  input: { fulfillmentId: string },
) {
  return fulfillOneTimeEntitlement(
    input,
    entitlementActivatedCommercialAnalyticsDependencies,
  )
}

export function recoverChargeFulfillmentWithCommercialAnalytics(
  input: {
    fulfillmentId: string
    providerMode: 'test' | 'live'
  },
) {
  return recoverChargeFulfillment(input, {
    oneTimeFulfillment:
      fulfillOneTimeEntitlementWithCommercialAnalytics,
    approvedFinancialPolicyHandler:
      individualFinancialDocumentPolicyHandler,
  })
}

export function fulfillSubscriptionCycleWithCommercialAnalytics(
  input: FulfillSubscriptionCycleInput,
) {
  return fulfillSubscriptionCycle(
    input,
    entitlementActivatedCommercialAnalyticsDependencies,
  )
}

export function fulfillSubscriptionUpfrontCycleWithCommercialAnalytics(
  input: FulfillSubscriptionUpfrontCycleInput,
) {
  return fulfillSubscriptionUpfrontCycle(
    input,
    entitlementActivatedCommercialAnalyticsDependencies,
  )
}

export function fulfillSubscriptionCycleProviderObservationWithCommercialAnalytics(
  input: SubscriptionCycleProviderObservationInput,
) {
  return fulfillSubscriptionCycleProviderObservation(
    input,
    entitlementActivatedCommercialAnalyticsDependencies,
  )
}
