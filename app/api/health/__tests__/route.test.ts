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
import { GET } from '../route'

const originalHealthToken = process.env.HEALTH_CHECK_TOKEN
const originalDeploymentCommit = process.env.DEPLOYMENT_COMMIT_SHA

afterEach(() => {
  if (originalHealthToken === undefined) delete process.env.HEALTH_CHECK_TOKEN
  else process.env.HEALTH_CHECK_TOKEN = originalHealthToken
  if (originalDeploymentCommit === undefined) delete process.env.DEPLOYMENT_COMMIT_SHA
  else process.env.DEPLOYMENT_COMMIT_SHA = originalDeploymentCommit
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
