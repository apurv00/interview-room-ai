import { describe, it, expect, vi } from 'vitest'
import { gzipSync } from 'zlib'

const {
  mockAppFindOne, mockAppExists, mockAppUpdateOne, mockPostingFindById, mockPostingExists, mockPostingUpdateOne, mockUsageCreate, mockEventCreate,
  mockCheckATS, mockGetBase, mockGetResume, mockPreparePractice,
  mockIsJobsAccountActive, mockWithActiveJobsAccountWrite,
} = vi.hoisted(() => ({
  mockAppFindOne: vi.fn(),
  mockAppExists: vi.fn(),
  mockAppUpdateOne: vi.fn(),
  mockPostingFindById: vi.fn(),
  mockPostingExists: vi.fn(),
  mockPostingUpdateOne: vi.fn(),
  mockUsageCreate: vi.fn(),
  mockEventCreate: vi.fn(),
  mockCheckATS: vi.fn(),
  mockGetBase: vi.fn(),
  mockGetResume: vi.fn(),
  mockPreparePractice: vi.fn(),
  mockIsJobsAccountActive: vi.fn(),
  mockWithActiveJobsAccountWrite: vi.fn(),
}))

vi.mock('@shared/services/inngest', () => ({ inngest: { send: vi.fn(), createFunction: vi.fn(() => ({})) } }))
vi.mock('@shared/db/connection', () => ({ connectDB: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@shared/logger', () => ({ logger: { warn: vi.fn() } }))
vi.mock('@shared/db/models', () => ({
  JobApplication: { findOne: mockAppFindOne, exists: mockAppExists, updateOne: mockAppUpdateOne },
  JobPosting: { findById: mockPostingFindById, exists: mockPostingExists, updateOne: mockPostingUpdateOne },
  UsageRecord: { create: mockUsageCreate },
  ProductEvent: { create: mockEventCreate },
}))
vi.mock('@resume', () => ({ checkATS: mockCheckATS, getResume: mockGetResume, listResumes: vi.fn(), saveResume: vi.fn(), ResumeSchema: { safeParse: vi.fn() } }))
vi.mock('../services/baseResumeService', () => ({ getBaseResume: mockGetBase }))
vi.mock('../services/practiceHandoff', () => ({ preparePracticeHandoffPosting: mockPreparePractice }))
vi.mock('@shared/services/jobsAccountFence', () => ({
  JobsAccountInactiveError: class JobsAccountInactiveError extends Error {
    constructor(public readonly userId: string) {
      super('account is missing or being deleted')
      this.name = 'JobsAccountInactiveError'
    }
  },
  isJobsAccountActive: mockIsJobsAccountActive,
  withActiveJobsAccountWrite: mockWithActiveJobsAccountWrite,
}))

import { runAtsCheckHandler } from '../jobs/atsCheckJob'
import { xrayHashOf } from '../services/xrayService'
import { JobsAccountInactiveError } from '@shared/services/jobsAccountFence'

const step = { run: <T,>(_n: string, fn: () => Promise<T> | T) => Promise.resolve(fn()) }
const JD = 'Build services. Node.js required. SQL a plus.'
const CLAIMED = '2026-07-14T12:00:00.000Z'
const EVENT = { data: { userId: 'u1', jobPostingId: 'j1', claimedAt: CLAIMED } }
const TRANSACTION_SESSION = { id: 'jobs-account-fence-session' }

function reset(app: unknown = { _id: 'app1', atsResult: undefined }) {
  for (const m of [mockAppFindOne, mockAppExists, mockAppUpdateOne, mockPostingFindById, mockPostingExists, mockPostingUpdateOne, mockUsageCreate, mockEventCreate, mockCheckATS, mockGetBase, mockGetResume, mockPreparePractice, mockIsJobsAccountActive, mockWithActiveJobsAccountWrite]) m.mockReset()
  mockAppFindOne.mockResolvedValue(app)
  mockAppExists.mockResolvedValue({ _id: 'app1' })
  mockAppUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mockPostingFindById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ status: 'open', jdCompressed: gzipSync(Buffer.from(JD)) }) }) })
  mockPostingExists.mockResolvedValue({ _id: 'j1' })
  mockPostingUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mockPreparePractice.mockResolvedValue({ jobDescription: JD, jdHash: 'canonical-sha256', role: 'backend' })
  mockGetBase.mockResolvedValue({ id: 'base-1', name: 'Base Resume — QA', targetRole: 'QA', skills: [] })
  mockGetResume.mockResolvedValue({ fullText: 'MY RESUME TEXT' })
  mockCheckATS.mockResolvedValue({ score: 72, keywords: { found: ['node.js'], missing: ['sql', 'kafka'], total: 3 } })
  mockUsageCreate.mockResolvedValue({})
  mockEventCreate.mockResolvedValue({})
  mockIsJobsAccountActive.mockResolvedValue(true)
  mockWithActiveJobsAccountWrite.mockImplementation(
    async (_userId: string, work: (session: typeof TRANSACTION_SESSION) => Promise<unknown> | unknown) =>
      work(TRANSACTION_SESSION),
  )
}

