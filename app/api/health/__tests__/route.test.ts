/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

const originalEnvironment = { ...process.env }

function configureControlHealth(
  overrides: Record<string, string | undefined> = {},
): void {
  const environment: Record<string, string | undefined> = {
    IPG_SURFACE: 'hire-control',
    MONGODB_URI: 'mongodb://mongo.example/ipg-hire-control',
    REDIS_URL: 'rediss://redis.example',
    HEALTH_CHECK_TOKEN: 'gate-secret',
    DEPLOYMENT_COMMIT_SHA: 'e'.repeat(40),
    HIRE_ENGINE_BRIDGE_KEY_ID: 'hire-bridge-current',
    HIRE_ENGINE_BRIDGE_SECRET: 'b'.repeat(64),
    B2C_DATABASE_NAME: 'ipg-b2c',
    HIRE_CONTROL_DATABASE_NAME: 'ipg-hire-control',
    HIRE_RUNTIME_DATABASE_NAME: 'ipg-hire-runtime',
    B2C_INNGEST_APP_ID: 'ipg-b2c-production',
    HIRE_CONTROL_INNGEST_APP_ID: 'ipg-hire-control-production',
    HIRE_RUNTIME_INNGEST_APP_ID: 'ipg-hire-runtime-production',
    INNGEST_APP_ID: 'ipg-hire-control-production',
    INNGEST_SIGNING_KEY: 'signkey-test',
    INNGEST_EVENT_KEY: 'event-key',
    NEXTAUTH_SECRET: 'n'.repeat(64),
    HIRE_HANDOFF_ISSUANCE_MODE: 'open',
    HIRE_INGESTION_REVISION_PROTOCOL_MODE: 'required',
    HIRE_INGESTION_REVISION_PROTOCOL_DRAIN_STARTED_AT: '2026-08-20T00:00:00.000Z',
    HIRE_HANDOFF_SMOKE_TOKEN: undefined,
    HIRE_PUBLIC_URL: 'https://hire.interviewprep.guru',
    HIRE_ENGINE_RUNTIME_URL: 'https://engine.hire.interviewprep.guru',
    RESEND_API_KEY: 're_test',
    EMAIL_FROM: 'IPG Hire <hire@send.interviewprep.guru>',
    HIRE_INVITE_DELIVERY_KEY_ID: 'invite-delivery-current',
    HIRE_INVITE_DELIVERY_KEY: Buffer.alloc(32, 7).toString('base64'),
    HIRE_INVITE_DELIVERY_KEY_ID_PREVIOUS: undefined,
    HIRE_INVITE_DELIVERY_KEY_PREVIOUS: undefined,
    HIRE_ACCOUNT_BRIDGE_KEY_ID: 'account-bridge-current',
    HIRE_ACCOUNT_BRIDGE_SECRET: 'a'.repeat(64),
    R2_ACCOUNT_ID: 'control-account',
    R2_ACCESS_KEY_ID: 'control-key',
    R2_SECRET_ACCESS_KEY: 'control-secret',
    R2_BUCKET_NAME: 'ipg-hire-control-media',
    HIRE_RUNTIME_R2_ACCOUNT_ID: 'runtime-account',
    HIRE_RUNTIME_R2_ACCESS_KEY_ID: 'runtime-key',
    HIRE_RUNTIME_R2_SECRET_ACCESS_KEY: 'runtime-secret',
    HIRE_RUNTIME_R2_BUCKET_NAME: 'ipg-hire-runtime-staging',
    ...overrides,
  }

  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

beforeEach(() => {
  process.env.IPG_SURFACE = 'b2c'
})

afterEach(() => {
  for (const name of Object.keys(process.env)) {
    if (!(name in originalEnvironment)) delete process.env[name]
  }
  Object.assign(process.env, originalEnvironment)
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

  it('exposes redacted control issuance-gate evidence only on authenticated health', async () => {
    configureControlHealth({
      HIRE_HANDOFF_ISSUANCE_MODE: 'smoke',
      HIRE_HANDOFF_SMOKE_TOKEN: 's'.repeat(64),
    })

    const publicResponse = await GET(new NextRequest('https://example.test/api/health'))
    expect(await publicResponse.json()).toEqual({ status: 'ok' })

    const gateResponse = await GET(new NextRequest('https://example.test/api/health', {
      headers: { authorization: 'Bearer gate-secret' },
    }))
    expect(gateResponse.status).toBe(200)
    await expect(gateResponse.json()).resolves.toMatchObject({
      surface: 'hire-control',
      hireMediaObjectProtocol:
        'v2-opaque-nonce-if-none-match-zero-seal',
      handoffIssuance: {
        mode: 'smoke',
        explicitlyConfigured: true,
        publicIssuanceOpen: false,
        smokeReady: true,
      },
      hireIngestionRevisionProtocol: {
        protocolVersion: '2',
        mode: 'required',
        explicitlyConfigured: true,
        releaseReady: true,
      },
    })
  })

  it('keeps intentional draining live but marks it as not release-ready', async () => {
    configureControlHealth({
      HIRE_INGESTION_REVISION_PROTOCOL_MODE: 'draining',
    })

    const response = await GET(new NextRequest('https://example.test/api/health', {
      headers: { authorization: 'Bearer gate-secret' },
    }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: 'healthy',
      hireIngestionRevisionProtocol: {
        mode: 'draining',
        releaseReady: false,
      },
    })
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
