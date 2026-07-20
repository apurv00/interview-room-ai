import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockGetServerSession, mockConnectDB, mockGetJobDetail, mockMint } = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockConnectDB: vi.fn(),
  mockGetJobDetail: vi.fn(),
  mockMint: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: mockGetServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/db/connection', () => ({ connectDB: mockConnectDB }))
vi.mock('@jobs', () => ({ getJobDetail: mockGetJobDetail }))
vi.mock('@jobs/services/practiceHandoff', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@jobs/services/practiceHandoff')>()),
  mintPracticeHandoffToken: mockMint,
}))

import { GET } from '../route'
import { practiceHandoffHashOf } from '@jobs/services/practiceHandoff'

const USER_ID = '507f1f77bcf86cd799439010'
const JOB_ID = '507f1f77bcf86cd799439011'
const JD = 'Backend role requiring Node.js and MongoDB.'

beforeEach(() => {
  vi.clearAllMocks()
  mockConnectDB.mockResolvedValue(undefined)
  mockMint.mockReturnValue('signed-handoff')
})

describe('GET /api/jobs/[id] practice handoff', () => {
  it('adds a user+job+JD-bound token only to the authenticated full projection', async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: USER_ID } })
    mockGetJobDetail.mockResolvedValue({
      id: JOB_ID,
      gated: false,
      title: 'Backend Engineer',
      company: 'PhonePe',
      jd: JD,
    })

    const response = await GET(new Request(`http://localhost/api/jobs/${JOB_ID}`), {
      params: { id: JOB_ID },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await response.json()).toMatchObject({ practiceHandoffToken: 'signed-handoff' })
    expect(mockMint).toHaveBeenCalledWith({
      userId: USER_ID,
      jobId: JOB_ID,
      jdHash: practiceHandoffHashOf(JD),
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
    expect(await response.json()).not.toHaveProperty('practiceHandoffToken')
    expect(mockMint).not.toHaveBeenCalled()
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
    expect(mockMint).not.toHaveBeenCalled()
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
