import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockGetServerSession,
  mockConnectDB,
  mockGetJobDetail,
  mockIsJobsAccountActive,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockConnectDB: vi.fn(),
  mockGetJobDetail: vi.fn(),
  mockIsJobsAccountActive: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: mockGetServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/db/connection', () => ({ connectDB: mockConnectDB }))
vi.mock('@jobs', () => ({ getJobDetail: mockGetJobDetail }))
vi.mock('@shared/services/jobsAccountFence', () => ({
  isJobsAccountActive: mockIsJobsAccountActive,
}))

import { GET } from '../route'

const USER_ID = '507f1f77bcf86cd799439010'
const JOB_ID = '507f1f77bcf86cd799439011'
const JD = 'Backend role requiring Node.js and MongoDB.'

beforeEach(() => {
  vi.clearAllMocks()
  mockConnectDB.mockResolvedValue(undefined)
  mockIsJobsAccountActive.mockResolvedValue(true)
})

describe('GET /api/jobs/[id] practice handoff', () => {
  it('rejects an inactive stale-JWT account before reading the full detail projection', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
    mockIsJobsAccountActive.mockResolvedValue(false)

    const response = await GET(new Request(`http://localhost/api/jobs/${JOB_ID}`), {
      params: { id: JOB_ID },
    })

    expect(response.status).toBe(401)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
    expect(mockGetJobDetail).not.toHaveBeenCalled()
    expect(mockIsJobsAccountActive).toHaveBeenCalledTimes(1)
  })

  it('discards a prepared detail when deletion commits while the projection is in flight', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
    mockIsJobsAccountActive
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    mockGetJobDetail.mockResolvedValue({
      id: JOB_ID,
      gated: false,
      title: 'Backend Engineer',
      company: 'PhonePe',
      jd: JD,
      practiceRole: 'backend',
      practiceHandoffToken: 'must-not-leak',
    })

    const response = await GET(new Request(`http://localhost/api/jobs/${JOB_ID}`), {
      params: { id: JOB_ID },
    })

    expect(response.status).toBe(401)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    const body = await response.json()
    expect(body).toEqual({ error: 'account unavailable', code: 'ACCOUNT_UNAVAILABLE' })
    expect(body).not.toHaveProperty('jd')
    expect(body).not.toHaveProperty('practiceHandoffToken')
    expect(mockGetJobDetail).toHaveBeenCalledWith(JOB_ID, USER_ID)
    expect(mockIsJobsAccountActive).toHaveBeenCalledTimes(2)
  })

  it('passes through the service-issued role and token for the authenticated user', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
    mockGetJobDetail.mockResolvedValue({
      id: JOB_ID,
      gated: false,
      title: 'Backend Engineer',
      company: 'PhonePe',
      jd: JD,
      practiceRole: 'backend',
      practiceHandoffToken: 'signed-handoff',
    })

    const response = await GET(new Request(`http://localhost/api/jobs/${JOB_ID}`), {
      params: { id: JOB_ID },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mockGetJobDetail).toHaveBeenCalledWith(JOB_ID, USER_ID)
    expect(mockIsJobsAccountActive).toHaveBeenCalledTimes(2)
    expect(await response.json()).toMatchObject({
      practiceRole: 'backend',
      practiceHandoffToken: 'signed-handoff',
    })
  })

  it('never mints a handoff token for the anonymous shell', async () => {
    mockGetServerSession.mockResolvedValue(null)
    mockGetJobDetail.mockResolvedValue({
      id: JOB_ID,
      gated: true,
      title: 'Backend Engineer',
      company: 'PhonePe',
    })

    const response = await GET(new Request(`http://localhost/api/jobs/${JOB_ID}`), {
      params: { id: JOB_ID },
    })

    expect(response.status).toBe(200)
    expect(mockGetJobDetail).toHaveBeenCalledWith(JOB_ID, null)
    expect(await response.json()).not.toHaveProperty('practiceHandoffToken')
  })

  it('marks authenticated projections without a usable JD as private and non-cacheable', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
    mockGetJobDetail.mockResolvedValue({
      id: JOB_ID,
      gated: false,
      title: 'Backend Engineer',
      company: 'PhonePe',
    })

    const response = await GET(new Request(`http://localhost/api/jobs/${JOB_ID}`), {
      params: { id: JOB_ID },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await response.json()).not.toHaveProperty('practiceHandoffToken')
  })

  it('marks authenticated not-found responses as private and non-cacheable', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
    mockGetJobDetail.mockResolvedValue(null)

    const response = await GET(new Request(`http://localhost/api/jobs/${JOB_ID}`), {
      params: { id: JOB_ID },
    })

    expect(response.status).toBe(404)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('prevents anonymous not-found responses from being cached', async () => {
    mockGetServerSession.mockResolvedValue(null)
    mockGetJobDetail.mockResolvedValue(null)

    const response = await GET(new Request(`http://localhost/api/jobs/${JOB_ID}`), {
      params: { id: JOB_ID },
    })

    expect(response.status).toBe(404)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toEqual({ error: 'not found' })
  })

  it('returns a non-cacheable 410 for an anonymous normal archive', async () => {
    mockGetServerSession.mockResolvedValue(null)
    mockGetJobDetail.mockResolvedValue({ unavailable: 'gone' })

    const response = await GET(new Request(`http://localhost/api/jobs/${JOB_ID}`), {
      params: { id: JOB_ID },
    })

    expect(response.status).toBe(410)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toEqual({ error: 'gone' })
  })

  it('returns a private 410 for an authenticated archive non-owner after the account fence', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
    mockGetJobDetail.mockResolvedValue({ unavailable: 'gone' })

    const response = await GET(new Request(`http://localhost/api/jobs/${JOB_ID}`), {
      params: { id: JOB_ID },
    })

    expect(response.status).toBe(410)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await response.json()).toEqual({ error: 'gone' })
    expect(mockIsJobsAccountActive).toHaveBeenCalledTimes(2)
  })

  it('passes an owner archive projection through as private without adding authority', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
    mockGetJobDetail.mockResolvedValue({
      id: JOB_ID,
      gated: false,
      postingState: 'archived',
      title: 'Backend Engineer',
      company: 'PhonePe',
      jd: JD,
      applyOptions: [],
    })

    const response = await GET(new Request(`http://localhost/api/jobs/${JOB_ID}`), {
      params: { id: JOB_ID },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await response.json()).toMatchObject({ postingState: 'archived', applyOptions: [] })
  })
})
