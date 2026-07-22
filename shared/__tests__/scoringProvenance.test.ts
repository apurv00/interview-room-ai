import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connectDB: vi.fn(),
  resolveModelWithAuthority: vi.fn(),
  updateOne: vi.fn(),
  exists: vi.fn(),
}))

vi.mock('@shared/db/connection', () => ({ connectDB: mocks.connectDB }))
vi.mock('@shared/db/models', () => ({
  InterviewSession: { updateOne: mocks.updateOne, exists: mocks.exists },
}))
vi.mock('@shared/services/modelRouter', () => ({
  resolveModelWithAuthority: mocks.resolveModelWithAuthority,
}))

import {
  ANSWER_EVALUATION_CONTRACT_VERSION,
  answerScoringBindingHash,
  captureModelConfigSnapshot,
  isAnswerScoringReceipt,
  isCanonicalJobsPracticeSession,
  isModelExecutionProvenance,
  modelConfigSnapshotOf,
  modelExecutionProvenanceOf,
  primaryModelExecutionProvenanceOf,
  recordJobsAnswerScoringReceipt,
} from '../services/scoringProvenance'
import type { ResolvedModel } from '../services/modelRouter'
import { TASK_SLOT_DEFAULTS } from '../services/taskSlots'

const RESOLVED: ResolvedModel = {
  model: 'primary-model',
  provider: 'openai',
  maxTokens: 500,
  temperature: 0.2,
  reasoningEffort: 'low',
  fallbackModel: 'fallback-model',
  fallbackProvider: 'anthropic',
  useToonInput: false,
}

const EVALUATION = {
  questionIndex: 2,
  question: 'Describe a production incident.',
  answer: 'I isolated the failing queue and restored processing.',
  relevance: 80,
  structure: 75,
  specificity: 85,
  ownership: 90,
  status: 'ok',
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connectDB.mockResolvedValue(undefined)
  mocks.resolveModelWithAuthority.mockResolvedValue({
    resolved: { ...RESOLVED },
    source: 'L3-Mongo',
    authoritative: true,
  })
  mocks.updateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.exists.mockResolvedValue({ _id: 'session-1' })
})

