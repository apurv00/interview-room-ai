/**
 * Live connectivity check for .env.local — prints pass/fail only, never secrets.
 * Usage: node scripts/verify-env-keys.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const envPath = path.join(root, '.env.local')

function loadEnv(file) {
  const vars = {}
  if (!fs.existsSync(file)) return vars
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    val = val.replace(/\s+#.*$/, '').trim()
    if (
      (val.startsWith("'") && val.endsWith("'")) ||
      (val.startsWith('"') && val.endsWith('"'))
    ) {
      val = val.slice(1, -1)
    }
    vars[key] = val
  }
  return vars
}

const env = loadEnv(envPath)
const results = []

function record(name, ok, detail = '') {
  results.push({ name, ok, detail })
  const icon = ok ? 'PASS' : 'FAIL'
  console.log(`${icon}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function isPlaceholder(v) {
  return !v || v.includes('...') || v === "''" || v === '""'
}

async function testMongo(uri) {
  if (isPlaceholder(uri)) throw new Error('not configured')
  const { default: mongoose } = await import('mongoose')
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 })
  await mongoose.connection.db.admin().ping()
  await mongoose.disconnect()
}

async function testRedis(url) {
  if (isPlaceholder(url)) throw new Error('not configured')
  const { default: Redis } = await import('ioredis')
  const redis = new Redis(url, {
    maxRetriesPerRequest: 1,
    connectTimeout: 8000,
    lazyConnect: true,
    tls: url.startsWith('rediss://') ? {} : undefined,
  })
  await redis.connect()
  const pong = await redis.ping()
  await redis.quit()
  if (pong !== 'PONG') throw new Error(`unexpected ping: ${pong}`)
}

async function testAnthropic(key) {
  if (isPlaceholder(key)) throw new Error('placeholder — replace sk-ant-...')
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    }),
    signal: AbortSignal.timeout(15000),
  })
  if (res.status === 401) throw new Error('invalid API key')
  if (res.status === 403) throw new Error('key rejected (403)')
  if (!res.ok && res.status !== 429) {
    const body = await res.text()
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 120)}`)
  }
}

async function testDeepgram(key) {
  if (isPlaceholder(key)) throw new Error('not configured')
  const res = await fetch('https://api.deepgram.com/v1/auth/grant', {
    method: 'POST',
    headers: {
      Authorization: `Token ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ttl_seconds: 30 }),
    signal: AbortSignal.timeout(10000),
  })
  if (res.status === 401 || res.status === 403) {
    throw new Error('invalid API key or missing grant permission')
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const grant = await res.json().catch(() => null)
  if (
    !grant ||
    typeof grant.access_token !== 'string' ||
    !grant.access_token ||
    typeof grant.expires_in !== 'number' ||
    grant.expires_in <= 0 ||
    grant.expires_in > 30
  ) {
    throw new Error('invalid temporary grant response')
  }
}

async function testPostHog(key, host) {
  if (isPlaceholder(key)) throw new Error('not configured')
  const base = (host || 'https://us.i.posthog.com').replace(/\/$/, '')
  const res = await fetch(`${base}/batch/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: key,
      batch: [{ event: 'env_verify_ping', distinct_id: 'env-verify-script', properties: {} }],
    }),
    signal: AbortSignal.timeout(10000),
  })
  if (res.status === 401) throw new Error('invalid project key')
  if (!res.ok && res.status !== 200) throw new Error(`HTTP ${res.status}`)
}

async function testHttp(name, url, expectStatus = 200) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'manual' })
  if (Array.isArray(expectStatus)) {
    if (!expectStatus.includes(res.status)) throw new Error(`HTTP ${res.status}`)
  } else if (res.status !== expectStatus) {
    const loc = res.headers.get('location') || ''
    throw new Error(`HTTP ${res.status}${loc ? ` → ${loc}` : ''}`)
  }
}

async function testInngestDev() {
  await testHttp('Inngest dev UI', 'http://127.0.0.1:8288', [200, 301, 302, 307])
}

async function testInngestRoute() {
  const res = await fetch('http://localhost:3000/api/inngest', {
    signal: AbortSignal.timeout(8000),
    redirect: 'manual',
  })
  if (res.status === 307 || res.status === 302) {
    const loc = res.headers.get('location') || ''
    if (loc.includes('auth/error')) throw new Error('NextAuth misconfigured (NO_SECRET?)')
    throw new Error(`redirect ${res.status} → ${loc}`)
  }
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
  const text = await res.text()
  if (!text.includes('function') && !text.includes('schema')) {
    throw new Error('unexpected response body')
  }
}

console.log('Verifying .env.local connectivity (no secrets printed)\n')

try {
  await testMongo(env.MONGODB_URI)
  record('MongoDB (Atlas)', true)
} catch (e) {
  record('MongoDB (Atlas)', false, e.message)
}

try {
  await testRedis(env.REDIS_URL)
  record('Redis (Upstash)', true)
} catch (e) {
  record('Redis (Upstash)', false, e.message)
}

try {
  await testAnthropic(env.ANTHROPIC_API_KEY)
  record('Anthropic API', true)
} catch (e) {
  record('Anthropic API', false, e.message)
}

try {
  await testDeepgram(env.DEEPGRAM_API_KEY)
  record('Deepgram API + browser STT grants', true)
} catch (e) {
  record('Deepgram API + browser STT grants', false, e.message)
}

try {
  await testPostHog(env.NEXT_PUBLIC_POSTHOG_KEY, env.NEXT_PUBLIC_POSTHOG_HOST)
  record('PostHog ingest', true)
} catch (e) {
  record('PostHog ingest', false, e.message)
}

record(
  'NEXTAUTH_SECRET',
  !isPlaceholder(env.NEXTAUTH_SECRET),
  isPlaceholder(env.NEXTAUTH_SECRET) ? 'empty' : 'present'
)

record(
  'GA4 measurement ID',
  !isPlaceholder(env.NEXT_PUBLIC_GA_MEASUREMENT_ID),
  isPlaceholder(env.NEXT_PUBLIC_GA_MEASUREMENT_ID) ? 'not set' : 'present (client-side only)'
)

try {
  await testHttp('Next.js dev server', 'http://localhost:3000/api/health', [200, 404])
  record('Next.js dev server', true, 'reachable on :3000')
} catch (e) {
  record('Next.js dev server', false, e.message)
}

try {
  await testInngestRoute()
  record('/api/inngest sync route', true)
} catch (e) {
  record('/api/inngest sync route', false, e.message)
}

try {
  await testInngestDev()
  record('Inngest dev server', true, 'reachable on :8288')
} catch (e) {
  record('Inngest dev server', false, e.message)
}

const passed = results.filter((r) => r.ok).length
const failed = results.filter((r) => !r.ok).length
console.log(`\nSummary: ${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
