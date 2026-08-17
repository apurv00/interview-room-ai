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
const REQUEST_TIMEOUT_MS = 15_000
const HANDOFF_SESSION_KEY = 'hire-runtime:handoff-code:v1'

type HandoffViewState =
  | { kind: 'working'; message: string }
  | { kind: 'expired' }
  | { kind: 'invalid' }
  | { kind: 'retryable'; message: string }

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

function clearStoredHandoffCode(): void {
  try {
    window.sessionStorage.removeItem(HANDOFF_SESSION_KEY)
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
  options: { multimodalObservationsEnabled?: boolean } = {},
): void {
  clearRuntimeInterviewStorage(storage)

  const persistable = {
    ...bootstrap.config,
    _ownerId: bootstrap.principalId,
    _hireRoundId: bootstrap.roundId,
    _hireMultimodalObservationsEnabled:
      options.multimodalObservationsEnabled === true,
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
  const startedRef = useRef(false)
  const [view, setView] = useState<HandoffViewState>({
    kind: 'working',
    message: 'Securing your interview…',
  })

  const completeHandoff = useCallback(async () => {
    const code = codeRef.current
    // A runtime origin can be reused on a shared device. End any prior
    // round-scoped identity before accepting a new handoff; sign-in below
    // then establishes only the principal authorized by this one-time code.
    const staleSessionReset = signOut({ redirect: false }).catch(() => undefined)
    if (!HANDOFF_CODE_PATTERN.test(code)) {
      setView({ kind: 'invalid' })
      return
    }

    setView({ kind: 'working', message: 'Securing your interview…' })
    try {
      const exchangeResponse = await fetchWithTimeout(
        '/api/hire-engine/handoff/exchange',
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ code }),
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
      }
      if (
        exchange.ok !== true ||
        typeof exchange.ticket !== 'string' ||
        !AUTH_TICKET_PATTERN.test(exchange.ticket)
      ) {
        setView({
          kind: 'retryable',
          message: 'The interview service returned an incomplete response.',
        })
        return
      }

      setView({ kind: 'working', message: 'Opening your private interview…' })
      await staleSessionReset
      const auth = await signIn('invite-otp', {
        ticket: exchange.ticket,
        redirect: false,
      })
      if (!auth?.ok || auth.error) {
        setView({
          kind: 'retryable',
          message: 'Your private interview session could not be opened.',
        })
        return
      }

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
      if (!bootstrapResponse.ok) {
        setView({
          kind: 'retryable',
          message: 'Your interview details could not be loaded.',
        })
        return
      }

      const multimodalObservationsEnabled =
        bootstrapResponse.headers.get('X-Hire-Multimodal-Observations') === '1'
      const bootstrap = HireRuntimeBootstrapResponseSchema.parse(
        await bootstrapResponse.json(),
      )
      seedRuntimeInterviewStorage(window.localStorage, bootstrap, {
        multimodalObservationsEnabled,
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
      storeHandoffCode(fragmentCode)
      codeRef.current = fragmentCode
    } else {
      codeRef.current = readStoredHandoffCode()
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
  REQUEST_TIMEOUT_MS,
}
