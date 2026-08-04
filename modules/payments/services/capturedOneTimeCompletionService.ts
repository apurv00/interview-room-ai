import { logger } from '@shared/logger'
import {
  verifyCapturedCheckout,
  type CapturedCheckoutVerificationInput,
  type CapturedCheckoutVerificationResult,
} from './capturedCheckoutVerificationService'
import {
  recoverChargeFulfillment,
  type ChargeFulfillmentRecoveryResult,
} from './chargeFulfillmentRecoveryService'

/**
 * Payment capture durability stays active independently, but applying a
 * purchased entitlement requires this second compile-time readiness gate.
 */
export const PR7_CAPTURED_ONE_TIME_COMPLETION_READY =
  true as const

interface CapturedOneTimeCompletionDependencies {
  completionReady?: boolean
  verify?: (
    input: CapturedCheckoutVerificationInput,
  ) => Promise<CapturedCheckoutVerificationResult>
  recover?: typeof recoverChargeFulfillment
}

const completionLogger = logger.child({
  module: 'captured-one-time-completion',
})

function entitlementApplied(
  result: ChargeFulfillmentRecoveryResult,
): result is Extract<
  ChargeFulfillmentRecoveryResult,
  { outcome: 'one_time_entitlement_processed' }
> {
  return result.outcome === 'one_time_entitlement_processed'
}

/**
 * Verifies the server-fetched captured payment first, then—only when the
 * independent readiness gate is enabled—applies the one-time entitlement.
 * Recovery is idempotent; a failure returns the durable captured state so the
 * background recovery lane can retry without prompting a second payment.
 */
export async function verifyAndCompleteCapturedOneTimeCheckout(
  input: CapturedCheckoutVerificationInput,
  dependencies: CapturedOneTimeCompletionDependencies = {},
): Promise<CapturedCheckoutVerificationResult> {
  const verify = dependencies.verify ?? verifyCapturedCheckout
  const verified = await verify(input)

  if (
    (dependencies.completionReady ??
      PR7_CAPTURED_ONE_TIME_COMPLETION_READY) !== true
  ) {
    return verified
  }
  if (
    input.expectedKind !== 'order' ||
    verified.checkoutKind !== 'order' ||
    (
      verified.fulfillmentKind !== 'single_interview' &&
      verified.fulfillmentKind !== 'premium_resume'
    ) ||
    verified.fulfillmentId.length !== 24
  ) {
    completionLogger.error(
      {
        checkoutKind: verified.checkoutKind,
        fulfillmentKind: verified.fulfillmentKind,
      },
      'Captured order completion context is inconsistent',
    )
    return verified
  }
  if (
    verified.intentStatus === 'fulfilled' ||
    verified.fulfillmentStatus !== 'verified'
  ) {
    return verified
  }

  try {
    const recovery = await (
      dependencies.recover ?? recoverChargeFulfillment
    )({
      fulfillmentId: verified.fulfillmentId,
      providerMode: verified.providerMode,
    })
    if (!entitlementApplied(recovery)) {
      completionLogger.error(
        {
          fulfillmentId: verified.fulfillmentId,
          outcome: recovery.outcome,
        },
        'Captured order did not reach one-time entitlement recovery',
      )
      return verified
    }
    return {
      ...verified,
      intentStatus: 'fulfilled',
      fulfillmentStatus:
        recovery.entitlement.fulfillmentStatus,
      reused: verified.reused || recovery.entitlement.reused,
    }
  } catch (error) {
    completionLogger.error(
      {
        fulfillmentId: verified.fulfillmentId,
        errorName:
          error instanceof Error ? error.name : 'UnknownError',
      },
      'Captured order entitlement recovery deferred',
    )
    return verified
  }
}
