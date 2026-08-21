import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { STORAGE_KEYS } from '@shared/storageKeys'

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocks.replace }),
}))
vi.mock('next-auth/react', () => ({
  signIn: mocks.signIn,
  signOut: mocks.signOut,
}))

import {
  __hireRuntimeHandoffClient,
  default as HireRuntimeHandoffClient,
} from '../handoff-client'

const CODE = `${'c'.repeat(24)}.${'a'.repeat(64)}`
const TICKET = 'b'.repeat(64)
const PRINCIPAL_ID = '1'.repeat(24)
const ROUND_ID = '2'.repeat(24)
const CONFIG = {
  role: 'Backend engineer',
  interviewType: 'behavioral',
  experience: '3-6',
  duration: 20,
  jobDescription: 'Canonical server-owned JD',
  targetCompany: 'Example Co',
}
const EXCHANGE_RESPONSE = {
  ok: true,
  ticket: TICKET,
  principalId: PRINCIPAL_ID,
  roundId: ROUND_ID,
}
const HANDOFF_SESSION_KEY = __hireRuntimeHandoffClient.HANDOFF_SESSION_KEY
const HANDOFF_CLIENT_NONCE_KEY =
  __hireRuntimeHandoffClient.HANDOFF_CLIENT_NONCE_KEY
const HANDOFF_AUTH_STATE_KEY = __hireRuntimeHandoffClient.HANDOFF_AUTH_STATE_KEY
const HANDOFF_EXPECTED_SESSION_KEY =
  __hireRuntimeHandoffClient.HANDOFF_EXPECTED_SESSION_KEY

