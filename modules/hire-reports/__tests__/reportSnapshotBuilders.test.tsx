import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HireJobCloseoutReport } from '../components/HireJobCloseoutReport'
import { HirePipelineStatusReport } from '../components/HirePipelineStatusReport'
import {
  buildHireJobCloseoutReportSnapshot,
  buildHirePipelineStatusReportSnapshot,
  HireReportSnapshotValidationError,
} from '../services/reportSnapshotBuilders'
import {
  HIRE_REPORT_AGING_BUCKETS,
  HIRE_REPORT_BLOCKER_KINDS,
  HIRE_REPORT_PIPELINE_STAGES,
} from '../types'

function tally(overrides: Partial<Record<'strong_yes' | 'yes' | 'no' | 'strong_no', number>> = {}) {
  return { strong_yes: 0, yes: 0, no: 0, strong_no: 0, ...overrides }
}

function evidence() {
  return {
    aiAssessments: { completedCount: 3, rawEngineOutput: 'must not survive' },
    humanScorecards: {
      member: { submittedCount: 2, recommendations: tally({ yes: 2 }), overallScore: 4.5 },
      kit: { submittedCount: 1, recommendations: tally({ strong_yes: 1 }), reviewerNotes: 'must not survive' },
    },
    externalVerdicts: { submittedCount: 1, recommendations: tally({ no: 1 }), rawComment: 'must not survive' },
    compositeScore: 86,
  }
}

function pipelineInput(overrides: Record<string, unknown> = {}) {
  return {
    scope: 'workspace',
    asOf: new Date('2026-08-14T10:00:00.000Z'),
    jobs: [{
      jobTitle: '<Platform Engineer>',
      jobStatus: 'open',
      openedAt: new Date('2026-08-01T10:00:00.000Z'),
      stageCounts: HIRE_REPORT_PIPELINE_STAGES.map((stage, index) => ({ stage, count: index })),
      aging: HIRE_REPORT_AGING_BUCKETS.map((bucket, index) => ({ bucket, count: index + 1 })),
      blockers: HIRE_REPORT_BLOCKER_KINDS.map((kind, index) => ({ kind, count: index })),
      evidence: evidence(),
      candidateEmail: 'ada@example.test',
      internalRank: 1,
      candidates: [{ name: 'must not survive' }],
    }],
    workspaceName: 'must not survive',
    ...overrides,
  }
}

function closeoutInput(overrides: Record<string, unknown> = {}) {
  return {
    asOf: new Date('2026-08-15T10:00:00.000Z'),
    jobTitle: 'Platform Engineer',
    openedAt: new Date('2026-08-01T10:00:00.000Z'),
    closedAt: new Date('2026-08-15T10:00:00.000Z'),
    stageCounts: HIRE_REPORT_PIPELINE_STAGES.map((stage, index) => ({ stage, count: index })),
    evidence: evidence(),
    hiredCandidates: [{
      candidateId: '111111111111111111111111',
      candidateName: '<Ada & Co>',
      hiredAt: new Date('2026-08-14T10:00:00.000Z'),
      email: 'ada@example.test',
      internalRank: 1,
    }],
    decisionNote: 'The panel agreed after reviewing the independent evidence.',
    resumeText: 'must not survive',
    ...overrides,
  }
}

function properties(value: unknown): string[] {
  if (!value || typeof value !== 'object') return []
  if (value instanceof Date) return []
  if (Array.isArray(value)) return value.flatMap(properties)
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [key, ...properties(child)])
}

