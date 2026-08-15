import mongoose, { type Model } from 'mongoose'
import { describe, expect, it } from 'vitest'
import { HireCandidateStatusLink, type IHireCandidateStatusLink } from '../models'
import { CANDIDATE_STATUS_LINK_MAX_EXPIRY_DAYS } from '../types'

const IDS = {
  workspaceId: new mongoose.Types.ObjectId('111111111111111111111111'),
  applicationId: new mongoose.Types.ObjectId('222222222222222222222222'),
  jobId: new mongoose.Types.ObjectId('333333333333333333333333'),
  candidateId: new mongoose.Types.ObjectId('444444444444444444444444'),
  issuedByMemberId: new mongoose.Types.ObjectId('555555555555555555555555'),
}

function indexes(model: Model<never>): Array<[Record<string, number>, Record<string, unknown>]> {
  return model.schema.indexes() as Array<[Record<string, number>, Record<string, unknown>]>
}

function statusLink(overrides: Record<string, unknown> = {}) {
  const issuedAt = new Date('2099-08-14T10:00:00.000Z')
  return {
    ...IDS,
    issuedByName: 'Hiring manager',
    issuanceOperationId: 'b6c65a8d-b8b0-4982-b9e7-7571bd60b1f8',
    secretHash: 'a'.repeat(64),
    issuedAt,
    expiresAt: new Date(issuedAt.getTime() + 30 * 86_400_000),
    ...overrides,
  }
}

describe('Phase-5 candidate status-link model', () => {
  it('stores full immutable Hire coordinates and a non-selected secret hash only', () => {
    expect(new HireCandidateStatusLink(statusLink()).validateSync()).toBeUndefined()
    for (const field of [
      'workspaceId',
      'applicationId',
      'jobId',
      'candidateId',
      'issuedByMemberId',
      'issuedByName',
    ]) {
      const path = HireCandidateStatusLink.schema.path(field)
      expect(path.isRequired).toBe(true)
      expect((path.options as { immutable?: boolean }).immutable).toBe(true)
    }
    const hash = HireCandidateStatusLink.schema.path('secretHash')
    expect((hash.options as { select?: boolean }).select).toBe(false)
    for (const prohibited of [
      'rawSecret',
      'secret',
      'token',
      'userId',
      'email',
      'guestSessionId',
      'roundId',
      'applyTokenHash',
    ]) {
      expect(HireCandidateStatusLink.schema.path(prohibited)).toBeUndefined()
    }
    expect(
      new HireCandidateStatusLink(statusLink({ secretHash: 'not-a-hash' })).validateSync()?.errors
        .secretHash,
    ).toBeDefined()
  })

  it('requires expiry after issuance and within the bounded policy', () => {
    const issuedAt = new Date('2099-08-14T10:00:00.000Z')
    expect(
      new HireCandidateStatusLink(statusLink({ issuedAt, expiresAt: issuedAt })).validateSync()
        ?.errors.expiresAt,
    ).toBeDefined()
    expect(
      new HireCandidateStatusLink(
        statusLink({
          issuedAt,
          expiresAt: new Date(
            issuedAt.getTime() + (CANDIDATE_STATUS_LINK_MAX_EXPIRY_DAYS + 1) * 86_400_000,
          ),
        }),
      ).validateSync()?.errors.expiresAt,
    ).toBeDefined()
    expect(
      (
        HireCandidateStatusLink.schema.path('expiresAt').options as {
          immutable?: boolean
        }
      ).immutable,
    ).toBe(true)
  })

  it('keeps active/revoked state explicit and all operational indexes workspace-leading', () => {
    expect(
      new HireCandidateStatusLink(statusLink({ active: false, status: 'active' })).validateSync()
        ?.errors.status,
    ).toBeDefined()
    expect(
      new HireCandidateStatusLink(
        statusLink({
          active: false,
          status: 'revoked',
          revokedAt: new Date('2099-08-15T10:00:00.000Z'),
        }),
      ).validateSync(),
    ).toBeUndefined()
    const allIndexes = indexes(HireCandidateStatusLink as unknown as Model<never>)
    for (const [spec] of allIndexes) expect(spec.workspaceId).toBe(1)
    expect(
      allIndexes.some(
        ([spec, options]) =>
          spec.workspaceId === 1 &&
          spec.applicationId === 1 &&
          spec.issuanceOperationId === 1 &&
          options.unique === true,
      ),
    ).toBe(true)
    expect(allIndexes.some(([spec]) => spec.workspaceId === 1 && spec.candidateId === 1)).toBe(true)
  })

  it('allows only bounded member actor snapshots for a member-triggered revocation', () => {
    const link = new HireCandidateStatusLink(
      statusLink({
        active: false,
        status: 'revoked',
        revokedAt: new Date('2099-08-15T10:00:00.000Z'),
        revokedByMemberId: IDS.issuedByMemberId,
        revokedByName: 'Hiring manager',
      }),
    )
    expect(link.validateSync()).toBeUndefined()
    expect(
      new HireCandidateStatusLink(
        statusLink({
          active: false,
          status: 'revoked',
          revokedAt: new Date('2099-08-15T10:00:00.000Z'),
          revokedByName: 'x'.repeat(121),
        }),
      ).validateSync()?.errors.revokedByName,
    ).toBeDefined()
  })

  it('retains the direct lifecycle type contract without an import from the Hire root barrel', () => {
    const link: Pick<
      IHireCandidateStatusLink,
      | 'workspaceId'
      | 'applicationId'
      | 'jobId'
      | 'candidateId'
      | 'issuedByMemberId'
      | 'issuedByName'
    > = statusLink() as any
    expect(link.workspaceId).toEqual(IDS.workspaceId)
    expect(link.issuedByName).toBe('Hiring manager')
  })
})
