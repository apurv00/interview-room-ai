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

const HEALTH = {
  sentByStream: { e0: 3, e1: 2, e2: 4, e4: 1 },
  staleReservations: 2,
  unstampedTransactional: 1,
  incidents: {
    transactional: [{
      id: '507f1f77bcf86cd799439020',
      userId: '507f1f77bcf86cd799439010',
      stream: 'e2' as const,
      dedupeKey: 'app1:v2:2026-07-22',
      incidentKind: 'past-window' as const,
      createdAt: '2026-07-23T06:00:00.000Z',
    }],
    staleSolicitation: [{
      id: '507f1f77bcf86cd799439021',
      userId: '507f1f77bcf86cd799439011',
      stream: 'e1' as const,
      dedupeKey: 'app2',
      incidentKind: 'delivery-uncertain' as const,
      createdAt: '2026-07-21T06:00:00.000Z',
    }, {
      id: '507f1f77bcf86cd799439022',
      userId: '507f1f77bcf86cd799439012',
      stream: 'e4' as const,
      dedupeKey: 'app3',
      createdAt: '2026-07-21T05:00:00.000Z',
    }],
  },
}

const payload = (config = CONFIG, health = HEALTH) => ({
  config,
  ...health,
})

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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(payload())))

    render(<EmailOperationsPanel />)

    expect(await screen.findByRole('checkbox', { name: /E0 — Requested practice link/i })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: /E1 — Response nudge/i })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: /E2 — Interview reminder/i })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /E4 — Deferred practice/i })).not.toBeChecked()
    expect(screen.queryByRole('checkbox', { name: /E3/i })).toBeNull()
    expect(screen.getByRole('spinbutton', { name: /Weekly solicitation cap per user/i })).toHaveValue(3)
    expect(screen.getByText(/Applies to E1 and E4; E0 and E2 remain cap-exempt/i)).toBeTruthy()
    expect(screen.getByText('Email delivery health')).toBeTruthy()
    expect(screen.getByText('Time-critical delivery alerts').nextElementSibling).toHaveTextContent('1')
    expect(screen.getByText(/delivery failed or is uncertain/i)).toBeTruthy()
    expect(screen.getByText('Stale solicitation reservations').nextElementSibling).toHaveTextContent('2')
    expect(screen.getByText(/legacy E3 reservations are older than 24 hours/i)).toBeTruthy()
    expect(screen.getByText('Recorded sends by stream')).toBeTruthy()
    expect(screen.getByText('E2').nextElementSibling).toHaveTextContent('4')
    expect(screen.getByText(/do not prove inbox delivery/i)).toBeTruthy()
  })

  it('patches only changed four-stream controls and the bounded cap', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(payload()))
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
    const fetch = vi.fn().mockResolvedValue(response(payload()))
    vi.stubGlobal('fetch', fetch)

    render(<EmailOperationsPanel />)

    const cap = await screen.findByRole('spinbutton', { name: /Weekly solicitation cap per user/i })
    fireEvent.change(cap, { target: { value: '2.5' } })

    expect(cap).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('Enter a whole number from 0 to 20.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save email controls' })).toBeDisabled()
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('renders explicit zero-alert states without claiming provider health', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(payload(CONFIG, {
      sentByStream: { e0: 0, e1: 0, e2: 0, e4: 0 },
      staleReservations: 0,
      unstampedTransactional: 0,
      incidents: {
        transactional: [],
        staleSolicitation: [],
      },
    }))))

    render(<EmailOperationsPanel />)

    expect(await screen.findByText(/No unstamped E0\/E2 delivery rows/i)).toBeTruthy()
    expect(screen.getByText(/No solicitation reservation has remained unstamped/i)).toBeTruthy()
    expect(screen.getByText(/do not prove inbox delivery/i)).toBeTruthy()
  })

  it('closes an incident without resend while preserving unsaved config edits', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(payload(CONFIG, {
        ...HEALTH,
        staleReservations: 0,
        incidents: {
          transactional: [{
            id: '507f1f77bcf86cd799439020',
            userId: '507f1f77bcf86cd799439010',
            stream: 'e2' as const,
            dedupeKey: 'app1:v2:2026-07-22',
            incidentKind: 'past-window' as const,
            createdAt: '2026-07-23T06:00:00.000Z',
          }],
          staleSolicitation: [],
        },
      })))
      .mockResolvedValueOnce(response({ ok: true, idempotent: false }))
      .mockResolvedValueOnce(response(payload(CONFIG, {
        ...HEALTH,
        staleReservations: 0,
        unstampedTransactional: 0,
        incidents: {
          transactional: [],
          staleSolicitation: [],
        },
      })))
    vi.stubGlobal('fetch', fetch)

    render(<EmailOperationsPanel />)

    fireEvent.click(await screen.findByRole('checkbox', { name: /E1 — Response nudge/i }))
    fireEvent.change(screen.getByLabelText('Incident to investigate'), {
      target: { value: '507f1f77bcf86cd799439020' },
    })
    fireEvent.change(screen.getByLabelText('Resolution reason'), {
      target: { value: 'Provider delivery could not be confirmed.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Close without resend' }))

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3))
    expect(fetch.mock.calls[1][0]).toBe('/api/cms/jobs-ingest/email')
    expect(fetch.mock.calls[1][1]).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toEqual({
      action: 'closed-without-resend',
      incidentId: '507f1f77bcf86cd799439020',
      reason: 'Provider delivery could not be confirmed.',
    })
    expect(fetch.mock.calls[2][0]).toBe('/api/cms/jobs-ingest/email')
    expect(fetch.mock.calls[2][1]).toEqual({ cache: 'no-store' })
    expect(await screen.findByRole('status')).toHaveTextContent(/dedupe key remains burned/i)
    expect(screen.getByRole('checkbox', { name: /E1 — Response nudge/i })).toBeChecked()
    expect(screen.getByRole('button', { name: 'Save email controls' })).toBeEnabled()
    expect(screen.getByText(/No actionable email incidents/i)).toBeTruthy()
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
