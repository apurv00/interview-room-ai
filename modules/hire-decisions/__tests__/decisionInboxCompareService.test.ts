import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connect: vi.fn().mockResolvedValue(undefined),
  buildDecision: vi.fn(),
  applicationFind: vi.fn(),
  roundFind: vi.fn(),
  deliveryFind: vi.fn(),
  verdictFind: vi.fn(),
}))

vi.mock('@hire-decision-boundary', () => ({
  HireApplication: { find: mocks.applicationFind },
  HireHumanRound: { find: mocks.roundFind },
  HireHumanKitDelivery: { find: mocks.deliveryFind },
  HIRE_HUMAN_KIT_MAX_ATTEMPTS: 5,
}))
vi.mock('../models/HireExternalVerdict', () => ({
  HireExternalVerdict: { find: mocks.verdictFind },
}))
vi.mock('../services/hireDecisionBoundary', () => ({ connectHireDecisionDB: mocks.connect }))
vi.mock('../services/decisionAggregateService', async () => {
  const actual = await vi.importActual<typeof import('../services/decisionAggregateService')>(
    '../services/decisionAggregateService',
  )
  return { ...actual, buildHireDecisionView: mocks.buildDecision }
})

import {
  compareHireDecisionApplications,
  readHireDecisionActionInbox,
} from '../services/decisionInboxCompareService'
import type { HireDecisionView } from '../types'

const IDS = {
  workspaceId: '111111111111111111111111',
  jobId: '222222222222222222222222',
  applicationA: '333333333333333333333333',
  applicationB: '444444444444444444444444',
  applicationC: '555555555555555555555555',
  candidateA: '666666666666666666666666',
  candidateB: '777777777777777777777777',
  candidateC: '888888888888888888888888',
  sourceA: '999999999999999999999999',
  sourceB: 'aaaaaaaaaaaaaaaaaaaaaaaa',
}

function query<T>(value: T) {
  return {
    sort: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(value),
  }
}

function emptySource() {
  return {
    count: 0,
    recommendations: { strong_yes: 0, yes: 0, no: 0, strong_no: 0 },
    dimensions: [
      'role_capability',
      'problem_solving',
      'communication',
      'collaboration',
    ].map((key) => ({ key, count: 0, mean: null, min: null, max: null, reviewerSpread: null })),
  }
}

function view(
  applicationId: string,
  candidateId = IDS.candidateA,
  jobId = IDS.jobId,
): HireDecisionView {
  const source = emptySource()
  return {
    coordinates: { workspaceId: IDS.workspaceId, applicationId, jobId, candidateId },
    candidateBrief: { candidateName: 'Ada Lovelace', jobTitle: 'Platform Engineer', location: 'London', experienceYears: 6 },
    aiAssessments: [{
      completedAt: new Date('2026-08-14T10:00:00.000Z'),
      overallScore: 90,
      recommendation: 'advance',
      confidence: 'high',
      dimensions: [{ key: 'communication', score: 90 }],
    }],
    humanScorecards: { total: source, member: emptySource(), kit: emptySource() },
    externalVerdicts: { count: 0, recommendations: { strong_yes: 0, yes: 0, no: 0, strong_no: 0 } },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.roundFind.mockReturnValue(query([]))
  mocks.deliveryFind.mockReturnValue(query([]))
  mocks.verdictFind.mockReturnValue(query([]))
  mocks.applicationFind.mockResolvedValue([])
  mocks.buildDecision.mockImplementation(({ applicationId }: { applicationId: string }) =>
    Promise.resolve(view(applicationId)),
  )
})

