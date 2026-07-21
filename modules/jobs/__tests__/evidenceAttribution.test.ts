import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Attribution worker (READINESS.md §1, PR-R1). Invariants under test:
 * failed/truncated evaluations excluded; JD-version binding (mismatch =
 * counted skip, never cross-version); the must-have belt drops foreign
 * ids; 'none' never stored; replace semantics per (session, hash);
 * snapshot denormalized after persist; emit fires only on recorded:true.
 * Codex #538 round 1: epoch = attribution-time slot model (live evals
 * never persist modelUsed); best-row-per-requirement collapse before
 * insert; terminal outcomes stamp evidenceProcessedAt so the sweep never
 * re-bills processed zero-evidence sessions (throw paths stay unstamped).
 */

const {
  mockSessionFindById, mockAppFindById, mockAppFindOne, mockAppUpdateOne, mockPostingFindById, mockPostingExists,
  mockPostingUpdateOne,
  mockEvidenceDeleteMany, mockEvidenceInsertMany, mockEvidenceFind, mockEvidenceExists,
  mockCompletion, mockInngestSend, mockSessionFind, mockSessionUpdateOne, mockResolveModel,
  mockSessionExists, mockEnsurePracticeApplication,
  mockIsScorablePracticeEvaluation, mockHasCompletedScoredPractice,
  mockAppExists, createdFunctionConfigs,
  mockIsJobsAccountActive, mockWithActiveJobsAccountWrite, MockJobsAccountInactiveError,
} = vi.hoisted(() => {
  class MockJobsAccountInactiveError extends Error {}
  return {
  mockSessionFindById: vi.fn(), mockAppFindById: vi.fn(), mockAppFindOne: vi.fn(), mockAppUpdateOne: vi.fn(),
  mockPostingFindById: vi.fn(), mockPostingExists: vi.fn(), mockPostingUpdateOne: vi.fn(), mockEvidenceDeleteMany: vi.fn(), mockEvidenceInsertMany: vi.fn(),
  mockEvidenceFind: vi.fn(), mockEvidenceExists: vi.fn(), mockCompletion: vi.fn(), mockInngestSend: vi.fn(),
  mockSessionFind: vi.fn(), mockSessionUpdateOne: vi.fn(), mockResolveModel: vi.fn(),
  mockSessionExists: vi.fn(), mockEnsurePracticeApplication: vi.fn(),
    mockAppExists: vi.fn(),
    createdFunctionConfigs: [] as Array<Record<string, unknown>>,
  mockIsJobsAccountActive: vi.fn(),
  mockWithActiveJobsAccountWrite: vi.fn(),
  MockJobsAccountInactiveError,
  mockHasCompletedScoredPractice: vi.fn(() => true),
  mockIsScorablePracticeEvaluation: vi.fn((value: unknown) => {
    if (!value || typeof value !== 'object') return false
    const row = value as Record<string, unknown>
    return (row.status ?? 'ok') === 'ok' && typeof row.answer === 'string' && row.answer.trim().length > 0
  }),
  }
})

vi.mock('@shared/db/connection', () => ({ connectDB: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@shared/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@shared/services/inngest', () => ({
  inngest: {
    send: mockInngestSend,
    createFunction: vi.fn((config: Record<string, unknown>) => {
      createdFunctionConfigs.push(config)
      return {}
    }),
  },
}))
vi.mock('@shared/services/modelRouter', () => ({ completion: mockCompletion, resolveModel: mockResolveModel }))
vi.mock('@shared/services/jobsAccountFence', () => ({
  isJobsAccountActive: mockIsJobsAccountActive,
  JobsAccountInactiveError: MockJobsAccountInactiveError,
  withActiveJobsAccountWrite: mockWithActiveJobsAccountWrite,
}))
vi.mock('../services/applicationService', () => ({
  ensurePracticeApplication: mockEnsurePracticeApplication,
  hasCompletedScoredPractice: mockHasCompletedScoredPractice,
  isScorablePracticeEvaluation: mockIsScorablePracticeEvaluation,
}))
vi.mock('@shared/db/models', () => ({
  InterviewSession: { findById: mockSessionFindById, find: mockSessionFind, updateOne: mockSessionUpdateOne, exists: mockSessionExists },
  JobApplication: {
    findById: mockAppFindById,
    findOne: mockAppFindOne,
    updateOne: mockAppUpdateOne,
    exists: mockAppExists,
  },
  JobPosting: { findById: mockPostingFindById, exists: mockPostingExists, updateOne: mockPostingUpdateOne },
  JobPracticeEvidence: { deleteMany: mockEvidenceDeleteMany, insertMany: mockEvidenceInsertMany, find: mockEvidenceFind, exists: mockEvidenceExists },
}))

import { runEvidenceAttributionHandler, runEvidenceReconcileHandler, buildAttributionPrompt } from '../jobs/evidenceAttributionJob'
import { xrayHashOf } from '../services/xrayService'
import { practiceHandoffHashOf } from '../services/practiceHandoff'

/** What the mocked resolveModel returns — the epoch every row must carry. */
const RESOLVED_MODEL = 'gpt-5.6-luna'

const step = { run: <T,>(_n: string, fn: () => Promise<T> | T) => Promise.resolve(fn()) }
const selectLean = (v: unknown) => ({ select: () => ({ lean: () => Promise.resolve(v) }) })
const reconcileQuery = (v: unknown) => ({
  select: () => ({
    sort: () => ({
      limit: () => ({ lean: () => Promise.resolve(v) }),
    }),
  }),
})

