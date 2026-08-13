import mongoose, { type Model } from 'mongoose'
import { describe, expect, it } from 'vitest'
import { HireInvitationBatch } from '../models/HireInvitationBatch'
import { HireInvitationBatchItem } from '../models/HireInvitationBatchItem'
import {
  HIRE_SCREENING_GATE_SNAPSHOT_CAP,
  HireScreeningGate,
} from '../models/HireScreeningGate'
import { HireJob } from '../models/HireJob'

const WORKSPACE_ID = new mongoose.Types.ObjectId('111111111111111111111111')
const JOB_ID = new mongoose.Types.ObjectId('222222222222222222222222')
const GATE_ID = new mongoose.Types.ObjectId('333333333333333333333333')
const BATCH_ID = new mongoose.Types.ObjectId('444444444444444444444444')
const APPLICATION_ID = new mongoose.Types.ObjectId('555555555555555555555555')
const CANDIDATE_ID = new mongoose.Types.ObjectId('666666666666666666666666')
const MEMBER_ID = new mongoose.Types.ObjectId('777777777777777777777777')
const REQUIREMENT_VERSION_ID = new mongoose.Types.ObjectId('888888888888888888888888')

function indexes(model: Model<never>): Array<[Record<string, number>, Record<string, unknown>]> {
  return model.schema.indexes() as Array<[Record<string, number>, Record<string, unknown>]>
}

function gateInput(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: WORKSPACE_ID,
    jobId: JOB_ID,
    requirementVersionId: REQUIREMENT_VERSION_ID,
    requirementVersion: 3,
    requirementContentHash: 'a'.repeat(64),
    selectionMode: 'top_n',
    topN: 1,
    knockoutSettings: { location: 'Bengaluru, India', experienceFloorYears: 5 },
    cutLine: {
      mode: 'top_n',
      requestedTopN: 1,
      applicationId: APPLICATION_ID,
      rank: 1,
      score: 88,
    },
    evaluatedCount: 1,
    eligibleCount: 1,
    automaticallySelectedCount: 1,
    selectedCount: 1,
    rankedApplications: [
      {
        applicationId: APPLICATION_ID,
        candidateId: CANDIDATE_ID,
        applicationCreatedAt: new Date('2026-08-12T00:00:00.000Z'),
        rank: 1,
        score: 88,
        scoreState: 'scored',
        knockoutReasons: [],
        automaticallySelected: true,
        selected: true,
        selectionReason: 'top_n',
      },
    ],
    exceptions: [],
    confirmedByMemberId: MEMBER_ID,
    confirmedByName: 'Ava Recruiter',
    confirmedAt: new Date('2026-08-12T01:00:00.000Z'),
    ...overrides,
  }
}

