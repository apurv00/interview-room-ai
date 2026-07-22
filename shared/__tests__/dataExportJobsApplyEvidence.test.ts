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
import {
  modelConfigSnapshotOf,
  primaryModelExecutionProvenanceOf,
} from '../services/scoringProvenance'
import type { ResolvedModel } from '../services/modelRouter'

const USER_ID = '507f1f77bcf86cd799439010'
const APP_ID = '507f1f77bcf86cd799439011'
const LEGACY_APP_ID = '507f1f77bcf86cd799439012'
const PREFERENCE_APP_ID = '507f1f77bcf86cd799439013'
const OPTION_ID = `ao2_${'A'.repeat(43)}`
const SUBJECT = `ls1_${'B'.repeat(43)}`
const GENERATION = `lg1_${'C'.repeat(43)}`
const OPENED_AT = new Date('2026-07-21T09:00:00.000Z')
const REPORTED_AT = new Date('2026-07-21T09:30:00.000Z')
const LEGACY_REPORTED_AT = new Date('2026-06-01T10:00:00.000Z')
const EXACT_INTERVIEW_DATE = new Date('2026-08-04T00:00:00.000Z')
const LEGACY_SYNTHETIC_WEEK_DATE = new Date('2026-08-12T09:30:00.000Z')
const QUARANTINED_AT = new Date('2026-07-22T10:00:00.000Z')
const RECORDED_AT = new Date('2026-07-22T09:00:00.000Z')
const RESOLVED: ResolvedModel = {
  model: 'gpt-5.6-luna',
  provider: 'openai',
  maxTokens: 500,
  reasoningEffort: 'low',
  useToonInput: false,
}
const SCORING_EXECUTION = primaryModelExecutionProvenanceOf({
  snapshot: modelConfigSnapshotOf('interview.evaluate-answer', RESOLVED),
  contractVersion: 'answer-evaluation.v1',
})
const ATTRIBUTION_EXECUTION = primaryModelExecutionProvenanceOf({
  snapshot: modelConfigSnapshotOf('jobs.evidence-attribution', { ...RESOLVED, maxTokens: 1400 }),
  contractVersion: 'evidence-attribution.v1',
})

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
      interviewDate: EXACT_INTERVIEW_DATE,
      interviewDateConfidence: 'exact',
      clickedApplyOptionIds: [OPTION_ID],
      applyOpenAttempts: [{
        optionId: OPTION_ID,
        subject: SUBJECT,
        generation: GENERATION,
        incidentVersion: 2,
        openedAt: OPENED_AT,
      }],
      brokenLinkReports: [
        {
          optionId: OPTION_ID,
          url: 'https://jobs.example.test/backend',
          tier: 'direct-ats',
          reportedAt: REPORTED_AT,
          subject: SUBJECT,
          generation: GENERATION,
          incidentVersion: 2,
          disposition: 'pending-verification',
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
      // Old week captures stored a made-up event date and had no separate
      // preference field. The export must retain the confidence while
      // refusing to present this timestamp as an exact interview date.
      interviewDate: LEGACY_SYNTHETIC_WEEK_DATE,
      interviewDateConfidence: 'week',
    },
    {
      _id: { toString: () => PREFERENCE_APP_ID },
      jobSnapshot: { title: 'Preferred window role', company: 'Acme' },
      status: 'interview_scheduled',
      interviewDateConfidence: 'week',
      interviewDatePreference: 'next-week',
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
      applyOpenAttempts: [{
        optionId: OPTION_ID,
        subject: SUBJECT,
        generation: GENERATION,
        incidentVersion: 2,
        openedAt: OPENED_AT,
      }],
      brokenLinkReports: [
        {
          optionId: OPTION_ID,
          url: 'https://jobs.example.test/backend',
          tier: 'direct-ats',
          reportedAt: REPORTED_AT,
          subject: SUBJECT,
          generation: GENERATION,
          incidentVersion: 2,
          disposition: 'pending-verification',
        },
        {
          optionId: null,
          url: 'https://legacy.example.test/backend',
          tier: null,
          reportedAt: LEGACY_REPORTED_AT,
          subject: null,
          generation: null,
          incidentVersion: null,
          disposition: null,
        },
      ],
    })
    expect(applications[1]).toMatchObject({
      id: LEGACY_APP_ID,
      clickedApplyOptionIds: [],
      applyOpenAttempts: [],
      brokenLinkReports: [],
    })
  })

  it('survives the JSON download round trip without dropping legacy nulls or timestamps', async () => {
    const exported = await generateDataExport(USER_ID)
    const roundTripped = JSON.parse(JSON.stringify(exported)) as {
      jobApplications: Array<{
        id: string
        interviewDate?: string
        interviewDateConfidence: 'exact' | 'week' | 'unknown' | null
        interviewDatePreference: 'this-week' | 'next-week' | 'unknown' | null
        clickedApplyOptionIds: string[]
        applyOpenAttempts: Array<Record<string, unknown>>
        brokenLinkReports: Array<Record<string, unknown>>
      }>
    }

    expect(roundTripped.jobApplications[0].clickedApplyOptionIds).toEqual([OPTION_ID])
    expect(roundTripped.jobApplications[0].applyOpenAttempts).toEqual([{
      optionId: OPTION_ID,
      subject: SUBJECT,
      generation: GENERATION,
      incidentVersion: 2,
      openedAt: OPENED_AT.toISOString(),
    }])
    expect(roundTripped.jobApplications[0].brokenLinkReports).toEqual([
      {
        optionId: OPTION_ID,
        url: 'https://jobs.example.test/backend',
        tier: 'direct-ats',
        reportedAt: REPORTED_AT.toISOString(),
        subject: SUBJECT,
        generation: GENERATION,
        incidentVersion: 2,
        disposition: 'pending-verification',
      },
      {
        optionId: null,
        url: 'https://legacy.example.test/backend',
        tier: null,
        reportedAt: LEGACY_REPORTED_AT.toISOString(),
        subject: null,
        generation: null,
        incidentVersion: null,
        disposition: null,
      },
    ])
  })

  it('exports only exact interview dates and preserves range-preference semantics', async () => {
    const exported = await generateDataExport(USER_ID)
    const applications = exported.jobApplications as Array<Record<string, unknown>>
    const exact = applications.find((application) => application.id === APP_ID)!
    const legacyWeek = applications.find((application) => application.id === LEGACY_APP_ID)!
    const preferredWeek = applications.find((application) => application.id === PREFERENCE_APP_ID)!

    expect(exact).toMatchObject({
      interviewDate: EXACT_INTERVIEW_DATE,
      interviewDateConfidence: 'exact',
      interviewDatePreference: null,
    })
    expect(legacyWeek).toMatchObject({
      legacyInterviewDateAnchor: LEGACY_SYNTHETIC_WEEK_DATE,
      interviewDateConfidence: 'week',
      interviewDatePreference: null,
    })
    expect(legacyWeek).not.toHaveProperty('interviewDate')
    expect(preferredWeek).toMatchObject({
      interviewDateConfidence: 'week',
      interviewDatePreference: 'next-week',
    })
    expect(preferredWeek).not.toHaveProperty('interviewDate')

    const roundTripped = JSON.parse(JSON.stringify(exported)) as {
      jobApplications: Array<Record<string, unknown>>
    }
    const legacyDownload = roundTripped.jobApplications.find(
      (application) => application.id === LEGACY_APP_ID,
    )!
    expect(legacyDownload).not.toHaveProperty('interviewDate')
    expect(legacyDownload).toMatchObject({
      legacyInterviewDateAnchor: LEGACY_SYNTHETIC_WEEK_DATE.toISOString(),
      interviewDateConfidence: 'week',
      interviewDatePreference: null,
    })
  })

  it('exports scorer receipts, exact evidence provenance, quarantine state, and readiness provenance', async () => {
    mocks.interviewSessionFind.mockReturnValue(queryResult([{
      _id: { toString: () => 'session-1' },
      config: { role: 'backend' },
      status: 'completed',
      answerScoringReceipts: [{
        schemaVersion: 1,
        bindingHash: 'b'.repeat(64),
        execution: { ...SCORING_EXECUTION, internalPrompt: 'must-not-export' },
        recordedAt: RECORDED_AT,
        rawModelText: 'must-not-export',
      }],
    }]))
    mocks.jobPracticeEvidenceFind.mockReturnValue(queryResult([
      {
        _id: 'evidence-1',
        requirementId: 'req-node',
        xrayHash: 'x'.repeat(64),
        handoffVersion: 1,
        handoffJdHash: 'j'.repeat(64),
        strength: 'strong',
        answerScore: 82,
        scoringEpoch: SCORING_EXECUTION.fingerprint,
        provenance: {
          schemaVersion: 1,
          status: 'attested',
          scoring: { ...SCORING_EXECUTION, internalPrompt: 'must-not-export' },
          attribution: ATTRIBUTION_EXECUTION,
          rawModelText: 'must-not-export',
        },
        at: RECORDED_AT,
        sessionId: 'session-1',
        jobPostingId: 'job-1',
      },
      {
        _id: 'evidence-legacy',
        requirementId: 'req-payments',
        xrayHash: 'y'.repeat(64),
        strength: 'partial',
        answerScore: 61,
        scoringEpoch: 'historical-model-name',
        provenance: {
          schemaVersion: 1,
          status: 'legacy-unverifiable',
          quarantineReason: 'pre-provenance-contract',
          quarantinedAt: QUARANTINED_AT,
        },
        at: RECORDED_AT,
        sessionId: 'session-old',
        jobPostingId: 'job-1',
      },
      {
        _id: 'evidence-invalid-attestation',
        requirementId: 'req-invalid',
        xrayHash: 'z'.repeat(64),
        strength: 'strong',
        answerScore: 99,
        scoringEpoch: '0'.repeat(64),
        provenance: {
          schemaVersion: 1,
          status: 'attested',
          scoring: SCORING_EXECUTION,
          attribution: ATTRIBUTION_EXECUTION,
        },
        at: RECORDED_AT,
        sessionId: 'session-invalid',
        jobPostingId: 'job-1',
      },
    ]))
    const readiness = {
      handoffVersion: 1,
      band: 'building',
      sessions: 1,
      practicedCount: 1,
      mustHaveTotal: 3,
      quality: 82,
      strongCoverage: 0.33,
      xrayHash: 'x'.repeat(64),
      scoringEpoch: 'e'.repeat(64),
      provenance: {
        schemaVersion: 1,
        scoring: [{ ...SCORING_EXECUTION, internalPrompt: 'must-not-export' }],
        attribution: [ATTRIBUTION_EXECUTION],
      },
      at: RECORDED_AT,
      rawModelText: 'must-not-export',
    }
    const appRows = (await mocks.jobApplicationFind().lean()) as Array<Record<string, unknown>>
    mocks.jobApplicationFind.mockReturnValue(queryResult([
      { ...appRows[0], readiness },
      ...appRows.slice(1),
    ]))

    const exported = await generateDataExport(USER_ID)
    expect(exported.interviewSessions).toEqual([
      expect.objectContaining({
        id: 'session-1',
        answerScoringReceipts: [expect.objectContaining({ execution: SCORING_EXECUTION })],
      }),
    ])
    expect(exported.jobPracticeEvidence).toEqual([
      expect.objectContaining({
        scoringEpochStatus: 'attested-execution-fingerprint',
        provenance: expect.objectContaining({ status: 'attested', scoring: SCORING_EXECUTION }),
      }),
      expect.objectContaining({
        scoringEpoch: 'historical-model-name',
        scoringEpochStatus: 'legacy-unverified',
        provenance: {
          schemaVersion: 1,
          status: 'legacy-unverifiable',
          quarantineReason: 'pre-provenance-contract',
          quarantinedAt: QUARANTINED_AT,
        },
      }),
      expect.objectContaining({
        scoringEpoch: '0'.repeat(64),
        scoringEpochStatus: 'legacy-unverified',
        provenance: null,
      }),
    ])
    expect((exported.jobApplications as Array<Record<string, unknown>>)[0].readiness).toEqual({
      handoffVersion: 1,
      band: 'building',
      sessions: 1,
      practicedCount: 1,
      mustHaveTotal: 3,
      quality: 82,
      strongCoverage: 0.33,
      xrayHash: 'x'.repeat(64),
      scoringEpoch: 'e'.repeat(64),
      provenance: {
        schemaVersion: 1,
        scoring: [SCORING_EXECUTION],
        attribution: [ATTRIBUTION_EXECUTION],
      },
      at: RECORDED_AT,
    })

    const roundTrip = JSON.parse(JSON.stringify(exported)) as {
      interviewSessions: Array<Record<string, unknown>>
      jobPracticeEvidence: Array<Record<string, unknown>>
      jobApplications: Array<Record<string, unknown>>
    }
    expect(roundTrip.interviewSessions[0].answerScoringReceipts).toEqual([{
      schemaVersion: 1,
      bindingHash: 'b'.repeat(64),
      execution: SCORING_EXECUTION,
      recordedAt: RECORDED_AT.toISOString(),
    }])
    expect(roundTrip.jobPracticeEvidence[1].provenance).toEqual({
      schemaVersion: 1,
      status: 'legacy-unverifiable',
      quarantineReason: 'pre-provenance-contract',
      quarantinedAt: QUARANTINED_AT.toISOString(),
    })
    expect(roundTrip.jobApplications[0].readiness).toEqual({
      handoffVersion: 1,
      band: 'building',
      sessions: 1,
      practicedCount: 1,
      mustHaveTotal: 3,
      quality: 82,
      strongCoverage: 0.33,
      xrayHash: 'x'.repeat(64),
      scoringEpoch: 'e'.repeat(64),
      at: RECORDED_AT.toISOString(),
      provenance: {
        schemaVersion: 1,
        scoring: [SCORING_EXECUTION],
        attribution: [ATTRIBUTION_EXECUTION],
      },
    })
    expect(JSON.stringify(roundTrip)).not.toContain('must-not-export')
  })

  it('cursor-pages every interview session instead of truncating at 100', async () => {
    const firstPage = Array.from({ length: 500 }, (_, index) => ({
      _id: `session-${1000 - index}`,
      config: { role: 'backend' },
      status: 'completed',
      answerScoringReceipts: [],
    }))
    const finalPage = [{
      _id: 'session-500',
      config: { role: 'backend' },
      status: 'completed',
      answerScoringReceipts: [],
    }]
    const firstQuery = queryResult(firstPage)
    const finalQuery = queryResult(finalPage)
    mocks.interviewSessionFind
      .mockReturnValueOnce(firstQuery)
      .mockReturnValueOnce(finalQuery)

    const exported = await generateDataExport(USER_ID)

    expect(exported.interviewSessions).toHaveLength(501)
    expect(mocks.interviewSessionFind).toHaveBeenCalledTimes(2)
    expect(mocks.interviewSessionFind.mock.calls[1][0]).toMatchObject({
      _id: { $lt: 'session-501' },
    })
    expect(firstQuery.select).toHaveBeenCalledWith(
      '_id config status feedback answerScoringReceipts createdAt completedAt',
    )
  })
})
