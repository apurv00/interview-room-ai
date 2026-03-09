/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false, // disabled to prevent double-invocation of interview logic
  output: 'standalone', // required for Docker multi-stage build
  poweredByHeader: false, // security: don't reveal framework
}

module.exports = nextConfig
