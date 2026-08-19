import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  purge: vi.fn(),
}))

vi.mock('@shared/services/internalServiceAuth', () => ({
  verifyInternalServiceRequest: mocks.verify,
}))
vi.mock('@modules/hire-runtime/services/multimodalObservationRetentionService', () => ({
  purgeHireRuntimeMultimodalObservationRetention: mocks.purge,
}))

import {
  POST,
  __hireRuntimeMultimodalObservationRetentionRoute,
} from './route'

function request(body: string): NextRequest {
  return new NextRequest(
    'https://engine.example/api/internal/hire-engine/multimodal-observations/purge',
    { method: 'POST', body },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.verify.mockResolvedValue({ ok: true })
  mocks.purge.mockResolvedValue({ outcome: 'purged' })
})

describe('Hire runtime supplemental-observation retention route', () => {
  it('requires signed control-plane authentication before parsing the body', async () => {
    mocks.verify.mockResolvedValueOnce({ ok: false, reason: 'invalid-signature' })

    const response = await POST(request('{not-json'))

    expect(response.status).toBe(401)
    expect(mocks.purge).not.toHaveBeenCalled()
  })

  it('returns only the typed no-store purge acknowledgement', async () => {
    const body = JSON.stringify({ purgeId: 'purge-1' })

    const response = await POST(request(body))

    expect(mocks.verify).toHaveBeenCalledWith({
      method: 'POST',
      path: __hireRuntimeMultimodalObservationRetentionRoute.ROUTE_PATH,
      body,
      headers: expect.any(Headers),
    })
    expect(mocks.purge).toHaveBeenCalledWith({ purgeId: 'purge-1' })
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({ ok: true, outcome: 'purged' })
  })

  it('fails closed when replay protection is unavailable', async () => {
    mocks.verify.mockResolvedValueOnce({ ok: false, reason: 'replay-store-unavailable' })

    const response = await POST(request('{}'))

    expect(response.status).toBe(503)
    expect(mocks.purge).not.toHaveBeenCalled()
  })

  it('rejects oversized requests before authentication work', async () => {
    const response = await POST(
      request('x'.repeat(__hireRuntimeMultimodalObservationRetentionRoute.MAX_BODY_BYTES + 1)),
    )

    expect(response.status).toBe(400)
    expect(mocks.verify).not.toHaveBeenCalled()
    expect(mocks.purge).not.toHaveBeenCalled()
  })
})
