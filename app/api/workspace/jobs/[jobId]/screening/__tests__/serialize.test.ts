import mongoose from 'mongoose'
import { describe, expect, it } from 'vitest'
import {
  serializeInvitationBatch,
  serializeScreeningGate,
  serializeScreeningPreview,
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

    expect(response.rankedApplications).toEqual([])
    expect(response.exceptions).toEqual([])
    expect(response.cutLine.applicationId).toBeNull()
    expect(JSON.stringify(response)).not.toContain(REDACTED_CANDIDATE_ID.toString())
    expect(JSON.stringify(response)).not.toContain(REDACTED_APPLICATION_ID.toString())
  })

  it('adds current identity while keeping history batches aggregate-only and snapshots immutable', () => {
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

    const response = serializeScreeningGate(gate, [batch], projection)
    const preview = serializeScreeningPreview({
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
    }, projection)

    expect(response.rankedApplications[0].candidate).toMatchObject({
      displayName: 'Ada Lovelace',
      email: 'ada@example.com',
      applicationUrl: `/workspace/applications/${APPLICATION_ID.toString()}`,
    })
    expect(response.cutLine.candidate?.displayName).toBe('Ada Lovelace')
    expect(response.batches[0].recipients).toEqual([])
    expect(response.batches[0].lastError).toBe('One or more invitation deliveries need attention.')
    expect(preview.rankedApplications[0].candidate?.displayName).toBe('Ada Lovelace')
    expect(JSON.stringify(response)).not.toContain('do-not-expose')
    expect(JSON.stringify(gate)).not.toContain('Ada Lovelace')
    expect(JSON.stringify(batch)).not.toContain('Ada Lovelace')
    expect(serializeInvitationBatch(batch).recipients).toEqual([])
  })
})
