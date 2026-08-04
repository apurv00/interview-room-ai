import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const decide = vi.fn()
  return {
    decide,
    createRepository: vi.fn(() => ({})),
    createRuntime: vi.fn(() => ({ ports: {} })),
    createService: vi.fn(() => ({ decide })),
  }
})

vi.mock('@/modules/payment-rollout-control', () => ({
  createBillingRolloutControlService: mocks.createService,
  createMongoBillingRolloutControlRepository:
    mocks.createRepository,
}))

vi.mock('../mongoRuntimeAuthority', () => ({
  createMongoBillingRolloutRuntimeAuthority:
    mocks.createRuntime,
}))

import {
  readProductionBillingRolloutDecision,
} from '../productionDecisionAuthority'

describe('production billing rollout decision authority', () => {
  beforeEach(() => {
    mocks.decide.mockReset()
    mocks.createRepository.mockClear()
    mocks.createRuntime.mockClear()
    mocks.createService.mockClear()
  })

  it('passes through an explicitly dark authority decision without provider I/O', async () => {
    const input = {
      userId: '650000000000000000000001',
      userCreatedAt: new Date('2026-08-01T00:00:00.000Z'),
      buyerState: 'active' as const,
      now: new Date('2026-08-05T00:00:00.000Z'),
    }
    const darkDecision = {
      enabled: false,
      reason: 'execution_gate_off',
      sellingAllowed: false,
      enforcementEnabled: false,
      copyEnabled: false,
      analyticsEnabled: false,
      communicationsEnabled: false,
      skuScope: [],
    }
    mocks.decide.mockResolvedValue(darkDecision)

    await expect(
      readProductionBillingRolloutDecision(input),
    ).resolves.toEqual(darkDecision)

    expect(mocks.createRepository).toHaveBeenCalledTimes(1)
    expect(mocks.createRuntime).toHaveBeenCalledTimes(1)
    expect(mocks.createService).toHaveBeenCalledTimes(1)
    expect(mocks.decide).toHaveBeenCalledWith(input)
  })
})
