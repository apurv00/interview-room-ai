import { describe, expect, it } from 'vitest'
import type {
  HireAssessmentProjection,
  HireEvidenceRef,
} from '../models/HireInterviewResult'
import { canonicalHireResultJson, __evidence } from '../services/evidenceService'
import { addCalendarMonths } from '../services/mediaLifecycleService'

const ATTEMPT_ID = '444444444444444444444444'

function projection(overrides: Partial<HireAssessmentProjection> = {}): HireAssessmentProjection {
  return {
    overallScore: 82,
    overallEvidenceIds: ['answer-1'],
    recommendation: 'advance',
    dimensions: [
      { key: 'specificity', label: 'Specificity', score: 80, evidenceIds: ['answer-1'] },
    ],
    findings: [{ kind: 'strength', text: 'Uses concrete evidence', evidenceIds: ['answer-1'] }],
    questions: [
      {
        questionId: 'q-1',
        index: 0,
        prompt: 'Tell me about a launch.',
        answer: 'I led the launch.',
        score: 80,
        evidenceIds: ['answer-1'],
        questionStartedMs: 1_000,
        answerStartedMs: 2_000,
        answerEndedMs: 12_000,
      },
    ],
    ...overrides,
  }
}

const transcriptEvidence: HireEvidenceRef[] = [
  {
    id: 'answer-1',
    type: 'transcript_span',
    attemptId: ATTEMPT_ID,
    questionId: 'q-1',
    transcriptStart: 0,
    transcriptEnd: 17,
    transcriptExcerpt: 'Candidate: I reduced latency by 42% and measured the result.',
    startMs: 2_000,
    endMs: 12_000,
  },
]

describe('calendar-six-month retention', () => {
  it.each([
    ['2026-01-31T10:30:00.000Z', '2026-07-31T10:30:00.000Z'],
    ['2024-08-31T00:00:00.000Z', '2025-02-28T00:00:00.000Z'],
    ['2024-02-29T12:00:00.000Z', '2024-08-29T12:00:00.000Z'],
  ])('adds six calendar months to %s', (source, expected) => {
    expect(addCalendarMonths(new Date(source), 6).toISOString()).toBe(expected)
  })
})

describe('evidence-linked result contract', () => {
  it('canonicalizes unchanged engine JSON independent of object key order', () => {
    expect(canonicalHireResultJson({ b: 2, a: { d: 4, c: 3 } })).toBe(
      canonicalHireResultJson({ a: { c: 3, d: 4 }, b: 2 }),
    )
    expect(__evidence.rawDigest({ b: 2, a: 1 })).toBe(
      __evidence.rawDigest({ a: 1, b: 2 }),
    )
  })

  it('accepts exact transcript evidence for every displayed score and claim', async () => {
    await expect(
      __evidence.validateEvidence({
        workspaceId: '111111111111111111111111',
        applicationId: '222222222222222222222222',
        jobId: '333333333333333333333333',
        candidateId: '555555555555555555555555',
        roundId: '666666666666666666666666',
        attemptId: ATTEMPT_ID,
        adapterVersion: 'adapter-v1',
        engineContractVersion: 'engine-v1',
        rawEngineOutput: { overallScore: 82 },
        projection: projection(),
        evidenceIndex: transcriptEvidence,
        completedAt: new Date(),
        durationMs: 60_000,
      }),
    ).resolves.toBeUndefined()
  })

  it('rejects an uncited displayed score and out-of-range recording time', async () => {
    await expect(
      __evidence.validateEvidence({
        workspaceId: '111111111111111111111111',
        applicationId: '222222222222222222222222',
        jobId: '333333333333333333333333',
        candidateId: '555555555555555555555555',
        roundId: '666666666666666666666666',
        attemptId: ATTEMPT_ID,
        adapterVersion: 'adapter-v1',
        engineContractVersion: 'engine-v1',
        rawEngineOutput: {},
        projection: projection({ overallEvidenceIds: [] }),
        evidenceIndex: transcriptEvidence,
        completedAt: new Date(),
        durationMs: 60_000,
      }),
    ).rejects.toMatchObject({ code: 'EVIDENCE_INVALID' })

    await expect(
      __evidence.validateEvidence({
        workspaceId: '111111111111111111111111',
        applicationId: '222222222222222222222222',
        jobId: '333333333333333333333333',
        candidateId: '555555555555555555555555',
        roundId: '666666666666666666666666',
        attemptId: ATTEMPT_ID,
        adapterVersion: 'adapter-v1',
        engineContractVersion: 'engine-v1',
        rawEngineOutput: {},
        projection: projection(),
        evidenceIndex: [{ ...transcriptEvidence[0], endMs: 61_000 }],
        completedAt: new Date(),
        durationMs: 60_000,
      }),
    ).rejects.toMatchObject({ code: 'EVIDENCE_INVALID' })
  })
})
