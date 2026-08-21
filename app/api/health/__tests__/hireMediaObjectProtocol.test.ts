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

import { GET } from '../route'

const originalEnvironment = { ...process.env }

function configureControlHealth(): void {
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
    R2_BUCKET_NAME: 'control-media',
    HIRE_RUNTIME_R2_ACCOUNT_ID: 'runtime-account',
    HIRE_RUNTIME_R2_ACCESS_KEY_ID: 'runtime-key',
    HIRE_RUNTIME_R2_SECRET_ACCESS_KEY: 'runtime-secret',
    HIRE_RUNTIME_R2_BUCKET_NAME: 'runtime-media',
  }
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

beforeEach(() => {
  configureControlHealth()
})

afterEach(() => {
  for (const name of Object.keys(process.env)) {
    if (!(name in originalEnvironment)) delete process.env[name]
  }
  Object.assign(process.env, originalEnvironment)
  vi.clearAllMocks()
})

describe('GET Hire media object protocol release marker', () => {
  it('exposes the pinned v2 marker to an authenticated Hire control probe', async () => {
    const response = await GET(new NextRequest('https://hire.example.test/api/health', {
      headers: { authorization: 'Bearer gate-secret' },
    }))

    await expect(response.json()).resolves.toMatchObject({
      releaseGateAuthenticated: true,
      surface: 'hire-control',
      hireMediaObjectProtocol: 'v2-opaque-nonce-if-none-match-zero-seal',
      hireRuntimeLandmarkObjectProtocol: 'not-applicable',
    })
  })

  it('does not disclose the marker through the public health response', async () => {
    const response = await GET(new NextRequest('https://hire.example.test/api/health'))

    await expect(response.json()).resolves.toEqual({ status: 'ok' })
    expect(mocks.connectDB).not.toHaveBeenCalled()
    expect(mocks.ping).not.toHaveBeenCalled()
  })

  it.each(['b2c', 'hire-engine'] as const)(
    'reports only the protocol owned by the %s surface',
    async (surface) => {
      process.env.HEALTH_CHECK_TOKEN = 'gate-secret'
      process.env.IPG_SURFACE = surface

      const response = await GET(new NextRequest('https://example.test/api/health', {
        headers: { authorization: 'Bearer gate-secret' },
      }))

      await expect(response.json()).resolves.toMatchObject({
        releaseGateAuthenticated: true,
        surface,
        hireMediaObjectProtocol: 'not-applicable',
        hireRuntimeLandmarkObjectProtocol:
          surface === 'hire-engine'
            ? 'v2-opaque-scope-digest-if-none-match-zero-seal'
            : 'not-applicable',
        deploymentCommit: 'e'.repeat(40),
      })
    },
  )
})
