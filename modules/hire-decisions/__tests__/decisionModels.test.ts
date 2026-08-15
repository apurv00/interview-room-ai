import mongoose, { type Model } from 'mongoose'
import { describe, expect, it } from 'vitest'
import {
  HireExternalVerdict,
  HireSharePacket,
  type IHireSharePacket,
} from '../models'
import { HIRE_DECISION_DIMENSIONS, HIRE_SHARE_PACKET_SECTIONS } from '../types'

const IDS = {
  workspaceId: new mongoose.Types.ObjectId('111111111111111111111111'),
  applicationId: new mongoose.Types.ObjectId('222222222222222222222222'),
  jobId: new mongoose.Types.ObjectId('333333333333333333333333'),
  candidateId: new mongoose.Types.ObjectId('444444444444444444444444'),
  packetId: new mongoose.Types.ObjectId('555555555555555555555555'),
}

function indexes(model: Model<never>): Array<[Record<string, number>, Record<string, unknown>]> {
  return model.schema.indexes() as Array<[Record<string, number>, Record<string, unknown>]>
}

function sourceAggregate() {
  return {
    count: 0,
    recommendations: { strong_yes: 0, yes: 0, no: 0, strong_no: 0 },
    dimensions: HIRE_DECISION_DIMENSIONS.map((key) => ({
      key,
      count: 0,
      mean: null,
      min: null,
      max: null,
      reviewerSpread: null,
    })),
  }
}

function packet(overrides: Record<string, unknown> = {}) {
  const empty = sourceAggregate()
  const { packetId: _packetId, ...coordinates } = IDS
  return {
    ...coordinates,
    creationOperationId: 'b6c65a8d-b8b0-4982-b9e7-7571bd60b1f8',
    secretHash: 'a'.repeat(64),
    allowedSections: [...HIRE_SHARE_PACKET_SECTIONS],
    snapshot: {
      version: 1,
      candidateBrief: { candidateName: 'Ada Lovelace', jobTitle: 'Platform Engineer' },
      aiAssessments: [],
      humanScorecards: { total: empty, member: sourceAggregate(), kit: sourceAggregate() },
    },
    expiresAt: new Date('2026-08-21T10:00:00.000Z'),
    ...overrides,
  }
}

