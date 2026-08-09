/**
 * Phase 2 intake — the load-bearing contracts: idempotency (same person,
 * same job, twice → one candidate, one application, no error), the merge
 * policy (recruiter-entered data survives; newest resume wins), E11000
 * race recovery, and the seen-before signal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))

const mockJob = { findOne: vi.fn(), find: vi.fn() }
const mockCandidate = { create: vi.fn(), findOne: vi.fn() }
const mockApplication = { create: vi.fn(), findOne: vi.fn(), find: vi.fn() }

vi.mock('../models', async () => {
  const actual = await vi.importActual<typeof import('../models')>('../models')
  return {
    ...actual,
    HireJob: {
      findOne: (...a: unknown[]) => mockJob.findOne(...a),
      find: (...a: unknown[]) => mockJob.find(...a),
    },
    HireCandidate: {
      create: (...a: unknown[]) => mockCandidate.create(...a),
      findOne: (...a: unknown[]) => mockCandidate.findOne(...a),
    },
    HireApplication: {
      create: (...a: unknown[]) => mockApplication.create(...a),
      findOne: (...a: unknown[]) => mockApplication.findOne(...a),
      find: (...a: unknown[]) => mockApplication.find(...a),
    },
  }
})

import { intakeCandidate } from '../services/intakeService'
import type { MembershipContext } from '../services/workspaceService'

const CTX = {
  workspace: { _id: 'ws-A', name: 'Acme' },
  membership: { _id: 'm1', userId: 'u1', email: 'hr@acme.com', name: 'HR One', role: 'admin' },
} as unknown as MembershipContext

const OPEN_JOB = { _id: 'job-1', status: 'open', title: 'Backend Engineer', jdText: 'jd' }

/** Chainable stub for HireApplication.find().sort().limit(). */
function findChain(result: unknown[]) {
  return { sort: () => ({ limit: () => Promise.resolve(result) }) }
}

