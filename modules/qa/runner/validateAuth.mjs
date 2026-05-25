import { readFileSync, existsSync } from 'node:fs'

const SESSION_COOKIE_NAMES = [
  '__Secure-next-auth.session-token',
  'next-auth.session-token',
  '__Host-next-auth.session-token',
]

/**
 * @param {string} storageStatePath
 */
export function loadStorageState(storageStatePath) {
  if (!existsSync(storageStatePath)) return null
  return JSON.parse(readFileSync(storageStatePath, 'utf-8'))
}

/**
 * @param {string | object} storageStateOrPath
 */
export function findSessionCookie(storageStateOrPath) {
  const state =
    typeof storageStateOrPath === 'string'
      ? loadStorageState(storageStateOrPath)
      : storageStateOrPath
  if (!state?.cookies) return null
  return state.cookies.find((c) => SESSION_COOKIE_NAMES.includes(c.name)) ?? null
}

/**
 * @param {string | object} storageStateOrPath
 */
export function validateStorageState(storageStateOrPath) {
  const state =
    typeof storageStateOrPath === 'string'
      ? loadStorageState(storageStateOrPath)
      : storageStateOrPath

  if (!state) {
    return { ok: false, reason: 'missing-file', message: 'Auth file not found' }
  }

  const session = findSessionCookie(state)
  if (!session?.value) {
    const hasOAuthMidFlow = state.cookies?.some((c) =>
      ['__Secure-next-auth.state', '__Secure-next-auth.pkce.code_verifier'].includes(c.name),
    )
    const signedOut = state.origins?.some((o) =>
      o.localStorage?.some(
        (e) => e.name === 'nextauth.message' && e.value.includes('signout'),
      ),
    )
    let message =
      'No session cookie — login never completed. Missing __Secure-next-auth.session-token.'
    if (hasOAuthMidFlow) {
      message += ' File contains aborted Google/GitHub OAuth state only.'
    }
    if (signedOut) {
      message += ' Storage shows signout event.'
    }
    return { ok: false, reason: 'no-session-token', message }
  }

  if (session.expires > 0 && session.expires * 1000 < Date.now()) {
    return { ok: false, reason: 'expired', message: 'Session cookie expired — re-export auth.' }
  }

  return {
    ok: true,
    email: null,
    cookieName: session.name,
    expires: session.expires,
  }
}

/**
 * Build minimal Playwright storageState from session JWT cookie value.
 * @param {string} sessionTokenValue
 * @param {string} [domain]
 */
export function buildStorageStateFromSessionToken(sessionTokenValue, domain = 'www.interviewprep.guru') {
  const expires = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60
  return {
    cookies: [
      {
        name: '__Secure-next-auth.session-token',
        value: sessionTokenValue.trim(),
        domain,
        path: '/',
        expires,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
    ],
    origins: [],
  }
}