const JD = 'We need a backend engineer with Node.js, MongoDB, and payment-systems experience. '.repeat(3)
const HASH = xrayHashOf(JD)
const EVENT = { data: { sessionId: 'sess1', applicationId: 'app1', jobPostingId: 'job1' } }
const ATTRIBUTION = {
  source: 'jobs',
  jobId: 'job1',
  applicationId: 'app1',
  handoffVersion: 1,
  jdHash: practiceHandoffHashOf(JD),
}
const reconcileAttribution = (jobId: string, applicationId?: string) => ({
  source: 'jobs',
  jobId,
  ...(applicationId ? { applicationId } : {}),
  handoffVersion: 1,
  jdHash: ATTRIBUTION.jdHash,
})

// NOTE: no modelUsed field — live AnswerEvaluations never persist their
// judge model (evaluate-answer stamps it on trackUsage only, Codex #538 P1).
// The fixture MUST match that shape so the epoch fix stays honest.
const evaluation = (over: Record<string, unknown> = {}) => ({
  questionIndex: 0, question: 'Tell me about a payment system you built.',
  answer: 'I built UPI autopay serving 2M users with Node and Mongo.',
  relevance: 80, structure: 70, specificity: 90, ownership: 80,
  status: 'ok', ...over,
})
const parsedJD = {
  requirements: [
    { id: 'req-node', requirement: 'Node.js experience', importance: 'must-have' },
    { id: 'req-pay', requirement: 'Payment systems', importance: 'must-have' },
    { id: 'req-nice', requirement: 'GraphQL', importance: 'nice-to-have' },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
  // Live persisted shape (Codex #538 r3 P1): the JD is mirrored to the
  // TOP-LEVEL field by /api/interviews; the strict config subdoc strips
  // it. Every test therefore pins the top-level read.
  mockSessionFindById.mockReturnValue(selectLean({ jobDescription: JD, config: {}, evaluations: [evaluation()], userId: 'u1', attribution: ATTRIBUTION }))
  mockAppFindById.mockReturnValue(selectLean({ verifiedPracticeSessionIds: ['sess1', 's0', 'sx'], userId: 'u1', jobPostingId: 'job1' }))
  mockAppFindOne.mockReturnValue(selectLean({ userId: 'u1', jobPostingId: 'job1', readinessRevision: 0 }))
  mockPostingFindById.mockReturnValue(selectLean({ status: 'open', parsedJD, parsedJDHash: HASH }))
  mockPostingExists.mockResolvedValue({ _id: 'job1' })
  mockPostingUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mockCompletion.mockResolvedValue({ text: '{"attributions":[{"answerIndex":0,"requirementIds":["req-node","req-pay","req-nice","invented-id"],"strength":"strong"}]}' })
  mockEvidenceDeleteMany.mockResolvedValue({})
  mockEvidenceInsertMany.mockResolvedValue({})
  mockEvidenceFind.mockReturnValue(selectLean([
    { requirementId: 'req-node', xrayHash: HASH, strength: 'strong', answerScore: 80, scoringEpoch: RESOLVED_MODEL, sessionId: 'sess1' },
    { requirementId: 'req-pay', xrayHash: HASH, strength: 'strong', answerScore: 80, scoringEpoch: RESOLVED_MODEL, sessionId: 'sess1' },
  ]))
  mockAppUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mockSessionUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mockEvidenceExists.mockResolvedValue(null)
  mockResolveModel.mockResolvedValue({ model: RESOLVED_MODEL })
  mockSessionExists.mockResolvedValue({ _id: 'sess1' })
  mockIsJobsAccountActive.mockResolvedValue(true)
  mockWithActiveJobsAccountWrite.mockImplementation(
    async (_userId: string, work: (session: undefined) => Promise<unknown>) => work(undefined),
  )
  mockAppExists.mockResolvedValue({ _id: 'app1' })
  mockHasCompletedScoredPractice.mockReturnValue(true)
  mockEnsurePracticeApplication.mockResolvedValue({
    applicationId: 'app1', jobPostingId: 'job1', sessionId: 'sess1', evidenceCount: 1, newlyAdded: false,
  })
})

