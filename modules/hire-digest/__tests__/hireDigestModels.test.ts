import mongoose, { type Model } from 'mongoose'
import { describe, expect, it } from 'vitest'
import {
  HireDigestOutbox,
  HireDigestPreference,
} from '../models'
import { HIRE_DIGEST_MAX_ATTEMPTS } from '../types'

const IDS = {
  workspaceId: new mongoose.Types.ObjectId('111111111111111111111111'),
  memberId: new mongoose.Types.ObjectId('222222222222222222222222'),
}

function indexes(model: Model<never>): Array<[Record<string, number>, Record<string, unknown>]> {
  return model.schema.indexes() as Array<[Record<string, number>, Record<string, unknown>]>
}

function preference(overrides: Record<string, unknown> = {}) {
  return {
    ...IDS,
    enabled: true,
    updatedByMemberId: IDS.memberId,
    updatedByName: 'Hiring manager',
    ...overrides,
  }
}

function outbox(overrides: Record<string, unknown> = {}) {
  return {
    ...IDS,
    periodKey: '2026-08-14',
    recipientEmail: 'member@example.com',
    recipientName: 'Hiring manager',
    payload: {
      workspaceName: 'Acme',
      generatedAt: new Date('2026-08-14T09:00:00.000Z'),
      openJobs: 2,
      awaitingDecision: 3,
      pendingScorecards: 1,
      terminalKitDeliveryFailures: 0,
    },
    status: 'pending',
    sendAfter: new Date('2026-08-14T09:00:00.000Z'),
    attempts: 0,
    ...overrides,
  }
}

describe('Phase-5 Hire digest models', () => {
  it('defaults to an explicit member opt-in model and keeps all indexes workspace-leading', () => {
    expect(new HireDigestPreference(preference()).validateSync()).toBeUndefined()
    const allIndexes = indexes(HireDigestPreference as unknown as Model<never>)
    for (const [spec] of allIndexes) expect(spec.workspaceId).toBe(1)
    expect(
      allIndexes.some(
        ([spec, options]) => spec.workspaceId === 1 && spec.memberId === 1 && options.unique === true,
      ),
    ).toBe(true)
    expect(HireDigestPreference.schema.path('writeFenceVersion').options.default).toBe(0)
  })

  it('stores a member-scoped UTC-period idempotency row with non-selected PII and aggregate-only payload', () => {
    expect(new HireDigestOutbox(outbox()).validateSync()).toBeUndefined()
    for (const field of ['recipientEmail', 'recipientName', 'payload', 'providerMessageId']) {
      expect((HireDigestOutbox.schema.path(field).options as { select?: boolean }).select).toBe(false)
    }
    for (const prohibited of [
      'candidateId',
      'applicationId',
      'jobId',
      'capability',
      'reportUrl',
      'providerError',
      'decisionNote',
    ]) {
      expect(HireDigestOutbox.schema.path(prohibited)).toBeUndefined()
    }
    expect(HireDigestOutbox.schema.path('privacyAggregateFenceVersion').options.default).toBe(0)
    const allIndexes = indexes(HireDigestOutbox as unknown as Model<never>)
    for (const [spec] of allIndexes) expect(spec.workspaceId).toBe(1)
    expect(
      allIndexes.some(
        ([spec, options]) =>
          spec.workspaceId === 1 &&
          spec.memberId === 1 &&
          spec.periodKey === 1 &&
          options.unique === true,
      ),
    ).toBe(true)
  })

  it('rejects malformed period keys and attempts beyond the bounded retry policy', () => {
    expect(new HireDigestOutbox(outbox({ periodKey: '14-08-2026' })).validateSync()?.errors.periodKey)
      .toBeDefined()
    expect(
      new HireDigestOutbox(outbox({ attempts: HIRE_DIGEST_MAX_ATTEMPTS + 1 })).validateSync()?.errors
        .attempts,
    ).toBeDefined()
  })
})
