import { withAuth } from 'next-auth/middleware'
import { NextResponse } from 'next/server'

export default withAuth(
  function middleware(req) {
    const { pathname } = req.nextUrl
    const token = req.nextauth.token
    const response = NextResponse.next()

    // Security headers
    response.headers.set('X-Content-Type-Options', 'nosniff')
    response.headers.set('X-Frame-Options', 'DENY')
    response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
    response.headers.set('Permissions-Policy', 'geolocation=(), payment=(), usb=()')

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
          pathname.startsWith('/api/generate-question') ||
          pathname.startsWith('/api/evaluate-answer') ||
          pathname.startsWith('/api/generate-feedback') ||
          pathname.startsWith('/pricing') ||
          pathname.startsWith('/_next') ||
          pathname === '/favicon.ico'
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
