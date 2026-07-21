import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  connectDB: vi.fn(),
  userFindById: vi.fn(),
  userSelect: vi.fn(),
  userLean: vi.fn(),
  userFindByIdAndUpdate: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: mocks.getServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/db/connection', () => ({ connectDB: mocks.connectDB }))
vi.mock('@shared/db/models', () => ({
  User: {
    findById: (...args: unknown[]) => mocks.userFindById(...args),
    findByIdAndUpdate: (...args: unknown[]) => mocks.userFindByIdAndUpdate(...args),
  },
}))

import { GET, PATCH } from '../route'

const USER_ID = '507f1f77bcf86cd799439011'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getServerSession.mockResolvedValue({ user: { id: USER_ID } })
  mocks.connectDB.mockResolvedValue(undefined)
  mocks.userFindById.mockReturnValue({ select: mocks.userSelect })
  mocks.userSelect.mockReturnValue({ lean: mocks.userLean })
  mocks.userLean.mockResolvedValue({
    targetRole: 'PM',
    resumeText: 'Parsed resume text',
    resumeFileName: 'resume.pdf',
    // A legacy value can still exist in Mongo, but must not be selected or
    // exposed by this profile endpoint.
    resumeR2Key: 'documents/507f1f77bcf86cd799439011/resume.pdf',
  })
  mocks.userFindByIdAndUpdate.mockResolvedValue({ _id: USER_ID })
})

describe('/api/onboarding resume storage boundary', () => {
  it('does not select or return the legacy raw resume object key', async () => {
    const response = await GET()

    expect(response.status).toBe(200)
    const selectedFields = mocks.userSelect.mock.calls[0][0] as string
    expect(selectedFields.split(' ')).not.toContain('resumeR2Key')
    await expect(response.json()).resolves.not.toHaveProperty('resumeR2Key')
  })

  it('strips resumeR2Key from profile mutations while preserving allowed fields', async () => {
    const request = new Request('http://localhost/api/onboarding', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        targetRole: 'Product Manager',
        resumeR2Key: 'documents/another-user/private.pdf',
      }),
    })

    const response = await PATCH(request)

    expect(response.status).toBe(200)
    expect(mocks.userFindByIdAndUpdate).toHaveBeenCalledWith(
      USER_ID,
      { $set: { targetRole: 'Product Manager' } },
      { returnDocument: 'after' },
    )
  })
})
