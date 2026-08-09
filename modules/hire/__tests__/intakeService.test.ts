/**
 * Phase 2 intake — the load-bearing contracts: ALL writes run inside
 * withPersonalDataWriteTransaction (the account-deletion write barrier),
 * idempotency (same person, same job, twice → one candidate, one
 * application), the merge policy (recruiter-entered data survives; newest
 * resume wins), resume/score coherence (failed rescore CLEARS the old
 * match; sibling applications get flagged stale), E11000 whole-transaction
 * retry, and the seen-before signal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))

const txMock = vi.fn()
vi.mock('@shared/services/accountDeletion', () => ({
  withPersonalDataWriteTransaction: (
    userId: string,
    work: (session: unknown, userObjectId: unknown) => Promise<unknown>,
  ) => txMock(userId, work),
}))

const mockJob = { findOne: vi.fn(), find: vi.fn(), updateOne: vi.fn() }
const mockCandidate = { create: vi.fn(), findOne: vi.fn() }
const mockApplication = { create: vi.fn(), findOne: vi.fn(), find: vi.fn(), updateMany: vi.fn() }

vi.mock('../models', async () => {
  const actual = await vi.importActual<typeof import('../models')>('../models')
  return {
    ...actual,
    HireJob: {
      findOne: (...a: unknown[]) => mockJob.findOne(...a),
      find: (...a: unknown[]) => mockJob.find(...a),
      updateOne: (...a: unknown[]) => mockJob.updateOne(...a),
    },
    HireCandidate: {
      create: (...a: unknown[]) => mockCandidate.create(...a),
      findOne: (...a: unknown[]) => mockCandidate.findOne(...a),
    },
    HireApplication: {
      create: (...a: unknown[]) => mockApplication.create(...a),
      findOne: (...a: unknown[]) => mockApplication.findOne(...a),
      find: (...a: unknown[]) => mockApplication.find(...a),
      updateMany: (...a: unknown[]) => mockApplication.updateMany(...a),
    },
  }
})

import { intakeCandidate, intakeFromApplyPage } from '../services/intakeService'
import type { MembershipContext } from '../services/workspaceService'

const CTX = {
  workspace: { _id: 'ws-A', name: 'Acme' },
  membership: { _id: 'm1', userId: 'u1', email: 'hr@acme.com', name: 'HR One', role: 'admin' },
} as unknown as MembershipContext

const OPEN_JOB = { _id: 'job-1', status: 'open', title: 'Backend Engineer', jdText: 'jd' }
const SESSION = { id: 'tx-session' }

/** In-transaction findOne returns a .session() chain. */
function inTx(doc: unknown) {
  return { session: () => Promise.resolve(doc) }
}

/** seen-before chain: find().sort().limit(). */
function findChain(result: unknown[]) {
  return { sort: () => ({ limit: () => Promise.resolve(result) }) }
}

function candidateDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'cand-1',
    name: 'Existing Name',
    email: 'jane@example.com',
    phone: undefined as string | undefined,
    resumeText: undefined as string | undefined,
    resumeFileName: undefined as string | undefined,
    save: vi.fn().mockResolvedValue(undefined),
    isModified: vi.fn(() => true),
    ...overrides,
  }
}

function applicationDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'app-1',
    resumeMatch: undefined as unknown,
    save: vi.fn().mockResolvedValue(undefined),
    markModified: vi.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  txMock.mockImplementation(async (_userId, work) => work(SESSION, 'u1-oid'))
  mockJob.findOne.mockResolvedValue(OPEN_JOB)
  mockJob.find.mockReturnValue({ select: () => Promise.resolve([]) })
  mockJob.updateOne.mockResolvedValue({ matchedCount: 1 })
  mockApplication.find.mockReturnValue(findChain([]))
  mockApplication.updateMany.mockResolvedValue({ modifiedCount: 0 })
})

const MATCH = {
  score: 72,
  strengths: ['x'],
  gaps: ['y'],
  scoredAt: new Date(),
  jdHash: 'jd-hash',
  resumeHash: 'resume-hash',
}

const BASE_INPUT = {
  jobId: 'job-1',
  name: 'Jane Doe',
  email: 'Jane@Example.com',
  resumeText: 'resume body',
  resumeFileName: 'jane.pdf',
  source: 'bulk_upload' as const,
}

