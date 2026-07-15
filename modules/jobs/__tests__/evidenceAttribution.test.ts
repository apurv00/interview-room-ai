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
  mockSessionFindById, mockAppFindById, mockAppFindOne, mockAppUpdateOne, mockPostingFindById,
  mockEvidenceDeleteMany, mockEvidenceInsertMany, mockEvidenceFind, mockEvidenceExists,
  mockCompletion, mockInngestSend, mockSessionFind, mockSessionUpdateOne, mockResolveModel,
  mockSessionExists,
} = vi.hoisted(() => ({
  mockSessionFindById: vi.fn(), mockAppFindById: vi.fn(), mockAppFindOne: vi.fn(), mockAppUpdateOne: vi.fn(),
  mockPostingFindById: vi.fn(), mockEvidenceDeleteMany: vi.fn(), mockEvidenceInsertMany: vi.fn(),
  mockEvidenceFind: vi.fn(), mockEvidenceExists: vi.fn(), mockCompletion: vi.fn(), mockInngestSend: vi.fn(),
  mockSessionFind: vi.fn(), mockSessionUpdateOne: vi.fn(), mockResolveModel: vi.fn(),
  mockSessionExists: vi.fn(),
}))

vi.mock('@shared/db/connection', () => ({ connectDB: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@shared/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@shared/services/inngest', () => ({ inngest: { send: mockInngestSend, createFunction: vi.fn(() => ({})) } }))
vi.mock('@shared/services/modelRouter', () => ({ completion: mockCompletion, resolveModel: mockResolveModel }))
vi.mock('@shared/db/models', () => ({
  InterviewSession: { findById: mockSessionFindById, find: mockSessionFind, updateOne: mockSessionUpdateOne, exists: mockSessionExists },
  JobApplication: { findById: mockAppFindById, findOne: mockAppFindOne, updateOne: mockAppUpdateOne },
  JobPosting: { findById: mockPostingFindById },
  JobPracticeEvidence: { deleteMany: mockEvidenceDeleteMany, insertMany: mockEvidenceInsertMany, find: mockEvidenceFind, exists: mockEvidenceExists },
}))

import { runEvidenceAttributionHandler, runEvidenceReconcileHandler, buildAttributionPrompt } from '../jobs/evidenceAttributionJob'
import { xrayHashOf } from '../services/xrayService'

/** What the mocked resolveModel returns — the epoch every row must carry. */
const RESOLVED_MODEL = 'gpt-5.6-luna'

const step = { run: <T,>(_n: string, fn: () => Promise<T> | T) => Promise.resolve(fn()) }
const selectLean = (v: unknown) => ({ select: () => ({ lean: () => Promise.resolve(v) }) })

const JD = 'We need a backend engineer with Node.js, MongoDB, and payment-systems experience. '.repeat(3)
const HASH = xrayHashOf(JD)
const EVENT = { data: { sessionId: 'sess1', applicationId: 'app1', jobPostingId: 'job1' } }

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
  mockSessionFindById.mockReturnValue(selectLean({ jobDescription: JD, config: {}, evaluations: [evaluation()], userId: 'u1' }))
  mockAppFindById.mockReturnValue(selectLean({ practiceSessionIds: ['sess1', 's0', 'sx'], userId: 'u1' }))
  mockPostingFindById.mockReturnValue(selectLean({ parsedJD, parsedJDHash: HASH }))
  mockCompletion.mockResolvedValue({ text: '{"attributions":[{"answerIndex":0,"requirementIds":["req-node","req-pay","req-nice","invented-id"],"strength":"strong"}]}' })
  mockEvidenceDeleteMany.mockResolvedValue({})
  mockEvidenceInsertMany.mockResolvedValue({})
  mockEvidenceFind.mockReturnValue(selectLean([
    { requirementId: 'req-node', xrayHash: HASH, strength: 'strong', answerScore: 80, scoringEpoch: RESOLVED_MODEL, sessionId: 'sess1' },
    { requirementId: 'req-pay', xrayHash: HASH, strength: 'strong', answerScore: 80, scoringEpoch: RESOLVED_MODEL, sessionId: 'sess1' },
  ]))
  mockAppUpdateOne.mockResolvedValue({})
  mockSessionUpdateOne.mockResolvedValue({})
  mockEvidenceExists.mockResolvedValue(null)
  mockResolveModel.mockResolvedValue({ model: RESOLVED_MODEL })
  mockSessionExists.mockResolvedValue({ _id: 'sess1' })
})

describe('runEvidenceAttributionHandler', () => {
  it('happy path: persists ONLY must-have ids (belt drops nice-to-have + invented), replace semantics, snapshot denormalized', async () => {
    const r = await runEvidenceAttributionHandler(EVENT, step)
    expect(r.outcome).toBe('attributed')
    expect(r.rows).toBe(2) // req-node + req-pay; req-nice and invented-id dropped
    expect(mockEvidenceDeleteMany).toHaveBeenCalledWith({ sessionId: 'sess1', xrayHash: HASH })
    const docs = mockEvidenceInsertMany.mock.calls[0][0] as Array<Record<string, unknown>>
    expect(docs.map((d) => d.requirementId).sort()).toEqual(['req-node', 'req-pay'])
    // Codex #538 P1+r2: live evaluations carry NO modelUsed — rows are
    // epoch-stamped with the RESOLVED evaluate-answer model at attribution
    // time (resolveModel honors CMS overrides; hardcoded defaults do not),
    // and the same value feeds the snapshot filter (else readiness pins
    // at zero).
    expect(mockResolveModel).toHaveBeenCalledWith('interview.evaluate-answer')
    expect(docs[0]).toMatchObject({ strength: 'strong', answerScore: 80, scoringEpoch: RESOLVED_MODEL })
    expect(docs[0].scoringEpoch).not.toBe('unknown')
    // Snapshot written with computed band fields.
    const snap = mockAppUpdateOne.mock.calls[0][1].$set.readiness
    expect(snap).toMatchObject({ practicedCount: 2, mustHaveTotal: 2, xrayHash: HASH })
    expect(typeof snap.quality).toBe('number')
    expect(typeof snap.strongCoverage).toBe('number')
    // Terminal outcome → processed marker stamped (Codex #538).
    expect(mockSessionUpdateOne).toHaveBeenCalledWith(
      { _id: 'sess1' },
      { $set: { 'attribution.evidenceProcessedAt': expect.any(Date) } }
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
    mockPostingFindById.mockReturnValue(selectLean({ parsedJD, parsedJDHash: 'different-hash' }))
    const r = await runEvidenceAttributionHandler(EVENT, step)
    expect(r.outcome).toBe('jd-version-mismatch')
    expect(mockCompletion).not.toHaveBeenCalled()
    expect(mockEvidenceInsertMany).not.toHaveBeenCalled()
    // A session practiced against the UPDATED JD looks mismatched until
    // /xray reparses the posting — the sweep must be able to retry it.
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
    }))
    const r = await runEvidenceAttributionHandler(EVENT, step)
    expect(r.outcome).toBe('no-scorable-answers')
    expect(mockCompletion).not.toHaveBeenCalled()
  })

  it('missing evaluations throws (persist race → Inngest retry), never fabricates', async () => {
    mockSessionFindById.mockReturnValue(selectLean({ jobDescription: JD, config: {}, evaluations: [], userId: 'u1' }))
    await expect(runEvidenceAttributionHandler(EVENT, step)).rejects.toThrow('not yet persisted')
  })

  it('the session query PROJECTS the top-level jobDescription (mocks return full docs — only this pins the select)', async () => {
    let selectArg = ''
    mockSessionFindById.mockReturnValue({
      select: (s: string) => {
        selectArg = s
        return { lean: () => Promise.resolve({ jobDescription: JD, config: {}, evaluations: [evaluation()], userId: 'u1' }) }
      },
    })
    await runEvidenceAttributionHandler(EVENT, step)
    expect(selectArg).toContain('jobDescription')
  })

  it('legacy config-carried JD still attributes via the fallback read', async () => {
    mockSessionFindById.mockReturnValue(selectLean({ config: { jobDescription: JD }, evaluations: [evaluation()], userId: 'u1' }))
    const r = await runEvidenceAttributionHandler(EVENT, step)
    expect(r.outcome).toBe('attributed')
  })

  it("transient 'no-parse' (X-ray not cached yet) is NEVER stamped — the sweep must retry it (Codex #538 r3)", async () => {
    mockPostingFindById.mockReturnValue(selectLean({ parsedJD: null, parsedJDHash: null }))
    const r = await runEvidenceAttributionHandler(EVENT, step)
    expect(r.outcome).toBe('no-parse')
    expect(mockCompletion).not.toHaveBeenCalled()
    expect(mockSessionUpdateOne).not.toHaveBeenCalled()
  })

  it("parse with zero must-haves = terminal 'no-must-haves', stamped", async () => {
    mockPostingFindById.mockReturnValue(selectLean({
      parsedJD: { requirements: [{ id: 'req-nice', requirement: 'GraphQL', importance: 'nice-to-have' }] },
      parsedJDHash: HASH,
    }))
    const r = await runEvidenceAttributionHandler(EVENT, step)
    expect(r.outcome).toBe('no-must-haves')
    expect(mockCompletion).not.toHaveBeenCalled()
    expect(mockSessionUpdateOne).toHaveBeenCalledWith(
      { _id: 'sess1' },
      { $set: { 'attribution.evidenceProcessedAt': expect.any(Date) } }
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
      { $set: { 'attribution.evidenceProcessedAt': expect.any(Date) } }
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

describe('runEvidenceReconcileHandler', () => {
  it('sweep chases only UNstamped sessions (query filter) and keeps the legacy rows-exist net', async () => {
    mockSessionFind.mockReturnValue({
      select: () => ({
        limit: () => ({
          lean: () => Promise.resolve([
            { _id: 'sA', attribution: { source: 'jobs', jobId: 'j1', applicationId: 'appA' }, userId: 'u1' },
            { _id: 'sB', attribution: { source: 'jobs', jobId: 'j2' }, userId: 'u1' },
          ]),
        }),
      }),
    })
    // sB: evidence rows already exist (pre-stamp legacy) → skipped.
    mockEvidenceExists.mockImplementation(({ sessionId }: { sessionId: string }) =>
      Promise.resolve(sessionId === 'sB' ? { _id: 'x' } : null)
    )
    mockAppFindOne.mockReturnValue(selectLean({ _id: 'appA', jobPostingId: 'jpA' }))
    const r = await runEvidenceReconcileHandler(step)
    expect(r.reEmitted).toBe(1)
    // The Codex #538 guard: processed-but-zero-evidence sessions are
    // excluded at the QUERY, so they can never be re-emitted/re-billed.
    const filter = mockSessionFind.mock.calls[0][0] as Record<string, unknown>
    expect(filter['attribution.evidenceProcessedAt']).toEqual({ $exists: false })
    expect(mockInngestSend).toHaveBeenCalledTimes(1)
    expect(mockInngestSend).toHaveBeenCalledWith({
      name: 'jobs/evidence.attribute',
      data: { sessionId: 'sA', applicationId: 'appA', jobPostingId: 'jpA' },
    })
  })
})
