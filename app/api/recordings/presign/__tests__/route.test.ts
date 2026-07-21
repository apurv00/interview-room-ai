import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  connectDB: vi.fn(),
  isJobsAccountActive: vi.fn(),
  withActiveJobsAccountWrite: vi.fn(),
  findOne: vi.fn(),
  exists: vi.fn(),
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
  InterviewSession: {
    findOne: mocks.findOne,
    exists: mocks.exists,
  },
}))
vi.mock('@shared/storage/r2', () => ({
  getDownloadPresignedUrl: mocks.getDownloadPresignedUrl,
  deleteFromR2: mocks.deleteFromR2,
  isR2Configured: mocks.isR2Configured,
}))
vi.mock('@shared/logger', () => ({ aiLogger: { warn: mocks.loggerWarn } }))

import { GET } from '../route'

const USER_ID = '507f1f77bcf86cd799439010'
const SESSION_ID = '507f1f77bcf86cd799439011'
const RECRUITER_ID = '507f1f77bcf86cd799439012'
const OTHER_SESSION_ID = '507f1f77bcf86cd799439013'
const TIMESTAMP = '1721500000000'
const R2_KEY = `recordings/${USER_ID}/${SESSION_ID}-${TIMESTAMP}.webm`
const SCREEN_R2_KEY = `recordings/${USER_ID}/${SESSION_ID}-screen-${TIMESTAMP}.webm`

function callRoute(kind?: 'camera' | 'screen' | 'audio') {
  const url = new URL('http://localhost/api/recordings/presign')
  url.searchParams.set('sessionId', SESSION_ID)
  if (kind) url.searchParams.set('kind', kind)
  return GET(new NextRequest(url))
}

