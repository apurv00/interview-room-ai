/** @vitest-environment node */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
  ping: vi.fn().mockResolvedValue('PONG'),
}))

vi.mock('@shared/db/connection', () => ({ connectDB: mocks.connectDB }))
vi.mock('mongoose', () => ({ default: { connection: { readyState: 1 } } }))
vi.mock('@shared/redis', () => ({ redis: { ping: mocks.ping } }))

import { deploymentCommitOf } from '../deploymentIdentity'
import { GET, HEAD } from '../route'

const originalHealthToken = process.env.HEALTH_CHECK_TOKEN
const originalDeploymentCommit = process.env.DEPLOYMENT_COMMIT_SHA
const originalSurface = process.env.IPG_SURFACE
const originalControlDb = process.env.HIRE_CONTROL_DATABASE_NAME

afterEach(() => {
  if (originalHealthToken === undefined) delete process.env.HEALTH_CHECK_TOKEN
  else process.env.HEALTH_CHECK_TOKEN = originalHealthToken
  if (originalDeploymentCommit === undefined) delete process.env.DEPLOYMENT_COMMIT_SHA
  else process.env.DEPLOYMENT_COMMIT_SHA = originalDeploymentCommit
  if (originalSurface === undefined) delete process.env.IPG_SURFACE
  else process.env.IPG_SURFACE = originalSurface
  if (originalControlDb === undefined) delete process.env.HIRE_CONTROL_DATABASE_NAME
  else process.env.HIRE_CONTROL_DATABASE_NAME = originalControlDb
  vi.clearAllMocks()
})

describe('deploymentCommitOf', () => {
  it('prefers the explicit deployment identity and normalizes it', () => {
    expect(deploymentCommitOf({
      DEPLOYMENT_COMMIT_SHA: 'A'.repeat(40),
      SOURCE_COMMIT: 'b'.repeat(40),
      VERCEL_GIT_COMMIT_SHA: 'c'.repeat(40),
    })).toBe('a'.repeat(40))
  })

  it('falls through invalid values and fails closed when no full SHA exists', () => {
    expect(deploymentCommitOf({
      DEPLOYMENT_COMMIT_SHA: 'short-sha',
      SOURCE_COMMIT: 'd'.repeat(40),
      VERCEL_GIT_COMMIT_SHA: undefined,
    })).toBe('d'.repeat(40))
    expect(deploymentCommitOf({
      DEPLOYMENT_COMMIT_SHA: undefined,
      SOURCE_COMMIT: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    })).toBeNull()
  })
})

describe('GET deployment identity', () => {
  it('returns the revision only to the authenticated release gate', async () => {
    process.env.HEALTH_CHECK_TOKEN = 'gate-secret'
    process.env.DEPLOYMENT_COMMIT_SHA = 'e'.repeat(40)

    const publicResponse = await GET(new NextRequest('https://example.test/api/health'))
    expect(await publicResponse.json()).toEqual({ status: 'ok' })
    expect(mocks.connectDB).not.toHaveBeenCalled()

    const gateResponse = await GET(new NextRequest('https://example.test/api/health', {
      headers: { authorization: 'Bearer gate-secret' },
    }))
    expect(gateResponse.status).toBe(200)
    await expect(gateResponse.json()).resolves.toMatchObject({
      status: 'healthy',
      releaseGateAuthenticated: true,
      deploymentCommit: 'e'.repeat(40),
    })
    expect(gateResponse.headers.get('cache-control')).toBe('private, no-store')
  })
})

describe('HEAD dependency readiness', () => {
  it('returns 200 only when MongoDB and Redis are reachable', async () => {
    const response = await HEAD()

    expect(response.status).toBe(200)
    expect(mocks.connectDB).toHaveBeenCalledOnce()
    expect(mocks.ping).toHaveBeenCalledOnce()
  })

  it('returns 503 when Redis is unavailable', async () => {
    mocks.ping.mockRejectedValueOnce(new Error('redis unavailable'))

    const response = await HEAD()

    expect(response.status).toBe(503)
  })

  it('returns 503 without probing Redis when MongoDB is unavailable', async () => {
    mocks.connectDB.mockRejectedValueOnce(new Error('mongo unavailable'))

    const response = await HEAD()

    expect(response.status).toBe(503)
    expect(mocks.ping).not.toHaveBeenCalled()
  })

  it('fails before dependency probes when a Hire manifest has no valid surface', async () => {
    delete process.env.IPG_SURFACE
    process.env.HIRE_CONTROL_DATABASE_NAME = 'ipg-hire-control'
    process.env.HEALTH_CHECK_TOKEN = 'gate-secret'

    const headResponse = await HEAD()
    const publicResponse = await GET(
      new NextRequest('https://hire.example.test/api/health'),
    )
    const gateResponse = await GET(
      new NextRequest('https://hire.example.test/api/health', {
        headers: { authorization: 'Bearer gate-secret' },
      }),
    )

    expect(headResponse.status).toBe(503)
    expect(publicResponse.status).toBe(503)
    expect(gateResponse.status).toBe(503)
    await expect(publicResponse.json()).resolves.toEqual({ status: 'degraded' })
    await expect(gateResponse.json()).resolves.toMatchObject({
      status: 'degraded',
      checks: { configuration: 'error' },
      configurationIssues: ['missing:IPG_SURFACE'],
    })
    expect(mocks.connectDB).not.toHaveBeenCalled()
    expect(mocks.ping).not.toHaveBeenCalled()
  })
})
