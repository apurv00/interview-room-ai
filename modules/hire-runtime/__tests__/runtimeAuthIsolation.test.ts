import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  googleProvider: vi.fn((options: unknown) => ({ id: 'google', options })),
  githubProvider: vi.fn((options: unknown) => ({ id: 'github', options })),
  credentialsProvider: vi.fn((options: { id: string }) => ({
    id: options.id,
    type: 'credentials',
    options,
  })),
  connectDB: vi.fn(),
  userFindOne: vi.fn(),
  userFindById: vi.fn(),
  redeemAuthTicket: vi.fn(),
}))

vi.mock('next-auth/providers/google', () => ({ default: mocks.googleProvider }))
vi.mock('next-auth/providers/github', () => ({ default: mocks.githubProvider }))
vi.mock('next-auth/providers/credentials', () => ({
  default: mocks.credentialsProvider,
}))
vi.mock('@auth/mongodb-adapter', () => ({ MongoDBAdapter: vi.fn(() => ({})) }))
vi.mock('@shared/db/connection', () => ({ connectDB: mocks.connectDB }))
vi.mock('@shared/db/mongoClient', () => ({ default: vi.fn() }))
vi.mock('@shared/db/models', () => ({
  User: {
    findById: mocks.userFindById,
    findOne: mocks.userFindOne,
    create: vi.fn(),
  },
}))
vi.mock('@shared/logger', () => ({
  authLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@b2b/services/inviteTicketService', () => ({
  redeemAuthTicket: mocks.redeemAuthTicket,
}))
vi.mock('@modules/hire-runtime/services/handoffAuthTicketService', () => ({
  redeemRuntimeAuthTicket: mocks.redeemAuthTicket,
}))

