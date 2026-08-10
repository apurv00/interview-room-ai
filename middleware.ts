import { withAuth } from 'next-auth/middleware'
import { NextResponse } from 'next/server'
import { isHireGuestEmail, evaluateGuestAccess, guestRoundIdFromEmail } from '@shared/auth/guestScope'
import { runtimeWriteDrainMs } from '@shared/contracts/hireRuntimeWriteFence'

const isHireRuntimeSurface = process.env.IPG_SURFACE === 'hire-engine'
const isHireControlSurface = process.env.IPG_SURFACE === 'hire-control'
const HIRE_RUNTIME_FENCE_BYPASS_HEADER = 'x-ipg-hire-runtime-fence-bypass'
const HIRE_CONTROL_PUBLIC_POLICY_PATHS = new Set(['/privacy', '/terms', '/contact'])

function isHireRuntimePathAllowed(pathname: string, method: string): boolean {
  // Candidate consent, OTP, photo, privacy, and handoff issuance belong to
  // the Hire control plane. shared/auth/guestScope also allows that prefix
  // for the legacy single-deployment flow, so exclude it explicitly before
  // consulting the unchanged engine API allowlist.
  if (
    pathname === '/candidate' ||
    pathname.startsWith('/candidate/') ||
    pathname === '/api/candidate' ||
    pathname.startsWith('/api/candidate/')
  ) {
    return false
  }
  if (
    pathname === '/handoff' ||
    pathname === '/handoff/complete' ||
    pathname.startsWith('/api/hire-engine/') ||
    pathname === '/api/internal/hire-engine/revoke' ||
    pathname.startsWith('/api/auth/') ||
    pathname.startsWith('/api/inngest') ||
    pathname.startsWith('/_next/') ||
    pathname === '/favicon.ico' ||
    pathname === '/icon' ||
    pathname === '/apple-icon'
  ) {
    return true
  }
  if (pathname === '/feedback' || pathname.startsWith('/feedback/')) return true
  return evaluateGuestAccess(pathname, method).allowed
}

function isHireControlPathAllowed(pathname: string): boolean {
  return (
    pathname === '/' ||
    pathname.startsWith('/workspace') ||
    pathname.startsWith('/candidate/') ||
    pathname === '/apply' ||
    pathname.startsWith('/apply/') ||
    pathname.startsWith('/hire-signin') ||
    pathname.startsWith('/api/workspace') ||
    pathname.startsWith('/api/candidate/') ||
    pathname === '/api/apply' ||
    pathname.startsWith('/api/apply/') ||
    pathname.startsWith('/api/hire-auth/') ||
    // Shared HR JWT support on the isolated control host. Keep this exact:
    // session hydration and sign-out are needed, but OAuth/sign-in/callback
    // endpoints stay on the B2C origin and remain unreachable here.
    pathname === '/api/auth/session' ||
    pathname === '/api/auth/csrf' ||
    pathname === '/api/auth/signout' ||
    pathname.startsWith('/api/internal/hire/engine/') ||
    pathname === '/api/internal/hire/member-account-deletion' ||
    pathname.startsWith('/api/inngest') ||
    pathname.startsWith('/api/health') ||
    pathname.startsWith('/_next/') ||
    HIRE_CONTROL_PUBLIC_POLICY_PATHS.has(pathname) ||
    pathname === '/favicon.ico' ||
    pathname === '/icon' ||
    pathname === '/apple-icon' ||
    pathname === '/robots.txt'
  )
}

