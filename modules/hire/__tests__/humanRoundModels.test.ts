import mongoose, { type Model } from 'mongoose'
import { describe, expect, it } from 'vitest'
import {
  HIRE_HUMAN_SCORECARD_DIMENSIONS,
  HireHumanKitDelivery,
  HireHumanRound,
  HireHumanScorecard,
  HireInterviewKit,
} from '../models'

const WORKSPACE_ID = new mongoose.Types.ObjectId('111111111111111111111111')
const APPLICATION_ID = new mongoose.Types.ObjectId('222222222222222222222222')
const JOB_ID = new mongoose.Types.ObjectId('333333333333333333333333')
const CANDIDATE_ID = new mongoose.Types.ObjectId('444444444444444444444444')
const ROUND_ID = new mongoose.Types.ObjectId('555555555555555555555555')
const KIT_ID = new mongoose.Types.ObjectId('666666666666666666666666')
const MEMBER_ID = new mongoose.Types.ObjectId('777777777777777777777777')

const COORDINATES = {
  workspaceId: WORKSPACE_ID,
  applicationId: APPLICATION_ID,
  jobId: JOB_ID,
  candidateId: CANDIDATE_ID,
}

const DIMENSIONS = HIRE_HUMAN_SCORECARD_DIMENSIONS.map((key) => ({
  key,
  rating: 4,
  evidence: `Observed ${key.replaceAll('_', ' ')} during the interview.`,
}))

function indexes(model: Model<never>): Array<[Record<string, number>, Record<string, unknown>]> {
  return model.schema.indexes() as Array<[Record<string, number>, Record<string, unknown>]>
}

function memberDraft(overrides: Record<string, unknown> = {}) {
  return {
    ...COORDINATES,
    humanRoundId: ROUND_ID,
    reviewerKind: 'member',
    reviewerKey: `member:${MEMBER_ID.toString()}`,
    memberId: MEMBER_ID,
    reviewerName: 'Ava Recruiter',
    status: 'draft',
    ...overrides,
  }
}

