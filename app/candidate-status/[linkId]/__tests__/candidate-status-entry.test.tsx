import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import CandidateStatusEntry from '../CandidateStatusEntry'

const LINK_ID = 'a'.repeat(24)
const WORKSPACE_ID = '1'.repeat(24)
const APPLICATION_ID = '2'.repeat(24)
const JOB_ID = '3'.repeat(24)
const CANDIDATE_ID = '4'.repeat(24)
const CAPABILITY = `${WORKSPACE_ID}.${APPLICATION_ID}.${JOB_ID}.${CANDIDATE_ID}.${LINK_ID}.${'bc'.repeat(32)}`
const STORAGE_KEY = `hire:candidate-status:v1:${LINK_ID}`

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function activeStatus() {
  return {
    state: 'ok',
    status: {
      phase: 'interviewing',
      progress: { current: 2, total: 3 },
    },
  }
}

beforeEach(() => {
  window.sessionStorage.clear()
  window.history.replaceState({}, '', `/candidate-status/${LINK_ID}`)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('CandidateStatusEntry', () => {
  it('stores a valid fragment, scrubs history, and bootstraps without cookies', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(activeStatus()))
    vi.stubGlobal('fetch', fetchMock)
    window.history.replaceState(
      {},
      '',
      `/candidate-status/${LINK_ID}#status=${encodeURIComponent(CAPABILITY)}`,
    )

    render(<CandidateStatusEntry linkId={LINK_ID} />)

    expect(
      await screen.findByRole('heading', {
        name: 'Your application is in the interview stage.',
      }),
    ).toBeTruthy()
    expect(screen.getByLabelText('Application progress: step 2 of 3')).toBeTruthy()
    expect(window.location.hash).toBe('')
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe(CAPABILITY)
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/candidate-status/${LINK_ID}/bootstrap`,
      expect.objectContaining({
        method: 'POST',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
        body: JSON.stringify({ capability: CAPABILITY }),
      }),
    )
  })

  it('recovers a tab-scoped capability after the fragment was scrubbed', async () => {
    window.sessionStorage.setItem(STORAGE_KEY, CAPABILITY)
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(activeStatus()))
    vi.stubGlobal('fetch', fetchMock)

    render(<CandidateStatusEntry linkId={LINK_ID} />)

    expect(await screen.findByText('Your application is in the interview stage.')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/candidate-status/${LINK_ID}/bootstrap`,
      expect.objectContaining({
        body: JSON.stringify({ capability: CAPABILITY }),
      }),
    )
  })

  it('never persists a malformed or mismatched fragment', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const mismatchedLinkId = 'b'.repeat(24)
    const mismatched = `${WORKSPACE_ID}.${APPLICATION_ID}.${JOB_ID}.${CANDIDATE_ID}.${mismatchedLinkId}.${'bc'.repeat(32)}`
    window.history.replaceState(
      {},
      '',
      `/candidate-status/${LINK_ID}#status=${encodeURIComponent(mismatched)}`,
    )

    render(<CandidateStatusEntry linkId={LINK_ID} />)

    expect(
      await screen.findByRole('heading', {
        name: 'This application status link is no longer active',
      }),
    ).toBeTruthy()
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses one inactive state for an expired, revoked, or unknown response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'inactive' }, 410))
    vi.stubGlobal('fetch', fetchMock)
    window.history.replaceState(
      {},
      '',
      `/candidate-status/${LINK_ID}#status=${encodeURIComponent(CAPABILITY)}`,
    )

    render(<CandidateStatusEntry linkId={LINK_ID} />)

    expect(
      await screen.findByRole('heading', {
        name: 'This application status link is no longer active',
      }),
    ).toBeTruthy()
  })
})