describe('write authority (the deletion barrier)', () => {
  it('runs ALL writes inside withPersonalDataWriteTransaction for the acting recruiter', async () => {
    mockCandidate.findOne.mockReturnValue(inTx(null))
    mockCandidate.create.mockResolvedValue([{ _id: 'cand-1' }])
    mockApplication.findOne.mockReturnValue(inTx(null))
    mockApplication.create.mockResolvedValue([{ _id: 'app-1' }])

    await intakeCandidate(CTX, BASE_INPUT)

    expect(txMock).toHaveBeenCalledTimes(1)
    expect(txMock.mock.calls[0][0]).toBe('u1')
    // Every write op received the transaction session.
    expect(mockCandidate.create.mock.calls[0][1]).toEqual({ session: SESSION })
    expect(mockApplication.create.mock.calls[0][1]).toEqual({ session: SESSION })
  })

  it('propagates the barrier rejection (deletion in progress) without writing', async () => {
    const blocked = Object.assign(new Error('deletion pending'), { code: 'ACCOUNT_DELETION_PENDING' })
    txMock.mockRejectedValue(blocked)
    await expect(intakeCandidate(CTX, BASE_INPUT)).rejects.toBe(blocked)
    expect(mockCandidate.create).not.toHaveBeenCalled()
  })
})

describe('creation path', () => {
  it('creates candidate + application with lowercased email, source, and audit event', async () => {
    mockCandidate.findOne.mockReturnValue(inTx(null))
    mockCandidate.create.mockResolvedValue([{ _id: 'cand-1' }])
    mockApplication.findOne.mockReturnValue(inTx(null))
    mockApplication.create.mockResolvedValue([{ _id: 'app-1' }])

    const result = await intakeCandidate(CTX, BASE_INPUT)

    expect(result).toMatchObject({
      candidateId: 'cand-1',
      applicationId: 'app-1',
      createdCandidate: true,
      createdApplication: true,
      seenBefore: [],
    })
    const cand = mockCandidate.create.mock.calls[0][0][0]
    expect(cand.email).toBe('jane@example.com')
    expect(cand.source).toBe('bulk_upload')
    expect(cand.createdBy).toBe('u1')
    const app = mockApplication.create.mock.calls[0][0][0]
    expect(app.stage).toBe('new')
    expect(app.events[0]).toMatchObject({
      type: 'created',
      actorName: 'HR One',
      note: 'via bulk resume upload',
    })
  })

  it('refuses a closed job with 409 JOB_CLOSED before claiming write authority', async () => {
    mockJob.findOne.mockResolvedValue({ ...OPEN_JOB, status: 'closed' })
    await expect(intakeCandidate(CTX, BASE_INPUT)).rejects.toMatchObject({ code: 'JOB_CLOSED' })
    expect(txMock).not.toHaveBeenCalled()
  })

  it('422s on empty email instead of writing a keyless candidate', async () => {
    await expect(
      intakeCandidate(CTX, { ...BASE_INPUT, email: '   ' }),
    ).rejects.toMatchObject({ code: 'NO_EMAIL' })
    expect(txMock).not.toHaveBeenCalled()
  })
})

describe('idempotency and merge', () => {
  it('same person re-uploaded: no new rows, newest resume wins, name preserved', async () => {
    const existing = candidateDoc({
      phone: '+911234567890',
      resumeText: 'old resume',
      resumeFileName: 'old.pdf',
      name: 'Recruiter-Entered Name',
    })
    mockCandidate.findOne.mockReturnValue(inTx(existing))
    mockApplication.findOne.mockReturnValue(inTx(applicationDoc()))

    // identityConfirmed: fully-different name + different resume otherwise
    // trips the identity-conflict guard by design (covered below).
    const result = await intakeCandidate(CTX, { ...BASE_INPUT, identityConfirmed: true })

    expect(result.createdCandidate).toBe(false)
    expect(result.createdApplication).toBe(false)
    expect(mockCandidate.create).not.toHaveBeenCalled()
    expect(mockApplication.create).not.toHaveBeenCalled()
    expect(existing.name).toBe('Recruiter-Entered Name')
    expect(existing.phone).toBe('+911234567890')
    expect(existing.resumeText).toBe('resume body')
    expect(existing.resumeFileName).toBe('jane.pdf')
    expect(existing.save).toHaveBeenCalledWith({ session: SESSION })
  })

  it('recovers from a lost E11000 race by retrying the WHOLE transaction once', async () => {
    const winner = candidateDoc({ name: 'Jane', isModified: vi.fn(() => false) })
    mockCandidate.findOne
      .mockReturnValueOnce(inTx(null)) // attempt 1: not found
      .mockReturnValueOnce(inTx(winner)) // attempt 2: winner visible
    mockCandidate.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }))
    mockApplication.findOne.mockReturnValue(inTx(null))
    mockApplication.create.mockResolvedValue([{ _id: 'app-1' }])

    const result = await intakeCandidate(CTX, BASE_INPUT)

    expect(txMock).toHaveBeenCalledTimes(2)
    expect(result.candidateId).toBe('cand-1')
    expect(result.createdCandidate).toBe(false)
    expect(result.createdApplication).toBe(true)
  })
})