export default withAuth(
  function middleware(req) {
    const { pathname } = req.nextUrl
    const token = req.nextauth.token

    // Retire every request-target credential shape. Fragment capabilities
    // never reach middleware; seeing one of these paths/query keys therefore
    // means an old or copied-incorrectly link. Do not read or echo the value.
    const legacyHireCredentialTransport =
      pathname.startsWith('/apply/') ||
      (pathname.startsWith('/api/apply/') && pathname !== '/api/apply/resolve') ||
      pathname.startsWith('/candidate/privacy/') ||
      (pathname.startsWith('/candidate/') && req.nextUrl.searchParams.has('token')) ||
      (pathname === '/hire-signin' && req.nextUrl.searchParams.has('setup')) ||
      (pathname === '/handoff' && req.nextUrl.searchParams.has('code'))
    if (legacyHireCredentialTransport) {
      return new NextResponse('This link format is no longer active', {
        status: 410,
        headers: { 'Cache-Control': 'private, no-store' },
      })
    }

    // The isolated runtime is an engine appliance, not another copy of the
    // product. Its network surface is allow-listed independently of whatever
    // domain-wide B2C cookie the browser may also send.
    if (isHireRuntimeSurface) {
      if (pathname === '/feedback' || pathname.startsWith('/feedback/')) {
        const url = req.nextUrl.clone()
        url.pathname = '/handoff/complete'
        url.search = ''
        return NextResponse.redirect(url)
      }
      // The isolated runtime never starts multimodal/analysis jobs. Those
      // engine-adjacent collections are intentionally outside the Hire data
      // contract and would make a privacy purge impossible to acknowledge.
      if (pathname === '/api/analysis/start') {
        return new NextResponse('Not found', { status: 404 })
      }

      const fencedWrite = runtimeWriteDrainMs(pathname, req.method) !== null
      const bypass = req.headers.get(HIRE_RUNTIME_FENCE_BYPASS_HEADER)
      if (bypass !== null) {
        const configuredSecret = process.env.HIRE_RUNTIME_FENCE_SECRET
        if (
          !fencedWrite ||
          !configuredSecret ||
          configuredSecret.length < 32 ||
          bypass !== configuredSecret
        ) {
          return new NextResponse('Not found', { status: 404 })
        }
      } else if (fencedWrite) {
        // Every mutable unchanged-engine route passes through the runtime
        // capability fence. A same-origin 307 is deliberate: the self-hosted
        // Next.js middleware rewrite path drops PATCH/POST request bodies,
        // while 307 preserves both method and body for the fenced endpoint.
        // The internal proxy then repeats the admitted request with the strong
        // bypass header, avoiding recursion and preserving non-reserved query
        // parameters.
        const url = req.nextUrl.clone()
        url.pathname = '/api/hire-engine/write-fence'
        url.searchParams.set('__runtime_target', pathname)
        const response = NextResponse.redirect(url, 307)
        response.headers.set('Cache-Control', 'private, no-store')
        return response
      }
      // The unchanged interview UI calls the established /api/tts paths.
      // After the write fence admits that request, route it to the isolated
      // runtime's transient (never shared-cache) provider boundary.
      if (pathname === '/api/tts' || pathname === '/api/tts/stream') {
        const url = req.nextUrl.clone()
        url.pathname = pathname === '/api/tts/stream'
          ? '/api/hire-engine/tts/stream'
          : '/api/hire-engine/tts'
        return NextResponse.rewrite(url)
      }
      if (!isHireRuntimePathAllowed(pathname, req.method)) {
        return new NextResponse('Not found', { status: 404 })
      }
      if (pathname === '/api/interviews' && req.method === 'POST') {
        const url = req.nextUrl.clone()
        url.pathname = '/api/hire-engine/sessions'
        return NextResponse.rewrite(url)
      }
    }
    if (isHireControlSurface) {
      if (pathname === '/signin' || pathname === '/signup') {
        const url = req.nextUrl.clone()
        url.pathname = '/hire-signin'
        url.search = ''
        return NextResponse.redirect(url)
      }
      if (!isHireControlPathAllowed(pathname)) {
        return new NextResponse('Not found', { status: 404 })
      }
      if (pathname === '/') {
        const url = req.nextUrl.clone()
        url.pathname = '/workspace'
        return NextResponse.rewrite(url)
      }
    }

    // ── IPG Hire guest capability scope (DEFAULT-DENY) ──
    // FIRST, before any subdomain rewrite: the guest flow can run on any
    // host (hire.* included), and a rewrite branch returns early — which
    // would carry a guest straight past this gate into the rewritten target
    // (Codex P1 on #607). An invited candidate is not a B2C user: their
    // session exists only because the engine requires one, and it may reach
    // only what running ONE interview needs. Everything else — results,
    // GDPR export, account, resumes, history, learn, jobs, and any future
    // authed surface — is denied by default, never patched away one door at
    // a time. Authority + rationale: shared/auth/guestScope.ts.
    if (!isHireRuntimeSurface && !isHireControlSurface && isHireGuestEmail(token?.email)) {
      const decision = evaluateGuestAccess(pathname, req.method)
      if (!decision.allowed) {
        if (decision.redirectTo) {
          const url = req.nextUrl.clone()
          url.pathname = decision.redirectTo
          // Carry the guest's OWN round id so the thank-you sign-out stays
          // scoped to it: a reloaded stale thank-you tab (older invite) must
          // never end a newer round's session (multi-invite bug, 2026-08-09).
          const guestRoundId = guestRoundIdFromEmail(token?.email)
          url.search = guestRoundId ? `round=${guestRoundId}` : ''
          return NextResponse.redirect(url)
        }
        return NextResponse.json(
          { error: 'Not available for interview candidates', code: 'GUEST_SCOPE' },
          { status: 403 }
        )
      }
    }

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
      '/hire-signin',
      '/api/',
      '/_next',
      '/favicon.ico',
      '/sitemap.xml',
      '/robots.txt',
      // Legal/policy pages are global — they exist only at app/<page> and
      // must render as-is on every subdomain, never be rewritten to a
      // per-subdomain prefix (e.g. hire.* → /workspace/privacy, which 404s
      // and stranded the apply page's Privacy link — Codex P2 on #615).
      '/privacy',
      '/terms',
      '/cancellation-refunds',
      '/fulfilment',
      '/contact',
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

    // Rewrite Hire subdomain requests to the IPG Hire v2 workspace surface
    // (founder flip 2026-08-09; the v1 org-based product was deleted the
    // same day). /workspace* passes through untouched so the v2 layout's
    // absolute links resolve; /candidate* passes through so a guest link
    // opened on this host still works.
    const shouldRewriteToHire =
      isHire &&
      !pathname.startsWith('/workspace') &&
      // Guest surface only — segment-exact so the PLURAL /candidates (the
      // workspace clean URL) still rewrites (Codex P2 on #605).
      !(pathname === '/candidate' || pathname.startsWith('/candidate/')) &&
      // Public apply page — a shared link must work on the hire host too,
      // where recruiters copy it from (segment-exact, like /candidate).
      !(pathname === '/apply' || pathname.startsWith('/apply/')) &&
      !subdomainExcludedPaths.some((p) => pathname.startsWith(p))

    if (shouldRewriteToHire) {
      const url = req.nextUrl.clone()
      url.pathname = `/workspace${pathname === '/' ? '' : pathname}`
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

    return response
  },
  {
    callbacks: {
      authorized: ({ token, req }) => {
        const { pathname } = req.nextUrl
        // Runtime authentication uses a different host-only cookie name that
        // next-auth/middleware does not decode. Every runtime API/page still
        // performs its own custom-cookie session check; the middleware body
        // above supplies the default-deny route fence.
        if (isHireRuntimeSurface || isHireControlSurface) return true
        // Public paths that don't require auth
        if (
          pathname === '/' ||
          pathname.startsWith('/signin') ||
          pathname.startsWith('/signup') ||
          pathname.startsWith('/hire-signin') ||
          pathname.startsWith('/api/auth') ||
          pathname.startsWith('/api/hire-auth') ||
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
          // IPG Hire guest surface — auth-entry-point (the candidate is not
          // signed in yet): the emailed round token is the gate (plus the
          // 6-digit code in otp-mode workspaces), with consent + dual rate
          // limits enforced server-side. /candidate/[roundId]/prepare
          // additionally requires the NextAuth session it just minted
          // (checked in-route).
          pathname.startsWith('/candidate/') ||
          pathname.startsWith('/api/candidate/') ||
          // Workspace routes carry their own dual-principal fence: either a
          // current B2C HR session or the dedicated Hire-member cookie. The
          // NextAuth middleware cannot decode the latter, so it must let the
          // request reach composeHireApiRoute, which remains default-deny.
          pathname.startsWith('/workspace') ||
          pathname.startsWith('/api/workspace') ||
          // Public apply page + its submit endpoint. The fragment capability
          // is scrubbed client-side before the fixed API call; abuse remains
          // bounded by the route's anon daily cap + per-job ceiling.
          pathname === '/apply' ||
          pathname.startsWith('/apply/') ||
          pathname === '/api/apply' ||
          pathname.startsWith('/api/apply/') ||
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