describe('Phase-4 decision record contracts', () => {
  it('keeps packet and verdict records Hire-scoped with immutable coordinates', () => {
    for (const model of [HireSharePacket, HireExternalVerdict]) {
      for (const field of ['workspaceId', 'applicationId', 'jobId', 'candidateId']) {
        const path = model.schema.path(field)
        expect(path).toBeDefined()
        expect(path.isRequired).toBe(true)
        expect((path.options as { immutable?: boolean }).immutable).toBe(true)
      }
      expect(model.schema.path('userId')).toBeUndefined()
      expect(model.schema.path('candidateEmail')).toBeUndefined()
      expect(model.schema.path('resumeText')).toBeUndefined()
    }

    expect((HireSharePacket.schema.path('creationOperationId').options as { immutable?: boolean }).immutable).toBe(true)
    expect((HireExternalVerdict.schema.path('packetId').options as { immutable?: boolean }).immutable).toBe(true)
  })

  it('stores only a non-default-selected hash of the 32-byte packet secret', () => {
    const secretHash = HireSharePacket.schema.path('secretHash')
    expect(secretHash).toBeDefined()
    expect((secretHash.options as { select?: boolean }).select).toBe(false)
    expect(HireSharePacket.schema.path('rawSecret')).toBeUndefined()
    expect(HireSharePacket.schema.path('secret')).toBeUndefined()
    expect(HireSharePacket.schema.path('token')).toBeUndefined()

    expect(new HireSharePacket(packet()).validateSync()).toBeUndefined()
    const invalidHash = new HireSharePacket(packet({ secretHash: 'not-a-secret-hash' })).validateSync()
    expect(invalidHash?.errors.secretHash).toBeDefined()
  })

  it('requires an immutable snapshot that matches exactly the chosen sections', () => {
    const missingEnabledSection = new HireSharePacket(
      packet({
        allowedSections: ['candidate_brief'],
        snapshot: { version: 1 },
      }),
    ).validateSync()
    expect(missingEnabledSection?.errors.snapshot).toBeDefined()

    const leakedDisabledSection = new HireSharePacket(
      packet({
        allowedSections: ['candidate_brief'],
        snapshot: {
          version: 1,
          candidateBrief: { candidateName: 'Ada', jobTitle: 'Engineer' },
          aiAssessments: [],
        },
      }),
    ).validateSync()
    expect(leakedDisabledSection?.errors.snapshot).toBeDefined()

    const duplicateSection = new HireSharePacket(
      packet({ allowedSections: ['candidate_brief', 'candidate_brief'] }),
    ).validateSync()
    expect(duplicateSection?.errors.allowedSections).toBeDefined()

    expect((HireSharePacket.schema.path('snapshot').options as { immutable?: boolean }).immutable).toBe(true)
    expect((HireSharePacket.schema.path('allowedSections').options as { immutable?: boolean }).immutable).toBe(true)
  })

  it('keeps active, consumed, and revoked packet state explicit', () => {
    const inconsistentActive = new HireSharePacket(packet({ active: false, status: 'active' })).validateSync()
    expect(inconsistentActive?.errors.status).toBeDefined()

    expect(new HireSharePacket(packet({
      active: false,
      status: 'verdict_submitted',
      verdictSubmittedAt: new Date('2026-08-14T10:00:00.000Z'),
    })).validateSync()).toBeUndefined()

    expect(new HireSharePacket(packet({
      active: false,
      status: 'revoked',
      revokedAt: new Date('2026-08-14T10:00:00.000Z'),
    })).validateSync()).toBeUndefined()
  })

  it('gives a packet one immutable external verdict without human-scorecard fields', () => {
    const verdict = new HireExternalVerdict({
      ...IDS,
      packetId: IDS.packetId,
      recommendation: 'yes',
      comment: 'The packet evidence is sufficient to continue.',
      submittedAt: new Date('2026-08-14T10:00:00.000Z'),
    })
    expect(verdict.validateSync()).toBeUndefined()
    expect(HireExternalVerdict.schema.path('dimensions')).toBeUndefined()
    expect(HireExternalVerdict.schema.path('evidence')).toBeUndefined()
    expect(HireExternalVerdict.schema.path('humanRoundId')).toBeUndefined()
    expect(HireExternalVerdict.schema.path('reviewerKey')).toBeUndefined()

    const uniquePacketIndex = indexes(HireExternalVerdict as unknown as Model<never>).find(
      ([spec]) => spec.workspaceId === 1 && spec.packetId === 1,
    )
    expect(uniquePacketIndex?.[1].unique).toBe(true)
  })

  it('keeps all operational indexes workspace-leading and packet expiry/revocation explicit', () => {
    for (const model of [HireSharePacket, HireExternalVerdict]) {
      for (const [spec] of indexes(model as unknown as Model<never>)) {
        expect(spec.workspaceId).toBe(1)
      }
    }
    expect(HireSharePacket.schema.path('active')).toBeDefined()
    expect(HireSharePacket.schema.path('expiresAt')).toBeDefined()
    expect(HireSharePacket.schema.path('revokedAt')).toBeDefined()
    expect(HireSharePacket.schema.path('verdictSubmittedAt')).toBeDefined()
    expect(indexes(HireSharePacket as unknown as Model<never>).some(
      ([spec]) => spec.workspaceId === 1 && spec.candidateId === 1,
    )).toBe(true)
    expect(indexes(HireExternalVerdict as unknown as Model<never>).some(
      ([spec]) => spec.workspaceId === 1 && spec.candidateId === 1,
    )).toBe(true)
  })
})