const RUNTIME_SECRET = 'runtime-secret-isolated-from-b2c'
const B2C_SECRET = 'b2c-secret-must-not-be-used-here'
const USER_ID = '507f1f77bcf86cd799439011'
const ROUND_ID = '507f1f77bcf86cd799439012'
const WORKSPACE_ID = '507f1f77bcf86cd799439013'

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('IPG_SURFACE', 'hire-engine')
  vi.stubEnv('HIRE_RUNTIME_NEXTAUTH_SECRET', RUNTIME_SECRET)
  vi.stubEnv('NEXTAUTH_SECRET', B2C_SECRET)
  // Configure the consumer providers deliberately: a runtime build must
  // still omit them rather than allowing a personal account sign-in.
  vi.stubEnv('GOOGLE_CLIENT_ID', 'consumer-google-id')
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'consumer-google-secret')
  vi.stubEnv('GITHUB_CLIENT_ID', 'consumer-github-id')
  vi.stubEnv('GITHUB_CLIENT_SECRET', 'consumer-github-secret')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Hire runtime NextAuth isolation', () => {
  it('uses a separate host-only secure cookie, secret, and credentials-only provider', async () => {
    const { authOptions } = await import('@shared/auth/authOptions')

    expect(authOptions.secret).toBe(RUNTIME_SECRET)
    expect(authOptions.cookies?.sessionToken).toEqual({
      name: '__Secure-ipg-hire-runtime',
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: true,
      },
    })
    expect(authOptions.cookies?.sessionToken?.options).not.toHaveProperty('domain')
    expect(authOptions.providers.map((provider) => provider.id)).toEqual([
      'invite-otp',
    ])
    expect(mocks.googleProvider).not.toHaveBeenCalled()
    expect(mocks.githubProvider).not.toHaveBeenCalled()
    expect(authOptions.pages).toMatchObject({
      signIn: '/handoff',
      error: '/handoff',
    })
    expect(authOptions.events).toEqual({})
  })

  it('never falls back to the B2C secret when the runtime secret is missing', async () => {
    vi.stubEnv('HIRE_RUNTIME_NEXTAUTH_SECRET', '')
    await expect(import('@shared/auth/authOptions')).rejects.toThrow(
      /HIRE_RUNTIME_NEXTAUTH_SECRET must be set/,
    )
  })

  it('authorizes only the principal in the workspace carried by the one-time ticket', async () => {
    const dbUser = {
      _id: { toString: () => USER_ID },
      email: `round-${ROUND_ID}@guests.interviewprep.internal`,
      name: 'Interview candidate',
      image: null,
    }
    const select = vi.fn().mockResolvedValue(dbUser)
    mocks.redeemAuthTicket.mockResolvedValue({
      userId: USER_ID,
      sessionId: ROUND_ID,
      organizationId: WORKSPACE_ID,
    })
    mocks.userFindOne.mockReturnValue({ select })
    const { authOptions } = await import('@shared/auth/authOptions')
    const provider = authOptions.providers[0] as unknown as {
      options: { authorize(credentials: { ticket: string }): Promise<unknown> }
    }

    await expect(
      provider.options.authorize({ ticket: 'a'.repeat(64) }),
    ).resolves.toMatchObject({
      id: USER_ID,
      organizationId: WORKSPACE_ID,
    })
    expect(mocks.userFindOne).toHaveBeenCalledWith({
      _id: USER_ID,
      organizationId: WORKSPACE_ID,
    })
    expect(mocks.userFindById).not.toHaveBeenCalled()
  })

  it('rejects a runtime ticket that has no workspace boundary before querying User', async () => {
    mocks.redeemAuthTicket.mockResolvedValue({
      userId: USER_ID,
      sessionId: ROUND_ID,
    })
    const { authOptions } = await import('@shared/auth/authOptions')
    const provider = authOptions.providers[0] as unknown as {
      options: { authorize(credentials: { ticket: string }): Promise<unknown> }
    }

    await expect(
      provider.options.authorize({ ticket: 'a'.repeat(64) }),
    ).resolves.toBeNull()
    expect(mocks.userFindOne).not.toHaveBeenCalled()
    expect(mocks.userFindById).not.toHaveBeenCalled()
  })

  it('issues and explicitly refreshes runtime JWTs with id plus exact organization only', async () => {
    const dbUser = {
      _id: { toString: () => USER_ID },
      role: 'candidate',
      organizationId: { toString: () => WORKSPACE_ID },
      plan: 'free',
    }
    mocks.userFindOne.mockResolvedValueOnce(dbUser)
    const { authOptions } = await import('@shared/auth/authOptions')
    const jwt = authOptions.callbacks!.jwt!
    const initial = await jwt({
      token: {},
      user: {
        id: USER_ID,
        email: `round-${ROUND_ID}@guests.interviewprep.internal`,
        organizationId: WORKSPACE_ID,
      },
      account: { provider: 'invite-otp', providerAccountId: USER_ID, type: 'credentials' },
    } as unknown as Parameters<typeof jwt>[0])

    expect(mocks.userFindOne).toHaveBeenNthCalledWith(1, {
      _id: USER_ID,
      organizationId: WORKSPACE_ID,
    })
    expect(initial.organizationId).toBe(WORKSPACE_ID)

    const select = vi.fn().mockResolvedValue(dbUser)
    mocks.userFindOne.mockReturnValueOnce({ select })
    await jwt({
      token: initial,
      user: undefined,
      trigger: 'update',
    } as unknown as Parameters<typeof jwt>[0])

    expect(mocks.userFindOne).toHaveBeenNthCalledWith(2, {
      _id: USER_ID,
      organizationId: WORKSPACE_ID,
    })
    expect(mocks.userFindById).not.toHaveBeenCalled()
    expect(select).toHaveBeenCalledWith('plan role organizationId')
  })

  it('fails a runtime JWT refresh closed when the signed session lost its workspace', async () => {
    const { authOptions } = await import('@shared/auth/authOptions')
    const jwt = authOptions.callbacks!.jwt!

    await expect(jwt({
      token: { userId: USER_ID, role: 'candidate', plan: 'free' },
      user: undefined,
      trigger: 'update',
    } as unknown as Parameters<typeof jwt>[0])).rejects.toThrow(
      /missing its workspace boundary/,
    )
    expect(mocks.userFindOne).not.toHaveBeenCalled()
    expect(mocks.userFindById).not.toHaveBeenCalled()
  })
})
