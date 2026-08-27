import mongoose from 'mongoose'
import { describe, expect, it } from 'vitest'
import {
  serializeInvitationBatch,
  serializeScreeningGate,
  serializeScreeningPreview,
  sliceScreeningPreviewPage,
} from '../_lib/serialize'

const WORKSPACE_ID = new mongoose.Types.ObjectId('111111111111111111111111')
const JOB_ID = new mongoose.Types.ObjectId('222222222222222222222222')
const GATE_ID = new mongoose.Types.ObjectId('333333333333333333333333')
const VERSION_ID = new mongoose.Types.ObjectId('444444444444444444444444')
const MEMBER_ID = new mongoose.Types.ObjectId('555555555555555555555555')
const REDACTED_APPLICATION_ID = new mongoose.Types.ObjectId('666666666666666666666666')
const REDACTED_CANDIDATE_ID = new mongoose.Types.ObjectId('777777777777777777777777')
const APPLICATION_ID = new mongoose.Types.ObjectId('888888888888888888888888')
const CANDIDATE_ID = new mongoose.Types.ObjectId('999999999999999999999999')
const BATCH_ID = new mongoose.Types.ObjectId('aaaaaaaaaaaaaaaaaaaaaaaa')

describe('serializeScreeningGate privacy boundary', () => {
  it('omits a legacy partially-redacted snapshot entry instead of exposing a dangling ID', () => {
    const response = serializeScreeningGate({
      _id: GATE_ID,
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      requirementVersionId: VERSION_ID,
      requirementVersion: 1,
      requirementContentHash: 'a'.repeat(64),
      status: 'confirmed',
      selectionMode: 'top_n',
      topN: 1,
      knockoutSettings: {},
      cutLine: {
        mode: 'top_n',
        requestedTopN: 1,
        applicationId: undefined,
        rank: 1,
        score: 90,
      },
      evaluatedCount: 1,
      eligibleCount: 1,
      automaticallySelectedCount: 1,
      selectedCount: 1,
      rankedApplications: [
        {
          applicationId: undefined,
          candidateId: REDACTED_CANDIDATE_ID,
          applicationCreatedAt: new Date('2026-08-13T10:00:00.000Z'),
          rank: 1,
          score: 90,
          scoreState: 'scored',
          knockoutReasons: [],
          automaticallySelected: true,
          selected: true,
          selectionReason: 'top_n',
        },
      ],
      exceptions: [
        {
          applicationId: undefined,
          action: 'exclude',
          actorMemberId: MEMBER_ID,
          actorName: 'Ava Recruiter',
          note: `Legacy coordinate ${REDACTED_APPLICATION_ID.toString()}`,
          at: new Date('2026-08-13T10:00:00.000Z'),
        },
      ],
      confirmedByMemberId: MEMBER_ID,
      confirmedByName: 'Ava Recruiter',
      confirmedAt: new Date('2026-08-13T10:00:00.000Z'),
      createdAt: new Date('2026-08-13T10:00:00.000Z'),
      updatedAt: new Date('2026-08-13T10:00:00.000Z'),
    } as never)

    expect(response).not.toHaveProperty('rankedApplications')
    expect(response).not.toHaveProperty('exceptions')
    expect(response.exceptionCount).toBe(0)
    expect(response.cutLine.applicationId).toBeNull()
    expect(JSON.stringify(response)).not.toContain(REDACTED_CANDIDATE_ID.toString())
    expect(JSON.stringify(response)).not.toContain(REDACTED_APPLICATION_ID.toString())
  })

  it('adds identity only to a bounded preview page and keeps history aggregate-only', () => {
    const rankedEntry = {
      applicationId: APPLICATION_ID,
      candidateId: CANDIDATE_ID,
      applicationCreatedAt: new Date('2026-08-13T10:00:00.000Z'),
      rank: 1,
      score: 92,
      scoreState: 'scored',
      knockoutReasons: [],
      automaticallySelected: true,
      selected: true,
      selectionReason: 'top_n',
    }
    const gate = {
      _id: GATE_ID,
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      requirementVersionId: VERSION_ID,
      requirementVersion: 1,
      requirementContentHash: 'a'.repeat(64),
      status: 'confirmed',
      selectionMode: 'top_n',
      topN: 1,
      knockoutSettings: {},
      cutLine: { mode: 'top_n', requestedTopN: 1, applicationId: APPLICATION_ID, rank: 1, score: 92 },
      evaluatedCount: 1,
      eligibleCount: 1,
      automaticallySelectedCount: 1,
      selectedCount: 1,
      rankedApplications: [rankedEntry],
      exceptions: [],
      confirmedByMemberId: MEMBER_ID,
      confirmedByName: 'Ava Recruiter',
      confirmedAt: new Date('2026-08-13T10:00:00.000Z'),
      createdAt: new Date('2026-08-13T10:00:00.000Z'),
      updatedAt: new Date('2026-08-13T10:00:00.000Z'),
    } as never
    const batch = {
      _id: BATCH_ID,
      screeningGateId: GATE_ID,
      wave: 1,
      sendAfter: new Date('2026-08-13T11:00:00.000Z'),
      status: 'failed',
      plannedCount: 1,
      sentCount: 0,
      failedCount: 1,
      lastError: 'SMTP provider credential=do-not-expose',
      createdByName: 'Ava Recruiter',
      createdAt: new Date('2026-08-13T10:00:00.000Z'),
    } as never
    const projection = {
      candidates: [
        {
          applicationId: APPLICATION_ID.toString(),
          candidateId: CANDIDATE_ID.toString(),
          identityState: 'available' as const,
          displayName: 'Ada Lovelace',
          email: 'ada@example.com',
          applicationUrl: `/workspace/applications/${APPLICATION_ID.toString()}`,
        },
      ],
    }

    const response = serializeScreeningGate(gate, [batch])
    const previewSource = {
      workspaceId: WORKSPACE_ID.toString(),
      jobId: JOB_ID.toString(),
      rule: { mode: 'top_n', topN: 1, knockoutSettings: {} },
      generatedAt: new Date('2026-08-13T10:00:00.000Z'),
      evaluatedCount: 1,
      eligibleCount: 1,
      automaticallySelectedCount: 1,
      selectedCount: 1,
      cutLine: { mode: 'top_n', requestedTopN: 1, applicationId: APPLICATION_ID.toString(), rank: 1, score: 92 },
      rankedApplications: [{
        ...rankedEntry,
        applicationId: APPLICATION_ID.toString(),
        candidateId: CANDIDATE_ID.toString(),
      }],
      exceptions: [],
      selectedApplicationIds: [APPLICATION_ID.toString()],
    }
    const page = sliceScreeningPreviewPage(previewSource, 'selected', 0)
    const preview = serializeScreeningPreview(
      previewSource,
      { ...page, previousCursor: null, nextCursor: null },
      projection,
    )

    expect(response).not.toHaveProperty('rankedApplications')
    expect(response).not.toHaveProperty('exceptions')
    expect(response.exceptionCount).toBe(0)
    expect(response.batches[0].recipients).toEqual([])
    expect(response.batches[0].lastError).toBe('One or more invitation deliveries need attention.')
    expect(preview.page.rows[0].candidate?.displayName).toBe('Ada Lovelace')
    expect(preview.cutLine.candidate?.displayName).toBe('Ada Lovelace')
    expect(JSON.stringify(response)).not.toContain('do-not-expose')
    expect(JSON.stringify(gate)).not.toContain('Ada Lovelace')
    expect(JSON.stringify(batch)).not.toContain('Ada Lovelace')
    expect(serializeInvitationBatch(batch).recipients).toEqual([])
  })

  it('never serializes more than 50 rows from a 5,000-application preview', () => {
    const rankedApplications = Array.from({ length: 5_000 }, (_, index) => ({
      applicationId: (index + 1).toString(16).padStart(24, '0'),
      candidateId: (index + 5_001).toString(16).padStart(24, '0'),
      applicationCreatedAt: new Date(1_700_000_000_000 + index),
      rank: index + 1,
      score: 100 - (index % 101),
      scoreState: 'scored' as const,
      knockoutReasons: [],
      automaticallySelected: true,
      selected: true,
      selectionReason: 'top_n' as const,
    }))
    const source = {
      workspaceId: WORKSPACE_ID.toString(),
      jobId: JOB_ID.toString(),
      rule: { mode: 'top_n' as const, topN: 5_000, knockoutSettings: {} },
      generatedAt: new Date(),
      evaluatedCount: 5_000,
      eligibleCount: 5_000,
      automaticallySelectedCount: 5_000,
      selectedCount: 5_000,
      cutLine: { mode: 'top_n' as const, requestedTopN: 5_000 },
      rankedApplications,
      exceptions: [],
      selectedApplicationIds: rankedApplications.map((entry) => entry.applicationId),
    }
    const page = sliceScreeningPreviewPage(source, 'selected', 0)
    const response = serializeScreeningPreview(
      source,
      { ...page, previousCursor: null, nextCursor: 'opaque' },
    )

    expect(response.page.rows).toHaveLength(50)
    expect(response.page.total).toBe(5_000)
    expect(response.page.hasNext).toBe(true)
    expect(response).not.toHaveProperty('rankedApplications')
    expect(response).not.toHaveProperty('selectedApplicationIds')
  })

  it('provides direct bounded pages for score attention and known knockouts', () => {
    const rankedApplications = [
      { scoreState: 'scored' as const, knockoutReasons: [] },
      { scoreState: 'stale' as const, knockoutReasons: [] },
      { scoreState: 'unscored' as const, knockoutReasons: ['location'] },
    ].map((state, index) => ({
      applicationId: (index + 1).toString(16).padStart(24, '0'),
      candidateId: (index + 101).toString(16).padStart(24, '0'),
      applicationCreatedAt: new Date(1_700_000_000_000 + index),
      rank: index + 1,
      score: state.scoreState === 'unscored' ? null : 90 - index,
      ...state,
      automaticallySelected: false,
      selected: false,
      selectionReason: 'not_selected' as const,
    }))
    const source = {
      workspaceId: WORKSPACE_ID.toString(),
      jobId: JOB_ID.toString(),
      rule: { mode: 'top_n' as const, topN: 1, knockoutSettings: {} },
      generatedAt: new Date(),
      evaluatedCount: 3,
      eligibleCount: 2,
      automaticallySelectedCount: 1,
      selectedCount: 1,
      cutLine: { mode: 'top_n' as const, requestedTopN: 1 },
      rankedApplications,
      exceptions: [],
      selectedApplicationIds: [],
    }

    const attention = sliceScreeningPreviewPage(source, 'attention', 0)
    const knockouts = sliceScreeningPreviewPage(source, 'knockouts', 0)

    expect(attention.total).toBe(2)
    expect(attention.rows.map((row) => row.scoreState)).toEqual(['stale', 'unscored'])
    expect(knockouts.total).toBe(1)
    expect(knockouts.rows[0].knockoutReasons).toEqual(['location'])
  })
})
