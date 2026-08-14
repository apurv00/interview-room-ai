import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connect: vi.fn().mockResolvedValue(undefined),
  applicationFindOne: vi.fn(),
  candidateFindOne: vi.fn(),
  jobFindOne: vi.fn(),
  scorecardFind: vi.fn(),
  verdictFind: vi.fn(),
  resultFind: vi.fn(),
}))

vi.mock('@hire-decision-boundary', () => ({
  HireApplication: { findOne: mocks.applicationFindOne },
  HireCandidate: { findOne: mocks.candidateFindOne },
  HireJob: { findOne: mocks.jobFindOne },
  HireHumanScorecard: { find: mocks.scorecardFind },
  HireInterviewResult: { find: mocks.resultFind },
}))
vi.mock('../models/HireExternalVerdict', () => ({
  HireExternalVerdict: { find: mocks.verdictFind },
}))
vi.mock('../services/hireDecisionBoundary', () => ({ connectHireDecisionDB: mocks.connect }))

import {
  aggregateExternalVerdicts,
  aggregateSubmittedHumanScorecards,
  buildHireDecisionView,
  buildSharePacketSnapshot,
} from '../services/decisionAggregateService'
import type { HireDecisionView } from '../types'

const IDS = {
  workspaceId: '111111111111111111111111',
  applicationId: '222222222222222222222222',
  jobId: '333333333333333333333333',
  candidateId: '444444444444444444444444',
}

const DIMENSIONS = [
  { key: 'role_capability', rating: 4 },
  { key: 'problem_solving', rating: 3 },
  { key: 'communication', rating: 5 },
  { key: 'collaboration', rating: 4 },
]

function decisionView(overrides: Partial<HireDecisionView> = {}): HireDecisionView {
  return {
    coordinates: IDS,
    candidateBrief: { candidateName: 'Ada Lovelace', jobTitle: 'Platform Engineer', location: 'London', experienceYears: 6 },
    aiAssessments: [
      {
        completedAt: new Date('2026-08-14T10:00:00.000Z'),
        overallScore: 82,
        recommendation: 'advance',
        confidence: 'high',
        dimensions: [{ key: 'communication', label: 'Communication', score: 85 }],
      },
    ],
    humanScorecards: aggregateSubmittedHumanScorecards([]),
    externalVerdicts: aggregateExternalVerdicts([]),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.applicationFindOne.mockResolvedValue({
    _id: IDS.applicationId,
    jobId: IDS.jobId,
    candidateId: IDS.candidateId,
  })
  mocks.candidateFindOne.mockResolvedValue({
    name: 'Ada Lovelace',
    screeningProfile: { location: 'London', experienceYears: 6 },
  })
  mocks.jobFindOne.mockResolvedValue({ title: 'Platform Engineer' })
  mocks.scorecardFind.mockResolvedValue([])
  mocks.verdictFind.mockResolvedValue([])
  mocks.resultFind.mockReturnValue({
    sort: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
  })
})

