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
          { key: 'Content-Security-Policy', value: "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https://cdn.jsdelivr.net https://storage.googleapis.com https://api.deepgram.com wss://api.deepgram.com https://*.r2.cloudflarestorage.com; media-src 'self' blob: https://*.r2.cloudflarestorage.com; worker-src 'self' blob:; frame-ancestors 'none'" },
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
