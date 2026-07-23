import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  class MockJobsAccountInactiveError extends Error {}
  return {
    getServerSession: vi.fn(),
    connectDB: vi.fn(),
    withActiveJobsAccountWrite: vi.fn(),
    userFindOne: vi.fn(),
    userUpdateOne: vi.fn(),
    MockJobsAccountInactiveError,
  }
})

vi.mock('next-auth', () => ({ getServerSession: mocks.getServerSession }))
vi.mock('@shared/auth/authOptions', () => ({ authOptions: {} }))
vi.mock('@shared/db/connection', () => ({ connectDB: mocks.connectDB }))
vi.mock('@shared/services/jobsAccountFence', () => ({
  activeJobsAccountFilter: (userId: string) => ({ _id: userId, accountState: 'active' }),
  JobsAccountInactiveError: mocks.MockJobsAccountInactiveError,
  withActiveJobsAccountWrite: mocks.withActiveJobsAccountWrite,
}))
vi.mock('@shared/db/models', () => ({
  User: {
    findOne: mocks.userFindOne,
    updateOne: mocks.userUpdateOne,
  },
}))

import { GET, PATCH } from '../route'

const USER_ID = '507f1f77bcf86cd799439010'
const DB_SESSION = { id: 'session-1' }
const responseFor = (value: unknown) => ({
  select: () => ({
    lean: () => Promise.resolve(value),
  }),
})
const patchRequest = (body: unknown, raw = false) =>
  new Request('http://localhost/api/settings/jobs-email', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: raw ? String(body) : JSON.stringify(body),
  })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getServerSession.mockResolvedValue({ user: { id: USER_ID } })
  mocks.connectDB.mockResolvedValue(undefined)
  mocks.userFindOne.mockReturnValue(responseFor({
    emailPreferences: { jobs: { nudges: true, unsubscribedStreams: [] } },
  }))
  mocks.userUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.withActiveJobsAccountWrite.mockImplementation(
    async (_userId: string, work: (session: unknown) => Promise<unknown>) => work(DB_SESSION),
  )
})

describe('GET /api/settings/jobs-email', () => {
  it('requires authentication before database work', async () => {
    mocks.getServerSession.mockResolvedValueOnce(null)

    const response = await GET()

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
    expect(mocks.connectDB).not.toHaveBeenCalled()
  })

  it('returns the four effective stream preferences and fixed IST delivery hours', async () => {
    mocks.userFindOne.mockReturnValueOnce(responseFor({
      emailPreferences: {
        jobs: {
          nudges: true,
          unsubscribedStreams: ['e0', 'e3', 'e4'],
        },
      },
    }))

    const response = await GET()

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({
      enabled: { e0: false, e1: true, e2: true, e4: false },
      quietHours: {
        label: '08:00 until 21:00 IST',
        timezone: 'Asia/Kolkata',
      },
    })
  })

  it('honors legacy coarse nudge and all-stream suppression', async () => {
    mocks.userFindOne
      .mockReturnValueOnce(responseFor({
        emailPreferences: { jobs: { nudges: false, unsubscribedStreams: [] } },
      }))
      .mockReturnValueOnce(responseFor({
        emailPreferences: { jobs: { nudges: true, unsubscribedStreams: ['all'] } },
      }))

    const coarse = await GET()
    await expect(coarse.json()).resolves.toMatchObject({
      enabled: { e0: true, e1: false, e2: true, e4: false },
    })
    const all = await GET()
    await expect(all.json()).resolves.toMatchObject({
      enabled: { e0: false, e1: false, e2: false, e4: false },
    })
  })

  it('withholds preferences when the active-account read finds no account', async () => {
    mocks.userFindOne.mockReturnValueOnce(responseFor(null))
    const response = await GET()
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' })
    expect(mocks.userFindOne).toHaveBeenCalledWith({
      _id: USER_ID,
      accountState: 'active',
    }, undefined, undefined)
  })
})

