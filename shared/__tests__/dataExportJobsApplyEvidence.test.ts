import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connectDB: vi.fn(),
  userFindById: vi.fn(),
  interviewSessionFind: vi.fn(),
  pathwayPlanFindOne: vi.fn(),
  servedProblemFind: vi.fn(),
  jobApplicationFind: vi.fn(),
  productEventFind: vi.fn(),
  jobsEmailSendFind: vi.fn(),
  jobPracticeEvidenceFind: vi.fn(),
  competencyFind: vi.fn(),
  weaknessFind: vi.fn(),
  summaryFind: vi.fn(),
  xpEventFind: vi.fn(),
  userBadgeFind: vi.fn(),
}))

vi.mock('@shared/db/connection', () => ({ connectDB: mocks.connectDB }))
vi.mock('@shared/logger', () => ({ logger: { warn: vi.fn() } }))
vi.mock('@shared/db/models', () => ({
  User: { findById: mocks.userFindById },
  InterviewSession: { find: mocks.interviewSessionFind },
  PathwayPlan: { findOne: mocks.pathwayPlanFindOne },
  ServedProblem: { find: mocks.servedProblemFind },
  JobApplication: { find: mocks.jobApplicationFind },
  ProductEvent: { find: mocks.productEventFind },
  JobsEmailSend: { find: mocks.jobsEmailSendFind },
  JobPracticeEvidence: { find: mocks.jobPracticeEvidenceFind },
}))
vi.mock('@shared/db/models/UserCompetencyState', () => ({
  UserCompetencyState: { find: mocks.competencyFind },
}))
vi.mock('@shared/db/models/WeaknessCluster', () => ({
  WeaknessCluster: { find: mocks.weaknessFind },
}))
vi.mock('@shared/db/models/SessionSummary', () => ({
  SessionSummary: { find: mocks.summaryFind },
}))
vi.mock('@shared/db/models/XpEvent', () => ({
  XpEvent: { find: mocks.xpEventFind },
}))
vi.mock('@shared/db/models/UserBadge', () => ({
  UserBadge: { find: mocks.userBadgeFind },
}))

import { generateDataExport } from '../services/dataExportService'

const USER_ID = '507f1f77bcf86cd799439010'
const APP_ID = '507f1f77bcf86cd799439011'
const LEGACY_APP_ID = '507f1f77bcf86cd799439012'
const OPTION_ID = `ao1_${'A'.repeat(43)}`
const REPORTED_AT = new Date('2026-07-21T09:30:00.000Z')
const LEGACY_REPORTED_AT = new Date('2026-06-01T10:00:00.000Z')

function queryResult<T>(value: T) {
  const query = {
    select: vi.fn(),
    sort: vi.fn(),
    limit: vi.fn(),
    lean: vi.fn().mockResolvedValue(value),
  }
  query.select.mockReturnValue(query)
  query.sort.mockReturnValue(query)
  query.limit.mockReturnValue(query)
  return query
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connectDB.mockResolvedValue(undefined)
  mocks.userFindById.mockReturnValue(queryResult({
    _id: { toString: () => USER_ID },
    name: 'Candidate',
    email: 'candidate@example.test',
    savedResumes: [],
    starStories: [],
  }))

  for (const find of [
    mocks.interviewSessionFind,
    mocks.servedProblemFind,
    mocks.productEventFind,
    mocks.jobsEmailSendFind,
    mocks.jobPracticeEvidenceFind,
    mocks.competencyFind,
    mocks.weaknessFind,
    mocks.summaryFind,
    mocks.xpEventFind,
    mocks.userBadgeFind,
  ]) {
    find.mockReturnValue(queryResult([]))
  }
  mocks.pathwayPlanFindOne.mockReturnValue(queryResult(null))
  mocks.jobApplicationFind.mockReturnValue(queryResult([
    {
      _id: { toString: () => APP_ID },
      jobSnapshot: { title: 'Backend Engineer', company: 'Acme' },
      status: 'apply_clicked',
      clickedApplyOptionIds: [OPTION_ID],
      brokenLinkReports: [
        {
          optionId: OPTION_ID,
          url: 'https://jobs.example.test/backend',
          tier: 'direct-ats',
          reportedAt: REPORTED_AT,
        },
        {
          url: 'https://legacy.example.test/backend',
          reportedAt: LEGACY_REPORTED_AT,
        },
      ],
    },
    {
      _id: { toString: () => LEGACY_APP_ID },
      jobSnapshot: { title: 'Legacy role', company: 'Acme' },
      status: 'saved',
    },
  ]))
})

describe('GDPR Jobs apply-evidence export', () => {
  it('preserves canonical click/report evidence and explicitly represents legacy gaps', async () => {
    const exported = await generateDataExport(USER_ID)
    const applications = exported.jobApplications as Array<Record<string, unknown>>

    expect(applications[0]).toMatchObject({
      id: APP_ID,
      clickedApplyOptionIds: [OPTION_ID],
      brokenLinkReports: [
        {
          optionId: OPTION_ID,
          url: 'https://jobs.example.test/backend',
          tier: 'direct-ats',
          reportedAt: REPORTED_AT,
        },
        {
          optionId: null,
          url: 'https://legacy.example.test/backend',
          tier: null,
          reportedAt: LEGACY_REPORTED_AT,
        },
      ],
    })
    expect(applications[1]).toMatchObject({
      id: LEGACY_APP_ID,
      clickedApplyOptionIds: [],
      brokenLinkReports: [],
    })
  })

  it('survives the JSON download round trip without dropping legacy nulls or timestamps', async () => {
    const exported = await generateDataExport(USER_ID)
    const roundTripped = JSON.parse(JSON.stringify(exported)) as {
      jobApplications: Array<{
        clickedApplyOptionIds: string[]
        brokenLinkReports: Array<Record<string, unknown>>
      }>
    }

    expect(roundTripped.jobApplications[0].clickedApplyOptionIds).toEqual([OPTION_ID])
    expect(roundTripped.jobApplications[0].brokenLinkReports).toEqual([
      {
        optionId: OPTION_ID,
        url: 'https://jobs.example.test/backend',
        tier: 'direct-ats',
        reportedAt: REPORTED_AT.toISOString(),
      },
      {
        optionId: null,
        url: 'https://legacy.example.test/backend',
        tier: null,
        reportedAt: LEGACY_REPORTED_AT.toISOString(),
      },
    ])
  })
})
