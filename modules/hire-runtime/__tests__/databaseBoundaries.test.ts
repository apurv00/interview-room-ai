import mongoose from 'mongoose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ connectDB: vi.fn() }))

vi.mock('@shared/db/connection', () => ({ connectDB: mocks.connectDB }))

import { connectHireControlDB } from '@hire/services/hireControlBoundary'
import { connectHireRuntimeDB } from '../services/runtimeBoundary'

const originalNameDescriptor = Object.getOwnPropertyDescriptor(
  mongoose.connection,
  'name',
)

function connectedDatabase(name: string) {
  Object.defineProperty(mongoose.connection, 'name', {
    configurable: true,
    value: name,
  })
}

function productionDatabases() {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('B2C_DATABASE_NAME', 'ipg-b2c')
  vi.stubEnv('HIRE_CONTROL_DATABASE_NAME', 'ipg-hire-control')
  vi.stubEnv('HIRE_RUNTIME_DATABASE_NAME', 'ipg-hire-runtime')
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connectDB.mockResolvedValue(undefined)
  productionDatabases()
  vi.stubEnv('MONGODB_URI', 'mongodb://db.example.test/ipg-hire-runtime')
  connectedDatabase('ipg-hire-runtime')
})

afterEach(() => {
  vi.unstubAllEnvs()
  if (originalNameDescriptor) {
    Object.defineProperty(mongoose.connection, 'name', originalNameDescriptor)
  } else {
    Reflect.deleteProperty(mongoose.connection, 'name')
  }
})

describe('isolated Hire database boundaries', () => {
  it('fails before connecting when runtime is invoked on another surface', async () => {
    vi.stubEnv('IPG_SURFACE', 'hire-control')
    await expect(connectHireRuntimeDB()).rejects.toThrow(
      /outside the isolated runtime deployment/,
    )
    expect(mocks.connectDB).not.toHaveBeenCalled()
  })

  it.each(['B2C_DATABASE_NAME', 'HIRE_CONTROL_DATABASE_NAME'] as const)(
    'fails closed in production when runtime sentinel %s is missing',
    async (missing) => {
      vi.stubEnv('IPG_SURFACE', 'hire-engine')
      vi.stubEnv(missing, '')
      await expect(connectHireRuntimeDB()).rejects.toThrow(
        /runtime database boundary is not configured/,
      )
      expect(mocks.connectDB).not.toHaveBeenCalled()
    },
  )

  it('rejects a runtime URI that actually connects to the B2C database', async () => {
    vi.stubEnv('IPG_SURFACE', 'hire-engine')
    vi.stubEnv('MONGODB_URI', 'mongodb://db.example.test/ipg-b2c')
    connectedDatabase('ipg-b2c')

    await expect(connectHireRuntimeDB()).rejects.toThrow(
      /expected ipg-hire-runtime, got ipg-b2c/,
    )
    expect(mocks.connectDB).toHaveBeenCalledOnce()
  })

  it.each(['ipg-b2c', 'ipg-hire-control'])(
    'rejects runtime name aliasing with %s even when the connection name matches',
    async (collidingName) => {
      vi.stubEnv('IPG_SURFACE', 'hire-engine')
      vi.stubEnv('HIRE_RUNTIME_DATABASE_NAME', collidingName)
      connectedDatabase(collidingName)

      await expect(connectHireRuntimeDB()).rejects.toThrow(/must be distinct/)
    },
  )

  it('accepts only the dedicated runtime surface and resolved database', async () => {
    vi.stubEnv('IPG_SURFACE', 'hire-engine')
    await expect(connectHireRuntimeDB()).resolves.toBeUndefined()
    expect(mocks.connectDB).toHaveBeenCalledOnce()
  })

  it('fails before connecting when control DB is invoked on another surface', async () => {
    vi.stubEnv('IPG_SURFACE', 'hire-engine')
    await expect(connectHireControlDB()).rejects.toThrow(/boundary is not configured/)
    expect(mocks.connectDB).not.toHaveBeenCalled()
  })

  it.each(['B2C_DATABASE_NAME', 'HIRE_RUNTIME_DATABASE_NAME'] as const)(
    'fails closed in production when control sentinel %s is missing',
    async (missing) => {
      vi.stubEnv('IPG_SURFACE', 'hire-control')
      vi.stubEnv(missing, '')
      await expect(connectHireControlDB()).rejects.toThrow(
        /control database boundary is not configured/,
      )
      expect(mocks.connectDB).not.toHaveBeenCalled()
    },
  )

  it('rejects a control URI that actually connects to the runtime database', async () => {
    vi.stubEnv('IPG_SURFACE', 'hire-control')
    vi.stubEnv('MONGODB_URI', 'mongodb://db.example.test/ipg-hire-runtime')
    connectedDatabase('ipg-hire-runtime')

    await expect(connectHireControlDB()).rejects.toThrow(
      /expected ipg-hire-control, got ipg-hire-runtime/,
    )
  })

  it.each(['ipg-b2c', 'ipg-hire-runtime'])(
    'rejects control name aliasing with %s even when the connection name matches',
    async (collidingName) => {
      vi.stubEnv('IPG_SURFACE', 'hire-control')
      vi.stubEnv('HIRE_CONTROL_DATABASE_NAME', collidingName)
      connectedDatabase(collidingName)

      await expect(connectHireControlDB()).rejects.toThrow(/must be distinct/)
    },
  )

  it('accepts only the dedicated control surface and resolved database', async () => {
    vi.stubEnv('IPG_SURFACE', 'hire-control')
    vi.stubEnv('MONGODB_URI', 'mongodb://db.example.test/ipg-hire-control')
    connectedDatabase('ipg-hire-control')

    await expect(connectHireControlDB()).resolves.toBeUndefined()
    expect(mocks.connectDB).toHaveBeenCalledOnce()
  })
})
