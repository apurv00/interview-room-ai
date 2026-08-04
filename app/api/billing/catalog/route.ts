import { isIP } from 'net'
import { NextRequest, NextResponse } from 'next/server'
import { logger } from '@shared/logger'
import { checkBillingRouteRateLimit } from '@payments/services/billingRouteRateLimitService'
import {
  CustomerBillingUnavailableError,
  readPublicBillingCatalog,
} from '@customer-billing'
import { PublicBillingCatalogResponseSchema } from '@payments/validators/customerBillingResponses'
import {
  recordAuthenticatedPricingResponse,
} from '@/app/api/_lib/commercialFunnelAnalyticsComposition'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const catalogLogger = logger.child({
  module: 'public-billing-catalog',
})

function json(body: object, status: number) {
  return NextResponse.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      Vary: 'Accept-Encoding',
    },
  })
}

function rateLimitSubject(request: NextRequest): string {
  const forwarded = request.headers
    .get('x-forwarded-for')
    ?.split(',', 1)[0]
    ?.trim()
  const candidate = forwarded || request.headers.get('x-real-ip')?.trim() || ''
  return `public-catalog-ip:${
    isIP(candidate) > 0 ? candidate.toLowerCase() : 'unattributed'
  }`
}

export async function GET(request: NextRequest) {
  try {
    const rateLimit = await checkBillingRouteRateLimit({
      userId: rateLimitSubject(request),
      scope: 'read',
    })
    if (!rateLimit.allowed) {
      const response = json({ error: 'Too many billing catalog requests' }, 429)
      response.headers.set('Retry-After', String(rateLimit.retryAfterSeconds))
      return response
    }
  } catch {
    catalogLogger.error(
      { scope: 'read' },
      'Public billing catalog rate limiting is unavailable',
    )
    const response = json(
      { error: 'Billing catalog is temporarily unavailable' },
      503,
    )
    response.headers.set('Retry-After', '5')
    return response
  }

  try {
    const catalog = PublicBillingCatalogResponseSchema.parse(
      await readPublicBillingCatalog(),
    )
    try {
      await recordAuthenticatedPricingResponse(catalog.catalogVersion)
    } catch {
      catalogLogger.warn(
        { stage: 'pricing_observation' },
        'Billing catalog analytics was unavailable',
      )
    }
    return json(catalog, 200)
  } catch (error) {
    catalogLogger.error(
      {
        errorCode:
          error instanceof CustomerBillingUnavailableError
            ? error.code
            : 'unexpected',
        errorName: error instanceof Error ? error.name : 'UnknownError',
      },
      'Public billing catalog lookup failed',
    )
    return json({ error: 'Billing catalog is temporarily unavailable' }, 503)
  }
}
