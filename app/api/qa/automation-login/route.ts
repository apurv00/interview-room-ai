import { timingSafeEqual, createHash } from 'crypto'
import { NextResponse } from 'next/server'
import { encode } from 'next-auth/jwt'
import { connectDB } from '@shared/db/connection'
import { User } from '@shared/db/models'

const SESSION_MAX_AGE = 7 * 24 * 60 * 60

function secretsMatch(provided: string, expected: string): boolean {
  if (!provided || !expected) return false
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

/**
 * Programmatic QA matrix login — no OAuth in the browser.
 * Gated by QA_AUTOMATION_ENABLED + QA_AUTOMATION_SECRET on the server.
 *
 * Playwright calls this once at matrix start; session cookie lasts 7 days.
 */
export async function POST(req: Request) {
  if (process.env.QA_AUTOMATION_ENABLED !== 'true') {
    return NextResponse.json({ error: 'QA automation login disabled' }, { status: 403 })
  }

  const configuredSecret = process.env.QA_AUTOMATION_SECRET
  const configuredEmail = process.env.QA_AUTOMATION_EMAIL
  if (!configuredSecret || !configuredEmail) {
    return NextResponse.json({ error: 'QA automation not configured on server' }, { status: 503 })
  }

  const headerSecret = req.headers.get('x-qa-automation-secret') ?? ''
  if (!secretsMatch(headerSecret, configuredSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let bodyEmail: string | undefined
  try {
    const body = await req.json().catch(() => ({}))
    bodyEmail = typeof body?.email === 'string' ? body.email : undefined
  } catch {
    bodyEmail = undefined
  }

  const email = (bodyEmail ?? configuredEmail).toLowerCase().trim()
  if (email !== configuredEmail.toLowerCase().trim()) {
    return NextResponse.json({ error: 'Email not allowed for QA automation' }, { status: 403 })
  }

  await connectDB()
  const dbUser = await User.findOne({ email: configuredEmail }).select(
    '_id email name role plan organizationId',
  )
  if (!dbUser) {
    return NextResponse.json({ error: 'QA user not found in database' }, { status: 404 })
  }

  const secret = process.env.NEXTAUTH_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'NEXTAUTH_SECRET missing' }, { status: 503 })
  }

  const userId = dbUser._id.toString()
  const token = await encode({
    token: {
      sub: userId,
      userId,
      email: dbUser.email,
      name: dbUser.name ?? dbUser.email,
      role: dbUser.role ?? 'candidate',
      plan: dbUser.plan ?? 'free',
      organizationId: dbUser.organizationId?.toString(),
    },
    secret,
    maxAge: SESSION_MAX_AGE,
  })

  const isProd = process.env.NODE_ENV === 'production'
  const cookieName = isProd ? '__Secure-next-auth.session-token' : 'next-auth.session-token'

  const res = NextResponse.json({
    ok: true,
    user: { email: dbUser.email, name: dbUser.name, id: userId },
    expiresInDays: 7,
    // Playwright APIRequestContext often drops Set-Cookie with Domain=.interviewprep.guru.
    // Client writes storageState from this value (endpoint is secret-gated).
    sessionToken: token,
    cookieName,
  })

  res.cookies.set(cookieName, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE,
    ...(isProd ? { domain: '.interviewprep.guru' } : {}),
  })

  return res
}
