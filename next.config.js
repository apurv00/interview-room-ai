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
    // Enable instrumentation.ts (register() at server startup) — installs
    // process-level unhandledRejection / uncaughtException handlers so a floating
    // promise can't crash the /api/inngest function host and kill co-located jobs.
    // Stable in Next 15; requires this flag on Next 14.
    instrumentationHook: true,
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
      // Interview skill files (modules/interview/skills/*.md) are read at runtime via a
      // DYNAMIC fs path in skillLoader (`${domain}-${depth}.md`). Next.js file-tracing
      // (nft) can't statically detect a dynamic read, so without these the .md files are
      // absent from the serverless bundle and skill content is empty in production for
      // EVERY domain. Flow templates are static TS imports and bundle automatically.
      '/api/generate-question': ['./modules/interview/skills/**'],
      '/api/evaluate-answer': ['./modules/interview/skills/**'],
      '/api/generate-feedback': ['./modules/interview/skills/**'],
      '/api/cms/skills/[domain]/[depth]': ['./modules/interview/skills/**'],
      '/api/cms/skills/[domain]/[depth]/reset': ['./modules/interview/skills/**'],
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
    // Next dev (react-refresh / webpack) needs eval(); production CSP stays strict.
    const scriptSrc = [
      "'self'",
      "'unsafe-inline'",
      "'wasm-unsafe-eval'",
      ...(process.env.NODE_ENV !== 'production' ? ["'unsafe-eval'"] : []),
      'https://cdn.jsdelivr.net',
      'https://www.googletagmanager.com',
    ].join(' ')
    const contentSecurityPolicy = [
      "default-src 'self'",
      `script-src ${scriptSrc}`,
      "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
      "img-src 'self' data: https:",
      "font-src 'self' data:",
      "connect-src 'self' https://cdn.jsdelivr.net https://storage.googleapis.com https://api.deepgram.com wss://api.deepgram.com https://*.r2.cloudflarestorage.com https://*.google-analytics.com https://*.analytics.google.com https://us.i.posthog.com",
      "media-src 'self' blob: https://*.r2.cloudflarestorage.com",
      "worker-src 'self' blob:",
      "frame-ancestors 'none'",
    ].join('; ')

    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-XSS-Protection', value: '1; mode=block' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          { key: 'Content-Security-Policy', value: contentSecurityPolicy },
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