function candidateDoc(overrides: Record<string, unknown> = {}) {
  const modified = { value: false }
  return {
    _id: 'cand-1',
    name: 'Existing Name',
    email: 'jane@example.com',
    phone: undefined,
    resumeText: undefined,
    resumeFileName: undefined,
    save: vi.fn().mockResolvedValue(undefined),
    isModified: () => modified.value,
    set _touch(_: never) {},
    ...overrides,
    // Simplified isModified: our merge helper mutates fields directly, so
    // tests flip this via markModified below when they expect a save.
    markModified: () => {
      modified.value = true
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockJob.findOne.mockResolvedValue(OPEN_JOB)
  mockJob.find.mockReturnValue({ select: () => Promise.resolve([]) })
  mockApplication.find.mockReturnValue(findChain([]))
})

const BASE_INPUT = {
  jobId: 'job-1',
  name: 'Jane Doe',
  email: 'Jane@Example.com',
  resumeText: 'resume body',
  resumeFileName: 'jane.pdf',
  source: 'bulk_upload' as const,
}

describe('intakeCandidate — creation path', () => {
  it('creates candidate + application with lowercased email, source, and audit event', async () => {
    mockCandidate.findOne.mockResolvedValue(null)
    mockCandidate.create.mockResolvedValue({ _id: 'cand-1' })
    mockApplication.findOne.mockResolvedValue(null)
    mockApplication.create.mockResolvedValue({ _id: 'app-1' })

    const result = await intakeCandidate(CTX, BASE_INPUT)

    expect(result).toMatchObject({
      candidateId: 'cand-1',
      applicationId: 'app-1',
      createdCandidate: true,
      createdApplication: true,
      seenBefore: [],
    })
    const cand = mockCandidate.create.mock.calls[0][0]
    expect(cand.email).toBe('jane@example.com')
    expect(cand.source).toBe('bulk_upload')
    expect(cand.createdBy).toBe('u1')
    const app = mockApplication.create.mock.calls[0][0]
    expect(app.stage).toBe('new')
    expect(app.events[0]).toMatchObject({
      type: 'created',
      actorName: 'HR One',
      note: 'via bulk resume upload',
    })
  })

  it('refuses a closed job with 409 JOB_CLOSED', async () => {
    mockJob.findOne.mockResolvedValue({ ...OPEN_JOB, status: 'closed' })
    await expect(intakeCandidate(CTX, BASE_INPUT)).rejects.toMatchObject({ code: 'JOB_CLOSED' })
  })

  it('422s on empty email instead of writing a keyless candidate', async () => {
    await expect(
      intakeCandidate(CTX, { ...BASE_INPUT, email: '   ' }),
    ).rejects.toMatchObject({ code: 'NO_EMAIL' })
    expect(mockCandidate.create).not.toHaveBeenCalled()
  })
})

describe('intakeCandidate — idempotency and merge', () => {
  it('same person re-uploaded: no new rows, newest resume wins, name preserved', async () => {
    const existing = {
      _id: 'cand-1',
      name: 'Recruiter-Entered Name',
      email: 'jane@example.com',
      phone: '+911234567890',
      resumeText: 'old resume',
      resumeFileName: 'old.pdf',
      save: vi.fn().mockResolvedValue(undefined),
      isModified: vi.fn(() => true),
    }
    mockCandidate.findOne.mockResolvedValue(existing)
    mockApplication.findOne.mockResolvedValue({
      _id: 'app-1',
      resumeMatch: undefined,
      save: vi.fn().mockResolvedValue(undefined),
    })

    const result = await intakeCandidate(CTX, BASE_INPUT)

    expect(result.createdCandidate).toBe(false)
    expect(result.createdApplication).toBe(false)
    expect(mockCandidate.create).not.toHaveBeenCalled()
    expect(mockApplication.create).not.toHaveBeenCalled()
    // Merge policy: existing name/phone survive; resume refreshed.
    expect(existing.name).toBe('Recruiter-Entered Name')
    expect(existing.phone).toBe('+911234567890')
    expect(existing.resumeText).toBe('resume body')
    expect(existing.resumeFileName).toBe('jane.pdf')
    expect(existing.save).toHaveBeenCalled()
  })

  it('re-upload refreshes resumeMatch on the existing application', async () => {
    mockCandidate.findOne.mockResolvedValue({
      _id: 'cand-1',
      name: 'Jane',
      email: 'jane@example.com',
      save: vi.fn(),
      isModified: vi.fn(() => false),
    })
    const app = { _id: 'app-1', resumeMatch: undefined as unknown, save: vi.fn().mockResolvedValue(undefined) }
    mockApplication.findOne.mockResolvedValue(app)

    const match = { score: 72, strengths: ['x'], gaps: ['y'], scoredAt: new Date(), jdHash: 'h' }
    await intakeCandidate(CTX, { ...BASE_INPUT, resumeMatch: match })

    expect(app.resumeMatch).toEqual(match)
    expect(app.save).toHaveBeenCalled()
  })

  it('recovers from a lost E11000 race by merging into the winner', async () => {
    mockCandidate.findOne
      .mockResolvedValueOnce(null) // pre-create check
      .mockResolvedValueOnce({
        // re-read after duplicate-key loss
        _id: 'cand-1',
        name: 'Jane',
        email: 'jane@example.com',
        save: vi.fn(),
        isModified: vi.fn(() => false),
      })
    mockCandidate.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }))
    mockApplication.findOne.mockResolvedValue(null)
    mockApplication.create.mockResolvedValue({ _id: 'app-1' })

    const result = await intakeCandidate(CTX, BASE_INPUT)

    expect(result.candidateId).toBe('cand-1')
    expect(result.createdCandidate).toBe(false)
    expect(result.createdApplication).toBe(true)
  })
})

describe('intakeCandidate — seen-before signal', () => {
  it('reports the candidate’s other applications with job titles and stages', async () => {
    mockCandidate.findOne.mockResolvedValue({
      _id: 'cand-1',
      name: 'Jane',
      email: 'jane@example.com',
      save: vi.fn(),
      isModified: vi.fn(() => false),
    })
    mockApplication.findOne.mockResolvedValue({ _id: 'app-NEW', resumeMatch: undefined, save: vi.fn() })
    mockApplication.find.mockReturnValue(
      findChain([
        { _id: 'app-old', jobId: 'job-9', stage: 'shortlist' },
      ]),
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
