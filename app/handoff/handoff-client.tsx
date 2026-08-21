'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { signIn, signOut } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import {
  HireRuntimeBootstrapResponseSchema,
  type HireRuntimeBootstrapResponse,
} from '@shared/contracts/hireEngineBridge'
import { clearAllInterviewStorage, STORAGE_KEYS } from '@shared/storageKeys'

const HANDOFF_CODE_PATTERN = /^[a-f0-9]{24}\.[a-f0-9]{64}$/i
const AUTH_TICKET_PATTERN = /^[a-f0-9]{64}$/i
const HANDOFF_CLIENT_NONCE_PATTERN = /^[a-f0-9]{64}$/
const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/
const REQUEST_TIMEOUT_MS = 15_000
const HANDOFF_SESSION_KEY = 'hire-runtime:handoff-code:v1'
const HANDOFF_CLIENT_NONCE_KEY = 'hire-runtime:handoff-client-nonce:v1'
const HANDOFF_AUTH_STATE_KEY = 'hire-runtime:handoff-auth-state:v1'
const HANDOFF_EXPECTED_SESSION_KEY = 'hire-runtime:handoff-expected-session:v1'

type HandoffViewState =
  | { kind: 'working'; message: string }
  | { kind: 'expired' }
  | { kind: 'invalid' }
  | { kind: 'session_failed' }
  | { kind: 'retryable'; message: string }

type HandoffAuthState =
  | 'needs_exchange'
  | 'needs_authentication'
  | 'authentication_ambiguous'
  | 'authenticated'

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    window.clearTimeout(timeout)
  }
}

async function resetRuntimeSession(): Promise<void> {
  let timeout = 0
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = window.setTimeout(
      () => reject(new Error('Runtime session reset timed out')),
      REQUEST_TIMEOUT_MS,
    )
  })
  try {
    const result = await Promise.race([
      signOut({ redirect: false }),
      deadline,
    ])
    // next-auth/react does not inspect the sign-out response status before it
    // resolves. Its successful redirect:false contract always includes a URL;
    // an error JSON (or any incomplete response) must therefore fail closed.
    if (!result || typeof result.url !== 'string' || result.url.length === 0) {
      throw new Error('Runtime session reset was not acknowledged')
    }
    const sessionResponse = await fetchWithTimeout('/api/auth/session', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      credentials: 'same-origin',
    })
    if (!sessionResponse.ok) {
      throw new Error('Runtime session reset could not be verified')
    }
    const session = await sessionResponse.json() as unknown
    if (
      !session ||
      typeof session !== 'object' ||
      Array.isArray(session) ||
      Object.keys(session).length !== 0
    ) {
      throw new Error('A prior runtime session is still active')
    }
  } finally {
    window.clearTimeout(timeout)
  }
}

function readStoredHandoffCode(): string {
  try {
    return window.sessionStorage.getItem(HANDOFF_SESSION_KEY)?.trim() ?? ''
  } catch {
    return ''
  }
}

function storeHandoffCode(code: string): void {
  try {
    window.sessionStorage.setItem(HANDOFF_SESSION_KEY, code)
  } catch {
    // Private browsing and locked-down clients may deny sessionStorage.
  }
}

function createHandoffClientNonce(): string {
  const bytes = new Uint8Array(32)
  window.crypto.getRandomValues(bytes)
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
}

function readStoredHandoffClientNonce(): string {
  try {
    const value = window.sessionStorage.getItem(HANDOFF_CLIENT_NONCE_KEY)?.trim() ?? ''
    return HANDOFF_CLIENT_NONCE_PATTERN.test(value) ? value : ''
  } catch {
    return ''
  }
}

function storeHandoffClientNonce(clientNonce: string): void {
  try {
    window.sessionStorage.setItem(HANDOFF_CLIENT_NONCE_KEY, clientNonce)
  } catch {
    // The in-memory nonce still binds retries while this page remains open.
  }
}

function readStoredHandoffAuthState(): HandoffAuthState | null {
  try {
    const value = window.sessionStorage.getItem(HANDOFF_AUTH_STATE_KEY)
    return value === 'authentication_ambiguous' || value === 'authenticated'
      ? value
      : null
  } catch {
    return null
  }
}

function storeHandoffAuthState(state: HandoffAuthState): void {
  try {
    window.sessionStorage.setItem(HANDOFF_AUTH_STATE_KEY, state)
  } catch {
    // The in-memory state still prevents ticket reuse while mounted.
  }
}

interface ExpectedRuntimeSession {
  principalId: string
  roundId: string
}

