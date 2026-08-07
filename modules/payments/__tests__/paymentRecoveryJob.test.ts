import { describe, expect, it, vi } from 'vitest'

const { mockCreateFunction } = vi.hoisted(() => ({
  mockCreateFunction: vi.fn((_config, handler) => ({ handler })),
}))

vi.mock('@shared/services/inngest', () => ({
  inngest: {
    createFunction: mockCreateFunction,
  },
}))
vi.mock('@/app/api/_lib/paymentWebhookLaunchComposition', () => ({
  paymentWebhookLaunchHandler: vi.fn(),
}))
vi.mock('@/app/api/_lib/entitlementCommercialAnalyticsComposition', () => ({
  fulfillSubscriptionCycleProviderObservationWithCommercialAnalytics:
    vi.fn(),
  recoverChargeFulfillmentWithCommercialAnalytics: vi.fn(),
}))

import {
  runPaymentRecoveryJobHandler,
} from '../jobs/paymentRecoveryJob'

describe('payment recovery Inngest handler', () => {
  it('registers one bounded five-minute recovery function', () => {
    expect(mockCreateFunction).toHaveBeenCalledOnce()
    expect(mockCreateFunction.mock.calls[0][0]).toEqual({
      id: 'payment-recovery-sweep',
      name: 'Payments: bounded recovery sweep',
      retries: 1,
      concurrency: [{ limit: 1 }],
      triggers: [{ cron: '*/5 * * * *' }],
    })
  })

  it('does no work without explicit provider-mode authorization', async () => {
    const step = { run: vi.fn() }

    await expect(runPaymentRecoveryJobHandler(step, {})).resolves.toEqual({
      outcome: 'disabled',
      providerModes: [],
    })
    expect(step.run).not.toHaveBeenCalled()
  })

  it('runs one bounded step when Live is explicitly authorized', async () => {
    const store = {
      listWebhookCandidates: vi.fn().mockResolvedValue([]),
      listSubscriptionCandidates: vi.fn().mockResolvedValue([]),
      markSubscriptionAttempted: vi.fn().mockResolvedValue(undefined),
      listChargeCandidates: vi.fn().mockResolvedValue([]),
      deferChargeCandidate: vi.fn().mockResolvedValue(undefined),
    }
    const step = {
      run: vi.fn(async (_name: string, task: () => Promise<unknown>) => task()),
    }

    const result = await runPaymentRecoveryJobHandler(step, {
      PAYMENT_RECOVERY_PROVIDER_MODES: 'live',
    }, { store })

    expect(step.run).toHaveBeenCalledOnce()
    expect(step.run).toHaveBeenCalledWith(
      'recover-payment-obligations',
      expect.any(Function),
    )
    expect(result).toEqual({
      outcome: 'completed',
      providerModes: ['live'],
      webhook: {
        candidates: 0,
        completed: 0,
        deferred: 0,
        failed: 0,
      },
      subscription: {
        candidates: 0,
        completed: 0,
        deferred: 0,
        failed: 0,
        cyclesRecovered: 0,
      },
      charge: {
        candidates: 0,
        completed: 0,
        deferred: 0,
        failed: 0,
      },
    })
    expect(store.listWebhookCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ providerMode: 'live', limit: 25 }),
    )
    expect(store.listSubscriptionCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ providerMode: 'live', limit: 5 }),
    )
    expect(store.listChargeCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ providerMode: 'live', limit: 25 }),
    )
  })
})
