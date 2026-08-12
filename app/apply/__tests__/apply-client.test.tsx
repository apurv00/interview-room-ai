import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import ApplyClient from '../ApplyClient'

const CAPABILITY = `${'1'.repeat(24)}.${'a'.repeat(64)}`

beforeEach(() => {
  window.history.replaceState(
    {},
    '',
    `/apply#apply=${encodeURIComponent(CAPABILITY)}`,
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('safe public apply bootstrap', () => {
  it('scrubs the fragment and never puts the capability in a request target or DOM', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ jobTitle: 'Backend Engineer', workspaceName: 'Acme' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    render(<ApplyClient />)

    expect(await screen.findByRole('heading', { name: 'Backend Engineer' })).toBeTruthy()
    expect(window.location.hash).toBe('')
    expect(window.location.pathname).toBe('/apply')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/apply/resolve',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ capability: CAPABILITY }),
      }),
    )
    expect(String(fetchMock.mock.calls[0][0])).not.toContain(CAPABILITY)
    await waitFor(() => expect(document.body.textContent).not.toContain(CAPABILITY))
  })

  it('states PII and interview-media retention plus the deletion override', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ jobTitle: 'Backend Engineer', workspaceName: 'Acme' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    ))

    render(<ApplyClient />)

    expect(await screen.findByText(/after the job closes.*up to 12 months from your last activity/i)).toBeTruthy()
    expect(screen.getByText(/recordings and identity photos are deleted 6 months after the job closes/i)).toBeTruthy()
    expect(screen.getByText(/verified deletion request overrides both periods/i)).toBeTruthy()
  })
})