describe('runEvidenceAttributionHandler', () => {
  it('happy path: persists ONLY must-have ids (belt drops nice-to-have + invented), replace semantics, snapshot denormalized', async () => {
    const r = await runEvidenceAttributionHandler(EVENT, step)
    expect(r.outcome).toBe('attributed')
    expect(r.rows).toBe(2) // req-node + req-pay; req-nice and invented-id dropped
    expect(mockEvidenceDeleteMany).toHaveBeenCalledWith(
      { sessionId: 'sess1', xrayHash: HASH },
      { session: undefined },
    )
    const docs = mockEvidenceInsertMany.mock.calls[0][0] as Array<Record<string, unknown>>
    expect(docs.map((d) => d.requirementId).sort()).toEqual(['req-node', 'req-pay'])
    // Codex #538 P1+r2: live evaluations carry NO modelUsed — rows are
    // epoch-stamped with the RESOLVED evaluate-answer model at attribution
    // time (resolveModel honors CMS overrides; hardcoded defaults do not),
    // and the same value feeds the snapshot filter (else readiness pins
    // at zero).
    expect(mockResolveModel).toHaveBeenCalledWith('interview.evaluate-answer')
    expect(docs[0]).toMatchObject({
      handoffVersion: 1,
      handoffJdHash: ATTRIBUTION.jdHash,
      strength: 'strong',
      answerScore: 80,
      scoringEpoch: RESOLVED_MODEL,
    })
    expect(docs[0].scoringEpoch).not.toBe('unknown')
    expect(mockEvidenceFind).toHaveBeenCalledWith({
      applicationId: 'app1',
      handoffVersion: 1,
      handoffJdHash: ATTRIBUTION.jdHash,
    })
    // Snapshot written with computed band fields.
    const snap = mockAppUpdateOne.mock.calls[0][1].$set.readiness
    expect(snap).toMatchObject({ handoffVersion: 1, practicedCount: 2, mustHaveTotal: 2, xrayHash: HASH })
    expect(typeof snap.quality).toBe('number')
    expect(typeof snap.strongCoverage).toBe('number')
    expect(mockAppUpdateOne.mock.calls[0][0]).toEqual({
      _id: 'app1',
      userId: 'u1',
      jobPostingId: 'job1',
      verifiedPracticeSessionIds: 'sess1',
      $or: [{ readinessRevision: 0 }, { readinessRevision: { $exists: false } }],
    })
    expect(mockAppUpdateOne.mock.calls[0][1].$inc).toEqual({ readinessRevision: 1 })
    // Terminal outcome → processed marker stamped (Codex #538).
    expect(mockSessionUpdateOne).toHaveBeenCalledWith(
      { _id: 'sess1' },
      { $set: { 'attribution.evidenceProcessedAt': expect.any(Date) } },
      undefined,
    )
    expect(mockWithActiveJobsAccountWrite).toHaveBeenCalledWith('u1', expect.any(Function))
    expect(mockPostingUpdateOne).toHaveBeenCalledWith(
      {
        _id: 'job1',
        status: 'open',
        closedReason: { $exists: false },
        parsedJDHash: HASH,
      },
      { $inc: { derivedAuthorityRevision: 1 } },
      { session: undefined, timestamps: false },
    )
  })

  it('same requirement evidenced by two answers collapses to the BEST row before insert (Codex #538)', async () => {
    mockSessionFindById.mockReturnValue(selectLean({
      jobDescription: JD,
      config: {},
      evaluations: [
        evaluation(), // index 0 → answerScore 80
        evaluation({ relevance: 60, structure: 60, specificity: 60, ownership: 60 }), // index 1 → 60
      ],
      userId: 'u1',
      attribution: ATTRIBUTION,
    }))
    // partial×80 = 40 loses to strong×60 = 60 — insertMany must see ONE
    // req-node row (the unique index would otherwise silently drop
    // whichever duplicate arrived second, possibly the stronger one).
    mockCompletion.mockResolvedValue({
      text: '{"attributions":[{"answerIndex":0,"requirementIds":["req-node"],"strength":"partial"},{"answerIndex":1,"requirementIds":["req-node"],"strength":"strong"}]}',
    })
    const r = await runEvidenceAttributionHandler(EVENT, step)
    expect(r.rows).toBe(1)
    const docs = mockEvidenceInsertMany.mock.calls[0][0] as Array<Record<string, unknown>>
    expect(docs).toHaveLength(1)
    expect(docs[0]).toMatchObject({ requirementId: 'req-node', strength: 'strong', answerScore: 60 })
  })

  it('a CMS ModelConfig override flows into the epoch — resolved model, never the hardcoded default (Codex #538 r2)', async () => {
    mockResolveModel.mockResolvedValue({ model: 'cms-override-model' })
    mockEvidenceFind.mockReturnValue(selectLean([
      { requirementId: 'req-node', xrayHash: HASH, strength: 'strong', answerScore: 80, scoringEpoch: 'cms-override-model', sessionId: 'sess1' },
    ]))
    const r = await runEvidenceAttributionHandler(EVENT, step)
    expect(r.outcome).toBe('attributed')
    const docs = mockEvidenceInsertMany.mock.calls[0][0] as Array<Record<string, unknown>>
    expect(docs.every((d) => d.scoringEpoch === 'cms-override-model')).toBe(true)
    const snap = mockAppUpdateOne.mock.calls[0][1].$set.readiness
    expect(snap.scoringEpoch).toBe('cms-override-model')
    expect(snap.practicedCount).toBe(1)
  })

  it('JD-version mismatch = counted skip, never cross-version attribution — and NEVER stamped (stale cache heals, Codex #538 r4)', async () => {
    mockPostingFindById.mockReturnValue(selectLean({ status: 'open', parsedJD, parsedJDHash: 'different-hash' }))
    const r = await runEvidenceAttributionHandler(EVENT, step)
    expect(r.outcome).toBe('jd-version-mismatch')
    expect(mockCompletion).not.toHaveBeenCalled()
    expect(mockEvidenceInsertMany).not.toHaveBeenCalled()
    // A session practiced against the UPDATED JD looks mismatched until
    // /xray reparses the posting — the sweep must be able to retry it.
    expect(mockSessionUpdateOne).not.toHaveBeenCalled()
  })

  it('a restricted source closure stops before model egress and derived persistence', async () => {
    mockPostingFindById.mockReturnValue(selectLean({
      status: 'closed',
      closedReason: 'source-revoked',
      parsedJD,
      parsedJDHash: HASH,
    }))

    const result = await runEvidenceAttributionHandler(EVENT, step)

    expect(result.outcome).toBe('posting-restricted')
    expect(mockCompletion).not.toHaveBeenCalled()
    expect(mockEvidenceDeleteMany).not.toHaveBeenCalled()
    expect(mockEvidenceInsertMany).not.toHaveBeenCalled()
    expect(mockSessionUpdateOne).not.toHaveBeenCalled()
  })

  it('rechecks exact posting/session authority inside the model boundary', async () => {
    mockPostingExists.mockResolvedValueOnce(null)
    mockCompletion.mockImplementationOnce(async (options: {
      beforeProviderCall?: () => Promise<boolean>
    }) => {
      expect(await options.beforeProviderCall?.()).toBe(false)
      throw Object.assign(new Error('model provider precondition failed'), {
        name: 'ModelProviderPreconditionError',
      })
    })

    const result = await runEvidenceAttributionHandler(EVENT, step)

    expect(result.outcome).toBe('authority-revoked')
    expect(mockPostingExists).toHaveBeenCalledWith({
      _id: 'job1',
      status: 'open',
      closedReason: { $exists: false },
      parsedJDHash: HASH,
    })
    expect(mockSessionExists).toHaveBeenCalledWith(expect.objectContaining({
      _id: 'sess1',
      userId: 'u1',
      status: 'completed',
      'attribution.source': 'jobs',
      'attribution.jobId': 'job1',
      'attribution.handoffVersion': 1,
      'attribution.jdHash': ATTRIBUTION.jdHash,
      'attribution.evidenceProcessedAt': { $exists: false },
    }))
    expect(mockEvidenceDeleteMany).not.toHaveBeenCalled()
    expect(mockEvidenceInsertMany).not.toHaveBeenCalled()
    expect(mockSessionUpdateOne).not.toHaveBeenCalled()
  })

  it('aborts persistence when source revocation commits after model completion', async () => {
    mockPostingExists.mockResolvedValueOnce(null)

    const result = await runEvidenceAttributionHandler(EVENT, step)

    expect(result).toEqual({ outcome: 'attributed', rows: 0 })
    expect(mockEvidenceDeleteMany).not.toHaveBeenCalled()
    expect(mockEvidenceInsertMany).not.toHaveBeenCalled()
    expect(mockAppUpdateOne).not.toHaveBeenCalled()
    expect(mockSessionUpdateOne).not.toHaveBeenCalled()
  })

  it('truncated-but-parseable output retries at the bumped budget instead of persisting a partial tail (Codex #538 r4)', async () => {
    mockCompletion
      .mockResolvedValueOnce({
        text: '{"attributions":[{"answerIndex":0,"requirementIds":["req-node"],"strength":"strong"}]}',
        truncated: true, // valid JSON, but the tail answers are missing
      })
      .mockResolvedValueOnce({
        text: '{"attributions":[{"answerIndex":0,"requirementIds":["req-node","req-pay"],"strength":"strong"}]}',
      })
    const r = await runEvidenceAttributionHandler(EVENT, step)
    expect(r.outcome).toBe('attributed')
    expect(mockCompletion).toHaveBeenCalledTimes(2)
    expect(mockCompletion.mock.calls.every(([options]) =>
      typeof (options as { beforeProviderCall?: unknown }).beforeProviderCall === 'function'
    )).toBe(true)
    const docs = mockEvidenceInsertMany.mock.calls[0][0] as Array<Record<string, unknown>>
    expect(docs.map((d) => d.requirementId).sort()).toEqual(['req-node', 'req-pay'])
  })

  it('still truncated after the bumped retry → throws, nothing persisted, nothing stamped', async () => {
    mockCompletion.mockResolvedValue({
      text: '{"attributions":[{"answerIndex":0,"requirementIds":["req-node"],"strength":"strong"}]}',
      truncated: true,
    })
    await expect(runEvidenceAttributionHandler(EVENT, step)).rejects.toThrow('truncated after bumped retry')
    expect(mockCompletion).toHaveBeenCalledTimes(2)
    expect(mockEvidenceInsertMany).not.toHaveBeenCalled()
    expect(mockSessionUpdateOne).not.toHaveBeenCalled()
  })

  it('failed/truncated evaluations are excluded; all-excluded = no-scorable-answers, zero LLM spend', async () => {
    mockSessionFindById.mockReturnValue(selectLean({
      jobDescription: JD,
      config: {},
      evaluations: [evaluation({ status: 'failed' }), evaluation({ status: 'truncated' })],
      userId: 'u1',
      attribution: ATTRIBUTION,
    }))
    const r = await runEvidenceAttributionHandler(EVENT, step)
    expect(r.outcome).toBe('no-scorable-answers')
    expect(mockCompletion).not.toHaveBeenCalled()
  })

  it('missing evaluations throws (persist race → Inngest retry), never fabricates', async () => {
    mockSessionFindById.mockReturnValue(selectLean({ jobDescription: JD, config: {}, evaluations: [], userId: 'u1', attribution: ATTRIBUTION }))
    await expect(runEvidenceAttributionHandler(EVENT, step)).rejects.toThrow('not yet persisted')
  })

  it('does not attribute or terminally stamp a session before completed feedback is durable', async () => {
    mockHasCompletedScoredPractice.mockReturnValue(false)

    const r = await runEvidenceAttributionHandler(EVENT, step)

    expect(r.outcome).toBe('not-scored')
    expect(mockCompletion).not.toHaveBeenCalled()
    expect(mockEvidenceDeleteMany).not.toHaveBeenCalled()
    expect(mockSessionUpdateOne).not.toHaveBeenCalled()
  })

  it('the session query PROJECTS the top-level jobDescription (mocks return full docs — only this pins the select)', async () => {
    let selectArg = ''
    mockSessionFindById.mockReturnValue({
      select: (s: string) => {
        selectArg = s
        return { lean: () => Promise.resolve({ jobDescription: JD, config: {}, evaluations: [evaluation()], userId: 'u1', attribution: ATTRIBUTION }) }
      },
    })
    await runEvidenceAttributionHandler(EVENT, step)
    expect(selectArg).toContain('jobDescription')
  })

  it('legacy config-carried JD still attributes via the fallback read', async () => {
    mockSessionFindById.mockReturnValue(selectLean({ config: { jobDescription: JD }, evaluations: [evaluation()], userId: 'u1', attribution: ATTRIBUTION }))
    const r = await runEvidenceAttributionHandler(EVENT, step)
    expect(r.outcome).toBe('attributed')
  })

  it('rejects a cross-user application without spending, persisting, or marking the session processed', async () => {
    mockAppFindById.mockReturnValue(selectLean({ userId: 'u2', jobPostingId: 'job1' }))

    const r = await runEvidenceAttributionHandler(EVENT, step)

    expect(r.outcome).toBe('identity-mismatch')
    expect(mockCompletion).not.toHaveBeenCalled()
    expect(mockEvidenceDeleteMany).not.toHaveBeenCalled()
    expect(mockEvidenceInsertMany).not.toHaveBeenCalled()
    expect(mockAppUpdateOne).not.toHaveBeenCalled()
    expect(mockSessionUpdateOne).not.toHaveBeenCalled()
  })

  it('rejects an event whose job does not match the Jobs-attributed session', async () => {
    mockSessionFindById.mockReturnValue(selectLean({
      jobDescription: JD,
      config: {},
      evaluations: [evaluation()],
      userId: 'u1',
      attribution: { source: 'jobs', jobId: 'another-job', applicationId: 'app1' },
    }))

    const r = await runEvidenceAttributionHandler(EVENT, step)

    expect(r.outcome).toBe('identity-mismatch')
    expect(mockCompletion).not.toHaveBeenCalled()
    expect(mockEvidenceDeleteMany).not.toHaveBeenCalled()
    expect(mockSessionUpdateOne).not.toHaveBeenCalled()
  })

  it('rejects an application whose job does not match the event', async () => {
    mockAppFindById.mockReturnValue(selectLean({ userId: 'u1', jobPostingId: 'another-job' }))

    const r = await runEvidenceAttributionHandler(EVENT, step)

    expect(r.outcome).toBe('identity-mismatch')
    expect(mockCompletion).not.toHaveBeenCalled()
    expect(mockEvidenceDeleteMany).not.toHaveBeenCalled()
    expect(mockSessionUpdateOne).not.toHaveBeenCalled()
  })

  it('keeps missing context unstamped so reconciliation can repair it', async () => {
    mockAppFindById.mockReturnValue(selectLean(null))

    const r = await runEvidenceAttributionHandler(EVENT, step)

    expect(r.outcome).toBe('missing-context')
    expect(mockCompletion).not.toHaveBeenCalled()
    expect(mockSessionUpdateOne).not.toHaveBeenCalled()
  })

  it('uses evidenceProcessedAt as the durable idempotency fence after event dedupe expires', async () => {
    mockSessionFindById.mockReturnValue(selectLean({
      jobDescription: JD,
      config: {},
      evaluations: [evaluation()],
      userId: 'u1',
      attribution: { ...ATTRIBUTION, evidenceProcessedAt: new Date('2026-07-01T00:00:00Z') },
    }))

    const r = await runEvidenceAttributionHandler(EVENT, step)

    expect(r.outcome).toBe('already-processed')
    expect(mockCompletion).not.toHaveBeenCalled()
    expect(mockEvidenceDeleteMany).not.toHaveBeenCalled()
    expect(mockAppUpdateOne).not.toHaveBeenCalled()
    expect(mockSessionUpdateOne).not.toHaveBeenCalled()
  })

  it("transient 'no-parse' (X-ray not cached yet) is NEVER stamped — the sweep must retry it (Codex #538 r3)", async () => {
    mockPostingFindById.mockReturnValue(selectLean({ status: 'open', parsedJD: null, parsedJDHash: null }))
    const r = await runEvidenceAttributionHandler(EVENT, step)
    expect(r.outcome).toBe('no-parse')
    expect(mockCompletion).not.toHaveBeenCalled()
    expect(mockSessionUpdateOne).not.toHaveBeenCalled()
  })

  it("parse with zero must-haves = terminal 'no-must-haves', stamped", async () => {
    mockPostingFindById.mockReturnValue(selectLean({
      status: 'open',
      parsedJD: { requirements: [{ id: 'req-nice', requirement: 'GraphQL', importance: 'nice-to-have' }] },
      parsedJDHash: HASH,
    }))
    const r = await runEvidenceAttributionHandler(EVENT, step)
    expect(r.outcome).toBe('no-must-haves')
    expect(mockCompletion).not.toHaveBeenCalled()
    expect(mockSessionUpdateOne).toHaveBeenCalledWith(
      { _id: 'sess1' },
      { $set: { 'attribution.evidenceProcessedAt': expect.any(Date) } },
      undefined,
    )
  })

  it("'none' strength verdicts are never stored — and zero-evidence is still PROCESSED (Codex #538)", async () => {
    mockCompletion.mockResolvedValue({ text: '{"attributions":[{"answerIndex":0,"requirementIds":["req-node"],"strength":"none"}]}' })
    mockEvidenceFind.mockReturnValue(selectLean([]))
    const r = await runEvidenceAttributionHandler(EVENT, step)
    expect(r.rows).toBe(0)
    expect(mockEvidenceInsertMany).not.toHaveBeenCalled()
    // Without this stamp the daily sweep would re-emit (and re-bill the
    // LLM for) this fully-processed session every day for a week.
    expect(mockSessionUpdateOne).toHaveBeenCalledWith(
      { _id: 'sess1' },
      { $set: { 'attribution.evidenceProcessedAt': expect.any(Date) } },
      undefined,
    )
  })

  it('delete-race guard: session GDPR-deleted between attribute and persist → abort, resurrect nothing', async () => {
    mockSessionExists.mockResolvedValue(null)
    const r = await runEvidenceAttributionHandler(EVENT, step)
    expect(r.rows).toBe(0)
    expect(mockEvidenceDeleteMany).not.toHaveBeenCalled()
    expect(mockEvidenceInsertMany).not.toHaveBeenCalled()
    expect(mockAppUpdateOne).not.toHaveBeenCalled() // snapshot the delete unset stays unset
    expect(mockSessionUpdateOne).not.toHaveBeenCalled()
  })

  it('aborts inside the transaction when a per-session delete wins after the preflight', async () => {
    mockSessionExists
      .mockResolvedValueOnce({ _id: 'sess1' })
      .mockResolvedValueOnce({ _id: 'sess1' })
      .mockResolvedValueOnce(null)

    const r = await runEvidenceAttributionHandler(EVENT, step)

    expect(r.rows).toBe(0)
    expect(mockWithActiveJobsAccountWrite).toHaveBeenCalledWith('u1', expect.any(Function))
    expect(mockEvidenceDeleteMany).not.toHaveBeenCalled()
    expect(mockAppUpdateOne).not.toHaveBeenCalled()
    expect(mockPostingUpdateOne).not.toHaveBeenCalled()
    expect(mockSessionUpdateOne).not.toHaveBeenCalled()
  })

  it('returns zero and writes nothing when account deletion wins the durable writer fence', async () => {
    mockWithActiveJobsAccountWrite.mockRejectedValueOnce(
      new MockJobsAccountInactiveError('account deleting'),
    )

    const r = await runEvidenceAttributionHandler(EVENT, step)

    expect(r.rows).toBe(0)
    expect(mockEvidenceDeleteMany).not.toHaveBeenCalled()
    expect(mockAppUpdateOne).not.toHaveBeenCalled()
    expect(mockPostingUpdateOne).not.toHaveBeenCalled()
    expect(mockSessionUpdateOne).not.toHaveBeenCalled()
  })

  it('aborts before evidence when the exact posting write fence misses during persistence', async () => {
    mockPostingUpdateOne.mockResolvedValueOnce({ matchedCount: 0 })

    const result = await runEvidenceAttributionHandler(EVENT, step)

    expect(result).toEqual({ outcome: 'attributed', rows: 0 })
    expect(mockPostingUpdateOne).toHaveBeenCalledOnce()
    expect(mockEvidenceInsertMany).not.toHaveBeenCalled()
    expect(mockEvidenceDeleteMany).not.toHaveBeenCalled()
    expect(mockAppUpdateOne).not.toHaveBeenCalled()
    expect(mockSessionUpdateOne).not.toHaveBeenCalled()
  })

  it('rejects the transaction when the processed-session marker misses after evidence/readiness writes', async () => {
    mockSessionUpdateOne.mockResolvedValueOnce({ matchedCount: 0 })

    await expect(runEvidenceAttributionHandler(EVENT, step)).rejects.toThrow(
      'evidence session changed before processed marker commit',
    )
    expect(mockEvidenceInsertMany).toHaveBeenCalledOnce()
    expect(mockAppUpdateOne).toHaveBeenCalled()
  })

  it('recomputes after deleting session A invalidates session B\'s stale application snapshot', async () => {
    mockAppFindOne
      .mockReturnValueOnce(selectLean({ userId: 'u1', jobPostingId: 'job1' }))
      .mockReturnValueOnce(selectLean({ readinessRevision: 0 }))
      .mockReturnValueOnce(selectLean({ readinessRevision: 1 }))
    mockEvidenceFind
      .mockReturnValueOnce(selectLean([
        { requirementId: 'req-node', xrayHash: HASH, strength: 'strong', answerScore: 80, scoringEpoch: RESOLVED_MODEL, sessionId: 'deleted-A' },
        { requirementId: 'req-pay', xrayHash: HASH, strength: 'strong', answerScore: 80, scoringEpoch: RESOLVED_MODEL, sessionId: 'sess1' },
      ]))
      .mockReturnValueOnce(selectLean([
        { requirementId: 'req-pay', xrayHash: HASH, strength: 'strong', answerScore: 80, scoringEpoch: RESOLVED_MODEL, sessionId: 'sess1' },
      ]))
    // The first miss represents session A's deletion incrementing the
    // revision after B read [A,B]. B must re-read and publish only [B].
    mockAppUpdateOne
      .mockResolvedValueOnce({ matchedCount: 0 })
      .mockResolvedValueOnce({ matchedCount: 1 })

    const result = await runEvidenceAttributionHandler(EVENT, step)

    expect(result.outcome).toBe('attributed')
    expect(mockEvidenceFind).toHaveBeenCalledTimes(2)
    expect(mockAppUpdateOne.mock.calls[1][0]).toMatchObject({ readinessRevision: 1 })
    expect(mockAppUpdateOne.mock.calls[1][1].$set.readiness).toMatchObject({
      sessions: 1,
      practicedCount: 1,
    })
    expect(mockSessionUpdateOne).toHaveBeenCalledWith(
      { _id: 'sess1' },
      { $set: { 'attribution.evidenceProcessedAt': expect.any(Date) } },
      undefined,
    )
  })

  it('unparseable output (throw path) does NOT stamp processed — retries and the sweep stay armed', async () => {
    mockCompletion
      .mockResolvedValueOnce({ text: 'garbage' })
      .mockResolvedValueOnce({ text: 'garbage' })
    await expect(runEvidenceAttributionHandler(EVENT, step)).rejects.toThrow()
    expect(mockSessionUpdateOne).not.toHaveBeenCalled()
  })

  it('unparseable LLM output retries once at a bumped budget, then throws (never fabricated)', async () => {
    mockCompletion
      .mockResolvedValueOnce({ text: 'not json at all' })
      .mockResolvedValueOnce({ text: 'still garbage' })
    await expect(runEvidenceAttributionHandler(EVENT, step)).rejects.toThrow('parse failed after bumped retry')
    expect(mockCompletion).toHaveBeenCalledTimes(2)
    expect(mockEvidenceInsertMany).not.toHaveBeenCalled()
  })

  it('prompt carries the boundary-tagged sections and never leaks ids it was not given', () => {
    const prompt = buildAttributionPrompt(
      [{ index: 0, question: 'Q', answer: 'A', answerScore: 70 }],
      [{ id: 'req-1', requirement: 'Node.js' }]
    )
    expect(prompt).toContain('<job_must_have_requirements>')
    expect(prompt).toContain('<interview_answers>')
    expect(prompt).toContain('Never invent ids')
  })
})

