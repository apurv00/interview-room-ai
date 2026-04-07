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

    const response = NextResponse.next()

    // Request correlation ID for tracing
    const requestId = req.headers.get('x-request-id') || crypto.randomUUID()
    response.headers.set('x-request-id', requestId)

    // Security headers
    response.headers.set('X-Content-Type-Options', 'nosniff')
    response.headers.set('X-Frame-Options', 'DENY')
    response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
    response.headers.set('Permissions-Policy', 'geolocation=(), payment=(), usb=()')

    // CMS routes require platform_admin role
    if (pathname.startsWith('/cms')) {
      if (token?.role !== 'platform_admin') {
        return NextResponse.redirect(new URL('/', req.url))
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
          pathname.startsWith('/api/domains') ||
          pathname.startsWith('/api/interview-types') ||
          pathname.startsWith('/pricing') ||
          pathname.startsWith('/privacy') ||
          pathname.startsWith('/terms') ||
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
          pathname === '/dashboard' ||
          pathname.startsWith('/learn/progress') ||
          pathname.startsWith('/learn/pathway') ||
          pathname.startsWith('/learn/dashboard') ||
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
          pathname.startsWith('/api/public')
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