describe('Phase-4 decision action inbox', () => {
  it('derives pending scorecard, terminal delivery, and new external-verdict actions with safe DTOs only', async () => {
    const openedAt = new Date('2026-08-14T09:00:00.000Z')
    const failedAt = new Date('2026-08-14T10:00:00.000Z')
    const submittedAt = new Date('2026-08-14T11:00:00.000Z')
    mocks.roundFind.mockReturnValue(query([{
      applicationId: IDS.applicationA,
      jobId: IDS.jobId,
      candidateId: IDS.candidateA,
      mode: 'guest_kit',
      openedAt,
      createdAt: openedAt,
      briefSnapshot: { sourceResumeHash: 'should-not-leak' },
      createdByName: 'Private reviewer',
    }]))
    mocks.deliveryFind.mockReturnValue(query([{
      applicationId: IDS.applicationA,
      jobId: IDS.jobId,
      candidateId: IDS.candidateA,
      purpose: 'initial',
      attempts: 5,
      updatedAt: failedAt,
      recipientEmail: 'private@example.com',
      recipientName: 'Private recipient',
      lastError: 'provider private error',
    }]))
    mocks.verdictFind.mockReturnValue(query([{
      applicationId: IDS.applicationA,
      jobId: IDS.jobId,
      candidateId: IDS.candidateA,
      recommendation: 'yes',
      submittedAt,
      comment: 'Private external comment',
      packetId: 'audit-id',
    }]))
    const unsafeView = view(IDS.applicationA) as HireDecisionView & {
      candidateBrief: HireDecisionView['candidateBrief'] & { email: string; resumeText: string }
      stage: string
      decisionNote: string
      rank: number
      audit: string[]
    }
    unsafeView.candidateBrief.email = 'ada@example.com'
    unsafeView.candidateBrief.resumeText = 'raw résumé'
    unsafeView.stage = 'offer'
    unsafeView.decisionNote = 'private decision'
    unsafeView.rank = 1
    unsafeView.audit = ['private audit']
    mocks.buildDecision.mockResolvedValue(unsafeView)

    const since = new Date('2026-08-14T08:00:00.000Z')
    const result = await readHireDecisionActionInbox({
      workspaceId: IDS.workspaceId,
      jobId: IDS.jobId,
      applicationId: IDS.applicationA,
      externalVerdictsSince: since,
      limit: 10,
    })

    expect(result.items.map((item) => item.kind)).toEqual([
      'external_verdict_submitted',
      'terminal_human_kit_delivery_failure',
      'pending_human_scorecard',
    ])
    expect(result.items[0]).toMatchObject({ recommendation: 'yes', occurredAt: submittedAt })
    expect(result.items[1]).toMatchObject({ deliveryPurpose: 'initial', attempts: 5, occurredAt: failedAt })
    expect(result.items[2]).toMatchObject({ humanRoundMode: 'guest_kit', occurredAt: openedAt })
    expect(mocks.roundFind).toHaveBeenCalledWith(expect.objectContaining({
      status: 'pending_scorecard',
      revokedAt: { $exists: false },
      workspaceId: expect.objectContaining({ toString: expect.any(Function) }),
      jobId: expect.objectContaining({ toString: expect.any(Function) }),
      applicationId: expect.objectContaining({ toString: expect.any(Function) }),
    }))
    expect(mocks.verdictFind).toHaveBeenCalledWith(expect.objectContaining({
      submittedAt: { $gt: since },
    }))
    expect(mocks.deliveryFind).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      attempts: { $gte: 5 },
      privacyRedactedAt: { $exists: false },
    }))
    expect(mocks.buildDecision).toHaveBeenCalledTimes(1)

    const encoded = JSON.stringify(result).toLowerCase()
    for (const forbidden of [
      'email',
      'resume',
      'private',
      'stage',
      'decisionnote',
      'rank',
      'audit',
      'raw',
      'media',
    ]) {
      expect(encoded).not.toContain(forbidden)
    }
    expect(result.items[0].decision).not.toHaveProperty('aiAssessments')
    expect(result.limit).toBe(10)
    expect(result.nextCursor).toBeNull()
  })

  it('rejects an invalid limit before reading any source collection', async () => {
    await expect(readHireDecisionActionInbox({ workspaceId: IDS.workspaceId, limit: 101 })).rejects.toMatchObject({
      code: 'DECISION_INVALID_SCOPE',
      status: 400,
    })
    expect(mocks.connect).not.toHaveBeenCalled()
    expect(mocks.roundFind).not.toHaveBeenCalled()
  })

  it('omits a source item if its independently scoped safe decision DTO is unavailable', async () => {
    mocks.roundFind.mockReturnValue(query([{
      applicationId: IDS.applicationA,
      jobId: IDS.jobId,
      candidateId: IDS.candidateA,
      mode: 'member_room',
      createdAt: new Date('2026-08-14T09:00:00.000Z'),
    }]))
    const { HireDecisionError } = await import('../services/decisionAggregateService')
    mocks.buildDecision.mockRejectedValue(new HireDecisionError('gone', 'DECISION_SCOPE_NOT_FOUND', 404))

    await expect(readHireDecisionActionInbox({ workspaceId: IDS.workspaceId })).resolves.toEqual({
      items: [],
      limit: 50,
      nextCursor: null,
    })
  })

  it('returns a stable keyset cursor when another safe action exists', async () => {
    const newest = new Date('2026-08-14T11:00:00.000Z')
    const older = new Date('2026-08-14T10:00:00.000Z')
    mocks.verdictFind.mockReturnValue(query([
      {
        _id: IDS.sourceA,
        applicationId: IDS.applicationA,
        jobId: IDS.jobId,
        candidateId: IDS.candidateA,
        recommendation: 'yes',
        submittedAt: newest,
      },
      {
        _id: IDS.sourceB,
        applicationId: IDS.applicationB,
        jobId: IDS.jobId,
        candidateId: IDS.candidateA,
        recommendation: 'no',
        submittedAt: older,
      },
    ]))

    const result = await readHireDecisionActionInbox({
      workspaceId: IDS.workspaceId,
      jobId: IDS.jobId,
      limit: 1,
    })

    expect(result.items).toHaveLength(1)
    expect(result.items[0].decision.coordinates.applicationId).toBe(
      IDS.applicationA,
    )
    expect(result.nextCursor).toEqual({
      occurredAt: newest,
      kind: 'external_verdict_submitted',
      applicationId: IDS.applicationA,
      sourceId: IDS.sourceA,
    })
  })

  it('hydrates only the visible page plus look-ahead instead of every source row', async () => {
    const rows = [
      [IDS.applicationA, IDS.candidateA, '2026-08-14T12:00:00.000Z'],
      [IDS.applicationB, IDS.candidateB, '2026-08-14T11:00:00.000Z'],
      [IDS.applicationC, IDS.candidateC, '2026-08-14T10:00:00.000Z'],
    ] as const
    mocks.roundFind.mockReturnValue(query(rows.map(([applicationId, candidateId, occurredAt], index) => ({
      _id: index === 0 ? IDS.sourceA : index === 1 ? IDS.sourceB : 'bbbbbbbbbbbbbbbbbbbbbbbb',
      applicationId,
      jobId: IDS.jobId,
      candidateId,
      mode: 'member_room',
      createdAt: new Date(occurredAt),
    }))))
    mocks.buildDecision.mockImplementation(({ applicationId }: { applicationId: string }) => {
      const candidateId = applicationId === IDS.applicationA
        ? IDS.candidateA
        : applicationId === IDS.applicationB
          ? IDS.candidateB
          : IDS.candidateC
      return Promise.resolve(view(applicationId, candidateId))
    })

    const result = await readHireDecisionActionInbox({
      workspaceId: IDS.workspaceId,
      jobId: IDS.jobId,
      limit: 2,
    })

    expect(result.items).toHaveLength(2)
    expect(result.nextCursor).not.toBeNull()
    expect(mocks.buildDecision).toHaveBeenCalledTimes(3)
  })

  it('backfills a context removed by privacy while keeping cursor progress truthful', async () => {
    const occurredAt = [
      new Date('2026-08-14T12:00:00.000Z'),
      new Date('2026-08-14T11:00:00.000Z'),
      new Date('2026-08-14T10:00:00.000Z'),
    ]
    mocks.roundFind.mockReturnValue(query([
      {
        _id: IDS.sourceA,
        applicationId: IDS.applicationA,
        jobId: IDS.jobId,
        candidateId: IDS.candidateA,
        mode: 'member_room',
        createdAt: occurredAt[0],
      },
      {
        _id: IDS.sourceB,
        applicationId: IDS.applicationB,
        jobId: IDS.jobId,
        candidateId: IDS.candidateB,
        mode: 'member_room',
        createdAt: occurredAt[1],
      },
      {
        _id: 'bbbbbbbbbbbbbbbbbbbbbbbb',
        applicationId: IDS.applicationC,
        jobId: IDS.jobId,
        candidateId: IDS.candidateC,
        mode: 'member_room',
        createdAt: occurredAt[2],
      },
    ]))
    const { HireDecisionError } = await import('../services/decisionAggregateService')
    mocks.buildDecision.mockImplementation(({ applicationId }: { applicationId: string }) => {
      if (applicationId === IDS.applicationA) {
        return Promise.reject(
          new HireDecisionError('gone', 'DECISION_SCOPE_NOT_FOUND', 404),
        )
      }
      return Promise.resolve(
        view(
          applicationId,
          applicationId === IDS.applicationB ? IDS.candidateB : IDS.candidateC,
        ),
      )
    })

    const result = await readHireDecisionActionInbox({
      workspaceId: IDS.workspaceId,
      jobId: IDS.jobId,
      limit: 1,
    })

    expect(result.items).toHaveLength(1)
    expect(result.items[0].decision.coordinates.applicationId).toBe(
      IDS.applicationB,
    )
    expect(result.nextCursor).toEqual({
      occurredAt: occurredAt[1],
      kind: 'pending_human_scorecard',
      applicationId: IDS.applicationB,
      sourceId: IDS.sourceB,
    })
    expect(mocks.buildDecision).toHaveBeenCalledTimes(3)
  })

  it('defensively excludes privacy-redacted delivery rows from items and pagination', async () => {
    mocks.deliveryFind.mockReturnValue(query([{
      _id: IDS.sourceA,
      applicationId: IDS.applicationA,
      jobId: IDS.jobId,
      candidateId: IDS.candidateA,
      purpose: 'initial',
      attempts: 5,
      updatedAt: new Date('2026-08-14T12:00:00.000Z'),
      privacyRedactedAt: new Date('2026-08-14T12:01:00.000Z'),
    }]))
    mocks.verdictFind.mockReturnValue(query([{
      _id: IDS.sourceB,
      applicationId: IDS.applicationB,
      jobId: IDS.jobId,
      candidateId: IDS.candidateB,
      recommendation: 'yes',
      submittedAt: new Date('2026-08-14T11:00:00.000Z'),
    }]))
    mocks.buildDecision.mockImplementation(({ applicationId }: { applicationId: string }) =>
      Promise.resolve(view(applicationId, IDS.candidateB)),
    )

    const result = await readHireDecisionActionInbox({
      workspaceId: IDS.workspaceId,
      jobId: IDS.jobId,
      limit: 1,
    })

    expect(result.items.map((item) => item.kind)).toEqual([
      'external_verdict_submitted',
    ])
    expect(result.nextCursor).toBeNull()
    expect(mocks.buildDecision).toHaveBeenCalledTimes(1)
    expect(mocks.buildDecision).toHaveBeenCalledWith({
      workspaceId: IDS.workspaceId,
      applicationId: IDS.applicationB,
    })
  })

  it('binds every source query to the same stable global keyset coordinate', async () => {
    const occurredAt = new Date('2026-08-14T10:00:00.000Z')

    await readHireDecisionActionInbox({
      workspaceId: IDS.workspaceId,
      jobId: IDS.jobId,
      limit: 10,
      cursor: {
        occurredAt,
        kind: 'pending_human_scorecard',
        applicationId: IDS.applicationA,
        sourceId: IDS.sourceA,
      },
    })

    expect(mocks.roundFind).toHaveBeenCalledWith(
      expect.objectContaining({
        $or: [
          { createdAt: { $lt: occurredAt } },
          {
            createdAt: occurredAt,
            $or: [
              {
                applicationId: {
                  $gt: expect.objectContaining({ toString: expect.any(Function) }),
                },
              },
              {
                applicationId: expect.objectContaining({
                  toString: expect.any(Function),
                }),
                _id: {
                  $gt: expect.objectContaining({ toString: expect.any(Function) }),
                },
              },
            ],
          },
        ],
      }),
    )
    expect(mocks.deliveryFind).toHaveBeenCalledWith(
      expect.objectContaining({
        $or: [
          { updatedAt: { $lt: occurredAt } },
          { updatedAt: occurredAt },
        ],
      }),
    )
    expect(mocks.verdictFind).toHaveBeenCalledWith(
      expect.objectContaining({
        $or: [{ submittedAt: { $lt: occurredAt } }],
      }),
    )
  })

  it('keeps the external-verdict watermark and keyset bound on later pages', async () => {
    const since = new Date('2026-08-14T08:00:00.000Z')
    const occurredAt = new Date('2026-08-14T10:00:00.000Z')

    await readHireDecisionActionInbox({
      workspaceId: IDS.workspaceId,
      jobId: IDS.jobId,
      externalVerdictsSince: since,
      limit: 10,
      cursor: {
        occurredAt,
        kind: 'pending_human_scorecard',
        applicationId: IDS.applicationA,
        sourceId: IDS.sourceA,
      },
    })

    expect(mocks.verdictFind).toHaveBeenCalledWith(
      expect.objectContaining({
        $and: [
          { submittedAt: { $gt: since } },
          { $or: [{ submittedAt: { $lt: occurredAt } }] },
        ],
      }),
    )
  })
})