describe('Phase-3 human round model contracts', () => {
  it('keeps all durable human records workspace-scoped with immutable application coordinates', () => {
    const models = [HireHumanRound, HireInterviewKit, HireHumanScorecard, HireHumanKitDelivery]
    for (const model of models) {
      for (const key of ['workspaceId', 'applicationId', 'jobId', 'candidateId']) {
        const path = model.schema.path(key)
        expect(path).toBeDefined()
        expect(path.isRequired).toBe(true)
        expect((path.options as { immutable?: boolean }).immutable).toBe(true)
      }
      expect(model.schema.path('userId')).toBeUndefined()
      expect(model.schema.path('actorUserId')).toBeUndefined()
      expect(model.schema.path('createdBy')).toBeUndefined()
    }

    expect((HireHumanRound.schema.path('creationOperationId').options as { immutable?: boolean }).immutable).toBe(true)
    expect((HireInterviewKit.schema.path('humanRoundId').options as { immutable?: boolean }).immutable).toBe(true)
    expect((HireHumanScorecard.schema.path('humanRoundId').options as { immutable?: boolean }).immutable).toBe(true)
    expect((HireHumanKitDelivery.schema.path('kitId').options as { immutable?: boolean }).immutable).toBe(true)
  })

  it('stores an expiring, revocable interview-kit hash rather than a raw capability', () => {
    expect(HireInterviewKit.schema.path('secretHash')).toBeDefined()
    expect(HireInterviewKit.schema.path('rawSecret')).toBeUndefined()
    expect(HireInterviewKit.schema.path('token')).toBeUndefined()
    expect(HireInterviewKit.schema.path('expiresAt')).toBeDefined()
    expect(HireInterviewKit.schema.path('revokedAt')).toBeDefined()
    expect(HireInterviewKit.schema.path('active')).toBeDefined()

    const activeIndex = indexes(HireInterviewKit as unknown as Model<never>).find(
      ([spec]) => spec.workspaceId === 1 && spec.humanRoundId === 1 && spec.active === 1,
    )
    expect(activeIndex?.[1].unique).toBe(true)
    expect(activeIndex?.[1].partialFilterExpression).toEqual({ active: true })
  })

  it('requires exactly one canonical reviewer coordinate for every scorecard', () => {
    expect(new HireHumanScorecard(memberDraft()).validateSync()).toBeUndefined()

    const kitDraft = new HireHumanScorecard(
      memberDraft({
        reviewerKind: 'kit',
        reviewerKey: `kit:${KIT_ID.toString()}`,
        kitId: KIT_ID,
        memberId: undefined,
        reviewerName: 'Morgan Hiring Manager',
      }),
    )
    expect(kitDraft.validateSync()).toBeUndefined()

    const bothCoordinates = new HireHumanScorecard(memberDraft({ kitId: KIT_ID })).validateSync()
    expect(bothCoordinates?.errors.reviewerKind).toBeDefined()

    const missingKit = new HireHumanScorecard(
      memberDraft({
        reviewerKind: 'kit',
        reviewerKey: `kit:${KIT_ID.toString()}`,
        memberId: undefined,
      }),
    ).validateSync()
    expect(missingKit?.errors.reviewerKind).toBeDefined()

    const forgedKey = new HireHumanScorecard(memberDraft({ reviewerKey: 'member:forged' })).validateSync()
    expect(forgedKey?.errors.reviewerKind).toBeDefined()
  })

  it('requires a complete fixed scorecard only on submission and keeps draft answers mutable', () => {
    const submitted = new HireHumanScorecard(
      memberDraft({
        status: 'submitted',
        dimensions: DIMENSIONS,
        recommendation: 'yes',
        overallComment: 'Clear evidence of strong delivery and collaboration.',
        submittedAt: new Date('2026-08-13T12:00:00.000Z'),
      }),
    )
    expect(submitted.validateSync()).toBeUndefined()

    const incompleteSubmitted = new HireHumanScorecard(
      memberDraft({ status: 'submitted' }),
    ).validateSync()
    expect(incompleteSubmitted?.errors.status).toBeDefined()

    const draftWithSubmittedValues = new HireHumanScorecard(
      memberDraft({
        dimensions: DIMENSIONS,
        recommendation: 'yes',
        overallComment: 'This must be submitted, not retained as a draft.',
      }),
    ).validateSync()
    expect(draftWithSubmittedValues?.errors.status).toBeDefined()

    const outOfOrder = new HireHumanScorecard(
      memberDraft({
        status: 'submitted',
        dimensions: [...DIMENSIONS].reverse(),
        recommendation: 'yes',
        overallComment: 'Wrong canonical order.',
        submittedAt: new Date(),
      }),
    ).validateSync()
    expect(outOfOrder?.errors.dimensions).toBeDefined()

    const dimensionSchema = (HireHumanScorecard.schema.path('dimensions') as unknown as {
      schema: mongoose.Schema
    }).schema
    expect((dimensionSchema.path('rating').options as { immutable?: boolean }).immutable).toBeUndefined()
    expect((dimensionSchema.path('evidence').options as { immutable?: boolean }).immutable).toBeUndefined()
  })

  it('has workspace-leading operational indexes and a bounded initial/reminder recovery envelope', () => {
    for (const model of [HireHumanRound, HireInterviewKit, HireHumanScorecard, HireHumanKitDelivery]) {
      for (const [spec, options] of indexes(model as unknown as Model<never>)) {
        if (options.expireAfterSeconds === 0) continue
        expect(spec.workspaceId).toBe(1)
      }
    }

    const scorecardIndex = indexes(HireHumanScorecard as unknown as Model<never>).find(
      ([spec]) => spec.workspaceId === 1 && spec.humanRoundId === 1 && spec.reviewerKey === 1,
    )
    expect(scorecardIndex?.[1].unique).toBe(true)

    const deliveryIndex = indexes(HireHumanKitDelivery as unknown as Model<never>).find(
      ([spec]) => spec.workspaceId === 1 && spec.kitId === 1 && spec.purpose === 1,
    )
    expect(deliveryIndex?.[1].unique).toBe(true)
    expect(HireHumanKitDelivery.schema.path('ciphertext')).toBeDefined()
    expect(HireHumanKitDelivery.schema.path('iv')).toBeDefined()
    expect(HireHumanKitDelivery.schema.path('authTag')).toBeDefined()
    expect(HireHumanKitDelivery.schema.path('rawSecret')).toBeUndefined()
    expect(HireHumanKitDelivery.schema.path('reminderCount')).toBeUndefined()

    const ttl = indexes(HireHumanKitDelivery as unknown as Model<never>).find(
      ([spec]) => spec.expiresAt === 1,
    )
    expect(ttl?.[1].expireAfterSeconds).toBe(0)

    // Candidate-scale inbox indexes are rollout-preparer owned. Existing
    // model initialization must not build them before preflight succeeds.
    expect(indexes(HireHumanRound as unknown as Model<never>)).not.toEqual(
      expect.arrayContaining([
        [
          {
            workspaceId: 1,
            jobId: 1,
            status: 1,
            createdAt: -1,
            applicationId: 1,
            _id: 1,
          },
          expect.any(Object),
        ],
      ]),
    )
    expect(indexes(HireHumanKitDelivery as unknown as Model<never>)).not.toEqual(
      expect.arrayContaining([
        [
          {
            workspaceId: 1,
            jobId: 1,
            status: 1,
            updatedAt: -1,
            applicationId: 1,
            _id: 1,
            attempts: 1,
          },
          expect.any(Object),
        ],
      ]),
    )
  })

  it('retains explicit privacy-redaction hooks without adding B2C identity fields', () => {
    for (const model of [HireHumanRound, HireInterviewKit, HireHumanScorecard]) {
      expect(model.schema.path('privacyRedactedAt')).toBeDefined()
      expect(model.schema.path('guestUserId')).toBeUndefined()
      expect(model.schema.path('runtimeSessionId')).toBeUndefined()
    }
  })
})
