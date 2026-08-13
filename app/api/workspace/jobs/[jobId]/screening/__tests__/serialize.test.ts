import mongoose from 'mongoose'
import { describe, expect, it } from 'vitest'
import { serializeScreeningGate } from '../_lib/serialize'

const WORKSPACE_ID = new mongoose.Types.ObjectId('111111111111111111111111')
const JOB_ID = new mongoose.Types.ObjectId('222222222222222222222222')
const GATE_ID = new mongoose.Types.ObjectId('333333333333333333333333')
const VERSION_ID = new mongoose.Types.ObjectId('444444444444444444444444')
const MEMBER_ID = new mongoose.Types.ObjectId('555555555555555555555555')
const REDACTED_APPLICATION_ID = new mongoose.Types.ObjectId('666666666666666666666666')
const REDACTED_CANDIDATE_ID = new mongoose.Types.ObjectId('777777777777777777777777')

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
})