describe('Phase-2 screening model contracts', () => {
  it('adds only optional Hire-owned screening settings to a job', () => {
    expect(HireJob.schema.path('screeningSettings.location')).toBeDefined()
    expect(HireJob.schema.path('screeningSettings.experienceFloorYears')).toBeDefined()
    expect((HireJob.schema.path('screeningSettings.location').options as { maxlength?: number }).maxlength).toBe(160)
    const floor = HireJob.schema.path('screeningSettings.experienceFloorYears').options as {
      min?: number
      max?: number
    }
    expect(floor.min).toBe(0)
    expect(floor.max).toBe(50)
    expect(HireJob.schema.path('screeningSettings.userId')).toBeUndefined()
  })

  it('persists a bounded, attributed gate snapshot and enforces mode fields', () => {
    expect(new HireScreeningGate(gateInput()).validateSync()).toBeUndefined()
    expect(new HireScreeningGate(gateInput({ requirementVersionId: undefined })).validateSync()?.errors.requirementVersionId).toBeDefined()
    expect(new HireScreeningGate(gateInput({ requirementContentHash: 'not-a-hash' })).validateSync()?.errors.requirementContentHash).toBeDefined()

    const missingTopN = new HireScreeningGate(gateInput({ topN: undefined })).validateSync()
    expect(missingTopN?.errors.topN).toBeDefined()

    const thresholdGate = new HireScreeningGate(
      gateInput({
        selectionMode: 'above_threshold',
        topN: undefined,
        scoreThreshold: 80,
        cutLine: { mode: 'above_threshold', scoreThreshold: 80, score: 80 },
      }),
    )
    expect(thresholdGate.validateSync()).toBeUndefined()
    const missingThreshold = new HireScreeningGate(
      gateInput({
        selectionMode: 'above_threshold',
        topN: undefined,
        scoreThreshold: undefined,
        cutLine: { mode: 'above_threshold', scoreThreshold: 80 },
      }),
    ).validateSync()
    expect(missingThreshold?.errors.scoreThreshold).toBeDefined()

    const snapshotTooLarge = new HireScreeningGate(
      gateInput({
        rankedApplications: Array.from({ length: HIRE_SCREENING_GATE_SNAPSHOT_CAP + 1 }, () =>
          gateInput().rankedApplications[0],
        ),
      }),
    ).validateSync()
    expect(snapshotTooLarge?.errors.rankedApplications).toBeDefined()
  })

  it('has no B2C actor pointer and uses workspace-leading indexes across all screening records', () => {
    for (const model of [HireScreeningGate, HireInvitationBatch, HireInvitationBatchItem]) {
      const workspacePath = model.schema.path('workspaceId')
      expect(workspacePath.isRequired).toBe(true)
      expect((workspacePath.options as { immutable?: boolean }).immutable).toBe(true)
      for (const [spec] of indexes(model as unknown as Model<never>)) {
        expect(spec.workspaceId).toBe(1)
      }
      expect(model.schema.path('userId')).toBeUndefined()
      expect(model.schema.path('actorUserId')).toBeUndefined()
    }
    expect(HireScreeningGate.schema.path('confirmedByMemberId')).toBeDefined()
    expect(HireScreeningGate.schema.path('exceptions.actorMemberId')).toBeDefined()
    expect(HireScreeningGate.schema.path('exceptions.note')).toBeDefined()

    const batchIndex = indexes(HireInvitationBatch as unknown as Model<never>).find(
      ([spec]) => spec.workspaceId === 1 && spec.screeningGateId === 1 && spec.wave === 1,
    )
    expect(batchIndex?.[1].unique).toBe(true)
    const itemIndex = indexes(HireInvitationBatchItem as unknown as Model<never>).find(
      ([spec]) => spec.workspaceId === 1 && spec.applicationId === 1,
    )
    expect(itemIndex?.[1].unique).toBe(true)
    expect(itemIndex?.[1].partialFilterExpression).toEqual({
      applicationId: { $exists: true },
    })
  })

  it('models staggered batches and selected application items without recipient PII', () => {
    const batch = new HireInvitationBatch({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      screeningGateId: GATE_ID,
      wave: 2,
      sendAfter: new Date('2026-08-13T09:00:00.000Z'),
      plannedCount: 1,
      createdByMemberId: MEMBER_ID,
      createdByName: 'Ava Recruiter',
    })
    expect(batch.validateSync()).toBeUndefined()

    const item = new HireInvitationBatchItem({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      screeningGateId: GATE_ID,
      invitationBatchId: BATCH_ID,
      applicationId: APPLICATION_ID,
      candidateId: CANDIDATE_ID,
      rank: 1,
      score: 88,
      scoreState: 'scored',
      selectionReason: 'top_n',
      sendAfter: new Date('2026-08-13T09:00:00.000Z'),
    })
    expect(item.validateSync()).toBeUndefined()
    expect(HireInvitationBatchItem.schema.path('recipientEmail')).toBeUndefined()
    expect(HireInvitationBatchItem.schema.path('recipientName')).toBeUndefined()
  })

  it('allows a privacy-redacted item to remove immutable recipient coordinates', () => {
    const redacted = new HireInvitationBatchItem({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      screeningGateId: GATE_ID,
      invitationBatchId: BATCH_ID,
      privacyRedactedAt: new Date('2026-08-13T10:00:00.000Z'),
      score: 88,
      scoreState: 'scored',
      selectionReason: 'top_n',
      sendAfter: new Date('2026-08-13T09:00:00.000Z'),
      status: 'cancelled',
    })
    expect(redacted.validateSync()).toBeUndefined()

    const unredacted = new HireInvitationBatchItem({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      screeningGateId: GATE_ID,
      invitationBatchId: BATCH_ID,
      score: 88,
      scoreState: 'scored',
      selectionReason: 'top_n',
      sendAfter: new Date('2026-08-13T09:00:00.000Z'),
      status: 'cancelled',
    }).validateSync()
    expect(unredacted?.errors.applicationId).toBeDefined()
    expect(unredacted?.errors.candidateId).toBeDefined()
  })
})