describe('in-transaction job claim', () => {
  it('409s JOB_CLOSED when the claim misses (job closed between fast-path and transaction)', async () => {
    mockJob.updateOne.mockResolvedValue({ matchedCount: 0 })
    mockCandidate.findOne.mockReturnValue(inTx(null))
    await expect(intakeCandidate(CTX, BASE_INPUT)).rejects.toMatchObject({ code: 'JOB_CLOSED' })
    expect(mockCandidate.create).not.toHaveBeenCalled()
  })

  it('claims via a conflict-inducing WRITE on the job row, inside the session', async () => {
    mockCandidate.findOne.mockReturnValue(inTx(null))
    mockCandidate.create.mockResolvedValue([{ _id: 'cand-1' }])
    mockApplication.findOne.mockReturnValue(inTx(null))
    mockApplication.create.mockResolvedValue([{ _id: 'app-1' }])

    await intakeCandidate(CTX, BASE_INPUT)

    expect(mockJob.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ status: { $ne: 'closed' } }),
      { $inc: { intakeWriteVersion: 1 } },
      { session: SESSION },
    )
  })
})

describe('identity-conflict guard', () => {
  it('422s IDENTITY_CONFLICT: extracted email joins a different-named candidate with a different resume', async () => {
    mockCandidate.findOne.mockReturnValue(
      inTx(candidateDoc({ name: 'Rahul Verma', resumeText: 'old resume of rahul' })),
    )
    await expect(
      intakeCandidate(CTX, { ...BASE_INPUT, name: 'Jane Doe' }),
    ).rejects.toMatchObject({ code: 'IDENTITY_CONFLICT' })
  })

  it('identityConfirmed (recruiter-typed email) bypasses the guard and merges', async () => {
    const existing = candidateDoc({ name: 'Rahul Verma', resumeText: 'old resume of rahul' })
    mockCandidate.findOne.mockReturnValue(inTx(existing))
    mockApplication.findOne.mockReturnValue(inTx(applicationDoc()))

    const result = await intakeCandidate(CTX, {
      ...BASE_INPUT,
      name: 'Jane Doe',
      identityConfirmed: true,
    })

    expect(result.createdCandidate).toBe(false)
    expect(existing.resumeText).toBe('resume body')
  })

  it('overlapping names ("Jane D." vs "Jane Doe") do NOT trip the guard', async () => {
    const existing = candidateDoc({ name: 'Jane D.', resumeText: 'older jane resume' })
    mockCandidate.findOne.mockReturnValue(inTx(existing))
    mockApplication.findOne.mockReturnValue(inTx(applicationDoc()))

    await intakeCandidate(CTX, { ...BASE_INPUT, name: 'Jane Doe' })
    expect(existing.resumeText).toBe('resume body')
  })
})

describe('resume/score coherence', () => {
  it('failed rescore on a replaced resume CLEARS the stale match on this application', async () => {
    const existing = candidateDoc({ resumeText: 'old resume', name: 'Jane' })
    const app = applicationDoc({ resumeMatch: { ...MATCH, score: 90 } })
    mockCandidate.findOne.mockReturnValue(inTx(existing))
    mockApplication.findOne.mockReturnValue(inTx(app))

    // resumeText present (replacement), but NO resumeMatch (analysis failed)
    await intakeCandidate(CTX, { ...BASE_INPUT, resumeMatch: undefined })

    expect(app.resumeMatch).toBeUndefined()
    expect(app.save).toHaveBeenCalledWith({ session: SESSION })
  })

  it('replacing the shared resume flags SIBLING applications stale', async () => {
    const existing = candidateDoc({ resumeText: 'old resume', name: 'Jane' })
    const app = applicationDoc()
    mockCandidate.findOne.mockReturnValue(inTx(existing))
    mockApplication.findOne.mockReturnValue(inTx(app))

    await intakeCandidate(CTX, { ...BASE_INPUT, resumeMatch: MATCH })

    expect(mockApplication.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: 'cand-1',
        _id: { $ne: 'app-1' },
        resumeMatch: { $exists: true },
      }),
      { $set: { 'resumeMatch.stale': true } },
      { session: SESSION },
    )
  })

  it('identical re-upload + FAILED analysis PRESERVES the still-valid match (outage must not wipe evidence)', async () => {
    const existing = candidateDoc({ resumeText: 'resume body', name: 'Jane' })
    const app = applicationDoc({ resumeMatch: { ...MATCH, score: 88 } })
    mockCandidate.findOne.mockReturnValue(inTx(existing))
    mockApplication.findOne.mockReturnValue(inTx(app))

    // Same bytes, no analysis (provider down): the old match is still valid.
    await intakeCandidate(CTX, { ...BASE_INPUT, resumeMatch: undefined })

    expect((app.resumeMatch as { score: number }).score).toBe(88)
    expect(app.save).not.toHaveBeenCalled()
  })

  it('an identical re-upload is NOT a replacement — no staleness sweep', async () => {
    const existing = candidateDoc({ resumeText: 'resume body', name: 'Jane' })
    mockCandidate.findOne.mockReturnValue(inTx(existing))
    mockApplication.findOne.mockReturnValue(inTx(applicationDoc()))

    await intakeCandidate(CTX, { ...BASE_INPUT, resumeMatch: MATCH })

    expect(mockApplication.updateMany).not.toHaveBeenCalled()
  })
})

