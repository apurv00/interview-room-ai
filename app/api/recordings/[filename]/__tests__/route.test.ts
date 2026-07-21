import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  connectDB: vi.fn(),
  isJobsAccountActive: vi.fn(),
  withActiveJobsAccountWrite: vi.fn(),
  sessionExists: vi.fn(),
  userExists: vi.fn(),
  getDownloadPresignedUrl: vi.fn(),
  deleteFromR2: vi.fn(),
  isR2Configured: vi.fn(),
  loggerWarn: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: mocks.getServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/db/connection', () => ({ connectDB: mocks.connectDB }))
vi.mock('@shared/services/jobsAccountFence', () => ({
  isJobsAccountActive: mocks.isJobsAccountActive,
  withActiveJobsAccountWrite: mocks.withActiveJobsAccountWrite,
}))
vi.mock('@shared/db/models/InterviewSession', () => ({
  InterviewSession: { exists: mocks.sessionExists },
}))
vi.mock('@shared/db/models/User', () => ({
  User: { exists: mocks.userExists },
}))
vi.mock('@shared/storage/r2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/storage/r2')>()
  return {
    ...actual,
    getDownloadPresignedUrl: mocks.getDownloadPresignedUrl,
    deleteFromR2: mocks.deleteFromR2,
    isR2Configured: mocks.isR2Configured,
  }
})
vi.mock('@shared/logger', () => ({ aiLogger: { warn: mocks.loggerWarn } }))

import { GET } from '../route'

const USER_ID = '507f1f77bcf86cd799439010'
const OWNER_ID = '507f1f77bcf86cd799439011'
const ADMIN_ID = '507f1f77bcf86cd799439012'
const SESSION_ID = '507f1f77bcf86cd799439013'
const OTHER_SESSION_ID = '507f1f77bcf86cd799439014'
const TIMESTAMP = '1721500000000'
const OWN_KEY = `recordings/${USER_ID}/${SESSION_ID}-${TIMESTAMP}.webm`
const FOREIGN_KEY = `recordings/${OWNER_ID}/${SESSION_ID}-${TIMESTAMP}.webm`
const SCREEN_KEY = `recordings/${USER_ID}/${SESSION_ID}-screen-${TIMESTAMP}.webm`
const DOCUMENT_KEY = `documents/${USER_ID}/resume/${TIMESTAMP}-cv.pdf`

function callRoute(key = OWN_KEY) {
  const req = new NextRequest(
    `http://localhost/api/recordings/legacy?key=${encodeURIComponent(key)}`,
  )
  return GET(req, { params: { filename: 'legacy' } })
}

function callPathRoute(filename: string) {
  const req = new NextRequest('http://localhost/api/recordings/legacy')
  return GET(req, { params: { filename } })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getServerSession.mockResolvedValue({ user: { id: USER_ID, role: 'candidate' } })
  mocks.connectDB.mockResolvedValue(undefined)
  mocks.isJobsAccountActive.mockResolvedValue(true)
  mocks.sessionExists.mockResolvedValue({ _id: SESSION_ID })
  mocks.userExists.mockResolvedValue(null)
  mocks.getDownloadPresignedUrl.mockResolvedValue('https://r2.example/download')
  mocks.isR2Configured.mockReturnValue(true)
})

