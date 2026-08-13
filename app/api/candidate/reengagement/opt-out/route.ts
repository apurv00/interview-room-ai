import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit } from '@shared/middleware/checkRateLimit'
import {
  applyHireReengagementOptOut,
  HireReengagementOptOutConfigurationError,
  verifyHireReengagementOptOutCapability,
} from '@hire/services/reengagementOptOutService'

export const dynamic = 'force-dynamic'

/**
 * This is intentionally a public Hire-only endpoint. The capability is
 * accepted only from the URL/form body, never copied into a response, log,
 * cookie, localStorage, or database field. GET is a no-side-effect consent
 * screen; POST is the only mutation and supports one-click mail clients.
 */
function responseHeaders(): HeadersInit {
  return {
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
  }
}

function genericPage(input: { title: string; body: string; formCapability?: string }): NextResponse {
  const safeCapability = input.formCapability?.replace(/"/g, '&quot;')
  const form = safeCapability
    // A fixed action removes the capability from the browser's POST URL.
    // The hidden body field is still needed for a capability that has never
    // been stored server-side; no post-response URL includes it.
    ? `<form method="post" action="/api/candidate/reengagement/opt-out"><input type="hidden" name="capability" value="${safeCapability}" /><button type="submit">Opt out</button></form>`
    : ''
  return new NextResponse(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>${input.title}</title></head><body><main><h1>${input.title}</h1><p>${input.body}</p>${form}</main></body></html>`,
    { status: 200, headers: { ...responseHeaders(), 'Content-Type': 'text/html; charset=utf-8' } },
  )
}

function capabilityFromRequest(req: NextRequest): string | null {
  return req.nextUrl.searchParams.get('capability')
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const capability = capabilityFromRequest(req)
    if (!verifyHireReengagementOptOutCapability(capability)) {
      return genericPage({
        title: 'This opt-out link is unavailable',
        body: 'The link is invalid or has expired. You can ignore this page.',
      })
    }
    return genericPage({
      title: 'Stop future re-engagement emails?',
      body: 'This stops future talent-pool re-engagement emails from this hiring workspace. It does not change a current application.',
      formCapability: capability ?? undefined,
    })
  } catch (error) {
    // Do not expose configuration or capability validation details to a
    // browser that may have received a forwarded/expired URL.
    if (error instanceof HireReengagementOptOutConfigurationError) {
      return genericPage({
        title: 'This opt-out link is unavailable',
        body: 'Please contact the hiring team if you need help.',
      })
    }
    return genericPage({
      title: 'This opt-out link is unavailable',
      body: 'Please contact the hiring team if you need help.',
    })
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    // RFC 8058 one-click clients POST `List-Unsubscribe=One-Click` to the
    // URL capability. Browser confirmation posts the hidden field instead.
    const form = await req.formData().catch(() => null)
    const fromForm = form?.get('capability')
    const capability = typeof fromForm === 'string' ? fromForm : capabilityFromRequest(req)
    const ip =
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      req.headers.get('x-real-ip') ||
      'unknown'
    const blocked = await checkRateLimit(`hire-reengagement-opt-out:${ip}`, {
      windowMs: 15 * 60_000,
      maxRequests: 20,
      keyPrefix: 'rl:hire-reengagement-opt-out',
    })
    if (blocked) {
      blocked.headers.set('Cache-Control', 'no-store')
      blocked.headers.set('Referrer-Policy', 'no-referrer')
      return blocked
    }
    await applyHireReengagementOptOut({ capability })
    // Generic success deliberately prevents a forged/expired link from
    // becoming an account/candidate existence oracle.
    return genericPage({
      title: 'Preference updated',
      body: 'You will not receive future talent-pool re-engagement emails from this hiring workspace.',
    })
  } catch {
    return genericPage({
      title: 'We could not update your preference',
      body: 'Please try again later or contact the hiring team for help.',
    })
  }
}
