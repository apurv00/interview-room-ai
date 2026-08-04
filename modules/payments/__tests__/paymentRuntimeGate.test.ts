import { describe, expect, it } from 'vitest'
import {
  ALL_OFF_BILLING_CONFIG,
  type BillingConfigView,
} from '../services/billingConfigService'
import {
  CURRENT_PAYMENT_CODE_READINESS,
  evaluatePaymentSaleGate,
  paymentRecoveryRequired,
} from '../services/paymentRuntimeGate'

const qaUserId = '507f1f77bcf86cd799439011'

function config(
  overrides: Partial<BillingConfigView>,
): BillingConfigView {
  return {
    ...ALL_OFF_BILLING_CONFIG,
    ...overrides,
  }
}

describe('payment runtime gates', () => {
  it('enables Test creation while keeping Live creation dark', () => {
    expect(CURRENT_PAYMENT_CODE_READINESS).toEqual({
      remoteCreationReady: true,
      recoveryReady: true,
      liveCreationReady: false,
    })
    expect(evaluatePaymentSaleGate(
      config({ sellingMode: 'qa', qaUserIds: [qaUserId] }),
      qaUserId,
    )).toEqual({
      allowed: true,
      providerMode: 'test',
      rollout: 'qa',
    })
    expect(evaluatePaymentSaleGate(
      config({ sellingMode: 'qa', qaUserIds: [qaUserId] }),
      qaUserId,
      {
        remoteCreationReady: false,
        recoveryReady: false,
        liveCreationReady: false,
      },
    )).toEqual({
      allowed: false,
      reason: 'remote_creation_not_ready',
    })
  })

  it('derives test mode only for an explicitly allowlisted QA user', () => {
    const qaConfig = config({
      sellingMode: 'qa',
      qaUserIds: [qaUserId],
    })
    const readiness = {
      remoteCreationReady: true,
      recoveryReady: true,
      liveCreationReady: false,
    }

    expect(evaluatePaymentSaleGate(
      qaConfig,
      qaUserId,
      readiness,
    )).toEqual({
      allowed: true,
      providerMode: 'test',
      rollout: 'qa',
    })
    expect(evaluatePaymentSaleGate(
      qaConfig,
      '507f1f77bcf86cd799439012',
      readiness,
    )).toEqual({
      allowed: false,
      reason: 'not_qa_user',
    })
  })

  it('requires a separate live-code readiness gate for all-user selling', () => {
    const allConfig = config({ sellingMode: 'all' })
    expect(evaluatePaymentSaleGate(allConfig, qaUserId, {
      remoteCreationReady: true,
      recoveryReady: true,
      liveCreationReady: false,
    })).toEqual({
      allowed: false,
      reason: 'live_creation_not_ready',
    })
    expect(evaluatePaymentSaleGate(allConfig, qaUserId, {
      remoteCreationReady: true,
      recoveryReady: true,
      liveCreationReady: true,
    })).toEqual({
      allowed: true,
      providerMode: 'live',
      rollout: 'all',
    })
  })

  it('does not let readiness bypass an off selling mode', () => {
    expect(evaluatePaymentSaleGate(
      ALL_OFF_BILLING_CONFIG,
      qaUserId,
      {
        remoteCreationReady: true,
        recoveryReady: true,
        liveCreationReady: true,
      },
    )).toEqual({
      allowed: false,
      reason: 'selling_off',
    })
  })

  it('blocks a deletion-pending buyer before any QA or live sale', () => {
    expect(evaluatePaymentSaleGate(
      config({ sellingMode: 'qa', qaUserIds: [qaUserId] }),
      qaUserId,
      {
        remoteCreationReady: true,
        recoveryReady: true,
        liveCreationReady: false,
      },
      'deletion_pending',
    )).toEqual({
      allowed: false,
      reason: 'buyer_deletion_pending',
    })
    expect(evaluatePaymentSaleGate(
      config({ sellingMode: 'all' }),
      qaUserId,
      {
        remoteCreationReady: true,
        recoveryReady: true,
        liveCreationReady: true,
      },
      'deletion_pending',
    )).toEqual({
      allowed: false,
      reason: 'buyer_deletion_pending',
    })
  })

  it.each([
    ['off', false],
    ['qa', true],
    ['all', true],
  ] as const)(
    'keeps provider-obligation recovery independent of sellingMode=%s',
    (sellingMode, saleAllowed) => {
      const sale = evaluatePaymentSaleGate(
        config({
          sellingMode,
          qaUserIds: [qaUserId],
        }),
        qaUserId,
        {
          remoteCreationReady: true,
          recoveryReady: true,
          liveCreationReady: true,
        },
      )

      expect(sale.allowed).toBe(saleAllowed)
      expect(paymentRecoveryRequired({
        configuredEnabled: false,
        hasProviderObligations: true,
      })).toBe(true)
    },
  )

  it('blocks remote creation until recovery is independently ready', () => {
    expect(evaluatePaymentSaleGate(
      config({ sellingMode: 'qa', qaUserIds: [qaUserId] }),
      qaUserId,
      {
        remoteCreationReady: true,
        recoveryReady: false,
        liveCreationReady: false,
      },
    )).toEqual({
      allowed: false,
      reason: 'payment_recovery_not_ready',
    })
  })

  it.each([
    [false, false, false],
    [true, false, true],
    [false, true, true],
    [true, true, true],
  ])(
    'keeps recovery on when configured=%s or obligations=%s',
    (configuredEnabled, hasProviderObligations, expected) => {
      expect(paymentRecoveryRequired({
        configuredEnabled,
        hasProviderObligations,
      })).toBe(expected)
    },
  )
})
