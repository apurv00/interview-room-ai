import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  MongoClient: vi.fn(),
}))

vi.mock('mongodb', () => ({
  MongoClient: mocks.MongoClient,
}))

const originalEnvironment = {
  MONGODB_URI: process.env.MONGODB_URI,
  IPG_SURFACE: process.env.IPG_SURFACE,
  HIRE_CONTROL_DATABASE_NAME: process.env.HIRE_CONTROL_DATABASE_NAME,
  HIRE_RUNTIME_DATABASE_NAME: process.env.HIRE_RUNTIME_DATABASE_NAME,
  B2C_DATABASE_NAME: process.env.B2C_DATABASE_NAME,
  HIRE_ENGINE_RUNTIME_URL: process.env.HIRE_ENGINE_RUNTIME_URL,
}

function restore(name: keyof typeof originalEnvironment): void {
  const value = originalEnvironment[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

beforeEach(() => {
  vi.resetModules()
  mocks.connect.mockResolvedValue({})
  mocks.MongoClient.mockImplementation(function MockMongoClient() {
    return { connect: mocks.connect }
  })
  delete (global as typeof globalThis & { _mongoClientPromise?: unknown })
    ._mongoClientPromise
})

afterEach(() => {
  for (const name of Object.keys(originalEnvironment) as Array<
    keyof typeof originalEnvironment
  >) {
    restore(name)
  }
  vi.clearAllMocks()
})

describe('raw Mongo client Hire surface boundary', () => {
  it('rejects a mispointed control URI before constructing a Mongo client', async () => {
    process.env.IPG_SURFACE = 'hire-control'
    process.env.HIRE_CONTROL_DATABASE_NAME = 'ipg-hire-control'
    process.env.HIRE_RUNTIME_DATABASE_NAME = 'ipg-hire-runtime'
    process.env.B2C_DATABASE_NAME = 'ipg-b2c'
    process.env.MONGODB_URI = 'mongodb://mongo.example/ipg-b2c'

    const { getClientPromise } = await import('../mongoClient')

    await expect(getClientPromise()).rejects.toThrow(
      /control database URI mismatch/,
    )
    expect(mocks.MongoClient).not.toHaveBeenCalled()
    expect(mocks.connect).not.toHaveBeenCalled()
  })

  it('connects only after a runtime URI passes the same boundary', async () => {
    process.env.IPG_SURFACE = 'hire-engine'
    process.env.HIRE_CONTROL_DATABASE_NAME = 'ipg-hire-control'
    process.env.HIRE_RUNTIME_DATABASE_NAME = 'ipg-hire-runtime'
    process.env.B2C_DATABASE_NAME = 'ipg-b2c'
    process.env.MONGODB_URI =
      'mongodb://db-a:27017,db-b:27017/ipg-hire-runtime?replicaSet=rs0'

    const { getClientPromise } = await import('../mongoClient')

    await expect(getClientPromise()).resolves.toEqual({})
    expect(mocks.MongoClient).toHaveBeenCalledOnce()
    expect(mocks.connect).toHaveBeenCalledOnce()
  })

  it('preserves the legacy B2C client path without a Hire surface', async () => {
    delete process.env.IPG_SURFACE
    process.env.MONGODB_URI = 'mongodb://mongo.example/interview-room-ai'

    const { getClientPromise } = await import('../mongoClient')

    await expect(getClientPromise()).resolves.toEqual({})
    expect(mocks.MongoClient).toHaveBeenCalledOnce()
  })

  it.each([undefined, 'hire-contorl'])(
    'rejects invalid surface %s with a Hire manifest before raw connect',
    async (surface) => {
      if (surface === undefined) delete process.env.IPG_SURFACE
      else process.env.IPG_SURFACE = surface
      process.env.HIRE_ENGINE_RUNTIME_URL = 'https://engine.example.test'
      process.env.MONGODB_URI = 'mongodb://mongo.example/interview-room-ai'

      const { getClientPromise } = await import('../mongoClient')

      await expect(getClientPromise()).rejects.toThrow(
        /surface identity is invalid/,
      )
      expect(mocks.MongoClient).not.toHaveBeenCalled()
    },
  )

  it('preserves explicitly identified B2C raw clients with Hire markers', async () => {
    process.env.IPG_SURFACE = 'b2c'
    process.env.HIRE_ENGINE_RUNTIME_URL = 'https://engine.example.test'
    process.env.MONGODB_URI = 'mongodb://mongo.example/interview-room-ai'

    const { getClientPromise } = await import('../mongoClient')

    await expect(getClientPromise()).resolves.toEqual({})
    expect(mocks.MongoClient).toHaveBeenCalledOnce()
  })

  it('rejects a whitespace-normalized runtime identity before raw connect', async () => {
    process.env.IPG_SURFACE = 'hire-engine'
    process.env.HIRE_CONTROL_DATABASE_NAME = 'ipg-hire-control'
    process.env.HIRE_RUNTIME_DATABASE_NAME = ' ipg-hire-runtime '
    process.env.B2C_DATABASE_NAME = 'ipg-b2c'
    process.env.MONGODB_URI = 'mongodb://mongo.example/ipg-hire-runtime'

    const { getClientPromise } = await import('../mongoClient')

    await expect(getClientPromise()).rejects.toThrow(/surrounding whitespace/)
    expect(mocks.MongoClient).not.toHaveBeenCalled()
  })
})
