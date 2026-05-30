/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false, // disabled to prevent double-invocation of interview logic
  output: 'standalone', // required for Docker multi-stage build
  poweredByHeader: false, // security: don't reveal framework
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'lh3.googleusercontent.com' },
      { protocol: 'https', hostname: 'avatars.githubusercontent.com' },
    ],
  },
  experimental: {
    // @sparticuz/chromium ships a brotli-compressed Chromium archive that is
    // extracted at runtime. Webpack bundling mangles the non-JS assets, so
    // we must mark it as an external serverless dependency. puppeteer-core
    // follows for the same reason.
    serverComponentsExternalPackages: [
      'unpdf',
      '@sparticuz/chromium',
      'puppeteer-core',
    ],
    // The @sparticuz/chromium brotli binary is loaded at runtime via
    // chromium.executablePath() (not a static require), so Next/Vercel's file
    // tracer doesn't follow it — the function shipped WITHOUT the binary, so
    // executablePath() threw and the launch fell back to a non-existent system
    // Chromium ("Browser was not found" → 500 on every PDF). Force-include the
    // package's files for EVERY serverless route that reaches the shared
    // services/pdfService (generatePDF). There are two such PDF callers:
    //   - /api/resume/pdf            (editor "Download PDF")
    //   - /api/resume-wizard/export  (wizard export step)
    outputFileTracingIncludes: {
      '/api/resume/pdf': ['./node_modules/@sparticuz/chromium/**'],
      '/api/resume-wizard/export': ['./node_modules/@sparticuz/chromium/**'],
    },
  },
  async redirects() {
    return [
      {
        source: '/setup',
        destination: '/lobby',
        permanent: true,
      },
      {
        source: '/resources/behavioral-interview-questions',
        destination: '/learn/guides/behavioral-questions',
        permanent: true,
      },
      // SEO: canonicalize /resources/* on /learn/guides/* to avoid duplicate content.
      {
        source: '/resources',
        destination: '/learn/guides',
        permanent: true,
      },
      {
        source: '/resources/:slug',
        destination: '/learn/guides/:slug',
        permanent: true,
      },
    ]
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-XSS-Protection', value: '1; mode=block' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          // Analytics origins:
          //   script-src: googletagmanager.com hosts the gtag.js loader.
          //     The inline init in <GoogleAnalyticsScripts> piggybacks on
          //     'unsafe-inline' (already present for Next runtime + jsdelivr).
          //   connect-src: GA event/pageview hits go to *.google-analytics.com
          //     (covers www. and region1./region5./etc. regional collect hosts;
          //     gtag picks the regional one based on the user's location, so
          //     a www-only allowance silently drops a chunk of hits) and
          //     *.analytics.google.com (newer GA4 measurement protocol hosts).
          //     us.i.posthog.com is the PostHog Cloud US capture host that
          //     shared/analytics/track.ts POSTs to as the second sink.
          { key: 'Content-Security-Policy', value: "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://cdn.jsdelivr.net https://www.googletagmanager.com; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https://cdn.jsdelivr.net https://storage.googleapis.com https://api.deepgram.com wss://api.deepgram.com https://*.r2.cloudflarestorage.com https://*.google-analytics.com https://*.analytics.google.com https://us.i.posthog.com; media-src 'self' blob: https://*.r2.cloudflarestorage.com; worker-src 'self' blob:; frame-ancestors 'none'" },
        ],
      },
      {
        source: '/_next/static/(.*)',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
        ],
      },
    ]
  },
}

module.exports = nextConfig
