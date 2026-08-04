import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  class CustomerBillingProfileConflictError extends Error {
    constructor() {
      super('sensitive profile conflict detail')
      this.name = 'CustomerBillingProfileConflictError'
    }
  }

  class PersonalDataWriteBlockedError extends Error {
    constructor() {
      super('sensitive account-deletion detail')
      this.name = 'PersonalDataWriteBlockedError'
    }
  }

  return {
    CustomerBillingProfileConflictError,
    PersonalDataWriteBlockedError,
    checkBillingRouteRateLimit: vi.fn(),
    getServerSession: vi.fn(),
    loggerError: vi.fn(),
    readCustomerBillingProfile: vi.fn(),
    upsertCustomerBillingProfile: vi.fn(),
    writesReady: true,
  }
})

vi.mock('next-auth', () => ({
  getServerSession: mocks.getServerSession,
}))

vi.mock('@shared/auth/authOptions', () => ({
  authOptions: {},
}))

vi.mock('@shared/logger', () => ({
  logger: {
    child: () => ({
      error: mocks.loggerError,
    }),
  },
}))

vi.mock('@shared/services/accountDeletion', () => ({
  PersonalDataWriteBlockedError: mocks.PersonalDataWriteBlockedError,
}))

vi.mock('@payments/services/billingRouteRateLimitService', () => ({
  checkBillingRouteRateLimit: mocks.checkBillingRouteRateLimit,
}))

vi.mock('@customer-billing', () => ({
  CustomerBillingProfileConflictError:
    mocks.CustomerBillingProfileConflictError,
  get PR6_BILLING_PROFILE_WRITES_READY() {
    return mocks.writesReady
  },
  readCustomerBillingProfile: mocks.readCustomerBillingProfile,
  upsertCustomerBillingProfile: mocks.upsertCustomerBillingProfile,
}))

import { GET, PUT } from '../route'

const userId = '69fb49747e70dc410e5a2f12'
const privateValue = 'rzp_private_provider_reference'
const billingProfile = {
  configured: true as const,
  version: 2,
  placeOfSupply: {
    stateCode: '27' as const,
    countryCode: 'IN' as const,
  },
  updatedAt: '2026-08-04T10:00:00.000Z',
}
const validMutation = {
  expectedVersion: 1,
  mutationId: 'profile-update-1',
  placeOfSupply: {
    stateCode: '27',
    countryCode: 'IN',
  },
}

function putRequest(
  body: string = JSON.stringify(validMutation),
  contentType = 'application/json',
) {
  return new NextRequest('http://localhost/api/billing/profile', {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body,
  })
}

function expectPrivateNoStore(response: Response) {
  expect(response.headers.get('cache-control')).toBe('no-store, private')
}

function expectSanitized(value: unknown) {
  const serialized = JSON.stringify(value)
  expect(serialized).not.toContain(privateValue)
  expect(serialized).not.toContain(userId)
}