describe('Phase-5 report snapshot builders', () => {
  it('deep-allowlists an aggregate pipeline report and keeps evidence sources separate', () => {
    const built = buildHirePipelineStatusReportSnapshot(pipelineInput())
    expect(built.affectedCandidateIds).toEqual([])
    expect(built.snapshot).toMatchObject({
      version: 1,
      kind: 'pipeline_status',
      scope: 'workspace',
      jobs: [{
        jobTitle: '<Platform Engineer>',
        evidence: {
          aiAssessments: { completedCount: 3 },
          humanScorecards: {
            member: { submittedCount: 2, recommendations: tally({ yes: 2 }) },
            kit: { submittedCount: 1, recommendations: tally({ strong_yes: 1 }) },
          },
          externalVerdicts: { submittedCount: 1, recommendations: tally({ no: 1 }) },
        },
      }],
    })
    expect(properties(built.snapshot)).not.toEqual(expect.arrayContaining([
      'candidateEmail',
      'internalRank',
      'compositeScore',
      'rawEngineOutput',
      'reviewerNotes',
      'rawComment',
      'candidates',
    ]))
    expect(built.snapshot.jobs[0].stageCounts.map((entry) => entry.stage)).toEqual(HIRE_REPORT_PIPELINE_STAGES)
    expect(built.snapshot.jobs[0].aging.map((entry) => entry.bucket)).toEqual(HIRE_REPORT_AGING_BUCKETS)
    expect(built.snapshot.jobs[0].blockers.map((entry) => entry.kind)).toEqual(HIRE_REPORT_BLOCKER_KINDS)
  })

  it('copies nested values and dates rather than retaining mutable source references', () => {
    const input = pipelineInput()
    const built = buildHirePipelineStatusReportSnapshot(input)
    ;(input.jobs[0].stageCounts[0] as { count: number }).count = 99
    ;(input.jobs[0].openedAt as Date).setUTCFullYear(2040)
    ;(input.jobs[0].evidence.humanScorecards.member.recommendations as { yes: number }).yes = 0

    expect(built.snapshot.jobs[0].stageCounts[0].count).toBe(0)
    expect(built.snapshot.jobs[0].openedAt.toISOString()).toBe('2026-08-01T10:00:00.000Z')
    expect(built.snapshot.jobs[0].evidence.humanScorecards.member.recommendations.yes).toBe(2)
  })

  it('rejects partial/malformed aggregates rather than inventing values', () => {
    expect(() => buildHirePipelineStatusReportSnapshot(pipelineInput({
      jobs: [{
        ...pipelineInput().jobs[0],
        stageCounts: [{ stage: 'new', count: 1 }],
      }],
    }))).toThrow(HireReportSnapshotValidationError)
    expect(() => buildHirePipelineStatusReportSnapshot(pipelineInput({
      jobs: [{
        ...pipelineInput().jobs[0],
        evidence: {
          ...evidence(),
          humanScorecards: {
            ...evidence().humanScorecards,
            member: { submittedCount: 3, recommendations: tally({ yes: 2 }) },
          },
        },
      }],
    }))).toThrow('submittedCount must equal')
    expect(() => buildHirePipelineStatusReportSnapshot(pipelineInput({
      scope: 'job',
      jobs: [pipelineInput().jobs[0], pipelineInput().jobs[0]],
    }))).toThrow('exactly one job')
  })

  it('derives closeout duration, isolates hired candidate IDs, and blocks invalid lifecycle facts', () => {
    const built = buildHireJobCloseoutReportSnapshot(closeoutInput())
    expect(built.snapshot.timeToCloseHours).toBe(336)
    expect(built.affectedCandidateIds).toEqual(['111111111111111111111111'])
    expect(properties(built.snapshot)).not.toEqual(expect.arrayContaining([
      'candidateId',
      'email',
      'internalRank',
      'resumeText',
      'compositeScore',
    ]))
    expect(built.snapshot.hiredCandidates).toEqual([{
      candidateName: '<Ada & Co>',
      hiredAt: new Date('2026-08-14T10:00:00.000Z'),
    }])

    expect(() => buildHireJobCloseoutReportSnapshot(closeoutInput({
      closedAt: new Date('2026-07-31T10:00:00.000Z'),
    }))).toThrow('cannot precede')
    expect(() => buildHireJobCloseoutReportSnapshot(closeoutInput({
      hiredCandidates: [{
        candidateId: '111111111111111111111111',
        candidateName: 'Ada',
        hiredAt: new Date('2026-08-14T10:00:00.000Z'),
      }, {
        candidateId: '111111111111111111111111',
        candidateName: 'Ada again',
        hiredAt: new Date('2026-08-14T10:00:00.000Z'),
      }],
    }))).toThrow('must be unique')
  })

  it('renders only snapshot-safe content, escapes prose, and states no composite/action', () => {
    const pipeline = buildHirePipelineStatusReportSnapshot(pipelineInput()).snapshot
    const closeout = buildHireJobCloseoutReportSnapshot(closeoutInput()).snapshot
    const html = `${renderToStaticMarkup(<HirePipelineStatusReport snapshot={pipeline} />)}${renderToStaticMarkup(<HireJobCloseoutReport snapshot={closeout} />)}`

    expect(html).toContain('&lt;Platform Engineer&gt;')
    expect(html).toContain('&lt;Ada &amp; Co&gt;')
    expect(html).toContain('Evidence is displayed by source')
    expect(html).toContain('does not calculate a composite score')
    expect(html).not.toContain('ada@example.test')
    expect(html).not.toContain('internalRank')
    expect(html).not.toContain('resumeText')
  })
})