describe('GET /api/recordings/[filename] account and artifact fences', () => {
  it('rejects an inactive requester before configuration or signing work', async () => {
    mocks.isJobsAccountActive.mockResolvedValueOnce(false)

    const response = await callRoute()

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
    expect(mocks.isR2Configured).not.toHaveBeenCalled()
    expect(mocks.getDownloadPresignedUrl).not.toHaveBeenCalled()
  })

  it.each([
    ['literal traversal', `recordings/${USER_ID}/${SESSION_ID}-${TIMESTAMP}.webm/../secret`],
    ['encoded traversal', `recordings/${USER_ID}/%2e%2e/${SESSION_ID}-${TIMESTAMP}.webm`],
    ['double-encoded traversal', `recordings/${USER_ID}/%252e%252e/${SESSION_ID}-${TIMESTAMP}.webm`],
  ])('rejects a %s query key before reference or signing work', async (_label, key) => {
    const response = await callRoute(key)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Invalid key' })
    expect(mocks.sessionExists).not.toHaveBeenCalled()
    expect(mocks.userExists).not.toHaveBeenCalled()
    expect(mocks.getDownloadPresignedUrl).not.toHaveBeenCalled()
  })

  it.each([
    ['literal traversal', `recordings/${USER_ID}/${SESSION_ID}-${TIMESTAMP}.webm/../secret`],
    ['encoded traversal', `recordings/${USER_ID}/%2e%2e/${SESSION_ID}-${TIMESTAMP}.webm`],
    ['double-encoded traversal', `recordings/${USER_ID}/%252e%252e/${SESSION_ID}-${TIMESTAMP}.webm`],
  ])('rejects a %s path parameter after its route-level decode', async (_label, filename) => {
    const response = await callPathRoute(filename)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Invalid key' })
    expect(mocks.sessionExists).not.toHaveBeenCalled()
    expect(mocks.getDownloadPresignedUrl).not.toHaveBeenCalled()
  })

  it('does not widen a syntactically canonical foreign key to a non-admin requester', async () => {
    const response = await callRoute(FOREIGN_KEY)

    expect(response.status).toBe(403)
    expect(mocks.isJobsAccountActive).toHaveBeenCalledTimes(1)
    expect(mocks.sessionExists).not.toHaveBeenCalled()
    expect(mocks.getDownloadPresignedUrl).not.toHaveBeenCalled()
  })

  it('hides an inactive foreign owner from a platform admin', async () => {
    mocks.getServerSession.mockResolvedValue({
      user: { id: ADMIN_ID, role: 'platform_admin' },
    })
    mocks.isJobsAccountActive.mockImplementation(async (userId: string) => userId === ADMIN_ID)

    const response = await callRoute(FOREIGN_KEY)

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'Recording not found' })
    expect(mocks.isJobsAccountActive).toHaveBeenNthCalledWith(1, ADMIN_ID)
    expect(mocks.isJobsAccountActive).toHaveBeenNthCalledWith(2, OWNER_ID)
    expect(mocks.sessionExists).not.toHaveBeenCalled()
    expect(mocks.getDownloadPresignedUrl).not.toHaveBeenCalled()
  })

  it('rechecks the requester after the foreign-owner admission read', async () => {
    mocks.getServerSession.mockResolvedValue({
      user: { id: ADMIN_ID, role: 'platform_admin' },
    })
    mocks.isJobsAccountActive
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    const response = await callRoute(FOREIGN_KEY)

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
    expect(mocks.sessionExists).not.toHaveBeenCalled()
    expect(mocks.getDownloadPresignedUrl).not.toHaveBeenCalled()
  })

  it('requires a live reference before signing a canonical session key', async () => {
    const key = `recordings/${USER_ID}/${OTHER_SESSION_ID}-${TIMESTAMP}.webm`
    mocks.sessionExists.mockResolvedValueOnce(null)

    const response = await callRoute(key)

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'Recording not found' })
    expect(mocks.sessionExists).toHaveBeenCalledWith({
      _id: OTHER_SESSION_ID,
      userId: USER_ID,
      recordingR2Key: key,
    })
    expect(mocks.getDownloadPresignedUrl).not.toHaveBeenCalled()
  })

  it('checks a syntactically canonical screen key against only the screen field', async () => {
    mocks.sessionExists.mockResolvedValueOnce(null)

    const response = await callRoute(SCREEN_KEY)

    expect(response.status).toBe(404)
    expect(mocks.sessionExists).toHaveBeenCalledWith({
      _id: SESSION_ID,
      userId: USER_ID,
      screenRecordingR2Key: SCREEN_KEY,
    })
    expect(mocks.getDownloadPresignedUrl).not.toHaveBeenCalled()
  })

  it('returns exact account-unavailable when deletion removes the pre-sign reference', async () => {
    mocks.sessionExists.mockResolvedValueOnce(null)
    mocks.isJobsAccountActive
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    const response = await callRoute()

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
    expect(mocks.getDownloadPresignedUrl).not.toHaveBeenCalled()
  })

  it('withholds a signed URL when requester deletion crosses signing', async () => {
    mocks.isJobsAccountActive
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    const response = await callRoute()

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
    expect(mocks.getDownloadPresignedUrl).toHaveBeenCalledWith(OWN_KEY)
  })

  it('withholds a signed URL when its live reference disappears', async () => {
    mocks.sessionExists
      .mockResolvedValueOnce({ _id: SESSION_ID })
      .mockResolvedValueOnce(null)

    const response = await callRoute()

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'Recording not found' })
    expect(mocks.getDownloadPresignedUrl).toHaveBeenCalledWith(OWN_KEY)
    expect(mocks.sessionExists).toHaveBeenCalledTimes(2)
  })

  it('returns exact account-unavailable when deletion removes the post-sign reference', async () => {
    mocks.sessionExists
      .mockResolvedValueOnce({ _id: SESSION_ID })
      .mockResolvedValueOnce(null)
    mocks.isJobsAccountActive
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    const response = await callRoute()

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
  })

  it('withholds a foreign-owner URL when that owner becomes inactive during signing', async () => {
    mocks.getServerSession.mockResolvedValue({
      user: { id: ADMIN_ID, role: 'platform_admin' },
    })
    mocks.isJobsAccountActive
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    const response = await callRoute(FOREIGN_KEY)

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'Recording not found' })
    expect(mocks.getDownloadPresignedUrl).toHaveBeenCalledWith(FOREIGN_KEY)
  })

  it('maps requester deletion found after signer failure to the exact terminal response', async () => {
    mocks.isJobsAccountActive
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    mocks.getDownloadPresignedUrl.mockRejectedValueOnce(new Error('signer failed'))

    const response = await callRoute()

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
  })

  it('authorizes a canonical document key through an exact live user reference', async () => {
    mocks.sessionExists.mockResolvedValue(null)
    mocks.userExists.mockResolvedValue({ _id: USER_ID })

    const response = await callRoute(DOCUMENT_KEY)

    expect(response.status).toBe(307)
    expect(mocks.userExists).toHaveBeenCalledTimes(2)
    expect(mocks.userExists).toHaveBeenCalledWith({ _id: USER_ID, resumeR2Key: DOCUMENT_KEY })
    expect(mocks.getDownloadPresignedUrl).toHaveBeenCalledWith(DOCUMENT_KEY)
  })

  it('returns an active owner redirect with a private no-store policy', async () => {
    const response = await callRoute()

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('https://r2.example/download')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mocks.sessionExists).toHaveBeenCalledTimes(2)
    expect(mocks.isJobsAccountActive).toHaveBeenCalledTimes(2)
  })
})