describe('runAtsCheckHandler (Save-gated background one-shot)', () => {
  it('happy path: checkATS against the base resume, result + quota seam + event persisted, marker cleared', async () => {
    reset()
    const r = await runAtsCheckHandler(EVENT, step)
    expect(r).toEqual({ done: true, score: 72, cached: false })
    expect(mockCheckATS).toHaveBeenCalledWith(
      { resumeText: 'MY RESUME TEXT', jobDescription: JD },
      { beforeProviderCall: expect.any(Function) },
    )
    // ONE claim-scoped atomic write: result + marker clear together, filtered
    // on the claim this run owns
    const [writeFilter, update] = mockAppUpdateOne.mock.calls[0]
    expect(writeFilter).toEqual({ _id: 'app1', atsRequestedAt: new Date(CLAIMED) })
    expect(update.$set.atsResult).toMatchObject({ score: 72, missingKeywords: ['sql', 'kafka'], jdHash: xrayHashOf(JD), resumeHash: xrayHashOf('MY RESUME TEXT') })
    expect(update.$unset).toEqual({ atsRequestedAt: 1 })
    expect(mockPostingUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'j1', status: 'open' }),
      { $inc: { derivedAuthorityRevision: 1 } },
      { session: TRANSACTION_SESSION, timestamps: false },
    )
    expect(mockUsageCreate).toHaveBeenCalledWith(
      [{ userId: 'u1', type: 'ats_check' }],
      { session: TRANSACTION_SESSION },
    )
    expect(mockEventCreate).toHaveBeenCalledWith(
      [expect.objectContaining({ name: 'jobs.ats_score_landed', props: { score: 72 } })],
      { session: TRANSACTION_SESSION },
    )
  })

  it('keeps a persisted ATS result when best-effort bookkeeping fails', async () => {
    reset()
    mockUsageCreate.mockRejectedValueOnce(new Error('analytics unavailable'))

    expect(await runAtsCheckHandler(EVENT, step)).toEqual({ done: true, score: 72, cached: false })
    expect(mockAppUpdateOne).toHaveBeenCalledWith(
      { _id: 'app1', atsRequestedAt: new Date(CLAIMED) },
      expect.objectContaining({
        $set: { atsResult: expect.objectContaining({ score: 72 }) },
        $unset: { atsRequestedAt: 1 },
      }),
      { session: TRANSACTION_SESSION },
    )
    expect(mockEventCreate).not.toHaveBeenCalled()
  })

  it('one-shot: a stored result for the CURRENT (resume x JD) pair short-circuits — no model call', async () => {
    reset({ _id: 'app1', atsResult: { score: 61, missingKeywords: [], jdHash: xrayHashOf(JD), resumeHash: xrayHashOf('MY RESUME TEXT'), checkedAt: new Date() } })
    const r = await runAtsCheckHandler(EVENT, step)
    expect(r).toEqual({ done: true, score: 61, cached: true })
    expect(mockCheckATS).not.toHaveBeenCalled()
    expect(mockAppUpdateOne.mock.calls[0][1].$unset).toEqual({ atsRequestedAt: 1 }) // marker still cleared
  })

  it('a cached ATS result does not outlive source authority lost during resume loading', async () => {
    reset({ _id: 'app1', atsResult: { score: 61, missingKeywords: [], jdHash: xrayHashOf(JD), resumeHash: xrayHashOf('MY RESUME TEXT'), checkedAt: new Date() } })
    mockPostingExists.mockResolvedValueOnce(null)

    expect(await runAtsCheckHandler(EVENT, step)).toEqual({ skipped: 'posting-unavailable' })
    expect(mockCheckATS).not.toHaveBeenCalled()
    expect(mockAppUpdateOne.mock.calls[0][1]).toEqual({ $unset: { atsRequestedAt: 1 } })
  })

  it('an EDITED RESUME (same JD) invalidates the result — the pair is the identity (Codex #521)', async () => {
    reset({ _id: 'app1', atsResult: { score: 61, missingKeywords: [], jdHash: xrayHashOf(JD), resumeHash: 'old-resume-hash', checkedAt: new Date() } })
    const r = await runAtsCheckHandler(EVENT, step)
    expect(r).toMatchObject({ done: true, cached: false })
    expect(mockCheckATS).toHaveBeenCalledTimes(1)
  })

  it('a SUPERSEDED run (claim reclaimed mid-flight) writes nothing — no result, no quota, no event', async () => {
    reset()
    mockAppUpdateOne.mockResolvedValue({ matchedCount: 0 }) // newer claim owns the marker now
    const r = await runAtsCheckHandler(EVENT, step)
    expect(r).toEqual({ skipped: 'superseded' })
    expect(mockUsageCreate).not.toHaveBeenCalled()
    expect(mockEventCreate).not.toHaveBeenCalled()
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

  it('an inactive account is rejected before application reads or provider work', async () => {
    reset()
    mockIsJobsAccountActive.mockResolvedValueOnce(false)

    expect(await runAtsCheckHandler(EVENT, step)).toEqual({ skipped: 'account-inactive' })
    expect(mockAppFindOne).not.toHaveBeenCalled()
    expect(mockCheckATS).not.toHaveBeenCalled()
    expect(mockWithActiveJobsAccountWrite).not.toHaveBeenCalled()
    expect(mockAppUpdateOne).not.toHaveBeenCalled()
    expect(mockUsageCreate).not.toHaveBeenCalled()
    expect(mockEventCreate).not.toHaveBeenCalled()
  })

  it('persists no result, quota, or event when deletion wins the final write fence', async () => {
    reset()
    mockWithActiveJobsAccountWrite.mockRejectedValueOnce(new JobsAccountInactiveError('u1'))

    expect(await runAtsCheckHandler(EVENT, step)).toEqual({ skipped: 'account-inactive' })
    expect(mockCheckATS).toHaveBeenCalledOnce()
    expect(mockAppUpdateOne).not.toHaveBeenCalled()
    expect(mockUsageCreate).not.toHaveBeenCalled()
    expect(mockEventCreate).not.toHaveBeenCalled()
  })

  it('persists no result when source revocation wins the transactional posting fence', async () => {
    reset()
    mockPostingUpdateOne.mockResolvedValueOnce({ matchedCount: 0 })

    expect(await runAtsCheckHandler(EVENT, step)).toEqual({ skipped: 'posting-unavailable' })
    expect(mockPostingUpdateOne).toHaveBeenCalledOnce()
    expect(mockAppUpdateOne).toHaveBeenCalledOnce()
    expect(mockAppUpdateOne.mock.calls[0][1]).toEqual({ $unset: { atsRequestedAt: 1 } })
    expect(mockUsageCreate).not.toHaveBeenCalled()
    expect(mockEventCreate).not.toHaveBeenCalled()
  })

  it('creates no bookkeeping when deletion starts after the ATS result commits', async () => {
    reset()
    let fenceCalls = 0
    mockWithActiveJobsAccountWrite.mockImplementation(
      async (_userId: string, work: (session: typeof TRANSACTION_SESSION) => Promise<unknown> | unknown) => {
        fenceCalls += 1
        if (fenceCalls === 2) throw new JobsAccountInactiveError('u1')
        return work(TRANSACTION_SESSION)
      },
    )

    expect(await runAtsCheckHandler(EVENT, step)).toEqual({ skipped: 'account-inactive' })
    expect(mockAppUpdateOne).toHaveBeenCalledOnce()
    expect(mockUsageCreate).not.toHaveBeenCalled()
    expect(mockEventCreate).not.toHaveBeenCalled()
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

  it('allows a normal owner archive but rejects a restricted posting before model work', async () => {
    reset()
    mockPostingFindById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ status: 'closed', closedReason: 'aged-out' }) }) })
    expect(await runAtsCheckHandler(EVENT, step)).toMatchObject({ done: true, cached: false })

    reset()
    mockPostingFindById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ status: 'closed', closedReason: 'source-revoked' }) }) })
    expect(await runAtsCheckHandler(EVENT, step)).toEqual({ skipped: 'posting-unavailable' })
    expect(mockCheckATS).not.toHaveBeenCalled()
  })

  it('rejects a body or policy change before persisting an ATS artifact', async () => {
    reset()
    mockPreparePractice
      .mockResolvedValueOnce({ jobDescription: JD, jdHash: 'v1' })
      .mockResolvedValueOnce({ jobDescription: `${JD} changed`, jdHash: 'v2' })
    expect(await runAtsCheckHandler(EVENT, step)).toEqual({ skipped: 'posting-changed' })
    expect(mockCheckATS).not.toHaveBeenCalled()

    reset()
    mockPostingFindById
      .mockReturnValueOnce({ select: () => ({ lean: () => Promise.resolve({ status: 'open' }) }) })
      .mockReturnValueOnce({ select: () => ({ lean: () => Promise.resolve({ status: 'open' }) }) })
      .mockReturnValueOnce({ select: () => ({ lean: () => Promise.resolve({ status: 'closed', closedReason: 'llm-verdict' }) }) })
    expect(await runAtsCheckHandler(EVENT, step)).toEqual({ skipped: 'posting-unavailable' })
    expect(mockCheckATS).toHaveBeenCalledOnce()
    expect(mockUsageCreate).not.toHaveBeenCalled()
  })

  it('rechecks exact posting authority before provider egress and fails closed after source revocation', async () => {
    reset()
    mockPostingExists.mockResolvedValueOnce(null)
    mockCheckATS.mockImplementationOnce(async (_data, options) => {
      if (!options?.beforeProviderCall || !(await options.beforeProviderCall())) {
        throw new Error('provider precondition failed')
      }
      return { score: 99, keywords: { missing: [] } }
    })

    expect(await runAtsCheckHandler(EVENT, step)).toEqual({ skipped: 'check-failed' })
    expect(mockCheckATS).toHaveBeenCalledOnce()
    expect(mockPostingExists).toHaveBeenCalledWith(expect.objectContaining({
      _id: 'j1',
      status: 'open',
      closedReason: { $exists: false },
    }))
    expect(mockUsageCreate).not.toHaveBeenCalled()
    expect(mockEventCreate).not.toHaveBeenCalled()
    expect(mockAppUpdateOne.mock.calls.at(-1)![1]).toEqual({ $unset: { atsRequestedAt: 1 } })
  })

  it('does not persist a model result when revocation commits during final CMS preparation', async () => {
    reset()
    mockPostingExists
      .mockResolvedValueOnce({ _id: 'j1' })
      .mockResolvedValueOnce(null)
    mockCheckATS.mockImplementationOnce(async (_data, options) => {
      expect(await options!.beforeProviderCall!()).toBe(true)
      return { score: 88, keywords: { missing: ['kafka'] } }
    })

    expect(await runAtsCheckHandler(EVENT, step)).toEqual({ skipped: 'posting-unavailable' })
    expect(mockPostingExists).toHaveBeenCalledTimes(2)
    expect(mockUsageCreate).not.toHaveBeenCalled()
    expect(mockEventCreate).not.toHaveBeenCalled()
    expect(mockAppUpdateOne).toHaveBeenCalledTimes(1)
    expect(mockAppUpdateOne.mock.calls[0][1]).toEqual({ $unset: { atsRequestedAt: 1 } })
  })
})
