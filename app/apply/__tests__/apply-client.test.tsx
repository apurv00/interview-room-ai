import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
        JSON.stringify({
          jobTitle: 'Backend Engineer',
          workspaceName: 'Acme',
          companyDescription: 'Acme builds reliable workflow software for operations teams.',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    render(<ApplyClient />)

    expect(await screen.findByRole('heading', { name: 'Backend Engineer' })).toBeTruthy()
    expect(window.location.hash).toBe('')
    expect(window.location.pathname).toBe('/apply')
    expect(
      await screen.findByText('Acme builds reliable workflow software for operations teams.'),
    ).toBeTruthy()
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

  it('acknowledges a 202 submission as queued rather than implying synchronous processing', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ jobTitle: 'Backend Engineer', workspaceName: 'Acme' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ok: true, message: 'Your application has been submitted.' }),
          { status: 202, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    vi.stubGlobal('fetch', fetchMock)

    render(<ApplyClient />)
    await screen.findByRole('heading', { name: 'Backend Engineer' })

    fireEvent.change(screen.getByLabelText('Full name'), {
      target: { value: 'Ada Lovelace' },
    })
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'ada@example.com' },
    })
    const resumeInput = screen.getByLabelText(/résumé/i)
    expect(resumeInput).toHaveClass('sr-only')
    expect(resumeInput).not.toHaveClass('hidden')
    fireEvent.change(resumeInput, {
      target: {
        files: [new File(['resume bytes'], 'ada.pdf', { type: 'application/pdf' })],
      },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Submit application' }))

    expect(await screen.findByRole('heading', { name: 'Application queued' })).toBeTruthy()
    expect(
      screen.getByText(/will process your résumé shortly/i),
    ).toBeTruthy()
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/apply',
      expect.objectContaining({
        method: 'POST',
        headers: { 'x-hire-apply-capability': CAPABILITY },
      }),
    )
  })

  it('keeps a transient form-bootstrap failure retryable instead of calling the link invalid', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: 'temporary upstream failure' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ jobTitle: 'Backend Engineer', workspaceName: 'Acme' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    vi.stubGlobal('fetch', fetchMock)

    render(<ApplyClient />)

    expect(await screen.findByRole('heading', { name: 'We could not open the application form' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'This application link is no longer active' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByRole('heading', { name: 'Backend Engineer' })).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(window.location.hash).toBe('')
  })
})
