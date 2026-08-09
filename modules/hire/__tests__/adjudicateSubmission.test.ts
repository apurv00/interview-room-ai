/**
 * Recruiter adjudication — the ONLY sanctioned path that removes public
 * submission evidence (founder ruling 2026-08-09). What matters: it runs
 * under the deletion barrier, it is workspace-scoped, and every action
 * leaves an attributed audit trace, because a document leaving the record
 * without one would turn the retention guarantee into a formality.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@shared/db/connection', () => ({ connectDB: vi.fn().mockResolvedValue(undefined) }))

const txMock = vi.fn()
vi.mock('@shared/services/accountDeletion', () => ({
  withPersonalDataWriteTransaction: (userId: string, work: (s: unknown) => Promise<unknown>) =>
    txMock(userId, work),
}))

const mockApplication = { findOne: vi.fn() }
const mockCandidate = { findOne: vi.fn() }

vi.mock('../models', async () => {
  const actual = await vi.importActual<typeof import('../models')>('../models')
  return {
    ...actual,
    HireApplication: { findOne: (...a: unknown[]) => mockApplication.findOne(...a) },
    HireCandidate: { findOne: (...a: unknown[]) => mockCandidate.findOne(...a) },
    HireJob: { findOne: vi.fn(), find: vi.fn(), updateOne: vi.fn() },
  }
})

import { adjudicateSubmission } from '../services/pipelineService'
import type { MembershipContext } from '../services/workspaceService'

const CTX = {
  workspace: { _id: 'ws-A' },
  membership: { userId: 'u1', email: 'hr@acme.com', name: 'HR One', role: 'admin' },
} as unknown as MembershipContext

const SESSION = { id: 'tx' }

function appDoc(subs: Array<{ resumeText: string; resumeFileName?: string; submittedAt: Date }>) {
  return {
    _id: 'app-1',
    candidateId: 'cand-1',
    applicantSubmissions: subs,
    events: [] as Array<Record<string, unknown>>,
    markModified: vi.fn(),
    save: vi.fn().mockResolvedValue(undefined),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  txMock.mockImplementation(async (_u, work) => work(SESSION))
})

const SUBS = [
  { resumeText: 'submission A', resumeFileName: 'a.pdf', submittedAt: new Date('2026-08-01') },
  { resumeText: 'submission B', resumeFileName: 'b.pdf', submittedAt: new Date('2026-07-01') },
]

describe('promote', () => {
  it('copies the chosen submission to the pool record and records who did it', async () => {
    const app = appDoc([...SUBS])
    const candidate = { _id: 'cand-1', resumeText: 'old pool', save: vi.fn() }
    mockApplication.findOne.mockReturnValue({ session: () => Promise.resolve(app) })
    mockCandidate.findOne.mockReturnValue({ session: () => Promise.resolve(candidate) })

    await adjudicateSubmission(CTX, 'app-1', { index: 0, action: 'promote' })

    expect(candidate.resumeText).toBe('submission A')
    expect(app.applicantSubmissions).toHaveLength(2) // promote removes nothing
    expect(app.events[0]).toMatchObject({
      type: 'submission_promoted',
      actorUserId: 'u1',
      actorName: 'HR One',
    })
  })
})

describe('delete', () => {
  it('removes only the chosen submission and leaves an attributed trace', async () => {
    const app = appDoc([...SUBS])
    mockApplication.findOne.mockReturnValue({ session: () => Promise.resolve(app) })

    await adjudicateSubmission(CTX, 'app-1', { index: 0, action: 'delete' })

    expect(app.applicantSubmissions).toHaveLength(1)
    expect(app.applicantSubmissions[0].resumeText).toBe('submission B')
    // Deletion without attribution would make retention a formality.
    expect(app.events[0]).toMatchObject({ type: 'submission_deleted', actorUserId: 'u1' })
    expect(app.events[0].note).toContain('a.pdf')
  })
})

describe('guards', () => {
  it('runs under the account-deletion write barrier', async () => {
    mockApplication.findOne.mockReturnValue({ session: () => Promise.resolve(appDoc([...SUBS])) })
    await adjudicateSubmission(CTX, 'app-1', { index: 1, action: 'delete' })
    expect(txMock).toHaveBeenCalledWith('u1', expect.any(Function))
  })

  it('is workspace-scoped', async () => {
    mockApplication.findOne.mockReturnValue({ session: () => Promise.resolve(appDoc([...SUBS])) })
    await adjudicateSubmission(CTX, 'app-1', { index: 0, action: 'delete' })
    expect(mockApplication.findOne.mock.calls[0][0]).toMatchObject({ workspaceId: 'ws-A' })
  })

  it('404s an out-of-range index instead of mutating anything', async () => {
    const app = appDoc([...SUBS])
    mockApplication.findOne.mockReturnValue({ session: () => Promise.resolve(app) })
    await expect(
      adjudicateSubmission(CTX, 'app-1', { index: 9, action: 'delete' }),
    ).rejects.toThrow()
    expect(app.save).not.toHaveBeenCalled()
  })
})