describe('seen-before signal', () => {
  it('reports the candidate’s other applications with job titles and stages', async () => {
    mockCandidate.findOne.mockReturnValue(inTx(candidateDoc({ name: 'Jane', isModified: vi.fn(() => false), resumeText: 'resume body' })))
    mockApplication.findOne.mockReturnValue(inTx(applicationDoc({ _id: 'app-NEW' })))
    mockApplication.find.mockReturnValue(
      findChain([{ _id: 'app-old', jobId: 'job-9', stage: 'shortlist' }]),
    )
    mockJob.find.mockReturnValue({
      select: () => Promise.resolve([{ _id: 'job-9', title: 'Data Engineer' }]),
    })

    const result = await intakeCandidate(CTX, BASE_INPUT)

    expect(result.seenBefore).toEqual([
      { jobId: 'job-9', jobTitle: 'Data Engineer', stage: 'shortlist' },
    ])
  })
})


describe('public apply-page intake', () => {
  const JOB = { _id: 'job-1', workspaceId: 'ws-A', createdBy: 'owner-1' } as never

  const APPLY_INPUT = {
    name: 'Jane Doe',
    email: 'Jane@Example.com',
    resumeText: 'resume body',
    resumeFileName: 'jane.pdf',
  }

  it('claims write authority against the JOB OWNER, not a member session', async () => {
    mockCandidate.findOne.mockReturnValue(inTx(null))
    mockCandidate.create.mockResolvedValue([{ _id: 'cand-1' }])
    mockApplication.findOne.mockReturnValue(inTx(null))
    mockApplication.create.mockResolvedValue([{ _id: 'app-1' }])

    await intakeFromApplyPage(JOB, APPLY_INPUT)

    // The deletion barrier is claimed on the owner's account: if the
    // recruiter is being deleted, their workspace stops accepting.
    expect(txMock.mock.calls[0][0]).toBe('owner-1')
    expect(mockCandidate.create.mock.calls[0][0][0].source).toBe('apply_page')
  })

  it('records the event with NO actorUserId — nobody on the team did this', async () => {
    mockCandidate.findOne.mockReturnValue(inTx(null))
    mockCandidate.create.mockResolvedValue([{ _id: 'cand-1' }])
    mockApplication.findOne.mockReturnValue(inTx(null))
    mockApplication.create.mockResolvedValue([{ _id: 'app-1' }])

    await intakeFromApplyPage(JOB, APPLY_INPUT)

    const event = mockApplication.create.mock.calls[0][0][0].events[0]
    expect(event.actorUserId).toBeUndefined()
    expect(event.actorName).toBe('Applicant (public apply page)')
    expect(event.note).toBe('via public apply page')
  })

  it('a stranger claiming someone else\'s email does NOT overwrite their résumé — and still gets a normal outcome', async () => {
    // Enumeration defence: throwing here (as the member path does) would
    // tell an anonymous caller that the email exists in this workspace.
    const existing = candidateDoc({ name: 'Rahul Verma', resumeText: 'rahul original resume' })
    mockCandidate.findOne.mockReturnValue(inTx(existing))
    mockApplication.findOne.mockReturnValue(inTx(null))
    mockApplication.create.mockResolvedValue([{ _id: 'app-1' }])

    const result = await intakeFromApplyPage(JOB, { ...APPLY_INPUT, name: 'Jane Doe' })

    // No throw, an application exists, and the stored résumé is untouched.
    expect(result.applicationId).toBe('app-1')
    expect(existing.resumeText).toBe('rahul original resume')
    expect(mockApplication.create.mock.calls[0][0][0].resumeMatch).toBeUndefined()
  })
})
