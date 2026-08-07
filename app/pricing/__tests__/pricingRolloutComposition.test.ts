import { beforeEach, describe, expect, it, vi } from 'vitest'

const QA_USER_ID = '64b64c0f2f4e8b6a8c7d9e10'
const NON_QA_USER_ID = '64b64c0f2f4e8b6a8c7d9e11'

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  getBillingConfig: vi.fn(),
  readPublicBillingCatalog: vi.fn(),
}))

vi.mock('next-auth', () => ({
  getServerSession: mocks.getServerSession,
}))

vi.mock('@shared/auth/authOptions', () => ({
  authOptions: {},
}))

vi.mock('@payments/services/billingConfigService', () => ({
  getBillingConfig: mocks.getBillingConfig,
}))

vi.mock('@customer-billing', () => ({
  readPublicBillingCatalog: mocks.readPublicBillingCatalog,
}))

import {
  resolveProductionPricingRolloutExperience,
} from '../pricingRolloutComposition'

describe('production pricing rollout composition', () => {
  beforeEach(() => {
    mocks.getServerSession.mockReset().mockResolvedValue(null)
    mocks.getBillingConfig.mockReset().mockResolvedValue({
      sellingMode: 'qa',
      qaUserIds: [QA_USER_ID],
    })
    mocks.readPublicBillingCatalog.mockReset().mockResolvedValue({
      catalogVersion: 'consumer-inr-v1',
    })
  })

  it('shows the active billing surface to signed-out visitors before the auth gate', async () => {
    await expect(
      resolveProductionPricingRolloutExperience(),
    ).resolves.toBe(true)
    expect(mocks.readPublicBillingCatalog).toHaveBeenCalledOnce()
  })

  it('continues to apply the user-specific sale gate after sign-in', async () => {
    mocks.getServerSession.mockResolvedValue({
      user: { id: NON_QA_USER_ID },
    })

    await expect(
      resolveProductionPricingRolloutExperience(),
    ).resolves.toBe(false)
    expect(mocks.readPublicBillingCatalog).not.toHaveBeenCalled()
  })

  it('keeps the billing surface closed when selling is globally off', async () => {
    mocks.getBillingConfig.mockResolvedValue({
      sellingMode: 'off',
      qaUserIds: [],
    })

    await expect(
      resolveProductionPricingRolloutExperience(),
    ).resolves.toBe(false)
    expect(mocks.readPublicBillingCatalog).not.toHaveBeenCalled()
  })
})
