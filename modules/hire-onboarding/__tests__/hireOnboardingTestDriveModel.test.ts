import mongoose, { type Model } from 'mongoose'
import { describe, expect, it } from 'vitest'
import {
  HireOnboardingTestDrive,
  HIRE_ONBOARDING_TEST_DRIVE_COLLECTION,
  type IHireOnboardingTestDrive,
} from '../models'

const IDS = {
  workspaceId: new mongoose.Types.ObjectId('111111111111111111111111'),
  memberId: new mongoose.Types.ObjectId('222222222222222222222222'),
  jobId: new mongoose.Types.ObjectId('333333333333333333333333'),
  candidateId: new mongoose.Types.ObjectId('444444444444444444444444'),
  applicationId: new mongoose.Types.ObjectId('555555555555555555555555'),
}

function indexes(model: Model<never>): Array<[Record<string, number>, Record<string, unknown>]> {
  return model.schema.indexes() as Array<[Record<string, number>, Record<string, unknown>]>
}

function drive(overrides: Record<string, unknown> = {}) {
  return {
    ...IDS,
    issuedByMemberId: IDS.memberId,
    issuedByName: 'Hiring manager',
    operationId: '11111111-1111-4111-8111-111111111111',
    label: 'Interview yourself',
    state: 'provisioning',
    active: true,
    excludeFromAggregates: true,
    cleanupAfter: new Date('2099-08-30T00:00:00.000Z'),
    ...overrides,
  }
}

describe('Hire onboarding test-drive model', () => {
  it('persists only Hire coordinates, bounded actor snapshots, and aggregate exclusion state', () => {
    expect(new HireOnboardingTestDrive(drive()).validateSync()).toBeUndefined()
    expect(HireOnboardingTestDrive.collection.name).toBe(HIRE_ONBOARDING_TEST_DRIVE_COLLECTION)
    for (const field of [
      'workspaceId',
      'issuedByMemberId',
      'issuedByName',
      'operationId',
      'jobId',
      'candidateId',
      'applicationId',
      'excludeFromAggregates',
    ]) {
      expect(HireOnboardingTestDrive.schema.path(field)).toBeDefined()
    }
    for (const prohibited of [
      'inviteUrl',
      'rawInvite',
      'token',
      'secret',
      'capability',
      'candidateEmail',
      'delivery',
      'userId',
    ]) {
      expect(HireOnboardingTestDrive.schema.path(prohibited)).toBeUndefined()
    }
    expect(
      new HireOnboardingTestDrive(drive({ issuedByName: 'x'.repeat(121) })).validateSync()?.errors
        .issuedByName,
    ).toBeDefined()
  })

  it('has all seven scoped indexes required for idempotency, cleanup, and coordinate filtering', () => {
    const allIndexes = indexes(HireOnboardingTestDrive as unknown as Model<never>)
    expect(allIndexes).toHaveLength(7)
    expect(
      allIndexes.some(
        ([spec, options]) =>
          spec.workspaceId === 1 &&
          spec.issuedByMemberId === 1 &&
          spec.operationId === 1 &&
          options.unique === true,
      ),
    ).toBe(true)
    expect(
      allIndexes.some(
        ([spec, options]) =>
          spec.workspaceId === 1 &&
          spec.issuedByMemberId === 1 &&
          spec.active === 1 &&
          options.unique === true,
      ),
    ).toBe(true)
    for (const coordinate of ['applicationId', 'jobId', 'candidateId', 'roundId']) {
      expect(
        allIndexes.some(
          ([spec]) =>
            spec.workspaceId === 1 &&
            spec[coordinate] === 1 &&
            spec.excludeFromAggregates === 1,
        ),
      ).toBe(true)
    }
  })

  it('retains the direct Hire-only type contract', () => {
    const typed: Pick<
      IHireOnboardingTestDrive,
      | 'workspaceId'
      | 'jobId'
      | 'candidateId'
      | 'applicationId'
      | 'excludeFromAggregates'
    > = drive() as any
    expect(typed.workspaceId).toEqual(IDS.workspaceId)
    expect(typed.excludeFromAggregates).toBe(true)
  })
})