describe('Phase-4 same-job compare', () => {
  it('requires an exact same-workspace/job selection and preserves caller order without rank sorting', async () => {
    mocks.applicationFind.mockResolvedValue([
      { _id: IDS.applicationA },
      { _id: IDS.applicationC },
    ])
    mocks.buildDecision.mockImplementation(({ applicationId }: { applicationId: string }) =>
      Promise.resolve(
        applicationId === IDS.applicationC
          ? view(applicationId, IDS.candidateC)
          : view(applicationId, IDS.candidateA),
      ),
    )

    const result = await compareHireDecisionApplications({
      workspaceId: IDS.workspaceId,
      jobId: IDS.jobId,
      applicationIds: [IDS.applicationC, IDS.applicationA],
    })

    expect(result.workspaceId).toBe(IDS.workspaceId)
    expect(result.jobId).toBe(IDS.jobId)
    expect(result.applications.map((application) => application.coordinates.applicationId)).toEqual([
      IDS.applicationC,
      IDS.applicationA,
    ])
    expect(result).not.toHaveProperty('rank')
    expect(mocks.applicationFind).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: expect.objectContaining({ toString: expect.any(Function) }),
      jobId: expect.objectContaining({ toString: expect.any(Function) }),
      _id: { $in: expect.any(Array) },
    }))
  })

  it('rejects duplicate, wrong-count, and cross-job/missing application selections', async () => {
    await expect(compareHireDecisionApplications({
      workspaceId: IDS.workspaceId,
      jobId: IDS.jobId,
      applicationIds: [IDS.applicationA, IDS.applicationA],
    })).rejects.toMatchObject({ code: 'DECISION_INVALID_SCOPE', status: 400 })
    await expect(compareHireDecisionApplications({
      workspaceId: IDS.workspaceId,
      jobId: IDS.jobId,
      applicationIds: [IDS.applicationA],
    })).rejects.toMatchObject({ code: 'DECISION_INVALID_SCOPE', status: 400 })

    mocks.applicationFind.mockResolvedValue([{ _id: IDS.applicationA }])
    await expect(compareHireDecisionApplications({
      workspaceId: IDS.workspaceId,
      jobId: IDS.jobId,
      applicationIds: [IDS.applicationA, IDS.applicationB],
    })).rejects.toMatchObject({ code: 'DECISION_SCOPE_NOT_FOUND', status: 404 })
    expect(mocks.buildDecision).not.toHaveBeenCalled()
  })
})
