/**
 * Contract test for GET /api/interviews/[id]/bootstrap.
 *
 * Verifies two invariants that matter for B2B candidate safety:
 *
 *   1. Strict owner check — a recruiter sharing the same org as the
 *      session CANNOT bootstrap it. This is the recruiter-private
 *      /hire UI's job, not this endpoint's.
 *
 *   2. Allowlist response — recruiterNotes (recruiter's private notes
 *      on the candidate), inviteTokenHash, templateId, candidateEmail,
 *      and recordingR2Key MUST NOT appear in the response even though
 *      they live on the session document.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import mongoose from 'mongoose'

// ─── Hoisted mocks (run before route import) ───────────────────────────────

const { mockGetServerSession } = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
}))
vi.mock('next-auth', () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}))

vi.mock('@shared/auth/authOptions', () => ({
  authOptions: {},
}))

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))

const { mockSessionFindById, mockOrgFindById } = vi.hoisted(() => ({
  mockSessionFindById: vi.fn(),
  mockOrgFindById: vi.fn(),
}))
vi.mock('@shared/db/models', () => ({
  InterviewSession: { findById: (...args: unknown[]) => mockSessionFindById(...args) },
  Organization: { findById: (...args: unknown[]) => mockOrgFindById(...args) },
}))

vi.mock('@shared/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { GET } from '../route'

const CANDIDATE_USER_ID = new mongoose.Types.ObjectId().toString()
const RECRUITER_USER_ID = new mongoose.Types.ObjectId().toString()
const ORG_ID = new mongoose.Types.ObjectId().toString()
const SESSION_ID = new mongoose.Types.ObjectId().toString()

function buildSessionDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: SESSION_ID,
    userId: { toString: () => CANDIDATE_USER_ID },
    organizationId: { toString: () => ORG_ID },
    config: {
      role: 'software-engineer',
      interviewType: 'behavioral',
      experience: '3-6',
      duration: 30,
    },
    jobDescription: 'Build great software.',
    jdFileName: 'jd.pdf',
    candidateName: 'Alex Candidate',
    persona: 'friendly',
    // Fields that MUST NOT leak into the response:
    recruiterNotes: 'seemed weak on system design in phone screen',
    inviteTokenHash: 'should-not-appear-in-response',
    templateId: 'template-abc',
    candidateEmail: 'alex@example.com',
    recordingR2Key: 'r2/recording.webm',
    status: 'created',
    ...overrides,
  }
}

function buildQuery(doc: unknown) {
  return {
    select: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue(doc),
  }
}

describe('GET /api/interviews/[id]/bootstrap', () => {
  beforeEach(() => {
    mockGetServerSession.mockReset()
    mockSessionFindById.mockReset()
    mockOrgFindById.mockReset()
  })

  function callRoute(sessionId = SESSION_ID) {
    return GET(
      new NextRequest(`http://localhost/api/interviews/${sessionId}/bootstrap`),
      { params: { id: sessionId } },
    )
  }

  it('returns 400 for a non-ObjectId session id', async () => {
    const res = await callRoute('not-an-objectid')
    expect(res.status).toBe(400)
  })

  it('returns 401 when no session cookie is present', async () => {
    mockGetServerSession.mockResolvedValue(null)
    const res = await callRoute()
    expect(res.status).toBe(401)
  })

  it('returns 404 when the session does not exist', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: CANDIDATE_USER_ID } })
    mockSessionFindById.mockReturnValue(buildQuery(null))
    const res = await callRoute()
    expect(res.status).toBe(404)
  })

  it('returns 403 when a recruiter in the same org (but not the owner) tries to bootstrap', async () => {
    mockGetServerSession.mockResolvedValue({
      user: {
        id: RECRUITER_USER_ID,
        role: 'recruiter',
        organizationId: ORG_ID,
      },
    })
    mockSessionFindById.mockReturnValue(buildQuery(buildSessionDoc()))
    const res = await callRoute()
    // Recruiters have org-scope access via the general session endpoint;
    // this endpoint is owner-only by design. Without this guard the
    // recruiter could read the session through the candidate's bootstrap
    // channel and bypass the allowlist-response stripping.
    expect(res.status).toBe(403)
  })

  it('returns 200 with the allowlisted config for the candidate owner', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: CANDIDATE_USER_ID } })
    mockSessionFindById.mockReturnValue(buildQuery(buildSessionDoc()))
    mockOrgFindById.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue({ name: 'Acme Corp' }),
    })

    const res = await callRoute()
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body).toEqual({
      config: {
        role: 'software-engineer',
        interviewType: 'behavioral',
        experience: '3-6',
        duration: 30,
        jobDescription: 'Build great software.',
        jdFileName: 'jd.pdf',
        persona: 'friendly',
      },
      candidateName: 'Alex Candidate',
      orgName: 'Acme Corp',
    })
  })

  it('NEVER leaks recruiterNotes, inviteTokenHash, templateId, candidateEmail, or recordingR2Key', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: CANDIDATE_USER_ID } })
    mockSessionFindById.mockReturnValue(buildQuery(buildSessionDoc()))
    mockOrgFindById.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue(null),
    })

    const res = await callRoute()
    const body = await res.json()
    const flat = JSON.stringify(body)

    // Critical: these fields live on the session doc but are recruiter-
    // private or security-sensitive. If any of them appears in the
    // response the candidate has a path to information they shouldn't.
    expect(flat).not.toContain('seemed weak on system design')
    expect(flat).not.toContain('should-not-appear-in-response')
    expect(flat).not.toContain('template-abc')
    expect(flat).not.toContain('alex@example.com')
    expect(flat).not.toContain('r2/recording.webm')
  })

  it('omits optional context fields when they are not on the doc', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: CANDIDATE_USER_ID } })
    mockSessionFindById.mockReturnValue(
      buildQuery(
        buildSessionDoc({
          jobDescription: undefined,
          jdFileName: undefined,
          resumeText: undefined,
          resumeFileName: undefined,
          persona: undefined,
          candidateName: undefined,
          organizationId: undefined,
        }),
      ),
    )

    const res = await callRoute()
    const body = await res.json()
    expect(body.config).toEqual({
      role: 'software-engineer',
      interviewType: 'behavioral',
      experience: '3-6',
      duration: 30,
    })
    expect(body.candidateName).toBeUndefined()
    expect(body.orgName).toBeUndefined()
    // Organization.findById must not be called when the session has no org.
    expect(mockOrgFindById).not.toHaveBeenCalled()
  })

  it('returns 500 when the DB throws', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: CANDIDATE_USER_ID } })
    mockSessionFindById.mockImplementation(() => {
      throw new Error('mongo down')
    })
    const res = await callRoute()
    expect(res.status).toBe(500)
  })
})
