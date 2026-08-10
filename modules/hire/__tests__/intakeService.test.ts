/**
 * Phase 2 intake — the load-bearing contracts: ALL writes run inside the
 * Hire-owned active-workspace/member transaction fence,
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
vi.mock('../services/hireWorkspaceWriteFence', () => ({
  withActiveHireWorkspaceWriteTransaction: (
    workspaceId: string,
    memberId: string,
    work: (session: unknown) => Promise<unknown>,
  ) => txMock(workspaceId, memberId, work),
}))

const mockJob = { findOne: vi.fn(), find: vi.fn(), updateOne: vi.fn() }
const mockCandidate = { create: vi.fn(), findOne: vi.fn(), updateOne: vi.fn() }
const mockApplication = {
  create: vi.fn(),
  findOne: vi.fn(),
  find: vi.fn(),
  updateOne: vi.fn(),
  updateMany: vi.fn(),
}

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
      updateOne: (...a: unknown[]) => mockCandidate.updateOne(...a),
    },
    HireApplication: {
      create: (...a: unknown[]) => mockApplication.create(...a),
      findOne: (...a: unknown[]) => mockApplication.findOne(...a),
      find: (...a: unknown[]) => mockApplication.find(...a),
      updateOne: (...a: unknown[]) => mockApplication.updateOne(...a),
      updateMany: (...a: unknown[]) => mockApplication.updateMany(...a),
    },
  }
})

import { intakeCandidate, intakeFromApplyPage } from '../services/intakeService'
import type { MembershipContext } from '../services/workspaceService'

const CTX = {
  workspace: { _id: 'ws-A', name: 'Acme' },
  membership: {
    _id: 'm1',
    userId: 'u1',
    email: 'hr@acme.com',
    name: 'HR One',
    role: 'admin',
  },
} as unknown as MembershipContext

const OPEN_JOB = {
  _id: 'job-1',
  status: 'open',
  title: 'Backend Engineer',
  jdText: 'jd',
}
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
    __v: 0,
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
    __v: 0,
    resumeMatch: undefined as unknown,
    save: vi.fn().mockResolvedValue(undefined),
    markModified: vi.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  txMock.mockImplementation(async (_workspaceId, _memberId, work) =>
    work(SESSION),
  )
  mockJob.findOne.mockResolvedValue(OPEN_JOB)
  mockJob.find.mockReturnValue({ select: () => Promise.resolve([]) })
  mockJob.updateOne.mockResolvedValue({ matchedCount: 1 })
  mockCandidate.updateOne.mockResolvedValue({ matchedCount: 1 })
  mockApplication.updateOne.mockResolvedValue({ matchedCount: 1 })
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
  it('runs ALL writes inside the active Hire workspace/member fence', async () => {
    mockCandidate.findOne.mockReturnValue(inTx(null))
    mockCandidate.create.mockResolvedValue([{ _id: 'cand-1' }])
    mockApplication.findOne.mockReturnValue(inTx(null))
    mockApplication.create.mockResolvedValue([{ _id: 'app-1' }])

    await intakeCandidate(CTX, BASE_INPUT)

    expect(txMock).toHaveBeenCalledTimes(1)
    expect(txMock.mock.calls[0].slice(0, 2)).toEqual(['ws-A', 'm1'])
    // Every write op received the transaction session.
    expect(mockCandidate.create.mock.calls[0][1]).toEqual({ session: SESSION })
    expect(mockApplication.create.mock.calls[0][1]).toEqual({
      session: SESSION,
    })
  })

  it('propagates the barrier rejection (deletion in progress) without writing', async () => {
    const blocked = Object.assign(new Error('deletion pending'), {
      code: 'WORKSPACE_DELETION_PENDING',
    })
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
    expect(cand.createdByMemberId).toBe('m1')
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
    await expect(intakeCandidate(CTX, BASE_INPUT)).rejects.toMatchObject({
      code: 'JOB_CLOSED',
    })
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
    const result = await intakeCandidate(CTX, {
      ...BASE_INPUT,
      identityConfirmed: true,
    })

    expect(result.createdCandidate).toBe(false)
    expect(result.createdApplication).toBe(false)
    expect(mockCandidate.create).not.toHaveBeenCalled()
    expect(mockApplication.create).not.toHaveBeenCalled()
    expect(existing.name).toBe('Recruiter-Entered Name')
    expect(existing.phone).toBe('+911234567890')
    expect(existing.resumeText).toBe('resume body')
    expect(existing.resumeFileName).toBe('jane.pdf')
    expect(mockCandidate.updateOne).toHaveBeenCalledWith(
      {
        _id: 'cand-1',
        workspaceId: 'ws-A',
        email: 'jane@example.com',
        __v: 0,
      },
      {
        $set: {
          resumeText: 'resume body',
          resumeFileName: 'jane.pdf',
        },
        $inc: { __v: 1 },
      },
      { session: SESSION, runValidators: true },
    )
  })

  it('recovers from a lost E11000 race by retrying the WHOLE transaction once', async () => {
    const winner = candidateDoc({
      name: 'Jane',
      isModified: vi.fn(() => false),
    })
    mockCandidate.findOne
      .mockReturnValueOnce(inTx(null)) // attempt 1: not found
      .mockReturnValueOnce(inTx(winner)) // attempt 2: winner visible
    mockCandidate.create.mockRejectedValue(
      Object.assign(new Error('dup'), { code: 11000 }),
    )
    mockApplication.findOne.mockReturnValue(inTx(null))
    mockApplication.create.mockResolvedValue([{ _id: 'app-1' }])

    const result = await intakeCandidate(CTX, BASE_INPUT)

    expect(txMock).toHaveBeenCalledTimes(2)
    expect(result.candidateId).toBe('cand-1')
    expect(result.createdCandidate).toBe(false)
    expect(result.createdApplication).toBe(true)
  })

  it('fails closed when a concurrent candidate update wins the version race', async () => {
    const existing = candidateDoc({
      name: 'Jane Doe',
      resumeText: 'old resume',
    })
    mockCandidate.findOne.mockReturnValue(inTx(existing))
    mockCandidate.updateOne.mockResolvedValue({ matchedCount: 0 })

    await expect(intakeCandidate(CTX, BASE_INPUT)).rejects.toMatchObject({
      code: 'INTAKE_WRITE_CONFLICT',
    })
    expect(mockApplication.findOne).not.toHaveBeenCalled()
  })
})

describe('in-transaction job claim', () => {
  it('409s JOB_CLOSED when the claim misses (job closed between fast-path and transaction)', async () => {
    mockJob.updateOne.mockResolvedValue({ matchedCount: 0 })
    mockCandidate.findOne.mockReturnValue(inTx(null))
    await expect(intakeCandidate(CTX, BASE_INPUT)).rejects.toMatchObject({
      code: 'JOB_CLOSED',
    })
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
      inTx(
        candidateDoc({
          name: 'Rahul Verma',
          resumeText: 'old resume of rahul',
        }),
      ),
    )
    await expect(
      intakeCandidate(CTX, { ...BASE_INPUT, name: 'Jane Doe' }),
    ).rejects.toMatchObject({ code: 'IDENTITY_CONFLICT' })
  })

  it('identityConfirmed (recruiter-typed email) bypasses the guard and merges', async () => {
    const existing = candidateDoc({
      name: 'Rahul Verma',
      resumeText: 'old resume of rahul',
    })
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
    const existing = candidateDoc({
      name: 'Jane D.',
      resumeText: 'older jane resume',
    })
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
    expect(mockApplication.updateOne).toHaveBeenCalledWith(
      {
        _id: 'app-1',
        workspaceId: 'ws-A',
        jobId: 'job-1',
        candidateId: 'cand-1',
        __v: 0,
      },
      { $unset: { resumeMatch: 1 }, $inc: { __v: 1 } },
      { session: SESSION, runValidators: true },
    )
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
    expect(mockApplication.updateOne).not.toHaveBeenCalled()
  })

  it('an identical re-upload is NOT a replacement — no staleness sweep', async () => {
    const existing = candidateDoc({ resumeText: 'resume body', name: 'Jane' })
    mockCandidate.findOne.mockReturnValue(inTx(existing))
    mockApplication.findOne.mockReturnValue(inTx(applicationDoc()))

    await intakeCandidate(CTX, { ...BASE_INPUT, resumeMatch: MATCH })

    expect(mockApplication.updateMany).not.toHaveBeenCalled()
  })

  it('fails closed when a concurrent application update wins the version race', async () => {
    const existing = candidateDoc({
      name: 'Jane Doe',
      resumeText: 'resume body',
    })
    mockCandidate.findOne.mockReturnValue(inTx(existing))
    mockApplication.findOne.mockReturnValue(inTx(applicationDoc()))
    mockApplication.updateOne.mockResolvedValue({ matchedCount: 0 })

    await expect(
      intakeCandidate(CTX, { ...BASE_INPUT, resumeMatch: MATCH }),
    ).rejects.toMatchObject({ code: 'INTAKE_WRITE_CONFLICT' })
  })
})

describe('seen-before signal', () => {
  it('reports the candidate’s other applications with job titles and stages', async () => {
    mockCandidate.findOne.mockReturnValue(
      inTx(
        candidateDoc({
          name: 'Jane',
          isModified: vi.fn(() => false),
          resumeText: 'resume body',
        }),
      ),
    )
    mockApplication.findOne.mockReturnValue(
      inTx(applicationDoc({ _id: 'app-NEW' })),
    )
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
  const JOB = { _id: 'job-1', workspaceId: 'ws-A' } as never

  const APPLY_INPUT = {
    name: 'Jane Doe',
    email: 'Jane@Example.com',
    resumeText: 'resume body',
    resumeFileName: 'jane.pdf',
  }

  it('folds the apply-token hash into the transactional job claim (rotation mid-parse cannot commit)', async () => {
    mockCandidate.findOne.mockReturnValue(inTx(null))
    mockCandidate.create.mockResolvedValue([{ _id: 'cand-1' }])
    mockApplication.findOne.mockReturnValue(inTx(null))
    mockApplication.create.mockResolvedValue([{ _id: 'app-1' }])

    await intakeFromApplyPage(JOB, APPLY_INPUT, {
      authorityMemberId: 'authority-1' as never,
      applyTokenHash: 'hash-abc',
    })

    expect(mockJob.updateOne.mock.calls[0][0]).toMatchObject({
      applyTokenHash: 'hash-abc',
      applyPageEnabled: true,
      status: { $ne: 'closed' },
    })
  })

  it('rejects when the link was rotated or disabled during parsing (claim misses)', async () => {
    mockJob.updateOne.mockResolvedValue({ matchedCount: 0 })
    mockCandidate.findOne.mockReturnValue(inTx(null))
    await expect(
      intakeFromApplyPage(JOB, APPLY_INPUT, {
        authorityMemberId: 'authority-1' as never,
        applyTokenHash: 'stale-hash',
      }),
    ).rejects.toMatchObject({ code: 'JOB_CLOSED' })
  })

  it('claims write authority against the resolved LIVE authority, not a member session', async () => {
    mockCandidate.findOne.mockReturnValue(inTx(null))
    mockCandidate.create.mockResolvedValue([{ _id: 'cand-1' }])
    mockApplication.findOne.mockReturnValue(inTx(null))
    mockApplication.create.mockResolvedValue([{ _id: 'app-1' }])

    await intakeFromApplyPage(JOB, APPLY_INPUT, {
      authorityMemberId: 'authority-1' as never,
      applyTokenHash: 'hash-abc',
    })

    // The barrier claims a member who still EXISTS — binding it to the
    // job's original creator broke every apply link once that member
    // deleted their account (Codex P1 on #615).
    expect(txMock.mock.calls[0].slice(0, 2)).toEqual(['ws-A', 'authority-1'])
    expect(mockCandidate.create.mock.calls[0][0][0].source).toBe('apply_page')
  })

  it('records the event with NO actorUserId — nobody on the team did this', async () => {
    mockCandidate.findOne.mockReturnValue(inTx(null))
    mockCandidate.create.mockResolvedValue([{ _id: 'cand-1' }])
    mockApplication.findOne.mockReturnValue(inTx(null))
    mockApplication.create.mockResolvedValue([{ _id: 'app-1' }])

    await intakeFromApplyPage(JOB, APPLY_INPUT, {
      authorityMemberId: 'authority-1' as never,
      applyTokenHash: 'hash-abc',
    })

    const event = mockApplication.create.mock.calls[0][0][0].events[0]
    expect(event.actorUserId).toBeUndefined()
    expect(event.actorName).toBe('Applicant (public apply page)')
    expect(event.note).toBe('via public apply page')
  })

  it("a stranger claiming someone else's email does NOT overwrite their résumé — and still gets a normal outcome", async () => {
    // Enumeration defence: throwing here (as the member path does) would
    // tell an anonymous caller that the email exists in this workspace.
    const existing = candidateDoc({
      name: 'Rahul Verma',
      resumeText: 'rahul original resume',
    })
    mockCandidate.findOne.mockReturnValue(inTx(existing))
    mockApplication.findOne.mockReturnValue(inTx(null))
    mockApplication.create.mockResolvedValue([{ _id: 'app-1' }])

    const result = await intakeFromApplyPage(
      JOB,
      { ...APPLY_INPUT, name: 'Jane Doe' },
      { authorityMemberId: 'authority-1' as never, applyTokenHash: 'hash-abc' },
    )

    // No throw, an application exists, and the stored résumé is untouched.
    expect(result.applicationId).toBe('app-1')
    expect(existing.resumeText).toBe('rahul original resume')
    // Recorded on the APPLICATION, never discarded (Codex P1 on #615).
    expect(
      mockApplication.create.mock.calls[0][0][0].applicantSubmissions[0]
        .resumeText,
    ).toBe('resume body')
  })
})

describe('quarantined résumé and its score move together (Codex P1 on #615)', () => {
  const JOB2 = { _id: 'job-1', workspaceId: 'ws-A' } as never
  const OPTS = {
    authorityMemberId: 'authority-1' as never,
    applyTokenHash: 'hash-abc',
  }

  it('a REPEAT public submission APPENDS — an anonymous caller can never overwrite evidence', async () => {
    const existing = candidateDoc({
      name: 'Rahul Verma',
      resumeText: 'pool résumé of rahul',
    })
    const app = applicationDoc({
      applicantSubmissions: [
        {
          resumeText: 'FIRST submitted résumé',
          resumeFileName: 'first.pdf',
          submittedAt: new Date(),
          match: { ...MATCH, score: 40 },
        },
      ],
      resumeMatch: { ...MATCH, score: 40 },
    })
    mockCandidate.findOne.mockReturnValue(inTx(existing))
    mockApplication.findOne.mockReturnValue(inTx(app))

    const freshMatch = { ...MATCH, score: 91, resumeHash: 'hash-of-second' }
    await intakeFromApplyPage(
      JOB2,
      {
        name: 'Jane Doe',
        email: 'jane@example.com',
        resumeText: 'SECOND submitted résumé',
        resumeFileName: 'second.pdf',
        resumeMatch: freshMatch,
      },
      OPTS,
    )

    const subs = app.applicantSubmissions as Array<{
      resumeText: string
      match?: { score: number }
    }>
    // Newest first, and the ORIGINAL is still intact beside it.
    expect(subs).toHaveLength(2)
    expect(subs[0].resumeText).toBe('SECOND submitted résumé')
    expect(subs[0].match?.score).toBe(91)
    expect(subs[1].resumeText).toBe('FIRST submitted résumé')
    expect(subs[1].match?.score).toBe(40)
    // Nothing pre-existing was mutated: headline score and pool copy stand.
    expect((app.resumeMatch as { score: number }).score).toBe(40)
    expect(existing.resumeText).toBe('pool résumé of rahul')
    expect(mockApplication.updateOne.mock.calls[0][0]).toEqual({
      _id: 'app-1',
      workspaceId: 'ws-A',
      jobId: 'job-1',
      candidateId: 'cand-1',
      __v: 0,
    })
  })
})

describe('a pool-copy rescore refreshes the score WITHOUT erasing history (Codex P1 on #615)', () => {
  it('advances the headline score and keeps every prior public submission', async () => {
    // Bulk upload (member path) rescoring an application that still holds a
    // quarantined document from an earlier public submission.
    const existing = candidateDoc({
      name: 'Jane Doe',
      resumeText: 'resume body',
    })
    const app = applicationDoc({
      applicantSubmissions: [
        {
          resumeText: 'OBSOLETE public submission',
          resumeFileName: 'old-public.pdf',
          submittedAt: new Date(),
        },
      ],
      resumeMatch: { ...MATCH, score: 30 },
    })
    mockCandidate.findOne.mockReturnValue(inTx(existing))
    mockApplication.findOne.mockReturnValue(inTx(app))

    const poolMatch = { ...MATCH, score: 77, resumeHash: 'hash-of-pool' }
    await intakeCandidate(CTX, {
      ...BASE_INPUT,
      resumeMatch: poolMatch,
      identityConfirmed: true,
    })

    expect((app.resumeMatch as { score: number }).score).toBe(77)
    // The stale document is gone — otherwise the card shows B beside a
    // score computed from A, and staleness anchors to B as well.
    // History is RETAINED — deleting it let anyone with the link, the
    // email and a copy of the pool résumé erase the append-only record.
    const kept = app.applicantSubmissions as Array<{ resumeText: string }>
    expect(kept).toHaveLength(1)
    expect(kept[0].resumeText).toBe('OBSOLETE public submission')
  })
})

describe('append-only submissions are bounded', () => {
  const JOB3 = { _id: 'job-1', workspaceId: 'ws-A' } as never
  it('bounds growth while PINNING the original — flooding cannot evict the genuine first submission', async () => {
    const existing = candidateDoc({
      name: 'Rahul Verma',
      resumeText: 'pool résumé',
    })
    // Newest-first, so the applicant's genuine first submission is LAST.
    const app = applicationDoc({
      applicantSubmissions: [
        { resumeText: 'attacker-2', submittedAt: new Date() },
        { resumeText: 'attacker-1', submittedAt: new Date() },
        { resumeText: 'GENUINE ORIGINAL', submittedAt: new Date() },
      ],
    })
    mockCandidate.findOne.mockReturnValue(inTx(existing))
    mockApplication.findOne.mockReturnValue(inTx(app))

    await intakeFromApplyPage(
      JOB3,
      {
        name: 'Jane',
        email: 'jane@example.com',
        resumeText: 'attacker-3',
        resumeFileName: 'n.pdf',
      },
      { authorityMemberId: 'authority-1' as never, applyTokenHash: 'hash-abc' },
    )

    const subs = app.applicantSubmissions as Array<{ resumeText: string }>
    // Bounded, so the document cannot grow without end...
    expect(subs).toHaveLength(3)
    // ...but the genuine original is PINNED: a newest-first cap alone let a
    // flood of submissions push it out, which made append-only meaningless.
    expect(subs[subs.length - 1].resumeText).toBe('GENUINE ORIGINAL')
    expect(subs[0].resumeText).toBe('attacker-3')
  })
})

describe('anonymous submissions are CREATE-ONLY on an existing candidate (threat-model pass)', () => {
  const JOB4 = { _id: 'job-1', workspaceId: 'ws-A' } as never
  const OPTS4 = {
    authorityMemberId: 'authority-1' as never,
    applyTokenHash: 'hash-abc',
  }

  it('cannot write into the pool record of a candidate who has NO résumé yet', async () => {
    // The common Phase 1 flow: a recruiter adds someone by name + email
    // only. Keying the guard on "is a résumé already there" left this case
    // wide open — an anonymous caller who knew the email could populate
    // the workspace-level record and fire the sibling staleness sweep.
    const existing = candidateDoc({
      name: 'Rahul Verma',
      resumeText: undefined,
      phone: undefined,
      isModified: vi.fn(() => true),
    })
    mockCandidate.findOne.mockReturnValue(inTx(existing))
    mockApplication.findOne.mockReturnValue(inTx(null))
    mockApplication.create.mockResolvedValue([{ _id: 'app-1' }])

    await intakeFromApplyPage(
      JOB4,
      {
        name: 'Jane Doe',
        email: 'jane@example.com',
        phone: '+910000000000',
        resumeText: 'anonymous document',
        resumeFileName: 'anon.pdf',
      },
      OPTS4,
    )

    // Pool record untouched — no résumé, no name, no phone written.
    expect(existing.resumeText).toBeUndefined()
    expect(existing.name).toBe('Rahul Verma')
    expect(existing.phone).toBeUndefined()
    expect(mockCandidate.updateOne).not.toHaveBeenCalled()
    // No sibling staleness sweep triggered by an anonymous caller.
    expect(mockApplication.updateMany).not.toHaveBeenCalled()
    // The document is still captured, on the application.
    expect(
      mockApplication.create.mock.calls[0][0][0].applicantSubmissions[0]
        .resumeText,
    ).toBe('anonymous document')
  })

  it('still becomes the pool résumé when the anonymous caller CREATES the candidate', async () => {
    mockCandidate.findOne.mockReturnValue(inTx(null))
    mockCandidate.create.mockResolvedValue([{ _id: 'cand-new' }])
    mockApplication.findOne.mockReturnValue(inTx(null))
    mockApplication.create.mockResolvedValue([{ _id: 'app-1' }])

    await intakeFromApplyPage(
      JOB4,
      {
        name: 'New Person',
        email: 'new@example.com',
        resumeText: 'first ever',
        resumeFileName: 'f.pdf',
      },
      OPTS4,
    )

    // Creating is allowed; only EDITING an existing record is not.
    expect(mockCandidate.create.mock.calls[0][0][0].resumeText).toBe(
      'first ever',
    )
  })
})
