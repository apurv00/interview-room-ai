import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  listResumes: vi.fn(),
  getResume: vi.fn(),
  saveResume: vi.fn(),
  deleteResume: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: mocks.getServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@resume/services/resumeService', () => ({
  listResumes: mocks.listResumes,
  getResume: mocks.getResume,
  saveResume: mocks.saveResume,
  deleteResume: mocks.deleteResume,
}))

import { GET, POST } from '../route'

const USER_A_ID = '507f1f77bcf86cd799439010'
const USER_B_ID = '507f1f77bcf86cd799439011'
const validBody = {
  name: 'Tailored resume',
  targetRole: '',
  targetCompany: 'Acme',
  fullText: 'PRIVATE TAILORED RESUME',
}

function request(body: Record<string, unknown>) {
  return new Request('http://localhost/api/resume/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function getRequest(id?: string, originUserId?: string) {
  const url = new URL('http://localhost/api/resume/save')
  if (id) url.searchParams.set('id', id)
  return new Request(url, {
    headers: originUserId !== undefined ? { 'x-origin-user-id': originUserId } : {},
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getServerSession.mockResolvedValue({ user: { id: USER_B_ID } })
  mocks.listResumes.mockResolvedValue({ resumes: [{ id: 'resume-1', name: 'Resume B' }] })
  mocks.getResume.mockResolvedValue({ id: 'resume-1', name: 'Resume B', fullText: 'USER B PRIVATE RESUME' })
  mocks.saveResume.mockResolvedValue({ id: 'resume-1', created: true })
})

describe('GET /api/resume/save session provenance', () => {
  it('rejects a different list origin before any resume read', async () => {
    const response = await GET(getRequest(undefined, USER_A_ID))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      error: 'sign-in session changed',
      code: 'SESSION_CHANGED',
    })
    expect(mocks.listResumes).not.toHaveBeenCalled()
    expect(mocks.getResume).not.toHaveBeenCalled()
  })

  it('rejects a different detail origin before any resume read', async () => {
    const response = await GET(getRequest('resume-1', USER_A_ID))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      error: 'sign-in session changed',
      code: 'SESSION_CHANGED',
    })
    expect(mocks.listResumes).not.toHaveBeenCalled()
    expect(mocks.getResume).not.toHaveBeenCalled()
  })

  it.each([
    ['matching list origin', undefined, USER_B_ID, 'list'],
    ['omitted list origin', undefined, undefined, 'list'],
    ['matching detail origin', 'resume-1', USER_B_ID, 'detail'],
    ['omitted detail origin', 'resume-1', undefined, 'detail'],
  ] as const)('preserves a %s caller', async (_label, id, originUserId, expectedRead) => {
    const response = await GET(getRequest(id, originUserId))

    expect(response.status).toBe(200)
    if (expectedRead === 'list') {
      expect(mocks.listResumes).toHaveBeenCalledWith(USER_B_ID)
      expect(mocks.getResume).not.toHaveBeenCalled()
    } else {
      expect(mocks.getResume).toHaveBeenCalledWith(USER_B_ID, 'resume-1')
      expect(mocks.listResumes).not.toHaveBeenCalled()
    }
  })
})

describe('POST /api/resume/save session provenance', () => {
  it('rejects a different originating user before persistence', async () => {
    const response = await POST(request({ ...validBody, originUserId: USER_A_ID }))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      error: 'sign-in session changed',
      code: 'SESSION_CHANGED',
    })
    expect(mocks.saveResume).not.toHaveBeenCalled()
  })

  it('accepts an exact origin and strips provenance from resume data', async () => {
    const response = await POST(request({ ...validBody, originUserId: USER_B_ID }))

    expect(response.status).toBe(201)
    expect(mocks.saveResume).toHaveBeenCalledWith(
      USER_B_ID,
      validBody,
      { preserveFullText: false },
    )
  })

  it('preserves callers that omit originUserId', async () => {
    const response = await POST(request(validBody))

    expect(response.status).toBe(201)
    expect(mocks.saveResume).toHaveBeenCalledWith(
      USER_B_ID,
      validBody,
      { preserveFullText: false },
    )
  })

  it('does not report success when account deletion fences the embedded resume write', async () => {
    mocks.saveResume.mockResolvedValueOnce({
      error: 'Your account is unavailable. Sign in again before saving.',
      code: 'ACCOUNT_UNAVAILABLE',
    })

    const response = await POST(request(validBody))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: 'Your account is unavailable. Sign in again before saving.',
      code: 'ACCOUNT_UNAVAILABLE',
    })
  })
})