describe('/api/billing/profile', () => {
  beforeEach(() => {
    mocks.writesReady = true
    mocks.getServerSession.mockReset().mockResolvedValue({
      user: { id: userId },
    })
    mocks.checkBillingRouteRateLimit.mockReset().mockResolvedValue({
      allowed: true,
      limit: 60,
      remaining: 59,
      retryAfterSeconds: 0,
    })
    mocks.loggerError.mockReset()
    mocks.readCustomerBillingProfile
      .mockReset()
      .mockResolvedValue(billingProfile)
    mocks.upsertCustomerBillingProfile
      .mockReset()
      .mockResolvedValue(billingProfile)
  })

  it('authenticates reads and writes before limiting or persistence', async () => {
    mocks.getServerSession.mockResolvedValue(null)

    const readResponse = await GET()
    const writeResponse = await PUT(putRequest())

    expect(readResponse.status).toBe(401)
    expect(writeResponse.status).toBe(401)
    expectPrivateNoStore(readResponse)
    expectPrivateNoStore(writeResponse)
    expect(mocks.checkBillingRouteRateLimit).not.toHaveBeenCalled()
    expect(mocks.readCustomerBillingProfile).not.toHaveBeenCalled()
    expect(mocks.upsertCustomerBillingProfile).not.toHaveBeenCalled()
  })

  it('fails closed on limiter denial and limiter outage', async () => {
    mocks.checkBillingRouteRateLimit.mockResolvedValueOnce({
      allowed: false,
      limit: 60,
      remaining: 0,
      retryAfterSeconds: 11,
    })

    const denied = await GET()
    expect(denied.status).toBe(429)
    expect(denied.headers.get('retry-after')).toBe('11')
    expect(mocks.readCustomerBillingProfile).not.toHaveBeenCalled()

    mocks.checkBillingRouteRateLimit.mockRejectedValueOnce(
      new Error(`${userId}:${privateValue}:redis.internal`),
    )
    const unavailable = await PUT(putRequest())

    expect(unavailable.status).toBe(503)
    expect(unavailable.headers.get('retry-after')).toBe('5')
    expect(await unavailable.json()).toEqual({
      error: 'Billing request is temporarily unavailable',
    })
    expect(mocks.upsertCustomerBillingProfile).not.toHaveBeenCalled()
    expectSanitized(mocks.loggerError.mock.calls)
  })

  it('returns configured and unconfigured public profiles', async () => {
    mocks.readCustomerBillingProfile.mockResolvedValueOnce({
      ...billingProfile,
      userId,
      contentHash: privateValue,
      razorpayCustomerId: privateValue,
    })

    const configured = await GET()
    const configuredBody = await configured.json()

    expect(configured.status).toBe(200)
    expectPrivateNoStore(configured)
    expect(configuredBody).toEqual(billingProfile)
    expectSanitized(configuredBody)
    expect(mocks.checkBillingRouteRateLimit).toHaveBeenCalledWith({
      userId,
      scope: 'read',
    })

    mocks.readCustomerBillingProfile.mockResolvedValueOnce(null)
    const unconfigured = await GET()

    expect(unconfigured.status).toBe(200)
    expect(await unconfigured.json()).toEqual({
      configured: false,
      version: 0,
    })
  })

  it('validates and saves a profile when writes are ready', async () => {
    const response = await PUT(putRequest(JSON.stringify({
      ...validMutation,
      mutationId: '  profile-update-1  ',
      placeOfSupply: {
        stateCode: ' 27 ',
        countryCode: 'IN',
      },
    })))

    expect(response.status).toBe(200)
    expectPrivateNoStore(response)
    expect(await response.json()).toEqual(billingProfile)
    expect(mocks.checkBillingRouteRateLimit).toHaveBeenCalledWith({
      userId,
      scope: 'profile',
    })
    expect(mocks.upsertCustomerBillingProfile).toHaveBeenCalledWith(
      userId,
      validMutation,
    )
  })

  it('blocks writes by readiness before reading the request body', async () => {
    mocks.writesReady = false
    const request = new Proxy({} as NextRequest, {
      get() {
        throw new Error('request body was touched')
      },
    })

    const response = await PUT(request)

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: 'Billing profile updates are not available yet',
      code: 'profile_writes_not_ready',
    })
    expect(mocks.upsertCustomerBillingProfile).not.toHaveBeenCalled()
  })

  it('rejects unsupported content types and invalid request bodies', async () => {
    let response = await PUT(putRequest('{}', 'text/plain'))
    expect(response.status).toBe(415)

    response = await PUT(putRequest('{not-json'))
    expect(response.status).toBe(400)

    response = await PUT(putRequest(JSON.stringify({
      ...validMutation,
      placeOfSupply: {
        stateCode: '99',
        countryCode: 'IN',
      },
    })))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: 'Invalid billing profile request',
      details: expect.any(Array),
    })
    expect(mocks.upsertCustomerBillingProfile).not.toHaveBeenCalled()
  })

  it('maps profile conflicts and deletion-pending writes to sanitized conflicts', async () => {
    mocks.upsertCustomerBillingProfile.mockRejectedValueOnce(
      new mocks.CustomerBillingProfileConflictError(),
    )
    let response = await PUT(putRequest())
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: 'Billing profile changed; refresh and try again',
    })

    mocks.upsertCustomerBillingProfile.mockRejectedValueOnce(
      new mocks.PersonalDataWriteBlockedError(),
    )
    response = await PUT(putRequest())
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: 'Billing profile cannot change while account deletion is pending',
    })
  })

  it('returns a sanitized 503 when profile persistence fails', async () => {
    mocks.upsertCustomerBillingProfile.mockRejectedValue(
      new Error(`${userId}:${privateValue}:mongodb.internal`),
    )

    const response = await PUT(putRequest())
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('5')
    expect(body).toEqual({
      error: 'Billing profile is temporarily unavailable',
    })
    expectSanitized(body)
    expectSanitized(mocks.loggerError.mock.calls)
  })
})
