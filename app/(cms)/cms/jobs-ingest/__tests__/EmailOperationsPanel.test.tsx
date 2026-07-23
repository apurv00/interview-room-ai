import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { EmailOperationsPanel } from '../EmailOperationsPanel'

const CONFIG = {
  e0Enabled: false,
  e1Enabled: false,
  e2Enabled: true,
  e4Enabled: false,
  globalWeeklyCap: 3,
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('EmailOperationsPanel', () => {
  it('renders only the four real email streams and explains the cap boundary', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      config: { ...CONFIG, e3Enabled: true },
    })))

    render(<EmailOperationsPanel />)

    expect(await screen.findByRole('checkbox', { name: /E0 — Requested practice link/i })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: /E1 — Response nudge/i })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: /E2 — Interview reminder/i })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /E4 — Deferred practice/i })).not.toBeChecked()
    expect(screen.queryByText(/E3/i)).toBeNull()
    expect(screen.getByRole('spinbutton', { name: /Weekly solicitation cap per user/i })).toHaveValue(3)
    expect(screen.getByText(/Applies to E1 and E4; E0 and E2 remain cap-exempt/i)).toBeTruthy()
  })

  it('patches only changed four-stream controls and the bounded cap', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ config: CONFIG }))
      .mockResolvedValueOnce(response({
        config: { ...CONFIG, e1Enabled: true, globalWeeklyCap: 5 },
      }))
    vi.stubGlobal('fetch', fetch)

    render(<EmailOperationsPanel />)

    fireEvent.click(await screen.findByRole('checkbox', { name: /E1 — Response nudge/i }))
    fireEvent.change(screen.getByRole('spinbutton', { name: /Weekly solicitation cap per user/i }), {
      target: { value: '5' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save email controls' }))

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(fetch.mock.calls[1][0]).toBe('/api/cms/jobs-ingest/email')
    expect(fetch.mock.calls[1][1]).toMatchObject({
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
    })
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toEqual({
      e1Enabled: true,
      globalWeeklyCap: 5,
    })
    expect(JSON.stringify(fetch.mock.calls[1][1]?.body)).not.toContain('e3')
    expect(await screen.findByRole('status')).toHaveTextContent(/No email was sent or replayed/i)
    expect(screen.getByRole('button', { name: 'Save email controls' })).toBeDisabled()
  })

  it('blocks an out-of-range or fractional cap before PATCH', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ config: CONFIG }))
    vi.stubGlobal('fetch', fetch)

    render(<EmailOperationsPanel />)

    const cap = await screen.findByRole('spinbutton', { name: /Weekly solicitation cap per user/i })
    fireEvent.change(cap, { target: { value: '2.5' } })

    expect(cap).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('Enter a whole number from 0 to 20.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save email controls' })).toBeDisabled()
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('surfaces authorization failures without exposing an editable fallback', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(
      { error: 'platform_admin required' },
      403,
    )))

    render(<EmailOperationsPanel />)

    expect(await screen.findByRole('alert')).toHaveTextContent(/no longer has platform-admin access/i)
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })
})
