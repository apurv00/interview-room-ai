import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CandidateStatusLinksPanel from '../CandidateStatusLinksPanel'

const APPLICATION_ID = 'app-1'
const STATUS_URL =
  'https://hire.example/candidate-status/link-1#status=fragment-only-capability-secret'

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('CandidateStatusLinksPanel', () => {
  it('issues one copy-only URL, copies it once, then removes the capability from React-rendered DOM', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => '11111111-1111-4111-8111-111111111111' })
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method || init.method === 'GET') {
        expect(String(input)).toBe(
          `/api/workspace/applications/${APPLICATION_ID}/candidate-status-links`,
        )
        return json({ candidateStatusLinks: [] })
      }
      expect(String(input)).toBe(
        `/api/workspace/applications/${APPLICATION_ID}/candidate-status-links`,
      )
      expect(init.method).toBe('POST')
      expect(JSON.parse(String(init.body))).toEqual({
        operationId: '11111111-1111-4111-8111-111111111111',
        expiresInDays: 30,
      })
      return json({
        created: true,
        candidateStatusLink: {
          id: 'link-1',
          applicationId: APPLICATION_ID,
          active: true,
          expiresAt: '2099-09-13T00:00:00.000Z',
          revokedAt: null,
        },
        statusUrl: STATUS_URL,
        // A broad response must not render unrelated delivery/identity data.
        recipientEmail: 'candidate@example.com',
      }, 201)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<CandidateStatusLinksPanel applicationId={APPLICATION_ID} />)
    fireEvent.click(screen.getByRole('button', { name: 'Manage status links' }))
    await screen.findByText('No candidate status links created yet.')
    fireEvent.click(screen.getByRole('button', { name: 'Create candidate status link' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create copy-only link' }))

    expect(await screen.findByDisplayValue(STATUS_URL)).toBeTruthy()
    expect(document.body.textContent).not.toContain('candidate@example.com')

    fireEvent.click(screen.getByRole('button', { name: 'Copy candidate status link' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(STATUS_URL))
    expect(
      await screen.findByText('Status link copied. The raw link is no longer shown.'),
    ).toBeTruthy()
    expect(screen.queryByDisplayValue(STATUS_URL)).toBeNull()
    expect(document.body.innerHTML).not.toContain('fragment-only-capability-secret')
  })

  it('keeps a failed clipboard copy available for a member to copy manually, then clears it on confirmation', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => '11111111-1111-4111-8111-111111111111' })
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('blocked')) } })
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method || init.method === 'GET') return json({ candidateStatusLinks: [] })
      return json({ created: true, statusUrl: STATUS_URL }, 201)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<CandidateStatusLinksPanel applicationId={APPLICATION_ID} />)
    fireEvent.click(screen.getByRole('button', { name: 'Manage status links' }))
    await screen.findByText('No candidate status links created yet.')
    fireEvent.click(screen.getByRole('button', { name: 'Create candidate status link' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create copy-only link' }))
    await screen.findByDisplayValue(STATUS_URL)

    fireEvent.click(screen.getByRole('button', { name: 'Copy candidate status link' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Copy the link manually')
    expect(screen.getByDisplayValue(STATUS_URL)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'I copied it — hide link' }))
    expect(await screen.findByText('Status link hidden after your manual copy.')).toBeTruthy()
    expect(screen.queryByDisplayValue(STATUS_URL)).toBeNull()
    expect(document.body.innerHTML).not.toContain('fragment-only-capability-secret')
  })

  it('uses only the application-scoped member APIs, filters cross-application rows, and revokes an active safe row', async () => {
    let revoked = false
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (!init?.method || init.method === 'GET') {
        expect(path).toBe(
          `/api/workspace/applications/${APPLICATION_ID}/candidate-status-links`,
        )
        return json({
          candidateStatusLinks: [
            {
              id: 'link-1',
              applicationId: APPLICATION_ID,
              active: !revoked,
              expiresAt: '2099-09-13T00:00:00.000Z',
              revokedAt: revoked ? '2026-08-14T00:00:00.000Z' : null,
              // Hostile additions must be discarded by the client DTO boundary.
              statusUrl: 'https://hire.example/candidate-status/link-1#status=never-render',
              secretHash: 'never-render-hash',
              candidateEmail: 'never-render@example.com',
            },
            {
              id: 'cross-application-link',
              applicationId: 'other-application',
              active: true,
              expiresAt: '2099-09-13T00:00:00.000Z',
              revokedAt: null,
              statusUrl: 'https://hire.example/candidate-status/cross#status=never-render-cross',
            },
          ],
        })
      }
      expect(path).toBe('/api/workspace/candidate-status-links/link-1/revoke')
      expect(init.method).toBe('POST')
      revoked = true
      return json({ candidateStatusLink: { id: 'link-1', active: false } })
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<CandidateStatusLinksPanel applicationId={APPLICATION_ID} />)
    fireEvent.click(screen.getByRole('button', { name: 'Manage status links' }))
    expect(await screen.findByRole('button', { name: 'Revoke status link' })).toBeTruthy()
    expect(document.body.textContent).not.toContain('never-render@example.com')
    expect(document.body.innerHTML).not.toContain('never-render-cross')
    expect(document.body.innerHTML).not.toContain('never-render-hash')

    fireEvent.click(screen.getByRole('button', { name: 'Revoke status link' }))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/workspace/candidate-status-links/link-1/revoke',
        expect.objectContaining({ method: 'POST' }),
      )
    })
    expect(await screen.findByText('Candidate status link revoked.')).toBeTruthy()
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Revoke status link' })).toBeNull()
    })
    expect(
      fetchMock.mock.calls
        .filter(([, init]) => !init?.method || init.method === 'GET')
        .every(([input]) => String(input).includes(`/applications/${APPLICATION_ID}/`)),
    ).toBe(true)
  })

  it('does not display a capability returned on an idempotent issue retry', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => '11111111-1111-4111-8111-111111111111' })
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method || init.method === 'GET') return json({ candidateStatusLinks: [] })
      return json({ created: false, statusUrl: STATUS_URL })
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<CandidateStatusLinksPanel applicationId={APPLICATION_ID} />)
    fireEvent.click(screen.getByRole('button', { name: 'Manage status links' }))
    await screen.findByText('No candidate status links created yet.')
    fireEvent.click(screen.getByRole('button', { name: 'Create candidate status link' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create copy-only link' }))

    expect(
      await screen.findByText(/This request was already completed\. The one-time link cannot be recovered/),
    ).toBeTruthy()
    expect(screen.queryByDisplayValue(STATUS_URL)).toBeNull()
    expect(document.body.innerHTML).not.toContain('fragment-only-capability-secret')
  })
})
