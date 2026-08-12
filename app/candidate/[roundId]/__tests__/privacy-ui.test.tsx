import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import CandidateEntry from '../CandidateEntry'
import CandidatePrivacyRequest from '../CandidatePrivacyRequest'

const ROUND_ID = 'a'.repeat(24)
const TOKEN = 'bc'.repeat(32)
const WORKSPACE_ID = '1'.repeat(24)
const CAPABILITY = `${WORKSPACE_ID}.${TOKEN}`
const REQUEST_ID = 'd'.repeat(24)
const REQUEST_CAPABILITY = `${WORKSPACE_ID}.${REQUEST_ID}.${'e'.repeat(64)}`

function jsonResponse(value: unknown, status: number) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  window.history.replaceState({}, '', '/')
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('candidate privacy request UI', () => {
  it('requests a mailbox code and requires explicit verification before deletion', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { requestCapability: REQUEST_CAPABILITY, emailHint: 'j***@example.com' },
          202,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({ accepted: true, status: 'processing' }, 202),
      )
    vi.stubGlobal('fetch', fetchMock)
    render(<CandidatePrivacyRequest roundId={ROUND_ID} capability={CAPABILITY} />)

    expect(screen.getByRole('heading', { name: 'Your data and privacy' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Request data deletion' }))

    const codeInput = await screen.findByLabelText('Enter the 6-digit deletion code')
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `/api/candidate/${ROUND_ID}/privacy/request`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ capability: CAPABILITY }),
        cache: 'no-store',
      }),
    )
    fireEvent.change(codeInput, { target: { value: '12a3456' } })
    expect(codeInput).toHaveValue('123456')
    fireEvent.click(
      screen.getByRole('button', { name: 'Verify and delete my candidate data' }),
    )

    expect(
      await screen.findByText('Your deletion request is being processed'),
    ).toBeTruthy()
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/candidate/privacy/verify',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ requestCapability: REQUEST_CAPABILITY, code: '123456' }),
        cache: 'no-store',
      }),
    )
    expect(document.body.textContent).not.toContain(TOKEN)
  })

  it('treats an already-verified request as processing without asking for another code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          { code: 'PRIVACY_REQUEST_CONFLICT', error: 'Already processing' },
          409,
        ),
      ),
    )
    render(<CandidatePrivacyRequest roundId={ROUND_ID} capability={CAPABILITY} />)

    fireEvent.click(screen.getByRole('button', { name: 'Request data deletion' }))

    expect(
      await screen.findByText('Your deletion request is being processed'),
    ).toBeTruthy()
    expect(screen.queryByLabelText('Enter the 6-digit deletion code')).toBeNull()
  })

  it.each(['expired', 'revoked'] as const)(
    'keeps deletion discoverable when the invite is %s',
    async (state) => {
      const fetchMock = vi.fn().mockResolvedValue(
        jsonResponse({ state, privacyAvailable: true }, 200),
      )
      vi.stubGlobal('fetch', fetchMock)
      window.history.replaceState(
        {},
        '',
        `/candidate/${ROUND_ID}#invite=${encodeURIComponent(CAPABILITY)}`,
      )
      render(<CandidateEntry roundId={ROUND_ID} />)

      expect(
        await screen.findByRole('heading', { name: 'This interview link is no longer valid' }),
      ).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Request data deletion' })).toBeTruthy()
      expect(window.location.hash).toBe('')
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/candidate/${ROUND_ID}/bootstrap`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ capability: CAPABILITY }),
        }),
      )
    },
  )

  it('shows a generic invite error without leaking record state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ code: 'PRIVACY_LINK_INVALID', error: 'Invalid' }, 410),
      ),
    )
    render(<CandidatePrivacyRequest roundId={ROUND_ID} capability={CAPABILITY} />)

    fireEvent.click(screen.getByRole('button', { name: 'Request data deletion' }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        'We could not verify this invite',
      )
    })
    expect(screen.queryByText('expired')).toBeNull()
    expect(screen.queryByText('revoked')).toBeNull()
  })
})
