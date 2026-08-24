import { describe, expect, it } from 'vitest'
import { HireCommercialAccount } from '../../modules/hire-commercial/models'
import {
  HireInterviewResult,
  HireInvitationBatchItem,
} from '../../modules/hire/models'

function hasExactKey(
  indexes: Array<[Record<string, number>, Record<string, unknown>]>,
  expected: Record<string, number>,
): boolean {
  return indexes.some(([key]) => JSON.stringify(key) === JSON.stringify(expected))
}

describe('Hire Phase 2 explicit index ownership', () => {
  it('keeps the three new rollout indexes out of runtime schema initialization', () => {
    const invitationIndexes = HireInvitationBatchItem.schema.indexes() as Array<
      [Record<string, number>, Record<string, unknown>]
    >
    const resultIndexes = HireInterviewResult.schema.indexes() as Array<
      [Record<string, number>, Record<string, unknown>]
    >

    expect(
      hasExactKey(invitationIndexes, {
        workspaceId: 1,
        jobId: 1,
        invitationBatchId: 1,
        _id: 1,
      }),
    ).toBe(false)
    expect(
      hasExactKey(resultIndexes, { workspaceId: 1, completedAt: -1 }),
    ).toBe(false)
    expect(HireCommercialAccount.schema.options.autoCreate).toBe(false)
    expect(HireCommercialAccount.schema.options.autoIndex).toBe(false)
    expect(HireCommercialAccount.schema.indexes()).toEqual([])
  })
})