describe('Phase-4 decision aggregate', () => {
  it('uses submitted human scorecards only and keeps member/kit distributions separate', () => {
    const aggregate = aggregateSubmittedHumanScorecards([
      { status: 'submitted', reviewerKind: 'member', recommendation: 'yes', dimensions: DIMENSIONS },
      {
        status: 'submitted',
        reviewerKind: 'member',
        recommendation: 'no',
        dimensions: DIMENSIONS.map((dimension) => ({ ...dimension, rating: 2 })),
      },
      {
        status: 'submitted',
        reviewerKind: 'kit',
        recommendation: 'strong_yes',
        dimensions: DIMENSIONS.map((dimension) => ({ ...dimension, rating: 5 })),
      },
      {
        status: 'draft',
        reviewerKind: 'kit',
        recommendation: 'strong_no',
        dimensions: DIMENSIONS.map((dimension) => ({ ...dimension, rating: 1 })),
      },
    ])

    expect(aggregate.member.count).toBe(2)
    expect(aggregate.member.recommendations).toMatchObject({ yes: 1, no: 1 })
    expect(aggregate.kit.count).toBe(1)
    expect(aggregate.kit.recommendations.strong_yes).toBe(1)
    expect(aggregate.total.count).toBe(3)
    expect(aggregate.total.dimensions.find((dimension) => dimension.key === 'role_capability')).toEqual({
      key: 'role_capability',
      count: 3,
      mean: 11 / 3,
      min: 2,
      max: 5,
      reviewerSpread: 3,
    })
    expect(aggregate).not.toHaveProperty('compositeScore')
    expect(aggregate).not.toHaveProperty('recommendedStage')
  })

  it('tallies external verdicts independently and never treats them as human scorecards', () => {
    const external = aggregateExternalVerdicts([
      { recommendation: 'yes' },
      { recommendation: 'strong_no' },
      { recommendation: 'forged' },
    ])
    expect(external).toEqual({
      count: 3,
      recommendations: { strong_yes: 0, yes: 1, no: 0, strong_no: 1 },
    })
  })

  it('deep-picks only section-gated safe packet fields', () => {
    const decision = decisionView({
      humanScorecards: aggregateSubmittedHumanScorecards([
        { status: 'submitted', reviewerKind: 'member', recommendation: 'yes', dimensions: DIMENSIONS },
      ]),
    }) as HireDecisionView & {
      candidateBrief: HireDecisionView['candidateBrief'] & { email: string; resumeText: string }
      aiAssessments: Array<HireDecisionView['aiAssessments'][number] & { rawEngineOutput: string; mediaAssetId: string }>
      stage: string
      decisionNote: string
      closeNote: string
      rank: number
      auditEvents: string[]
    }
    decision.candidateBrief.email = 'ada@example.com'
    decision.candidateBrief.resumeText = 'raw résumé'
    decision.aiAssessments[0].rawEngineOutput = 'full raw engine payload'
    decision.aiAssessments[0].mediaAssetId = 'media-id'
    decision.stage = 'offer'
    decision.decisionNote = 'internal note'
    decision.closeNote = 'internal close note'
    decision.rank = 1
    decision.auditEvents = ['private audit event']

    const snapshot = buildSharePacketSnapshot(decision, ['candidate_brief', 'ai_assessments', 'human_scorecards'])
    expect(snapshot).toEqual(expect.objectContaining({ version: 1 }))
    expect(snapshot.candidateBrief).toEqual({
      candidateName: 'Ada Lovelace',
      jobTitle: 'Platform Engineer',
      location: 'London',
      experienceYears: 6,
    })
    expect(snapshot.aiAssessments?.[0]).toEqual({
      completedAt: new Date('2026-08-14T10:00:00.000Z'),
      overallScore: 82,
      recommendation: 'advance',
      confidence: 'high',
      dimensions: [{ key: 'communication', label: 'Communication', score: 85 }],
    })
    const encoded = JSON.stringify(snapshot).toLowerCase()
    for (const forbidden of [
      'email',
      'resume',
      'rawengine',
      'media',
      'stage',
      'decisionnote',
      'closenote',
      'rank',
      'audit',
    ]) {
      expect(encoded).not.toContain(forbidden)
    }

    const briefOnly = buildSharePacketSnapshot(decision, ['candidate_brief'])
    expect(briefOnly.aiAssessments).toBeUndefined()
    expect(briefOnly.humanScorecards).toBeUndefined()
    expect(() => buildSharePacketSnapshot(decision, ['candidate_brief', 'candidate_brief'])).toThrow(
      'Share-packet sections must be non-empty, unique, and supported',
    )
  })

  it('reads a safe decision DTO without exposing raw model fields or changing state', async () => {
    mocks.scorecardFind.mockResolvedValue([
      { status: 'submitted', reviewerKind: 'member', recommendation: 'yes', dimensions: DIMENSIONS, overallComment: 'Private detail' },
    ])
    mocks.verdictFind.mockResolvedValue([{ recommendation: 'no', comment: 'Private external detail' }])
    mocks.resultFind.mockReturnValue({
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([
        {
          completedAt: new Date('2026-08-14T11:00:00.000Z'),
          numericSummary: { overallScore: 88, dimensions: [{ key: 'communication', score: 90 }] },
          projection: {
            recommendation: 'advance',
            confidence: 'high',
            dimensions: [{ key: 'communication', label: 'Communication', score: 90 }],
            questions: [{ answer: 'must not leak' }],
          },
          rawEngineOutput: { private: true },
          evidenceIndex: [{ mediaAssetId: 'media-id' }],
        },
      ]),
    })

    const result = await buildHireDecisionView({ workspaceId: IDS.workspaceId, applicationId: IDS.applicationId })
    expect(mocks.connect).toHaveBeenCalledTimes(1)
    expect(result).toEqual({
      coordinates: IDS,
      candidateBrief: { candidateName: 'Ada Lovelace', jobTitle: 'Platform Engineer', location: 'London', experienceYears: 6 },
      aiAssessments: [
        {
          completedAt: new Date('2026-08-14T11:00:00.000Z'),
          overallScore: 88,
          recommendation: 'advance',
          confidence: 'high',
          dimensions: [{ key: 'communication', label: 'Communication', score: 90 }],
        },
      ],
      humanScorecards: expect.objectContaining({ total: expect.objectContaining({ count: 1 }) }),
      externalVerdicts: { count: 1, recommendations: { strong_yes: 0, yes: 0, no: 1, strong_no: 0 } },
    })
    const encoded = JSON.stringify(result).toLowerCase()
    expect(encoded).not.toContain('private detail')
    expect(encoded).not.toContain('rawengine')
    expect(encoded).not.toContain('media')
    expect(encoded).not.toContain('answer')
  })
})