describe('scoring execution provenance', () => {
  it('fingerprints the full resolved route, actual attempt, request controls, and contract', () => {
    const snapshot = modelConfigSnapshotOf('interview.evaluate-answer', RESOLVED)
    const base = primaryModelExecutionProvenanceOf({
      snapshot,
      contractVersion: ANSWER_EVALUATION_CONTRACT_VERSION,
    })
    const retry = primaryModelExecutionProvenanceOf({
      snapshot,
      contractVersion: ANSWER_EVALUATION_CONTRACT_VERSION,
      overrides: { maxTokens: 800 },
    })
    const fallback = modelExecutionProvenanceOf({
      snapshot,
      result: {
        model: 'fallback-model',
        provider: 'anthropic',
        usedFallback: true,
        attemptKind: 'configured-fallback',
      },
      contractVersion: ANSWER_EVALUATION_CONTRACT_VERSION,
    })

    expect(isModelExecutionProvenance(base)).toBe(true)
    expect(isModelExecutionProvenance(retry)).toBe(true)
    expect(isModelExecutionProvenance(fallback)).toBe(true)
    expect(base.attemptKind).toBe('primary')
    expect(fallback.attemptKind).toBe('configured-fallback')
    expect(new Set([base.fingerprint, retry.fingerprint, fallback.fingerprint]).size).toBe(3)
    expect(isModelExecutionProvenance({ ...base, provider: 'tampered-provider' })).toBe(false)
    expect(isModelExecutionProvenance({ ...base, attemptKind: undefined })).toBe(false)
    expect(isModelExecutionProvenance({ ...base, attemptKind: 'task-default' })).toBe(false)
  })

  it('requires an explicit attempt kind when configured fallback equals the task default', () => {
    const defaults = TASK_SLOT_DEFAULTS['interview.evaluate-answer']
    const snapshot = modelConfigSnapshotOf('interview.evaluate-answer', {
      ...RESOLVED,
      fallbackModel: defaults.model,
      fallbackProvider: defaults.provider,
    })
    const ambiguous = {
      model: defaults.model,
      provider: defaults.provider,
      usedFallback: true,
    }

    expect(() => modelExecutionProvenanceOf({
      snapshot,
      result: ambiguous,
      contractVersion: ANSWER_EVALUATION_CONTRACT_VERSION,
    })).toThrow('unambiguous')
    expect(() => modelExecutionProvenanceOf({
      snapshot,
      result: { ...ambiguous, attemptKind: 'configured-fallback' },
      contractVersion: ANSWER_EVALUATION_CONTRACT_VERSION,
    })).not.toThrow()
  })

  it('preserves the authority source returned by the exact router snapshot', async () => {
    const snapshot = await captureModelConfigSnapshot(
      'interview.evaluate-answer',
      { waitForAuthoritative: true },
    )

    expect(mocks.resolveModelWithAuthority).toHaveBeenCalledWith(
      'interview.evaluate-answer',
      { waitForAuthoritative: true },
    )
    expect(snapshot).toMatchObject({ source: 'L3-Mongo', authoritative: true, resolved: RESOLVED })
  })

  it('binds only the exact evaluation fields consumed by Jobs attribution', () => {
    const base = answerScoringBindingHash(EVALUATION)
    expect(answerScoringBindingHash({ ...EVALUATION, answerSummary: 'not consumed' })).toBe(base)
    expect(answerScoringBindingHash({ ...EVALUATION, ownership: 89 })).not.toBe(base)
    expect(answerScoringBindingHash({ ...EVALUATION, answer: `${EVALUATION.answer} changed` })).not.toBe(base)
  })

  it('persists a safe hash-only receipt when the scorer config stayed stable', async () => {
    const before = modelConfigSnapshotOf('interview.evaluate-answer', RESOLVED)
    await expect(recordJobsAnswerScoringReceipt({
      sessionId: 'session-1',
      userId: 'user-1',
      evaluation: EVALUATION,
      before,
      result: {
        model: RESOLVED.model,
        provider: RESOLVED.provider,
        usedFallback: false,
        attemptKind: 'primary',
      },
      contractVersion: ANSWER_EVALUATION_CONTRACT_VERSION,
      now: new Date('2026-07-22T00:00:00.000Z'),
    })).resolves.toBe(true)

    const update = mocks.updateOne.mock.calls[0]
    expect(update[0]).toEqual({
      _id: 'session-1',
      userId: 'user-1',
      'attribution.source': 'jobs',
      'attribution.handoffVersion': 1,
    })
    const receipt = update[1].$push.answerScoringReceipts.$each[0]
    expect(isAnswerScoringReceipt(receipt)).toBe(true)
    expect(receipt).not.toHaveProperty('question')
    expect(receipt).not.toHaveProperty('answer')
    expect(update[1].$push.answerScoringReceipts.$slice).toBe(-200)
    expect(mocks.resolveModelWithAuthority).not.toHaveBeenCalled()
  })

  it('refuses non-authoritative snapshots and mismatched pinned results before touching Mongo', async () => {
    const nonAuthoritative = modelConfigSnapshotOf(
      'interview.evaluate-answer',
      RESOLVED,
      { source: 'cold-defaults-synthetic', authoritative: false },
    )

    await expect(recordJobsAnswerScoringReceipt({
      sessionId: 'session-1',
      userId: 'user-1',
      evaluation: EVALUATION,
      before: nonAuthoritative,
      result: {
        model: RESOLVED.model,
        provider: RESOLVED.provider,
        usedFallback: false,
        attemptKind: 'primary',
      },
      contractVersion: ANSWER_EVALUATION_CONTRACT_VERSION,
    })).resolves.toBe(false)

    const authoritative = modelConfigSnapshotOf('interview.evaluate-answer', RESOLVED)
    await expect(recordJobsAnswerScoringReceipt({
      sessionId: 'session-1',
      userId: 'user-1',
      evaluation: EVALUATION,
      before: authoritative,
      result: {
        model: 'different-model',
        provider: RESOLVED.provider,
        usedFallback: false,
        attemptKind: 'primary',
      },
      contractVersion: ANSWER_EVALUATION_CONTRACT_VERSION,
    })).resolves.toBe(false)

    expect(mocks.connectDB).not.toHaveBeenCalled()
    expect(mocks.updateOne).not.toHaveBeenCalled()
    expect(mocks.resolveModelWithAuthority).not.toHaveBeenCalled()
  })

  it('checks canonical Jobs session authority with the exact user and handoff version', async () => {
    await expect(isCanonicalJobsPracticeSession('session-1', 'user-1')).resolves.toBe(true)

    expect(mocks.connectDB).toHaveBeenCalledOnce()
    expect(mocks.exists).toHaveBeenCalledWith({
      _id: 'session-1',
      userId: 'user-1',
      'attribution.source': 'jobs',
      'attribution.handoffVersion': 1,
    })
  })
})