function returnSession(document: Record<string, unknown> | null) {
  mocks.findOne.mockReturnValue({
    select: vi.fn().mockResolvedValue(document),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getServerSession.mockResolvedValue({ user: { id: USER_ID } })
  mocks.connectDB.mockResolvedValue(undefined)
  mocks.isJobsAccountActive.mockResolvedValue(true)
  mocks.isR2Configured.mockReturnValue(true)
  returnSession({ recordingR2Key: R2_KEY, privacyMode: false })
  mocks.exists.mockResolvedValue({ _id: SESSION_ID })
  mocks.getDownloadPresignedUrl.mockResolvedValue('https://r2.example/signed-replay')
})

describe('GET /api/recordings/presign account and artifact fences', () => {
  it('rejects a deleting requester before reading the retained session', async () => {
    mocks.isJobsAccountActive.mockResolvedValueOnce(false)

    const response = await callRoute()

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
    expect(mocks.findOne).not.toHaveBeenCalled()
    expect(mocks.getDownloadPresignedUrl).not.toHaveBeenCalled()
  })

  it('keeps account-unavailable authoritative during a storage outage', async () => {
    mocks.isJobsAccountActive.mockResolvedValueOnce(false)
    mocks.isR2Configured.mockReturnValue(false)

    const response = await callRoute()

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' })
    expect(mocks.isR2Configured).not.toHaveBeenCalled()
  })

  it('stops when deletion commits during the session lookup', async () => {
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

  it.each([
    ['literal traversal', `recordings/${USER_ID}/${SESSION_ID}-${TIMESTAMP}.webm/../secret`],
    ['encoded traversal', `recordings/${USER_ID}/%2e%2e/${SESSION_ID}-${TIMESTAMP}.webm`],
    ['double-encoded traversal', `recordings/${USER_ID}/%252e%252e/${SESSION_ID}-${TIMESTAMP}.webm`],
  ])('does not sign a stored %s key', async (_label, recordingR2Key) => {
    returnSession({ recordingR2Key, privacyMode: false })

    const response = await callRoute()

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'No recording for this session' })
    expect(mocks.getDownloadPresignedUrl).not.toHaveBeenCalled()
  })

  it.each([
    [
      'foreign owner',
      'camera' as const,
      { recordingR2Key: `recordings/${RECRUITER_ID}/${SESSION_ID}-${TIMESTAMP}.webm` },
    ],
    [
      'different session',
      'camera' as const,
      { recordingR2Key: `recordings/${USER_ID}/${OTHER_SESSION_ID}-${TIMESTAMP}.webm` },
    ],
    [
      'artifact type mismatch',
      'screen' as const,
      { screenRecordingR2Key: R2_KEY },
    ],
  ])('rejects a syntactically canonical %s key', async (_label, kind, document) => {
    returnSession({ ...document, privacyMode: false })

    const response = await callRoute(kind)

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'No recording for this session' })
    expect(mocks.getDownloadPresignedUrl).not.toHaveBeenCalled()
  })

  it('requires the owner session and selected key before signing', async () => {
    returnSession(null)

    const response = await callRoute()

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'Session not found' })
    expect(mocks.getDownloadPresignedUrl).not.toHaveBeenCalled()
  })

  it('withholds a URL signed while deletion crossed the account boundary', async () => {
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
    expect(mocks.getDownloadPresignedUrl).toHaveBeenCalledWith(R2_KEY, 1800)
    expect(mocks.exists).not.toHaveBeenCalled()
  })

  it('withholds a signed URL when its selected live reference disappears', async () => {
    mocks.exists.mockResolvedValueOnce(null)

    const response = await callRoute()

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'No recording for this session' })
    expect(mocks.getDownloadPresignedUrl).toHaveBeenCalledWith(R2_KEY, 1800)
    expect(mocks.exists).toHaveBeenCalledWith({
      _id: SESSION_ID,
      userId: USER_ID,
      recordingR2Key: R2_KEY,
    })
  })

  it('returns exact account-unavailable when deletion removes the post-sign reference', async () => {
    mocks.exists.mockResolvedValueOnce(null)
    mocks.isJobsAccountActive
      .mockResolvedValueOnce(true)
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

  it('prefers account-unavailable when the session read fails during deletion', async () => {
    mocks.findOne.mockReturnValue({
      select: vi.fn().mockRejectedValue(new Error('session sweep interrupted query')),
    })
    mocks.isJobsAccountActive.mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    const response = await callRoute()

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
  })

  it('prefers account-unavailable when signing fails during deletion', async () => {
    mocks.getDownloadPresignedUrl.mockRejectedValue(new Error('signer failed'))
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

  it('does not widen recording ownership for an active organization recruiter', async () => {
    mocks.getServerSession.mockResolvedValue({
      user: { id: RECRUITER_ID, role: 'recruiter', organizationId: '507f1f77bcf86cd799439014' },
    })
    returnSession(null)

    const response = await callRoute()

    expect(response.status).toBe(404)
    expect(mocks.findOne).toHaveBeenCalledWith({
      _id: SESSION_ID,
      userId: RECRUITER_ID,
    })
    expect(mocks.getDownloadPresignedUrl).not.toHaveBeenCalled()
  })

  it('returns a presigned camera URL while its owner and exact reference remain live', async () => {
    const response = await callRoute()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      url: 'https://r2.example/signed-replay',
      kind: 'camera',
      expiresInSeconds: 1800,
    })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mocks.exists).toHaveBeenCalledWith({
      _id: SESSION_ID,
      userId: USER_ID,
      recordingR2Key: R2_KEY,
    })
    expect(mocks.isJobsAccountActive).toHaveBeenCalledTimes(3)
  })

  it('binds a screen replay to the screen field and key type', async () => {
    returnSession({ screenRecordingR2Key: SCREEN_R2_KEY, privacyMode: false })

    const response = await callRoute('screen')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ kind: 'screen' })
    expect(mocks.getDownloadPresignedUrl).toHaveBeenCalledWith(SCREEN_R2_KEY, 1800)
    expect(mocks.exists).toHaveBeenCalledWith({
      _id: SESSION_ID,
      userId: USER_ID,
      screenRecordingR2Key: SCREEN_R2_KEY,
    })
  })
})
