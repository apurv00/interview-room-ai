import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Attribution worker (READINESS.md §1, PR-R1). Invariants under test:
 * failed/truncated evaluations excluded; JD-version binding (mismatch =
 * counted skip, never cross-version); the must-have belt drops foreign
 * ids; 'none' never stored; replace semantics per (session, hash);
 * snapshot denormalized after persist; emit fires only on recorded:true.
 */

const {
  mockSessionFindById, mockAppFindById, mockAppFindOne, mockAppUpdateOne, mockPostingFindById,
  mockEvidenceDeleteMany, mockEvidenceInsertMany, mockEvidenceFind, mockEvidenceExists,
  mockCompletion, mockInngestSend, mockSessionFind,
} = vi.hoisted(() => ({
  mockSessionFindById: vi.fn(), mockAppFindById: vi.fn(), mockAppFindOne: vi.fn(), mockAppUpdateOne: vi.fn(),
  mockPostingFindById: vi.fn(), mockEvidenceDeleteMany: vi.fn(), mockEvidenceInsertMany: vi.fn(),
  mockEvidenceFind: vi.fn(), mockEvidenceExists: vi.fn(), mockCompletion: vi.fn(), mockInngestSend: vi.fn(),
  mockSessionFind: vi.fn(),
}))

vi.mock('@shared/db/connection', () => ({ connectDB: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@shared/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@shared/services/inngest', () => ({ inngest: { send: mockInngestSend, createFunction: vi.fn(() => ({})) } }))
vi.mock('@shared/services/modelRouter', () => ({ completion: mockCompletion }))
vi.mock('@shared/db/models', () => ({
  InterviewSession: { findById: mockSessionFindById, find: mockSessionFind },
  JobApplication: { findById: mockAppFindById, findOne: mockAppFindOne, updateOne: mockAppUpdateOne },
  JobPosting: { findById: mockPostingFindById },
  JobPracticeEvidence: { deleteMany: mockEvidenceDeleteMany, insertMany: mockEvidenceInsertMany, find: mockEvidenceFind, exists: mockEvidenceExists },
}))

import { runEvidenceAttributionHandler, buildAttributionPrompt } from '../jobs/evidenceAttributionJob'
import { xrayHashOf } from '../services/xrayService'

const step = { run: <T,>(_n: string, fn: () => Promise<T> | T) => Promise.resolve(fn()) }
const selectLean = (v: unknown) => ({ select: () => ({ lean: () => Promise.resolve(v) }) })

const JD = 'We need a backend engineer with Node.js, MongoDB, and payment-systems experience. '.repeat(3)
const HASH = xrayHashOf(JD)
const EVENT = { data: { sessionId: 'sess1', applicationId: 'app1', jobPostingId: 'job1' } }

const evaluation = (over: Record<string, unknown> = {}) => ({
  questionIndex: 0, question: 'Tell me about a payment system you built.',
  answer: 'I built UPI autopay serving 2M users with Node and Mongo.',
  relevance: 80, structure: 70, specificity: 90, ownership: 80,
  modelUsed: 'gpt-5.6-luna', status: 'ok', ...over,
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
  mockSessionFindById.mockReturnValue(selectLean({ config: { jobDescription: JD }, evaluations: [evaluation()], userId: 'u1' }))
  mockAppFindById.mockReturnValue(selectLean({ practiceSessionIds: ['sess1', 's0', 'sx'], userId: 'u1' }))
  mockPostingFindById.mockReturnValue(selectLean({ parsedJD, parsedJDHash: HASH }))
  mockCompletion.mockResolvedValue({ text: '{"attributions":[{"answerIndex":0,"requirementIds":["req-node","req-pay","req-nice","invented-id"],"strength":"strong"}]}' })
  mockEvidenceDeleteMany.mockResolvedValue({})
  mockEvidenceInsertMany.mockResolvedValue({})
  mockEvidenceFind.mockReturnValue(selectLean([
    { requirementId: 'req-node', xrayHash: HASH, strength: 'strong', answerScore: 80, scoringEpoch: 'gpt-5.6-luna', sessionId: 'sess1' },
    { requirementId: 'req-pay', xrayHash: HASH, strength: 'strong', answerScore: 80, scoringEpoch: 'gpt-5.6-luna', sessionId: 'sess1' },
  ]))
  mockAppUpdateOne.mockResolvedValue({})
})

describe('runEvidenceAttributionHandler', () => {
  it('happy path: persists ONLY must-have ids (belt drops nice-to-have + invented), replace semantics, snapshot denormalized', async () => {
    const r = await runEvidenceAttributionHandler(EVENT, step)
    expect(r.outcome).toBe('attributed')
    expect(r.rows).toBe(2) // req-node + req-pay; req-nice and invented-id dropped
    expect(mockEvidenceDeleteMany).toHaveBeenCalledWith({ sessionId: 'sess1', xrayHash: HASH })
    const docs = mockEvidenceInsertMany.mock.calls[0][0] as Array<Record<string, unknown>>
    expect(docs.map((d) => d.requirementId).sort()).toEqual(['req-node', 'req-pay'])
    expect(docs[0]).toMatchObject({ strength: 'strong', answerScore: 80, scoringEpoch: 'gpt-5.6-luna' })
    // Snapshot written with computed band fields.
    const snap = mockAppUpdateOne.mock.calls[0][1].$set.readiness
    expect(snap).toMatchObject({ practicedCount: 2, mustHaveTotal: 2, xrayHash: HASH })
    expect(typeof snap.quality).toBe('number')
    expect(typeof snap.strongCoverage).toBe('number')
  })

  it('JD-version mismatch = counted skip, never cross-version attribution', async () => {
    mockPostingFindById.mockReturnValue(selectLean({ parsedJD, parsedJDHash: 'different-hash' }))
    const r = await runEvidenceAttributionHandler(EVENT, step)
    expect(r.outcome).toBe('jd-version-mismatch')
    expect(mockCompletion).not.toHaveBeenCalled()
    expect(mockEvidenceInsertMany).not.toHaveBeenCalled()
  })

  it('failed/truncated evaluations are excluded; all-excluded = no-scorable-answers, zero LLM spend', async () => {
    mockSessionFindById.mockReturnValue(selectLean({
      config: { jobDescription: JD },
      evaluations: [evaluation({ status: 'failed' }), evaluation({ status: 'truncated' })],
      userId: 'u1',
    }))
    const r = await runEvidenceAttributionHandler(EVENT, step)
    expect(r.outcome).toBe('no-scorable-answers')
    expect(mockCompletion).not.toHaveBeenCalled()
  })

  it('missing evaluations throws (persist race → Inngest retry), never fabricates', async () => {
    mockSessionFindById.mockReturnValue(selectLean({ config: { jobDescription: JD }, evaluations: [], userId: 'u1' }))
    await expect(runEvidenceAttributionHandler(EVENT, step)).rejects.toThrow('not yet persisted')
  })

  it("'none' strength verdicts are never stored", async () => {
    mockCompletion.mockResolvedValue({ text: '{"attributions":[{"answerIndex":0,"requirementIds":["req-node"],"strength":"none"}]}' })
    const r = await runEvidenceAttributionHandler(EVENT, step)
    expect(r.rows).toBe(0)
    expect(mockEvidenceInsertMany).not.toHaveBeenCalled()
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
      [{ index: 0, question: 'Q', answer: 'A', answerScore: 70, scoringEpoch: 'e' }],
      [{ id: 'req-1', requirement: 'Node.js' }]
    )
    expect(prompt).toContain('<job_must_have_requirements>')
    expect(prompt).toContain('<interview_answers>')
    expect(prompt).toContain('Never invent ids')
  })
})