function readStoredExpectedSession(): ExpectedRuntimeSession | null {
  try {
    const parsed = JSON.parse(
      window.sessionStorage.getItem(HANDOFF_EXPECTED_SESSION_KEY) ?? 'null',
    ) as Partial<ExpectedRuntimeSession> | null
    return parsed &&
      typeof parsed.principalId === 'string' &&
      OBJECT_ID_PATTERN.test(parsed.principalId) &&
      typeof parsed.roundId === 'string' &&
      OBJECT_ID_PATTERN.test(parsed.roundId)
      ? {
          principalId: parsed.principalId.toLowerCase(),
          roundId: parsed.roundId.toLowerCase(),
        }
      : null
  } catch {
    return null
  }
}

function storeExpectedSession(expected: ExpectedRuntimeSession): void {
  try {
    window.sessionStorage.setItem(
      HANDOFF_EXPECTED_SESSION_KEY,
      JSON.stringify(expected),
    )
  } catch {
    // The in-memory expectation still binds this mounted handoff.
  }
}

function clearStoredAuthProgress(): void {
  try {
    window.sessionStorage.removeItem(HANDOFF_AUTH_STATE_KEY)
    window.sessionStorage.removeItem(HANDOFF_EXPECTED_SESSION_KEY)
  } catch {
    // The in-memory state is reset by the caller.
  }
}

function clearStoredHandoffCode(): void {
  try {
    window.sessionStorage.removeItem(HANDOFF_SESSION_KEY)
    window.sessionStorage.removeItem(HANDOFF_CLIENT_NONCE_KEY)
    window.sessionStorage.removeItem(HANDOFF_AUTH_STATE_KEY)
    window.sessionStorage.removeItem(HANDOFF_EXPECTED_SESSION_KEY)
  } catch {
    // The in-memory copy still expires with this page if storage is unavailable.
  }
}

/**
 * Reproduce the unchanged interview client's storage handoff while clearing
 * state left by any previous runtime guest on the same browser origin.
 */
export function clearRuntimeInterviewStorage(storage: Storage): void {
  const engineKeys = Object.values(STORAGE_KEYS)
  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const key = storage.key(index)
    if (
      key &&
      engineKeys.some((base) => key === base || key.startsWith(`${base}:`))
    ) {
      storage.removeItem(key)
    }
  }
}

export function seedRuntimeInterviewStorage(
  storage: Storage,
  bootstrap: HireRuntimeBootstrapResponse,
  options: {
    multimodalObservationsEnabled?: boolean
    displayCaptureRequired?: boolean
  } = {},
): void {
  clearRuntimeInterviewStorage(storage)

  const persistable = {
    ...bootstrap.config,
    _ownerId: bootstrap.principalId,
    _hireRoundId: bootstrap.roundId,
    _hireMultimodalObservationsEnabled:
      options.multimodalObservationsEnabled === true,
    _hireDisplayCaptureRequired: options.displayCaptureRequired === true,
  }
  const serialized = JSON.stringify(persistable)
  storage.setItem(STORAGE_KEYS.INTERVIEW_CONFIG, serialized)
  storage.setItem(
    `${STORAGE_KEYS.INTERVIEW_CONFIG}:${bootstrap.principalId}`,
    serialized,
  )
}

