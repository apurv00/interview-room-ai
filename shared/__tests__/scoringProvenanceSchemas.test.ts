import mongoose from 'mongoose'
import { describe, expect, it } from 'vitest'
import { InterviewSession } from '@shared/db/models/InterviewSession'
import { JobApplication } from '@shared/db/models/JobApplication'
import { JobPracticeEvidence } from '@shared/db/models/JobPracticeEvidence'
import {
  modelConfigSnapshotOf,
  primaryModelExecutionProvenanceOf,
  type ModelExecutionProvenance,
} from '@shared/services/scoringProvenance'
import type { TaskSlot } from '@shared/services/taskSlots'

const objectId = () => new mongoose.Types.ObjectId()

function execution(
  taskSlot: TaskSlot,
  contractVersion: string,
  model: string,
): ModelExecutionProvenance {
  return primaryModelExecutionProvenanceOf({
    snapshot: modelConfigSnapshotOf(taskSlot, {
      model,
      provider: 'openai',
      maxTokens: 500,
      useToonInput: false,
    }),
    contractVersion,
  })
}

const withoutAttemptKind = (value: ModelExecutionProvenance): Record<string, unknown> => {
  const copy = { ...value } as Record<string, unknown>
  delete copy.attemptKind
  return copy
}

function errorPaths(error: mongoose.Error.ValidationError | undefined): string[] {
  return error ? Object.keys(error.errors) : []
}

function interviewWith(executionValue: Record<string, unknown> | ModelExecutionProvenance) {
  return new InterviewSession({
    userId: objectId(),
    config: { role: 'backend', experience: '3-6', duration: 20 },
    answerScoringReceipts: [{
      schemaVersion: 1,
      bindingHash: 'b'.repeat(64),
      execution: executionValue,
      recordedAt: new Date(),
    }],
  })
}

function evidenceWith(executionValue: Record<string, unknown> | ModelExecutionProvenance) {
  return new JobPracticeEvidence({
    userId: objectId(),
    applicationId: objectId(),
    jobPostingId: objectId(),
    sessionId: objectId(),
    handoffVersion: 1,
    handoffJdHash: 'j'.repeat(64),
    requirementId: 'req-1',
    xrayHash: 'x'.repeat(64),
    strength: 'strong',
    answerScore: 80,
    scoringEpoch: 's'.repeat(64),
    provenance: {
      schemaVersion: 1,
      status: 'attested',
      scoring: executionValue,
      attribution: execution(
        'jobs.evidence-attribution',
        'evidence-attribution.v1',
        'attribution-model',
      ),
    },
    at: new Date(),
  })
}

function applicationWith(executionValue: Record<string, unknown> | ModelExecutionProvenance) {
  return new JobApplication({
    userId: objectId(),
    jobPostingId: objectId(),
    jobSnapshot: { title: 'Engineer', company: 'Example' },
    outcome: { askCount: 0 },
    readiness: {
      handoffVersion: 1,
      band: 'building',
      sessions: 1,
      practicedCount: 1,
      mustHaveTotal: 2,
      quality: 80,
      strongCoverage: 0.5,
      xrayHash: 'x'.repeat(64),
      scoringEpoch: 'e'.repeat(64),
      provenance: {
        schemaVersion: 1,
        scoring: [executionValue],
        attribution: [execution(
          'jobs.evidence-attribution',
          'evidence-attribution.v1',
          'attribution-model',
        )],
      },
      at: new Date(),
    },
  })
}

describe('scoring provenance Mongoose schemas', () => {
  it.each([
    ['receipt', interviewWith],
    ['evidence', evidenceWith],
    ['readiness', applicationWith],
  ])('accepts the CMS model-name limit and rejects one character beyond it for %s', (_label, build) => {
    const atLimit = execution('interview.evaluate-answer', 'answer-evaluation.v1', 'm'.repeat(200))
    const overLimit = execution('interview.evaluate-answer', 'answer-evaluation.v1', 'm'.repeat(201))

    expect(build(atLimit).validateSync()).toBeUndefined()
    expect(errorPaths(build(overLimit).validateSync()).some((path) => path.endsWith('.model'))).toBe(true)
  })

  it.each([
    ['receipt', interviewWith],
    ['evidence', evidenceWith],
    ['readiness', applicationWith],
  ])('requires exact attemptKind on %s provenance', (_label, build) => {
    const valid = execution('interview.evaluate-answer', 'answer-evaluation.v1', 'scoring-model')
    const paths = errorPaths(build(withoutAttemptKind(valid)).validateSync())

    expect(paths.some((path) => path.endsWith('.attemptKind'))).toBe(true)
  })
})
