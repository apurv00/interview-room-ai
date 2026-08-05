import type { BillingConfigView } from './billingConfigService'
import type { ProviderMode } from '../types/catalog'

/**
 * Code-readiness switches are intentionally separate from mutable CMS state.
 * A database write alone can never turn on remote creation or live money.
 */
export const PR4_REMOTE_PAYMENT_CREATION_READY = true
/**
 * Umbrella precondition for remote creation. It may become true only after
 * provider-mode recovery workers, durable scans, and P0 alert delivery have
 * their own approved evidence. Remote creation can never bypass this gate.
 */
export const PR4_PAYMENT_RECOVERY_READY = true
export const PR11_LIVE_PAYMENT_CREATION_READY = true

export const PAYMENT_SALE_BLOCK_REASONS = [
  'remote_creation_not_ready',
  'payment_recovery_not_ready',
  'selling_off',
  'not_qa_user',
  'live_creation_not_ready',
  'buyer_not_found',
  'buyer_deletion_pending',
] as const
export type PaymentSaleBlockReason =
  (typeof PAYMENT_SALE_BLOCK_REASONS)[number]

export type PaymentSaleGate =
  | {
      allowed: true
      providerMode: ProviderMode
      rollout: 'qa' | 'all'
    }
  | {
      allowed: false
      reason: PaymentSaleBlockReason
    }

export interface PaymentCodeReadiness {
  remoteCreationReady: boolean
  recoveryReady: boolean
  liveCreationReady: boolean
}

export const CURRENT_PAYMENT_CODE_READINESS:
  Readonly<PaymentCodeReadiness> = Object.freeze({
    remoteCreationReady: PR4_REMOTE_PAYMENT_CREATION_READY,
    recoveryReady: PR4_PAYMENT_RECOVERY_READY,
    liveCreationReady: PR11_LIVE_PAYMENT_CREATION_READY,
  })

/**
 * Pure policy function used by routes before any local intent or remote object
 * is created. Provider mode is derived here; it is never accepted from a
 * customer request.
 */
export function evaluatePaymentSaleGate(
  config: BillingConfigView,
  userId: string,
  readiness: PaymentCodeReadiness = CURRENT_PAYMENT_CODE_READINESS,
  buyerState?: string,
): PaymentSaleGate {
  if (!readiness.remoteCreationReady) {
    return { allowed: false, reason: 'remote_creation_not_ready' }
  }
  if (!readiness.recoveryReady) {
    return { allowed: false, reason: 'payment_recovery_not_ready' }
  }
  if (buyerState === 'deletion_pending') {
    return { allowed: false, reason: 'buyer_deletion_pending' }
  }
  if (config.sellingMode === 'off') {
    return { allowed: false, reason: 'selling_off' }
  }
  if (config.sellingMode === 'qa') {
    return config.qaUserIds.includes(userId)
      ? { allowed: true, providerMode: 'test', rollout: 'qa' }
      : { allowed: false, reason: 'not_qa_user' }
  }
  if (!readiness.liveCreationReady) {
    return { allowed: false, reason: 'live_creation_not_ready' }
  }
  return { allowed: true, providerMode: 'live', rollout: 'all' }
}

export interface PaymentRecoveryGateInput {
  configuredEnabled: boolean
  hasProviderObligations: boolean
}

/**
 * Selling switches must not strand an order, mandate, payment, refund, or
 * deletion request. Recovery remains required whenever provider obligations
 * exist, even if the CMS recovery switch is currently false.
 */
export function paymentRecoveryRequired(
  input: PaymentRecoveryGateInput,
): boolean {
  return input.configuredEnabled || input.hasProviderObligations
}