export default function HireRuntimeHandoffClient() {
  const router = useRouter()
  const codeRef = useRef('')
  const clientNonceRef = useRef('')
  const ticketRef = useRef('')
  const expectedSessionRef = useRef<ExpectedRuntimeSession | null>(null)
  const authStateRef = useRef<HandoffAuthState>('needs_exchange')
  const staleSessionResetRef = useRef<Promise<void> | null>(null)
  const startedRef = useRef(false)
  const [view, setView] = useState<HandoffViewState>({
    kind: 'working',
    message: 'Securing your interview…',
  })

  const completeHandoff = useCallback(async () => {
    const code = codeRef.current
    const clientNonce = clientNonceRef.current
    if (
      !HANDOFF_CODE_PATTERN.test(code) ||
      !HANDOFF_CLIENT_NONCE_PATTERN.test(clientNonce)
    ) {
      clearStoredHandoffCode()
      setView({ kind: 'invalid' })
      return
    }

    setView({ kind: 'working', message: 'Securing your interview…' })
    try {
      if (authStateRef.current === 'needs_exchange') {
        // A runtime origin can be reused on a shared device. Reset a prior
        // round-scoped identity once per handoff, never again after the new
        // one-time ticket may have established a session.
        staleSessionResetRef.current ??= resetRuntimeSession()
        try {
          await staleSessionResetRef.current
        } catch {
          staleSessionResetRef.current = null
          setView({
            kind: 'retryable',
            message: 'We could not securely reset the previous interview session.',
          })
          return
        }

        const exchangeResponse = await fetchWithTimeout(
          '/api/hire-engine/handoff/exchange',
          {
            method: 'POST',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ code, clientNonce }),
            cache: 'no-store',
            credentials: 'same-origin',
          },
        )
        if (exchangeResponse.status === 410) {
          clearStoredHandoffCode()
          setView({ kind: 'expired' })
          return
        }
        if (exchangeResponse.status === 400) {
          clearStoredHandoffCode()
          setView({ kind: 'invalid' })
          return
        }
        if (!exchangeResponse.ok) {
          setView({
            kind: 'retryable',
            message: 'We could not reach the interview service.',
          })
          return
        }
        const exchange = (await exchangeResponse.json()) as {
          ok?: unknown
          ticket?: unknown
          principalId?: unknown
          roundId?: unknown
        }
        if (
          exchange.ok !== true ||
          typeof exchange.ticket !== 'string' ||
          !AUTH_TICKET_PATTERN.test(exchange.ticket) ||
          typeof exchange.principalId !== 'string' ||
          !OBJECT_ID_PATTERN.test(exchange.principalId) ||
          typeof exchange.roundId !== 'string' ||
          !OBJECT_ID_PATTERN.test(exchange.roundId)
        ) {
          setView({
            kind: 'retryable',
            message: 'The interview service returned an incomplete response.',
          })
          return
        }
        ticketRef.current = exchange.ticket
        expectedSessionRef.current = {
          principalId: exchange.principalId.toLowerCase(),
          roundId: exchange.roundId.toLowerCase(),
        }
        storeExpectedSession(expectedSessionRef.current)
        authStateRef.current = 'needs_authentication'
      }

      if (authStateRef.current === 'needs_authentication') {
        setView({ kind: 'working', message: 'Opening your private interview…' })
        // From this point the response is ambiguous: NextAuth consumes the
        // ticket before its user lookup/session response completes. Never
        // exchange or submit this ticket again; probe the authenticated
        // bootstrap to learn whether the cookie was established.
        authStateRef.current = 'authentication_ambiguous'
        storeHandoffAuthState(authStateRef.current)
        try {
          const auth = await signIn('invite-otp', {
            ticket: ticketRef.current,
            redirect: false,
          })
          if (auth?.ok && !auth.error) {
            authStateRef.current = 'authenticated'
            storeHandoffAuthState(authStateRef.current)
          }
        } catch {
          // The bootstrap probe below is authoritative for an ambiguous
          // client response because the session cookie may still exist.
        }
      }

      setView({ kind: 'working', message: 'Loading your interview details…' })
      const bootstrapResponse = await fetchWithTimeout(
        '/api/hire-engine/bootstrap',
        {
          method: 'GET',
          headers: { Accept: 'application/json' },
          cache: 'no-store',
          credentials: 'same-origin',
        },
      )
      if (bootstrapResponse.status === 404 || bootstrapResponse.status === 410) {
        clearStoredHandoffCode()
        setView({ kind: 'expired' })
        return
      }
      if (bootstrapResponse.status === 401) {
        clearStoredHandoffCode()
        setView({ kind: 'session_failed' })
        return
      }
      if (!bootstrapResponse.ok) {
        setView({
          kind: 'retryable',
          message: 'Your interview details could not be loaded.',
        })
        return
      }

      const multimodalObservationsEnabled =
        bootstrapResponse.headers.get('X-Hire-Multimodal-Observations') === '1'
      const displayCaptureRequired =
        bootstrapResponse.headers.get('X-Hire-Display-Capture-Required') === '1'
      const bootstrap = HireRuntimeBootstrapResponseSchema.parse(
        await bootstrapResponse.json(),
      )
      const expected = expectedSessionRef.current
      if (
        !expected ||
        bootstrap.principalId !== expected.principalId ||
        bootstrap.roundId !== expected.roundId
      ) {
        clearStoredHandoffCode()
        clearRuntimeInterviewStorage(window.localStorage)
        try {
          await resetRuntimeSession()
        } catch {
          // Fail closed even if the stale cookie cannot be cleared remotely:
          // never seed or navigate with a mismatched authenticated principal.
        }
        setView({ kind: 'session_failed' })
        return
      }
      seedRuntimeInterviewStorage(window.localStorage, bootstrap, {
        multimodalObservationsEnabled,
        displayCaptureRequired,
      })
      clearStoredHandoffCode()
      router.replace('/lobby')
    } catch {
      setView({
        kind: 'retryable',
        message: 'Check your connection, then try again.',
      })
    }
  }, [router])

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    const fragment = new URLSearchParams(window.location.hash.slice(1))
    const fragmentCode = fragment.get('code')?.trim() ?? ''
    if (HANDOFF_CODE_PATTERN.test(fragmentCode)) {
      // Preserve the capability within this tab before removing it from the
      // address bar. A reload can then resume after a transient interruption.
      const normalizedFragmentCode = fragmentCode.toLowerCase()
      const storedCode = readStoredHandoffCode().toLowerCase()
      const storedNonce = readStoredHandoffClientNonce()
      const storedAuthState = readStoredHandoffAuthState()
      const storedExpectedSession = readStoredExpectedSession()
      const resumesStoredCode = storedCode === normalizedFragmentCode
      storeHandoffCode(normalizedFragmentCode)
      codeRef.current = normalizedFragmentCode
      clientNonceRef.current =
        resumesStoredCode &&
        HANDOFF_CLIENT_NONCE_PATTERN.test(storedNonce)
          ? storedNonce
          : createHandoffClientNonce()
      storeHandoffClientNonce(clientNonceRef.current)
      if (resumesStoredCode && storedAuthState) {
        authStateRef.current = storedAuthState
        expectedSessionRef.current = storedExpectedSession
      } else {
        authStateRef.current = 'needs_exchange'
        expectedSessionRef.current = null
        clearStoredAuthProgress()
      }
    } else {
      codeRef.current = readStoredHandoffCode()
      clientNonceRef.current = readStoredHandoffClientNonce()
      authStateRef.current = readStoredHandoffAuthState() ?? 'needs_exchange'
      expectedSessionRef.current = readStoredExpectedSession()
      if (
        HANDOFF_CODE_PATTERN.test(codeRef.current) &&
        !HANDOFF_CLIENT_NONCE_PATTERN.test(clientNonceRef.current)
      ) {
        // Upgrade an interrupted pre-binding handoff in this tab without
        // deriving the browser proof from the bearer code itself.
        clientNonceRef.current = createHandoffClientNonce()
        storeHandoffClientNonce(clientNonceRef.current)
      }
    }
    // Remove the one-time credential from browser history/referrers before
    // making any network call. Its tab-scoped recovery copy is cleared after
    // successful completion or a terminal response.
    window.history.replaceState(window.history.state, '', window.location.pathname)
    clearRuntimeInterviewStorage(window.localStorage)
    // Also clear prior runtime sessionStorage and replay-upload IndexedDB.
    // The synchronous storage sweep happens before this promise is returned;
    // the old replay cancellation generation remains active while handoff runs.
    void clearAllInterviewStorage().catch(() => undefined)
    void completeHandoff()
  }, [completeHandoff])

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <section
        aria-live="polite"
        className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm"
      >
        {view.kind === 'working' && (
          <>
            <div
              aria-hidden="true"
              className="mx-auto mb-5 h-8 w-8 animate-spin rounded-full border-2 border-blue-600 border-t-transparent"
            />
            <h1 className="text-xl font-semibold text-slate-950">
              Preparing your interview
            </h1>
            <p className="mt-2 text-sm text-slate-600">{view.message}</p>
          </>
        )}

        {view.kind === 'expired' && (
          <>
            <h1 className="text-xl font-semibold text-slate-950">
              This interview link has expired
            </h1>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              Please reopen the latest interview link you received, or contact
              the hiring team for a new one.
            </p>
          </>
        )}

        {view.kind === 'invalid' && (
          <>
            <h1 className="text-xl font-semibold text-slate-950">
              This interview link is invalid
            </h1>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              Check that you opened the complete link from the hiring team.
            </p>
          </>
        )}

        {view.kind === 'session_failed' && (
          <>
            <h1 className="text-xl font-semibold text-slate-950">
              Your secure handoff could not be completed
            </h1>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              Return to the original interview invitation and start again to
              receive a fresh secure handoff.
            </p>
          </>
        )}

        {view.kind === 'retryable' && (
          <>
            <h1 className="text-xl font-semibold text-slate-950">
              We could not open your interview
            </h1>
            <p className="mt-3 text-sm leading-6 text-slate-600">{view.message}</p>
            <button
              type="button"
              onClick={() => void completeHandoff()}
              className="mt-6 rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
            >
              Try again
            </button>
          </>
        )}
      </section>
    </main>
  )
}

export const __hireRuntimeHandoffClient = {
  HANDOFF_SESSION_KEY,
  HANDOFF_CLIENT_NONCE_KEY,
  HANDOFF_AUTH_STATE_KEY,
  HANDOFF_EXPECTED_SESSION_KEY,
  REQUEST_TIMEOUT_MS,
}
