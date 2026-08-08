import { withAuth } from 'next-auth/middleware'
import { NextResponse } from 'next/server'

export default withAuth(
  function middleware(req) {
    const { pathname } = req.nextUrl
    const token = req.nextauth.token

    // ── Subdomain detection ──
    const hostname = req.headers.get('host') || ''
    const isCms = hostname.startsWith('cms.')
    const isHire = hostname.startsWith('hire.')
    const isResume = hostname.startsWith('resume.')
    const isLearn = hostname.startsWith('learn.')

    const redirectToPrimaryApp = () => {
      const configuredAppUrl = process.env.APP_URL || process.env.NEXTAUTH_URL
      const url = configuredAppUrl ? new URL('/', configuredAppUrl) : req.nextUrl.clone()
      url.pathname = configuredAppUrl ? '/' : '/signin'
      url.search = ''
      return NextResponse.redirect(url)
    }

    // Paths excluded from subdomain rewriting
    const subdomainExcludedPaths = [
      '/signin',
      '/signup',
      '/api/',
      '/_next',
      '/favicon.ico',
      '/sitemap.xml',
      '/robots.txt',
    ]

    // Rewrite CMS subdomain requests to /cms prefix
    const shouldRewriteToCms =
      isCms &&
      !pathname.startsWith('/cms') &&
      !subdomainExcludedPaths.some((p) => pathname.startsWith(p))

    if (shouldRewriteToCms) {
      if (token?.role !== 'platform_admin') {
        return redirectToPrimaryApp()
      }
      const url = req.nextUrl.clone()
      url.pathname = `/cms${pathname}`
      return NextResponse.rewrite(url)
    }

    // Rewrite Hire subdomain requests to /hire prefix
    const shouldRewriteToHire =
      isHire &&
      !pathname.startsWith('/hire') &&
      !subdomainExcludedPaths.some((p) => pathname.startsWith(p))

    if (shouldRewriteToHire) {
      const url = req.nextUrl.clone()
      url.pathname = `/hire${pathname === '/' ? '/dashboard' : pathname}`
      return NextResponse.rewrite(url)
    }

    // Rewrite Resume subdomain requests to /resume prefix
    const shouldRewriteToResume =
      isResume &&
      !pathname.startsWith('/resume') &&
      !subdomainExcludedPaths.some((p) => pathname.startsWith(p))

    if (shouldRewriteToResume) {
      const url = req.nextUrl.clone()
      url.pathname = `/resume${pathname}`
      return NextResponse.rewrite(url)
    }

    // Rewrite Learn subdomain requests to /learn prefix
    const shouldRewriteToLearn =
      isLearn &&
      !pathname.startsWith('/learn') &&
      !subdomainExcludedPaths.some((p) => pathname.startsWith(p))

    if (shouldRewriteToLearn) {
      const url = req.nextUrl.clone()
      url.pathname = `/learn${pathname}`
      return NextResponse.rewrite(url)
    }

    // Redirect /replay/:sessionId → /feedback/:sessionId (replay page removed)
    if (pathname.startsWith('/replay/')) {
      const url = req.nextUrl.clone()
      url.pathname = pathname.replace('/replay/', '/feedback/')
      return NextResponse.redirect(url, 301)
    }

    const response = NextResponse.next()

    // Request correlation ID for tracing
    const requestId = req.headers.get('x-request-id') || crypto.randomUUID()
    response.headers.set('x-request-id', requestId)

    // Security headers
    response.headers.set('X-Content-Type-Options', 'nosniff')
    response.headers.set('X-Frame-Options', 'DENY')
    response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
    response.headers.set(
      'Permissions-Policy',
      'geolocation=(), payment=(self "https://api.razorpay.com"), usb=()',
    )

    // CMS routes require platform_admin role
    if (pathname.startsWith('/cms')) {
      if (token?.role !== 'platform_admin') {
        return redirectToPrimaryApp()
      }
    }

    // Hire routes require recruiter role or higher (or allow org creation)
    if (pathname.startsWith('/hire')) {
      // Allow access to /hire/settings for org creation (any authenticated user)
      if (pathname !== '/hire/settings' && pathname !== '/hire') {
        if (
          !token?.organizationId ||
          !['recruiter', 'org_admin', 'platform_admin'].includes(token.role as string)
        ) {
          return NextResponse.redirect(new URL('/hire/settings', req.url))
        }
      }
    }

    return response
  },
  {
    callbacks: {
      authorized: ({ token, req }) => {
        const { pathname } = req.nextUrl
        // Public paths that don't require auth
        if (
          pathname === '/' ||
          pathname.startsWith('/signin') ||
          pathname.startsWith('/signup') ||
          pathname.startsWith('/api/auth') ||
          pathname.startsWith('/api/health') ||
          pathname.startsWith('/api/inngest') ||
          pathname.startsWith('/api/domains') ||
          pathname.startsWith('/api/categories') ||
          pathname.startsWith('/api/interview-types') ||
          // JD context extraction is regex-first and only invokes Claude Haiku
          // as a fallback. Cost is bounded; allow anonymous so JD pasting on
          // /interview/setup auto-fills company/industry without sign-in.
          pathname.startsWith('/api/extract-company-context') ||
          // AI endpoints intentionally opened to anonymous users with strict
          // per-IP daily caps enforced inside composeApiRoute (anonDailyLimit).
          pathname.startsWith('/api/resume/parse') ||
          // Anonymous product-event capture (jobs Wave 1b, Codex #508):
          // identity = signed anon cookie minted by the route itself, so the
          // FIRST anonymous event must reach it; abuse bounded by the route's
          // 30/min + 300/day anon caps.
          pathname === '/api/events' ||
          // Jobs feed + detail SHELLS are public (founder ruling P-2,
          // 2026-07-14: public feed, auth-gated detail). The detail API
          // splits anon-shell vs authed-full server-side — the JD and apply
          // URLs never reach an anonymous client; the page renders the
          // shell + sign-in gate. Feed API responses carry cards only.
          pathname === '/jobs' ||
          pathname.startsWith('/jobs/') ||
          pathname === '/api/jobs/feed' ||
          (pathname.startsWith('/api/jobs/') && !pathname.startsWith('/api/jobs/admin') && !pathname.endsWith('/save') && !pathname.endsWith('/apply-click')) ||
          pathname.startsWith('/api/resume/tailor') ||
          pathname.startsWith('/api/resume/ats-check') ||
          pathname.startsWith('/pricing') ||
          pathname.startsWith('/privacy') ||
          pathname.startsWith('/terms') ||
          pathname === '/cancellation-refunds' ||
          pathname === '/fulfilment' ||
          pathname === '/contact' ||
          // ── Deferred-auth public surface (browseable anonymously;
          // auth gated client-side at value-capture actions only) ──
          pathname === '/resume' ||
          pathname.startsWith('/resume/builder') ||
          pathname.startsWith('/resume/tailor') ||
          pathname.startsWith('/resume/ats-check') ||
          pathname.startsWith('/resume/templates') ||
          pathname === '/interview/setup' ||
          pathname.startsWith('/lobby') ||
          pathname === '/history' ||
          pathname.startsWith('/learn/progress') ||
          pathname.startsWith('/learn/pathway') ||
          pathname.startsWith('/_next') ||
          pathname === '/favicon.ico' ||
          pathname === '/sitemap.xml' ||
          pathname === '/robots.txt' ||
          pathname === '/manifest.webmanifest' ||
          pathname === '/icon' ||
          pathname === '/apple-icon' ||
          pathname === '/opengraph-image' ||
          // Resume subdomain landing page is public
          pathname === '/resume' ||
          // Learn subdomain public pages
          pathname.startsWith('/learn/guides') ||
          pathname === '/learn' ||
          pathname.startsWith('/resources') ||
          // Public scorecard pages
          pathname.startsWith('/scorecard') ||
          pathname.startsWith('/api/public') ||
          // Candidate invite OTP flow is auth-entry-point (user is not
          // signed in yet). Token + OTP are the gates — not NextAuth.
          pathname.startsWith('/invite/') ||
          pathname.startsWith('/api/invite/') ||
          // IPG Hire v2 guest surface (consent → OTP → sign-in). Same
          // auth-entry-point posture as /invite: the emailed round token +
          // OTP are the gates, with consent + dual rate limits enforced
          // server-side. /candidate/[roundId]/prepare additionally requires
          // the NextAuth session it just minted (checked in-route).
          pathname.startsWith('/candidate/') ||
          pathname.startsWith('/api/candidate/') ||
          pathname.startsWith('/api/qa/automation-login')
          || pathname === '/api/billing/catalog'
          || pathname === '/api/billing/analytics/checkout-observation'
          // Razorpay has no NextAuth session. This exact route authenticates
          // the raw request body with the mode-specific webhook HMAC secret.
          || pathname === '/api/billing/webhooks/razorpay'
        ) {
          return true
        }
        return !!token
      },
    },
  }
)

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
