import { describe, it, expect, vi } from 'vitest'
import { gzipSync } from 'zlib'

const {
  mockAppFindOne, mockAppUpdateOne, mockPostingFindById, mockUsageCreate, mockEventCreate,
  mockCheckATS, mockGetBase, mockGetResume,
} = vi.hoisted(() => ({
  mockAppFindOne: vi.fn(),
  mockAppUpdateOne: vi.fn(),
  mockPostingFindById: vi.fn(),
  mockUsageCreate: vi.fn(),
  mockEventCreate: vi.fn(),
  mockCheckATS: vi.fn(),
  mockGetBase: vi.fn(),
  mockGetResume: vi.fn(),
}))

vi.mock('@shared/services/inngest', () => ({ inngest: { send: vi.fn(), createFunction: vi.fn(() => ({})) } }))
vi.mock('@shared/db/connection', () => ({ connectDB: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@shared/logger', () => ({ logger: { warn: vi.fn() } }))
vi.mock('@shared/db/models', () => ({
  JobApplication: { findOne: mockAppFindOne, updateOne: mockAppUpdateOne },
  JobPosting: { findById: mockPostingFindById },
  UsageRecord: { create: mockUsageCreate },
  ProductEvent: { create: mockEventCreate },
}))
vi.mock('@resume', () => ({ checkATS: mockCheckATS, getResume: mockGetResume, listResumes: vi.fn(), saveResume: vi.fn(), ResumeSchema: { safeParse: vi.fn() } }))
vi.mock('../services/baseResumeService', () => ({ getBaseResume: mockGetBase }))

import { runAtsCheckHandler } from '../jobs/atsCheckJob'
import { xrayHashOf } from '../services/xrayService'

const step = { run: <T,>(_n: string, fn: () => Promise<T> | T) => Promise.resolve(fn()) }
const JD = 'Build services. Node.js required. SQL a plus.'
const CLAIMED = '2026-07-14T12:00:00.000Z'
const EVENT = { data: { userId: 'u1', jobPostingId: 'j1', claimedAt: CLAIMED } }

function reset(app: unknown = { _id: 'app1', atsResult: undefined }) {
  for (const m of [mockAppFindOne, mockAppUpdateOne, mockPostingFindById, mockUsageCreate, mockEventCreate, mockCheckATS, mockGetBase, mockGetResume]) m.mockReset()
  mockAppFindOne.mockResolvedValue(app)
  mockAppUpdateOne.mockResolvedValue({})
  mockPostingFindById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ jdCompressed: gzipSync(Buffer.from(JD)) }) }) })
  mockGetBase.mockResolvedValue({ id: 'base-1', name: 'Base Resume — QA', targetRole: 'QA', skills: [] })
  mockGetResume.mockResolvedValue({ fullText: 'MY RESUME TEXT' })
  mockCheckATS.mockResolvedValue({ score: 72, keywords: { found: ['node.js'], missing: ['sql', 'kafka'], total: 3 } })
  mockUsageCreate.mockResolvedValue({})
  mockEventCreate.mockResolvedValue({})
}

describe('runAtsCheckHandler (Save-gated background one-shot)', () => {
  it('happy path: checkATS against the base resume, result + quota seam + event persisted, marker cleared', async () => {
    reset()
    const r = await runAtsCheckHandler(EVENT, step)
    expect(r).toEqual({ done: true, score: 72, cached: false })
    expect(mockCheckATS).toHaveBeenCalledWith({ resumeText: 'MY RESUME TEXT', jobDescription: JD })
    const update = mockAppUpdateOne.mock.calls[0][1]
    expect(update.$set.atsResult).toMatchObject({ score: 72, missingKeywords: ['sql', 'kafka'], jdHash: xrayHashOf(JD), resumeHash: xrayHashOf('MY RESUME TEXT') })
    // marker clear is CLAIM-SCOPED: only the run's own claim is unset
    const [clearFilter, clearUpdate] = mockAppUpdateOne.mock.calls[1]
    expect(clearFilter).toEqual({ _id: 'app1', atsRequestedAt: new Date(CLAIMED) })
    expect(clearUpdate).toEqual({ $unset: { atsRequestedAt: 1 } })
    expect(mockUsageCreate).toHaveBeenCalledWith({ userId: 'u1', type: 'ats_check' })
    expect(mockEventCreate.mock.calls[0][0]).toMatchObject({ name: 'jobs.ats_score_landed', props: { score: 72 } })
  })

  it('one-shot: a stored result for the CURRENT (resume x JD) pair short-circuits — no model call', async () => {
    reset({ _id: 'app1', atsResult: { score: 61, missingKeywords: [], jdHash: xrayHashOf(JD), resumeHash: xrayHashOf('MY RESUME TEXT'), checkedAt: new Date() } })
    const r = await runAtsCheckHandler(EVENT, step)
    expect(r).toEqual({ done: true, score: 61, cached: true })
    expect(mockCheckATS).not.toHaveBeenCalled()
    expect(mockAppUpdateOne.mock.calls[0][1].$unset).toEqual({ atsRequestedAt: 1 }) // marker still cleared
  })

  it('an EDITED RESUME (same JD) invalidates the result — the pair is the identity (Codex #521)', async () => {
    reset({ _id: 'app1', atsResult: { score: 61, missingKeywords: [], jdHash: xrayHashOf(JD), resumeHash: 'old-resume-hash', checkedAt: new Date() } })
    const r = await runAtsCheckHandler(EVENT, step)
    expect(r).toMatchObject({ done: true, cached: false })
    expect(mockCheckATS).toHaveBeenCalledTimes(1)
  })

  it('a CHANGED JD (hash mismatch) legitimately re-runs the check', async () => {
    reset({ _id: 'app1', atsResult: { score: 61, missingKeywords: [], jdHash: 'stale', checkedAt: new Date() } })
    const r = await runAtsCheckHandler(EVENT, step)
    expect(r).toMatchObject({ done: true, cached: false })
    expect(mockCheckATS).toHaveBeenCalledTimes(1)
  })

  it('Save-gated server-side: no application → skipped, nothing touched', async () => {
    reset(null)
    expect(await runAtsCheckHandler(EVENT, step)).toEqual({ skipped: 'no-application' })
    expect(mockCheckATS).not.toHaveBeenCalled()
    expect(mockAppUpdateOne).not.toHaveBeenCalled()
  })

  it('no resume / model failure both clear the pending marker so the button re-enables', async () => {
    reset()
    mockGetBase.mockResolvedValue(null)
    expect(await runAtsCheckHandler(EVENT, step)).toEqual({ skipped: 'no-resume' })
    expect(mockAppUpdateOne.mock.calls[0][0]).toEqual({ _id: 'app1', atsRequestedAt: new Date(CLAIMED) })
    expect(mockAppUpdateOne.mock.calls[0][1]).toEqual({ $unset: { atsRequestedAt: 1 } })

    reset()
    mockCheckATS.mockRejectedValue(new Error('model down'))
    expect(await runAtsCheckHandler(EVENT, step)).toEqual({ skipped: 'check-failed' })
    expect(mockAppUpdateOne.mock.calls.at(-1)![1]).toEqual({ $unset: { atsRequestedAt: 1 } })
    expect(mockUsageCreate).not.toHaveBeenCalled() // no quota record for a failed run
  })
})
