import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import CandidateEntry from '../CandidateEntry'

const ROUND_ID = 'a'.repeat(24)
const WORKSPACE_ID = '1'.repeat(24)
const CAPABILITY = `${WORKSPACE_ID}.${'bc'.repeat(32)}`
const STORAGE_KEY = `hire:candidate-invite:v1:${ROUND_ID}`

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  window.sessionStorage.clear()
  window.history.replaceState({}, '', `/candidate/${ROUND_ID}`)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('candidate invite recovery', () => {
  it('stores a valid fragment before scrubbing it from browser history', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ state: 'expired', privacyAvailable: true }),
    )
    vi.stubGlobal('fetch', fetchMock)
    window.history.replaceState(
      {},
      '',
      `/candidate/${ROUND_ID}#invite=${encodeURIComponent(CAPABILITY)}`,
    )

    render(<CandidateEntry roundId={ROUND_ID} />)

    expect(
      await screen.findByRole('heading', {
        name: 'This interview link is no longer valid',
      }),
    ).toBeTruthy()
    expect(window.location.hash).toBe('')
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe(CAPABILITY)
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/candidate/${ROUND_ID}/bootstrap`,
      expect.objectContaining({ body: JSON.stringify({ capability: CAPABILITY }) }),
    )
  })

  it('recovers the invite from tab-scoped storage after the fragment is scrubbed', async () => {
    window.sessionStorage.setItem(STORAGE_KEY, CAPABILITY)
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ state: 'expired', privacyAvailable: true }),
    )
    vi.stubGlobal('fetch', fetchMock)

    render(<CandidateEntry roundId={ROUND_ID} />)

    expect(
      await screen.findByRole('heading', {
        name: 'This interview link is no longer valid',
      }),
    ).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/candidate/${ROUND_ID}/bootstrap`,
      expect.objectContaining({ body: JSON.stringify({ capability: CAPABILITY }) }),
    )
  })

  it('does not persist or submit a malformed fragment', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    window.history.replaceState({}, '', `/candidate/${ROUND_ID}#invite=malformed`)

    render(<CandidateEntry roundId={ROUND_ID} />)

    expect(
      await screen.findByRole('heading', {
        name: 'This interview link is no longer valid',
      }),
    ).toBeTruthy()
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
