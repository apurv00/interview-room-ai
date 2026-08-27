import { describe, expect, it } from 'vitest'
import {
  CreateHireCandidateBulkOperationSchema,
  HireCandidateBulkOperationIssueQuerySchema,
} from '../validators'

const SELECTION_ID = '507f1f77bcf86cd799439011'
const OPERATION_ID = '018f3d6e-7a3d-7d19-9d3b-0123456789ab'

describe('candidate bulk action validation', () => {
  it('accepts an explicitly confirmed, non-communicating stage advance', () => {
    expect(
      CreateHireCandidateBulkOperationSchema.parse({
        selectionId: SELECTION_ID,
        clientOperationId: OPERATION_ID,
        action: 'advance',
        expectedStage: 'screened',
        communication: 'none',
        confirmed: true,
        confirmedCount: 1000,
      }),
    ).toMatchObject({ action: 'advance', confirmedCount: 1000 })
  })

  it.each(['offer_accepted', 'offer_declined', 'hire', 'auto_reject'])(
    'rejects unsafe bulk action %s',
    (action) => {
      expect(
        CreateHireCandidateBulkOperationSchema.safeParse({
          selectionId: SELECTION_ID,
          clientOperationId: OPERATION_ID,
          action,
          communication: 'none',
          confirmed: true,
          confirmedCount: 1,
        }).success,
      ).toBe(false)
    },
  )

  it('requires an affirmative confirmation and exact bounded count', () => {
    expect(
      CreateHireCandidateBulkOperationSchema.safeParse({
        selectionId: SELECTION_ID,
        clientOperationId: OPERATION_ID,
        action: 'reject',
        reasonCode: 'requirements_mismatch',
        communication: 'none',
        confirmed: false,
        confirmedCount: 1,
      }).success,
    ).toBe(false)
    expect(
      CreateHireCandidateBulkOperationSchema.safeParse({
        selectionId: SELECTION_ID,
        clientOperationId: OPERATION_ID,
        action: 'reject',
        reasonCode: 'requirements_mismatch',
        communication: 'none',
        confirmed: true,
        confirmedCount: 5001,
      }).success,
    ).toBe(false)
  })

  it('requires a controlled reason only for reject and withdrawal', () => {
    const base = {
      selectionId: SELECTION_ID,
      clientOperationId: OPERATION_ID,
      communication: 'none' as const,
      confirmed: true as const,
      confirmedCount: 2,
    }
    expect(
      CreateHireCandidateBulkOperationSchema.safeParse({
        ...base,
        action: 'reject',
      }).success,
    ).toBe(false)
    expect(
      CreateHireCandidateBulkOperationSchema.safeParse({
        ...base,
        action: 'withdraw',
        reasonCode: 'candidate_withdrew',
      }).success,
    ).toBe(true)
    expect(
      CreateHireCandidateBulkOperationSchema.safeParse({
        ...base,
        action: 'advance',
        expectedStage: 'new',
        reasonCode: 'requirements_mismatch',
      }).success,
    ).toBe(false)
    expect(
      CreateHireCandidateBulkOperationSchema.safeParse({
        ...base,
        action: 'reject',
        reasonCode: 'candidate mentioned medical history',
      }).success,
    ).toBe(false)
    expect(
      CreateHireCandidateBulkOperationSchema.safeParse({
        ...base,
        action: 'withdraw',
        reasonCode: 'role_filled',
      }).success,
    ).toBe(false)
    expect(
      CreateHireCandidateBulkOperationSchema.safeParse({
        ...base,
        action: 'reject',
        reasonCode: 'candidate_withdrew',
      }).success,
    ).toBe(false)
  })

  it('bounds issue pagination and coerces only whole numbers', () => {
    expect(HireCandidateBulkOperationIssueQuerySchema.parse({})).toEqual({
      limit: 50,
    })
    expect(
      HireCandidateBulkOperationIssueQuerySchema.safeParse({ limit: '1.5' })
        .success,
    ).toBe(false)
    expect(
      HireCandidateBulkOperationIssueQuerySchema.safeParse({ limit: '101' })
        .success,
    ).toBe(false)
  })
})
