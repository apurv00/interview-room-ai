import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockGetServerSession, mockConnectDB, mockGetJobDetail } = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockConnectDB: vi.fn(),
  mockGetJobDetail: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: mockGetServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/db/connection', () => ({ connectDB: mockConnectDB }))
vi.mock('@jobs', () => ({ getJobDetail: mockGetJobDetail }))

import { GET } from '../route'

const USER_ID = '507f1f77bcf86cd799439010'
const JOB_ID = '507f1f77bcf86cd799439011'
const JD = 'Backend role requiring Node.js and MongoDB.'

beforeEach(() => {
  vi.clearAllMocks()
  mockConnectDB.mockResolvedValue(undefined)
})

describe('GET /api/jobs/[id] practice handoff', () => {
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
})