function jsonResponse(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

function successfulFetch() {
  return vi
    .fn()
    .mockResolvedValueOnce(jsonResponse(EXCHANGE_RESPONSE))
    .mockResolvedValueOnce(
      jsonResponse({ principalId: PRINCIPAL_ID, roundId: ROUND_ID, config: CONFIG }),
    )
}

function stubHandoffFetch(
  handoffFetch: ReturnType<typeof vi.fn>,
  sessionValue: unknown = {},
  sessionStatus = 200,
) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      input === '/api/auth/session'
        ? Promise.resolve(jsonResponse(sessionValue, sessionStatus))
        : handoffFetch(input, init),
    ),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  sessionStorage.clear()
  mocks.signIn.mockResolvedValue({ ok: true, error: null })
  mocks.signOut.mockResolvedValue({ url: '/handoff' })
  window.history.replaceState({}, '', `/handoff#code=${CODE}`)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('isolated runtime handoff page', () => {
  it('exchanges, signs in, seeds only engine config keys, and replaces into lobby', async () => {
    localStorage.setItem(STORAGE_KEYS.INTERVIEW_DATA, 'prior candidate data')
    localStorage.setItem(`${STORAGE_KEYS.INTERVIEW_CONFIG}:old-user`, 'prior config')
    sessionStorage.setItem('feedback-session:old', 'prior candidate feedback')
    const fetchMock = successfulFetch()
    stubHandoffFetch(fetchMock)

    render(<HireRuntimeHandoffClient />)

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/lobby'))
    expect(window.location.search).toBe('')
    expect(window.location.hash).toBe('')
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/hire-engine/handoff/exchange',
      expect.objectContaining({
        method: 'POST',
        cache: 'no-store',
      }),
    )
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      code: CODE,
      clientNonce: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(mocks.signIn).toHaveBeenCalledWith('invite-otp', {
      ticket: TICKET,
      redirect: false,
    })
    expect(mocks.signOut).toHaveBeenCalledWith({ redirect: false })
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/hire-engine/bootstrap',
      expect.objectContaining({ method: 'GET', cache: 'no-store' }),
    )

    const stored = localStorage.getItem(STORAGE_KEYS.INTERVIEW_CONFIG)
    expect(JSON.parse(stored || '{}')).toEqual({
      ...CONFIG,
      _ownerId: PRINCIPAL_ID,
      _hireRoundId: ROUND_ID,
      _hireMultimodalObservationsEnabled: false,
      _hireDisplayCaptureRequired: false,
    })
    expect(
      localStorage.getItem(`${STORAGE_KEYS.INTERVIEW_CONFIG}:${PRINCIPAL_ID}`),
    ).toBe(stored)
    expect(localStorage.getItem(STORAGE_KEYS.INTERVIEW_DATA)).toBeNull()
    expect(localStorage.getItem(`${STORAGE_KEYS.INTERVIEW_CONFIG}:old-user`)).toBeNull()
    expect(sessionStorage.getItem('feedback-session:old')).toBeNull()
    expect(stored).not.toContain(CODE)
    expect(stored).not.toContain(TICKET)
    expect(stored).not.toContain('candidateEmail')
    expect(sessionStorage.getItem(HANDOFF_SESSION_KEY)).toBeNull()
    expect(sessionStorage.getItem(HANDOFF_CLIENT_NONCE_KEY)).toBeNull()
    expect(sessionStorage.getItem(HANDOFF_AUTH_STATE_KEY)).toBeNull()
  })

  it('seeds V6 collection and display-capture markers only from authenticated bootstrap headers', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(EXCHANGE_RESPONSE))
      .mockResolvedValueOnce(
        jsonResponse(
          { principalId: PRINCIPAL_ID, roundId: ROUND_ID, config: CONFIG },
          200,
          {
            'X-Hire-Multimodal-Observations': '1',
            'X-Hire-Display-Capture-Required': '1',
          },
        ),
      )
    stubHandoffFetch(fetchMock)

    render(<HireRuntimeHandoffClient />)

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/lobby'))
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.INTERVIEW_CONFIG) || '{}')).toEqual({
      ...CONFIG,
      _ownerId: PRINCIPAL_ID,
      _hireRoundId: ROUND_ID,
      _hireMultimodalObservationsEnabled: true,
      _hireDisplayCaptureRequired: true,
    })
  })

  it('shows a terminal expired state for a consumed or expired code', async () => {
    stubHandoffFetch(vi.fn().mockResolvedValue(jsonResponse({}, 410)))
    render(<HireRuntimeHandoffClient />)

    expect(
      await screen.findByRole('heading', { name: 'This interview link has expired' }),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(mocks.signIn).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(HANDOFF_SESSION_KEY)).toBeNull()
  })

  it('keeps the one-time code in memory for a retryable service failure', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse(EXCHANGE_RESPONSE))
      .mockResolvedValueOnce(
        jsonResponse({ principalId: PRINCIPAL_ID, roundId: ROUND_ID, config: CONFIG }),
      )
    stubHandoffFetch(fetchMock)
    render(<HireRuntimeHandoffClient />)

    const retry = await screen.findByRole('button', { name: 'Try again' })
    expect(sessionStorage.getItem(HANDOFF_SESSION_KEY)).toBe(CODE)
    const clientNonce = sessionStorage.getItem(HANDOFF_CLIENT_NONCE_KEY)
    expect(clientNonce).toMatch(/^[a-f0-9]{64}$/)
    fireEvent.click(retry)
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/lobby'))
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      code: CODE,
      clientNonce,
    })
    expect(sessionStorage.getItem(HANDOFF_SESSION_KEY)).toBeNull()
    expect(sessionStorage.getItem(HANDOFF_CLIENT_NONCE_KEY)).toBeNull()
    expect(mocks.signOut).toHaveBeenCalledTimes(1)
    expect(mocks.signIn).toHaveBeenCalledTimes(1)
  })

  it('fails closed before exchange when the stale-session sign-out fails, then retries it', async () => {
    mocks.signOut
      .mockRejectedValueOnce(new Error('cookie endpoint unavailable'))
      .mockResolvedValueOnce({ url: '/handoff' })
    const fetchMock = successfulFetch()
    stubHandoffFetch(fetchMock)

    render(<HireRuntimeHandoffClient />)

    const retry = await screen.findByRole('button', { name: 'Try again' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mocks.signIn).not.toHaveBeenCalled()
    expect(localStorage.getItem(STORAGE_KEYS.INTERVIEW_CONFIG)).toBeNull()

    fireEvent.click(retry)
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/lobby'))
    expect(mocks.signOut).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('fails closed when NextAuth resolves sign-out without a success acknowledgement', async () => {
    mocks.signOut.mockResolvedValueOnce({ error: 'server_error' })
    const fetchMock = successfulFetch()
    stubHandoffFetch(fetchMock)

    render(<HireRuntimeHandoffClient />)

    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mocks.signIn).not.toHaveBeenCalled()
    expect(mocks.replace).not.toHaveBeenCalled()
    expect(localStorage.getItem(STORAGE_KEYS.INTERVIEW_CONFIG)).toBeNull()
  })

  it('fails closed when an acknowledged sign-out leaves the prior session active', async () => {
    const fetchMock = successfulFetch()
    stubHandoffFetch(fetchMock, {
      user: { id: '9'.repeat(24) },
      expires: '2099-01-01T00:00:00.000Z',
    })

    render(<HireRuntimeHandoffClient />)

    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mocks.signIn).not.toHaveBeenCalled()
    expect(mocks.replace).not.toHaveBeenCalled()
    expect(localStorage.getItem(STORAGE_KEYS.INTERVIEW_CONFIG)).toBeNull()
  })

  it('retries bootstrap without exchanging, signing out, or redeeming again', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(EXCHANGE_RESPONSE))
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(
        jsonResponse({ principalId: PRINCIPAL_ID, roundId: ROUND_ID, config: CONFIG }),
      )
    stubHandoffFetch(fetchMock)
    render(<HireRuntimeHandoffClient />)

    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/lobby'))

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/hire-engine/handoff/exchange',
      '/api/hire-engine/bootstrap',
      '/api/hire-engine/bootstrap',
    ])
    expect(mocks.signOut).toHaveBeenCalledTimes(1)
    expect(mocks.signIn).toHaveBeenCalledTimes(1)
  })

  it('probes bootstrap after an ambiguous sign-in response', async () => {
    mocks.signIn.mockRejectedValueOnce(new Error('response lost'))
    const fetchMock = successfulFetch()
    stubHandoffFetch(fetchMock)
    render(<HireRuntimeHandoffClient />)

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/lobby'))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(mocks.signOut).toHaveBeenCalledTimes(1)
    expect(mocks.signIn).toHaveBeenCalledTimes(1)
  })

  it('requires a fresh handoff when the ticket was consumed without a session', async () => {
    mocks.signIn.mockResolvedValueOnce({ ok: false, error: 'CredentialsSignin' })
    stubHandoffFetch(
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(EXCHANGE_RESPONSE))
        .mockResolvedValueOnce(jsonResponse({}, 401)),
    )
    render(<HireRuntimeHandoffClient />)

    expect(
      await screen.findByRole('heading', {
        name: 'Your secure handoff could not be completed',
      }),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(sessionStorage.getItem(HANDOFF_SESSION_KEY)).toBeNull()
    expect(sessionStorage.getItem(HANDOFF_AUTH_STATE_KEY)).toBeNull()
  })

  it('resumes authenticated bootstrap after a remount without consuming another ticket', async () => {
    const firstFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(EXCHANGE_RESPONSE))
      .mockResolvedValueOnce(jsonResponse({}, 503))
    stubHandoffFetch(firstFetch)
    const firstRender = render(<HireRuntimeHandoffClient />)

    await screen.findByRole('button', { name: 'Try again' })
    expect(sessionStorage.getItem(HANDOFF_AUTH_STATE_KEY)).toBe('authenticated')
    expect(JSON.parse(
      sessionStorage.getItem(HANDOFF_EXPECTED_SESSION_KEY) ?? 'null',
    )).toEqual({ principalId: PRINCIPAL_ID, roundId: ROUND_ID })
    firstRender.unmount()

    const recoveredFetch = vi.fn().mockResolvedValue(
      jsonResponse({ principalId: PRINCIPAL_ID, roundId: ROUND_ID, config: CONFIG }),
    )
    stubHandoffFetch(recoveredFetch)
    render(<HireRuntimeHandoffClient />)

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/lobby'))
    expect(recoveredFetch).toHaveBeenCalledTimes(1)
    expect(recoveredFetch).toHaveBeenCalledWith(
      '/api/hire-engine/bootstrap',
      expect.any(Object),
    )
    expect(mocks.signOut).toHaveBeenCalledTimes(1)
    expect(mocks.signIn).toHaveBeenCalledTimes(1)
  })

  it('rejects a stale authenticated cookie whose bootstrap principal does not match the exchange', async () => {
    const stalePrincipalId = '9'.repeat(24)
    mocks.signOut
      .mockResolvedValueOnce({ url: '/handoff' })
      .mockRejectedValueOnce(new Error('stale cookie could not be cleared'))
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(EXCHANGE_RESPONSE))
      .mockResolvedValueOnce(
        jsonResponse({
          principalId: stalePrincipalId,
          roundId: ROUND_ID,
          config: CONFIG,
        }),
      )
    stubHandoffFetch(fetchMock)

    render(<HireRuntimeHandoffClient />)

    expect(
      await screen.findByRole('heading', {
        name: 'Your secure handoff could not be completed',
      }),
    ).toBeTruthy()
    expect(mocks.signOut).toHaveBeenCalledTimes(2)
    expect(mocks.replace).not.toHaveBeenCalled()
    expect(localStorage.getItem(STORAGE_KEYS.INTERVIEW_CONFIG)).toBeNull()
    expect(sessionStorage.getItem(HANDOFF_EXPECTED_SESSION_KEY)).toBeNull()
  })

  it('rejects a bootstrap round that differs from the exact exchanged round', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(EXCHANGE_RESPONSE))
      .mockResolvedValueOnce(
        jsonResponse({
          principalId: PRINCIPAL_ID,
          roundId: '8'.repeat(24),
          config: CONFIG,
        }),
      )
    stubHandoffFetch(fetchMock)

    render(<HireRuntimeHandoffClient />)

    expect(
      await screen.findByRole('heading', {
        name: 'Your secure handoff could not be completed',
      }),
    ).toBeTruthy()
    expect(mocks.signOut).toHaveBeenCalledTimes(2)
    expect(mocks.replace).not.toHaveBeenCalled()
    expect(localStorage.getItem(STORAGE_KEYS.INTERVIEW_CONFIG)).toBeNull()
  })

  it('never trusts an authenticated remount without its persisted exact expectation', async () => {
    const storedNonce = 'd'.repeat(64)
    sessionStorage.setItem(HANDOFF_SESSION_KEY, CODE)
    sessionStorage.setItem(HANDOFF_CLIENT_NONCE_KEY, storedNonce)
    sessionStorage.setItem(HANDOFF_AUTH_STATE_KEY, 'authenticated')
    window.history.replaceState({}, '', '/handoff')
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ principalId: PRINCIPAL_ID, roundId: ROUND_ID, config: CONFIG }),
    )
    stubHandoffFetch(fetchMock)

    render(<HireRuntimeHandoffClient />)

    expect(
      await screen.findByRole('heading', {
        name: 'Your secure handoff could not be completed',
      }),
    ).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(mocks.signIn).not.toHaveBeenCalled()
    expect(mocks.replace).not.toHaveBeenCalled()
    expect(localStorage.getItem(STORAGE_KEYS.INTERVIEW_CONFIG)).toBeNull()
    expect(mocks.signOut).toHaveBeenCalledTimes(1)
  })

  it('recovers the scrubbed code from tab storage after a remount', async () => {
    const firstFetch = vi.fn().mockResolvedValue(jsonResponse({}, 503))
    stubHandoffFetch(firstFetch)
    const firstRender = render(<HireRuntimeHandoffClient />)

    await screen.findByRole('button', { name: 'Try again' })
    expect(window.location.hash).toBe('')
    expect(sessionStorage.getItem(HANDOFF_SESSION_KEY)).toBe(CODE)
    const clientNonce = sessionStorage.getItem(HANDOFF_CLIENT_NONCE_KEY)
    expect(clientNonce).toMatch(/^[a-f0-9]{64}$/)
    firstRender.unmount()

    const recoveredFetch = successfulFetch()
    stubHandoffFetch(recoveredFetch)
    render(<HireRuntimeHandoffClient />)

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/lobby'))
    expect(recoveredFetch).toHaveBeenNthCalledWith(
      1,
      '/api/hire-engine/handoff/exchange',
      expect.any(Object),
    )
    expect(JSON.parse(String(recoveredFetch.mock.calls[0][1]?.body))).toEqual({
      code: CODE,
      clientNonce,
    })
    expect(sessionStorage.getItem(HANDOFF_SESSION_KEY)).toBeNull()
    expect(sessionStorage.getItem(HANDOFF_CLIENT_NONCE_KEY)).toBeNull()
  })

  it('reuses the same browser nonce when the same fragment is reopened', async () => {
    const storedNonce = 'd'.repeat(64)
    sessionStorage.setItem(HANDOFF_SESSION_KEY, CODE)
    sessionStorage.setItem(HANDOFF_CLIENT_NONCE_KEY, storedNonce)
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 503))
    stubHandoffFetch(fetchMock)

    render(<HireRuntimeHandoffClient />)
    await screen.findByRole('button', { name: 'Try again' })

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      code: CODE,
      clientNonce: storedNonce,
    })
  })

  it('generates a fresh browser nonce for a different fragment code', async () => {
    const storedNonce = 'd'.repeat(64)
    const differentCode = `${'e'.repeat(24)}.${'f'.repeat(64)}`
    sessionStorage.setItem(HANDOFF_SESSION_KEY, CODE)
    sessionStorage.setItem(HANDOFF_CLIENT_NONCE_KEY, storedNonce)
    window.history.replaceState({}, '', `/handoff#code=${differentCode}`)
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 503))
    stubHandoffFetch(fetchMock)

    render(<HireRuntimeHandoffClient />)
    await screen.findByRole('button', { name: 'Try again' })

    const request = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as {
      code: string
      clientNonce: string
    }
    expect(request.code).toBe(differentCode)
    expect(request.clientNonce).toMatch(/^[a-f0-9]{64}$/)
    expect(request.clientNonce).not.toBe(storedNonce)
  })

  it('clears the tab-scoped code after a terminal invalid response', async () => {
    stubHandoffFetch(vi.fn().mockResolvedValue(jsonResponse({}, 400)))
    render(<HireRuntimeHandoffClient />)

    expect(
      await screen.findByRole('heading', { name: 'This interview link is invalid' }),
    ).toBeTruthy()
    expect(sessionStorage.getItem(HANDOFF_SESSION_KEY)).toBeNull()
    expect(sessionStorage.getItem(HANDOFF_CLIENT_NONCE_KEY)).toBeNull()
  })
})
