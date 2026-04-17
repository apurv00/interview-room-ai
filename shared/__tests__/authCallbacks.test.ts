import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockAuthLoggerInfo = vi.fn()
const mockAuthLoggerWarn = vi.fn()
const mockAuthLoggerError = vi.fn()

vi.mock('@shared/logger', () => ({
  authLogger: {
    info: (...args: unknown[]) => mockAuthLoggerInfo(...args),
    warn: (...args: unknown[]) => mockAuthLoggerWarn(...args),
    error: (...args: unknown[]) => mockAuthLoggerError(...args),
  },
}))

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))

const mockUserFindOne = vi.fn()
const mockUserCreate = vi.fn()
const mockUserFindById = vi.fn()

vi.mock('@shared/db/models', () => ({
  User: {
    findOne: (...args: unknown[]) => mockUserFindOne(...args),
    create: (...args: unknown[]) => mockUserCreate(...args),
    findById: () => ({ select: () => ({ lean: () => Promise.resolve(null) }) }),
  },
}))

vi.mock('@shared/db/mongoClient', () => ({
  default: Promise.resolve({}),
}))

vi.mock('@auth/mongodb-adapter', () => ({
  MongoDBAdapter: () => ({}),
}))

vi.mock('next-auth/providers/google', () => ({
  default: vi.fn(() => ({ id: 'google', name: 'Google', type: 'oauth' })),
}))

vi.mock('next-auth/providers/github', () => ({
  default: vi.fn(() => ({ id: 'github', name: 'GitHub', type: 'oauth' })),
}))

import { authOptions } from '@shared/auth/authOptions'

describe('authOptions callbacks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('signIn callback', () => {
    const signIn = authOptions.callbacks!.signIn!

    it('allows sign-in with valid email', async () => {
      const result = await signIn({
        user: { id: '1', email: 'test@example.com' },
        account: { provider: 'google', providerAccountId: '1', type: 'oauth' },
      } as Parameters<typeof signIn>[0])

      expect(result).toBe(true)
      expect(mockAuthLoggerInfo).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'test@example.com', provider: 'google' }),
        'Sign-in attempt',
      )
    })

    it('blocks sign-in when email is null (GitHub private email)', async () => {
      const result = await signIn({
        user: { id: '1', email: null },
        account: { provider: 'github', providerAccountId: '1', type: 'oauth' },
      } as Parameters<typeof signIn>[0])

      expect(result).toBe(false)
      expect(mockAuthLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'github' }),
        expect.stringContaining('no email'),
      )
    })

    it('blocks sign-in when email is undefined', async () => {
      const result = await signIn({
        user: { id: '1' },
        account: { provider: 'github', providerAccountId: '1', type: 'oauth' },
      } as Parameters<typeof signIn>[0])

      expect(result).toBe(false)
    })

    it('blocks sign-in when email is empty string', async () => {
      const result = await signIn({
        user: { id: '1', email: '' },
        account: { provider: 'google', providerAccountId: '1', type: 'oauth' },
      } as Parameters<typeof signIn>[0])

      expect(result).toBe(false)
    })

    it('blocks sign-in with malformed email (no @)', async () => {
      const result = await signIn({
        user: { id: '1', email: 'notanemail' },
        account: { provider: 'google', providerAccountId: '1', type: 'oauth' },
      } as Parameters<typeof signIn>[0])

      expect(result).toBe(false)
      expect(mockAuthLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'notanemail' }),
        expect.stringContaining('malformed email'),
      )
    })

    it('blocks sign-in with malformed email (no domain)', async () => {
      const result = await signIn({
        user: { id: '1', email: 'user@' },
        account: { provider: 'google', providerAccountId: '1', type: 'oauth' },
      } as Parameters<typeof signIn>[0])

      expect(result).toBe(false)
    })

    it('allows sign-in with complex valid email', async () => {
      const result = await signIn({
        user: { id: '1', email: 'user.name+tag@sub.domain.com' },
        account: { provider: 'google', providerAccountId: '1', type: 'oauth' },
      } as Parameters<typeof signIn>[0])

      expect(result).toBe(true)
    })

    it('uses authLogger.info instead of console.log', async () => {
      const consoleSpy = vi.spyOn(console, 'log')

      await signIn({
        user: { id: '1', email: 'test@example.com' },
        account: { provider: 'google', providerAccountId: '1', type: 'oauth' },
      } as Parameters<typeof signIn>[0])

      expect(consoleSpy).not.toHaveBeenCalled()
      expect(mockAuthLoggerInfo).toHaveBeenCalled()
      consoleSpy.mockRestore()
    })
  })

  describe('createUser event', () => {
    const createUser = authOptions.events!.createUser!

    it('creates a Mongoose User record on first sign-in', async () => {
      mockUserFindOne.mockResolvedValue(null)
      mockUserCreate.mockResolvedValue({ email: 'new@example.com' })

      await createUser({ user: { id: '1', email: 'new@example.com', name: 'New User' } } as Parameters<typeof createUser>[0])

      expect(mockUserCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'new@example.com',
          name: 'New User',
          role: 'candidate',
          plan: 'free',
        }),
      )
    })

    it('skips creation when Mongoose User already exists', async () => {
      mockUserFindOne.mockResolvedValue({ email: 'existing@example.com' })

      await createUser({ user: { id: '1', email: 'existing@example.com', name: 'Existing' } } as Parameters<typeof createUser>[0])

      expect(mockUserCreate).not.toHaveBeenCalled()
    })

    it('does not throw when User.create fails (try-catch wraps)', async () => {
      mockUserFindOne.mockResolvedValue(null)
      mockUserCreate.mockRejectedValue(new Error('duplicate key'))

      await expect(
        createUser({ user: { id: '1', email: 'dup@example.com', name: 'Dup' } } as Parameters<typeof createUser>[0]),
      ).resolves.toBeUndefined()

      expect(mockAuthLoggerError).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error), email: 'dup@example.com' }),
        expect.stringContaining('createUser event failed'),
      )
    })

    it('does not throw when connectDB fails', async () => {
      const { connectDB } = await import('@shared/db/connection')
      vi.mocked(connectDB).mockRejectedValueOnce(new Error('ECONNREFUSED'))

      await expect(
        createUser({ user: { id: '1', email: 'test@example.com', name: 'Test' } } as Parameters<typeof createUser>[0]),
      ).resolves.toBeUndefined()

      expect(mockAuthLoggerError).toHaveBeenCalled()
    })

    it('early-returns with error log when email is missing', async () => {
      await createUser({ user: { id: '1', email: null, name: 'NoEmail' } } as Parameters<typeof createUser>[0])

      expect(mockUserFindOne).not.toHaveBeenCalled()
      expect(mockUserCreate).not.toHaveBeenCalled()
      expect(mockAuthLoggerError).toHaveBeenCalledWith(
        expect.objectContaining({ userId: '1' }),
        expect.stringContaining('no email'),
      )
    })

    it('derives name from email when name is missing', async () => {
      mockUserFindOne.mockResolvedValue(null)
      mockUserCreate.mockResolvedValue({})

      await createUser({ user: { id: '1', email: 'alice@example.com' } } as Parameters<typeof createUser>[0])

      expect(mockUserCreate).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'alice' }),
      )
    })
  })
})
