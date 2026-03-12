import { withAuth } from 'next-auth/middleware'
import { NextResponse } from 'next/server'

export default withAuth(
  function middleware(req) {
    const { pathname } = req.nextUrl
    const token = req.nextauth.token

    // ── CMS subdomain detection ──
    const hostname = req.headers.get('host') || ''
    const isCmsSubdomain = hostname.startsWith('cms.')
    const isCmsQueryParam = req.nextUrl.searchParams.get('subdomain') === 'cms'
    const isCms = isCmsSubdomain || isCmsQueryParam

    // Rewrite CMS subdomain requests to /cms prefix
    // e.g., cms.domain.com/domains -> /cms/domains
    // Exclude auth routes, API auth, and static assets so signin/signup work on CMS subdomain
    const cmsExcludedPaths = [
      '/signin',
      '/signup',
      '/api/',
      '/_next',
      '/favicon.ico',
      '/sitemap.xml',
      '/robots.txt',
    ]
    const shouldRewriteToCms =
      isCms &&
      !pathname.startsWith('/cms') &&
      !cmsExcludedPaths.some((p) => pathname.startsWith(p))

    if (shouldRewriteToCms) {
      const url = req.nextUrl.clone()
      url.pathname = `/cms${pathname}`
      return NextResponse.rewrite(url)
    }

    const response = NextResponse.next()

    // Security headers
    response.headers.set('X-Content-Type-Options', 'nosniff')
    response.headers.set('X-Frame-Options', 'DENY')
    response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
    response.headers.set('Permissions-Policy', 'geolocation=(), payment=(), usb=()')

    // Redirect new users to onboarding
    if (
      token?.onboardingCompleted === false &&
      !pathname.startsWith('/onboarding') &&
      !pathname.startsWith('/api/') &&
      !pathname.startsWith('/signin') &&
      !pathname.startsWith('/signup') &&
      !pathname.startsWith('/cms') &&
      pathname !== '/'
    ) {
      return NextResponse.redirect(new URL('/onboarding', req.url))
    }

    // B2B routes require recruiter role or higher
    if (
      pathname.startsWith('/dashboard') ||
      pathname.startsWith('/candidates') ||
      pathname.startsWith('/templates')
    ) {
      if (
        !token?.organizationId ||
        !['recruiter', 'org_admin', 'platform_admin'].includes(token.role as string)
      ) {
        return NextResponse.redirect(new URL('/', req.url))
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
          pathname.startsWith('/api/documents/upload') ||
          pathname.startsWith('/api/domains') ||
          pathname.startsWith('/api/interview-types') ||
          pathname.startsWith('/pricing') ||
          pathname.startsWith('/privacy') ||
          pathname.startsWith('/terms') ||
          pathname.startsWith('/_next') ||
          pathname === '/favicon.ico' ||
          pathname === '/sitemap.xml' ||
          pathname === '/robots.txt' ||
          pathname === '/manifest.webmanifest' ||
          pathname === '/icon' ||
          pathname === '/apple-icon' ||
          pathname === '/opengraph-image'
        ) {
          return true
        }
        // CMS paths require auth but are accessible behind the subdomain
        if (pathname.startsWith('/cms')) {
          return !!token
        }
        return !!token
      },
    },
  }
)

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