describe('jobsEvidenceAttributionJob configuration', () => {
  it('retains the global cap and serializes workers for the same application', () => {
    const config = createdFunctionConfigs.find((value) => value.id === 'jobs-evidence-attribution')
    expect(config?.concurrency).toEqual([
      { limit: 2 },
      { limit: 1, key: 'event.data.applicationId' },
    ])
  })
})

describe('runEvidenceReconcileHandler', () => {
  it('re-emits every eligible UNstamped session instead of trusting a possibly partial row set', async () => {
    mockSessionFind.mockReturnValue(reconcileQuery([
      { _id: 'sA', attribution: reconcileAttribution('j1', 'appA'), userId: 'u1', evaluations: [evaluation()] },
      { _id: 'sB', attribution: reconcileAttribution('j2'), userId: 'u1', evaluations: [evaluation()] },
    ]))
    mockEnsurePracticeApplication
      .mockResolvedValueOnce({
        applicationId: 'appA', jobPostingId: 'j1', sessionId: 'sA', evidenceCount: 1, newlyAdded: false,
      })
      .mockResolvedValueOnce({
        applicationId: 'appB', jobPostingId: 'j2', sessionId: 'sB', evidenceCount: 1, newlyAdded: false,
      })
    const r = await runEvidenceReconcileHandler(step)
    expect(r.reEmitted).toBe(2)
    // The Codex #538 guard: processed-but-zero-evidence sessions are
    // excluded at the QUERY, so they can never be re-emitted/re-billed.
    const filter = mockSessionFind.mock.calls[0][0] as Record<string, unknown>
    expect(filter['attribution.evidenceProcessedAt']).toEqual({ $exists: false })
    expect(filter['attribution.handoffVersion']).toBe(1)
    expect(filter.status).toBe('completed')
    expect(filter.feedback).toEqual({ $exists: true })
    expect(filter.$or).toEqual(expect.arrayContaining([
      expect.objectContaining({ 'evaluations.2': { $exists: true } }),
    ]))
    expect(mockEnsurePracticeApplication).toHaveBeenCalledTimes(2)
    expect(mockEnsurePracticeApplication).toHaveBeenCalledWith('u1', 'sA')
    expect(mockEnsurePracticeApplication).toHaveBeenCalledWith('u1', 'sB')
    expect(mockEvidenceExists).not.toHaveBeenCalled()
    expect(mockInngestSend).toHaveBeenCalledTimes(2)
    expect(mockInngestSend).toHaveBeenCalledWith({
      id: 'jobs-evidence-sA',
      name: 'jobs/evidence.attribute',
      data: { sessionId: 'sA', applicationId: 'appA', jobPostingId: 'j1' },
    })
  })

  it('backfills a practice-first session with no applicationId and emits canonical ids', async () => {
    mockSessionFind.mockReturnValue(reconcileQuery([
      {
        _id: 's-practice-first', attribution: reconcileAttribution('job1'), userId: 'u1',
        evaluations: [evaluation()],
      },
    ]))
    mockEnsurePracticeApplication.mockResolvedValueOnce({
      applicationId: 'canonical-app',
      jobPostingId: 'job1',
      sessionId: 's-practice-first',
      evidenceCount: 1,
      newlyAdded: true,
    })

    const r = await runEvidenceReconcileHandler(step)

    expect(r.reEmitted).toBe(1)
    expect(mockEnsurePracticeApplication).toHaveBeenCalledWith('u1', 's-practice-first')
    expect(mockInngestSend).toHaveBeenCalledWith({
      id: 'jobs-evidence-s-practice-first',
      name: 'jobs/evidence.attribute',
      data: {
        sessionId: 's-practice-first',
        applicationId: 'canonical-app',
        jobPostingId: 'job1',
      },
    })
  })

  it('does not emit when the canonical application cannot be materialized', async () => {
    mockSessionFind.mockReturnValue(reconcileQuery([
      {
        _id: 's-missing-job', attribution: reconcileAttribution('missing-job'), userId: 'u1',
        evaluations: [evaluation()],
      },
    ]))
    mockEnsurePracticeApplication.mockResolvedValueOnce(null)

    const r = await runEvidenceReconcileHandler(step)

    expect(r.reEmitted).toBe(0)
    expect(mockInngestSend).not.toHaveBeenCalled()
  })

  it('never materializes or emits failed/truncated-only sessions', async () => {
    mockHasCompletedScoredPractice.mockReturnValue(false)
    mockSessionFind.mockReturnValue(reconcileQuery([
      {
        _id: 's-unscored',
        attribution: reconcileAttribution('job1'),
        userId: 'u1',
        evaluations: [evaluation({ status: 'failed' }), evaluation({ status: 'truncated' })],
      },
    ]))

    const r = await runEvidenceReconcileHandler(step)

    expect(r.reEmitted).toBe(0)
    expect(mockEnsurePracticeApplication).not.toHaveBeenCalled()
    expect(mockInngestSend).not.toHaveBeenCalled()
    expect(mockSessionUpdateOne).toHaveBeenCalledWith(
      { _id: 's-unscored' },
      { $set: { 'attribution.evidenceProcessedAt': expect.any(Date) } },
      undefined,
    )
  })

  it('does not materialize an in-progress session or a two-answer standard short form', async () => {
    mockHasCompletedScoredPractice.mockReturnValue(false)
    mockSessionFind.mockReturnValue(reconcileQuery([
      {
        _id: 's-in-progress', attribution: reconcileAttribution('job1'), userId: 'u1',
        status: 'in_progress', feedback: { overall_score: 80 }, config: { interviewType: 'behavioral' },
        evaluations: [evaluation(), evaluation(), evaluation()],
      },
      {
        _id: 's-short', attribution: reconcileAttribution('job1'), userId: 'u1',
        status: 'completed', feedback: { overall_score: 0 }, config: { interviewType: 'behavioral' },
        evaluations: [evaluation(), evaluation()],
      },
    ]))

    const r = await runEvidenceReconcileHandler(step)

    expect(r.reEmitted).toBe(0)
    expect(mockEnsurePracticeApplication).not.toHaveBeenCalled()
    expect(mockInngestSend).not.toHaveBeenCalled()
  })

  it.each(['coding', 'system-design'])('accepts one completed substantive %s evaluation', async (interviewType) => {
    mockHasCompletedScoredPractice.mockReturnValue(true)
    mockSessionFind.mockReturnValue(reconcileQuery([
      {
        _id: `s-${interviewType}`, attribution: reconcileAttribution('job1'), userId: 'u1',
        status: 'completed', feedback: { overall_score: 82 }, config: { interviewType },
        evaluations: [evaluation()],
      },
    ]))
    mockEnsurePracticeApplication.mockResolvedValueOnce({
      applicationId: 'app1', jobPostingId: 'job1', sessionId: `s-${interviewType}`,
      evidenceCount: 1, newlyAdded: true,
    })

    const r = await runEvidenceReconcileHandler(step)

    expect(r.reEmitted).toBe(1)
    expect(mockEnsurePracticeApplication).toHaveBeenCalledWith('u1', `s-${interviewType}`)
  })

  it('isolates a poison candidate and still emits the next recoverable session', async () => {
    mockSessionFind.mockReturnValue(reconcileQuery([
      { _id: 's-poison', attribution: reconcileAttribution('job1'), userId: 'u1', evaluations: [evaluation()] },
      { _id: 's-good', attribution: reconcileAttribution('job2'), userId: 'u1', evaluations: [evaluation()] },
    ]))
    mockEnsurePracticeApplication
      .mockRejectedValueOnce(new Error('corrupt candidate'))
      .mockResolvedValueOnce({
        applicationId: 'app-good', jobPostingId: 'job2', sessionId: 's-good', evidenceCount: 1, newlyAdded: false,
      })

    const r = await runEvidenceReconcileHandler(step)

    expect(r.reEmitted).toBe(1)
    expect(mockEnsurePracticeApplication).toHaveBeenCalledTimes(2)
    expect(mockInngestSend).toHaveBeenCalledWith({
      id: 'jobs-evidence-s-good',
      name: 'jobs/evidence.attribute',
      data: { sessionId: 's-good', applicationId: 'app-good', jobPostingId: 'job2' },
    })
  })

  it('keyset-pages past 200 terminal poison rows to reach a valid candidate', async () => {
    const poison = Array.from({ length: 200 }, (_, index) => ({
      _id: `s-poison-${String(index).padStart(3, '0')}`,
      attribution: reconcileAttribution('job1'),
      userId: 'u1',
      status: 'completed',
      feedback: { overall_score: 0 },
      config: { interviewType: 'behavioral' },
      evaluations: [evaluation({ status: 'failed' }), evaluation({ status: 'failed' }), evaluation({ status: 'failed' })],
    }))
    const good = {
      _id: 's-valid-after-poison',
      attribution: reconcileAttribution('job2'),
      userId: 'u1',
      status: 'completed',
      feedback: { overall_score: 88 },
      config: { interviewType: 'behavioral' },
      evaluations: [evaluation(), evaluation(), evaluation()],
    }
    mockSessionFind
      .mockReturnValueOnce(reconcileQuery(poison))
      .mockReturnValueOnce(reconcileQuery([good]))
    mockHasCompletedScoredPractice.mockImplementation((session: { _id?: string }) =>
      session._id === 's-valid-after-poison'
    )
    mockEnsurePracticeApplication.mockResolvedValueOnce({
      applicationId: 'app-good', jobPostingId: 'job2', sessionId: 's-valid-after-poison',
      evidenceCount: 1, newlyAdded: true,
    })

    const r = await runEvidenceReconcileHandler(step)

    expect(r.reEmitted).toBe(1)
    expect(mockSessionFind).toHaveBeenCalledTimes(2)
    expect(mockSessionFind.mock.calls[1][0]).toMatchObject({
      _id: { $gt: 's-poison-199' },
    })
    expect(mockEnsurePracticeApplication).toHaveBeenCalledWith('u1', 's-valid-after-poison')
    expect(mockInngestSend).toHaveBeenCalledWith({
      id: 'jobs-evidence-s-valid-after-poison',
      name: 'jobs/evidence.attribute',
      data: {
        sessionId: 's-valid-after-poison',
        applicationId: 'app-good',
        jobPostingId: 'job2',
      },
    })
  })
})
