/** @vitest-environment node */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
  ping: vi.fn().mockResolvedValue('PONG'),
}))

vi.mock('@shared/surfaces/hireDeploymentReadiness', () => ({
  currentDeploymentSurface: () => 'hire-engine',
  hireDeploymentConfigurationIssues: () => [],
}))
vi.mock('@shared/db/connection', () => ({ connectDB: mocks.connectDB }))
vi.mock('mongoose', () => ({ default: { connection: { readyState: 1 } } }))
vi.mock('@shared/redis', () => ({ redis: { ping: mocks.ping } }))

async function healthModule(multimodalBuildFlag: string | undefined) {
  vi.resetModules()
  vi.stubEnv('HEALTH_CHECK_TOKEN', 'gate-secret')
  vi.stubEnv('NEXT_PUBLIC_FEATURE_MULTIMODAL', 'true')
  vi.stubEnv('HIRE_MULTIMODAL_BUILD_ENABLED', multimodalBuildFlag ?? '')
  return import('../route')
}

async function authenticatedHealth(multimodalBuildFlag: string | undefined) {
  const { GET } = await healthModule(multimodalBuildFlag)
  return GET(
    new NextRequest('https://engine.example.test/api/health', {
      headers: { authorization: 'Bearer gate-secret' },
    }),
  )
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
  vi.clearAllMocks()
})

describe('Hire engine browser build identity', () => {
  it('proves the build-inlined multimodal feature is present', async () => {
    const response = await authenticatedHealth('true')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: 'healthy',
      surface: 'hire-engine',
      checks: { hireBrowserBuild: 'ok' },
      hireInterviewBuild: { multimodal: true },
    })
  })

  it.each([undefined, 'false'])(
    'fails readiness when the compiled flag is %s',
    async (flag) => {
      const { GET, HEAD } = await healthModule(flag)
      const response = await GET(
        new NextRequest('https://engine.example.test/api/health', {
          headers: { authorization: 'Bearer gate-secret' },
        }),
      )
      const publicResponse = await GET(
        new NextRequest('https://engine.example.test/api/health'),
      )
      const headResponse = await HEAD()

      expect(response.status).toBe(503)
      await expect(response.json()).resolves.toMatchObject({
        status: 'degraded',
        surface: 'hire-engine',
        checks: { hireBrowserBuild: 'error' },
        hireInterviewBuild: { multimodal: false },
      })
      expect(publicResponse.status).toBe(503)
      await expect(publicResponse.json()).resolves.toEqual({
        status: 'degraded',
      })
      expect(headResponse.status).toBe(503)
      expect(mocks.connectDB).not.toHaveBeenCalled()
      expect(mocks.ping).not.toHaveBeenCalled()
    },
  )

  it('does not let the runtime public flag override a disabled build marker', async () => {
    const response = await authenticatedHealth('false')

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      checks: { hireBrowserBuild: 'error' },
      hireInterviewBuild: { multimodal: false },
    })
  })
})
