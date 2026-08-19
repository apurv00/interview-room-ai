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
const HANDOFF_SESSION_KEY = __hireRuntimeHandoffClient.HANDOFF_SESSION_KEY

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
    .mockResolvedValueOnce(jsonResponse({ ok: true, ticket: TICKET }))
    .mockResolvedValueOnce(
      jsonResponse({ principalId: PRINCIPAL_ID, roundId: ROUND_ID, config: CONFIG }),
    )
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  sessionStorage.clear()
  mocks.signIn.mockResolvedValue({ ok: true, error: null })
  mocks.signOut.mockResolvedValue(undefined)
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
    vi.stubGlobal('fetch', fetchMock)

    render(<HireRuntimeHandoffClient />)

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/lobby'))
    expect(window.location.search).toBe('')
    expect(window.location.hash).toBe('')
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/hire-engine/handoff/exchange',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ code: CODE }),
        cache: 'no-store',
      }),
    )
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
  })

  it('seeds the native-observation collection marker only from the runtime response header', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, ticket: TICKET }))
      .mockResolvedValueOnce(
        jsonResponse(
          { principalId: PRINCIPAL_ID, roundId: ROUND_ID, config: CONFIG },
          200,
          { 'X-Hire-Multimodal-Observations': '1' },
        ),
      )
    vi.stubGlobal('fetch', fetchMock)

    render(<HireRuntimeHandoffClient />)

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/lobby'))
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.INTERVIEW_CONFIG) || '{}')).toEqual({
      ...CONFIG,
      _ownerId: PRINCIPAL_ID,
      _hireRoundId: ROUND_ID,
      _hireMultimodalObservationsEnabled: true,
    })
  })

  it('shows a terminal expired state for a consumed or expired code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 410)))
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
      .mockResolvedValueOnce(jsonResponse({ ok: true, ticket: TICKET }))
      .mockResolvedValueOnce(
        jsonResponse({ principalId: PRINCIPAL_ID, roundId: ROUND_ID, config: CONFIG }),
      )
    vi.stubGlobal('fetch', fetchMock)
    render(<HireRuntimeHandoffClient />)

    const retry = await screen.findByRole('button', { name: 'Try again' })
    expect(sessionStorage.getItem(HANDOFF_SESSION_KEY)).toBe(CODE)
    fireEvent.click(retry)
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/lobby'))
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ code: CODE })
    expect(sessionStorage.getItem(HANDOFF_SESSION_KEY)).toBeNull()
  })

  it('recovers the scrubbed code from tab storage after a remount', async () => {
    const firstFetch = vi.fn().mockResolvedValue(jsonResponse({}, 503))
    vi.stubGlobal('fetch', firstFetch)
    const firstRender = render(<HireRuntimeHandoffClient />)

    await screen.findByRole('button', { name: 'Try again' })
    expect(window.location.hash).toBe('')
    expect(sessionStorage.getItem(HANDOFF_SESSION_KEY)).toBe(CODE)
    firstRender.unmount()

    const recoveredFetch = successfulFetch()
    vi.stubGlobal('fetch', recoveredFetch)
    render(<HireRuntimeHandoffClient />)

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/lobby'))
    expect(recoveredFetch).toHaveBeenNthCalledWith(
      1,
      '/api/hire-engine/handoff/exchange',
      expect.objectContaining({ body: JSON.stringify({ code: CODE }) }),
    )
    expect(sessionStorage.getItem(HANDOFF_SESSION_KEY)).toBeNull()
  })

  it('clears the tab-scoped code after a terminal invalid response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 400)))
    render(<HireRuntimeHandoffClient />)

    expect(
      await screen.findByRole('heading', { name: 'This interview link is invalid' }),
    ).toBeTruthy()
    expect(sessionStorage.getItem(HANDOFF_SESSION_KEY)).toBeNull()
  })
})