describe('PATCH /api/settings/jobs-email', () => {
  it('requires authentication before parsing or database work', async () => {
    mocks.getServerSession.mockResolvedValueOnce(null)

    const response = await PATCH(patchRequest('{bad-json', true))

    expect(response.status).toBe(401)
    expect(mocks.connectDB).not.toHaveBeenCalled()
  })

  it('strictly requires a non-empty partial object of the four active streams', async () => {
    for (const [body, raw] of [
      ['{bad-json', true],
      [{}, false],
      [{ enabled: {} }, false],
      [{ enabled: { e0: true, e1: true, e2: true, e4: true, e3: true } }, false],
      [{ enabled: { e4: 'yes' } }, false],
      [{ enabled: { e1: true }, extra: true }, false],
      [[], false],
    ] as Array<[unknown, boolean]>) {
      const response = await PATCH(patchRequest(body, raw))
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({
        code: 'INVALID_JOBS_EMAIL_PREFERENCES',
      })
    }
    expect(mocks.connectDB).not.toHaveBeenCalled()
    expect(mocks.withActiveJobsAccountWrite).not.toHaveBeenCalled()
  })

  it('merges a partial change with current state instead of clearing a newer unsubscribe', async () => {
    mocks.userFindOne.mockReturnValueOnce(responseFor({
      emailPreferences: {
        jobs: { nudges: true, unsubscribedStreams: ['e4'] },
      },
    }))

    const response = await PATCH(patchRequest({ enabled: { e1: false } }))

    expect(response.status).toBe(200)
    expect(mocks.withActiveJobsAccountWrite).toHaveBeenCalledWith(
      USER_ID,
      expect.any(Function),
    )
    expect(mocks.userUpdateOne).toHaveBeenCalledWith(
      { _id: USER_ID, accountState: 'active' },
      {
        $set: {
          'emailPreferences.jobs.unsubscribedStreams': ['e1', 'e4'],
          'emailPreferences.jobs.nudges': false,
        },
      },
      { session: DB_SESSION },
    )
    await expect(response.json()).resolves.toEqual({
      enabled: { e0: true, e1: false, e2: true, e4: false },
      quietHours: {
        label: '08:00 until 21:00 IST',
        timezone: 'Asia/Kolkata',
      },
    })
  })

  it('partially resubscribes an all marker without reviving hidden legacy E3', async () => {
    mocks.userFindOne.mockReturnValueOnce(responseFor({
      emailPreferences: {
        jobs: { nudges: true, unsubscribedStreams: ['all'] },
      },
    }))

    const response = await PATCH(patchRequest({ enabled: { e0: true } }))

    expect(response.status).toBe(200)
    expect(mocks.userUpdateOne).toHaveBeenCalledWith(
      expect.anything(),
      {
        $set: {
          'emailPreferences.jobs.unsubscribedStreams': ['e1', 'e2', 'e3', 'e4'],
          'emailPreferences.jobs.nudges': false,
        },
      },
      { session: DB_SESSION },
    )
    await expect(response.json()).resolves.toMatchObject({
      enabled: { e0: true, e1: false, e2: false, e4: false },
    })
  })

  it('stores one all marker when every active stream is disabled', async () => {
    const response = await PATCH(patchRequest({
      enabled: { e0: false, e1: false, e2: false, e4: false },
    }))

    expect(response.status).toBe(200)
    expect(mocks.userUpdateOne).toHaveBeenCalledWith(
      expect.anything(),
      {
        $set: {
          'emailPreferences.jobs.unsubscribedStreams': ['all'],
          'emailPreferences.jobs.nudges': false,
        },
      },
      { session: DB_SESSION },
    )
  })

  it('maps an account-deletion transaction race to ACCOUNT_UNAVAILABLE', async () => {
    mocks.withActiveJobsAccountWrite.mockRejectedValueOnce(
      new mocks.MockJobsAccountInactiveError(),
    )

    const response = await PATCH(patchRequest({
      enabled: { e0: true, e1: true, e2: true, e4: true },
    }))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({
      error: 'account unavailable',
      code: 'ACCOUNT_UNAVAILABLE',
    })
    expect(mocks.userUpdateOne).not.toHaveBeenCalled()
  })
})
