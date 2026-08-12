import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import JobsPage from '../page'

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Smart JD workspace company blurb', () => {
  it('prefills the saved workspace default and lets an admin update it explicitly', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/workspace/jobs') return json({ jobs: [] })
      if (url === '/api/workspace' && init?.method === 'PATCH') {
        expect(JSON.parse(String(init.body))).toEqual({
          companyBlurb: 'We build trustworthy hiring tools.',
        })
        return json({
          workspace: { companyBlurb: 'We build trustworthy hiring tools.' },
        })
      }
      if (url === '/api/workspace') {
        return json({
          workspace: { companyBlurb: 'Saved Acme company context.' },
          membership: { role: 'admin' },
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<JobsPage />)
    await screen.findByText('No jobs yet')
    fireEvent.click(screen.getAllByRole('button', { name: 'New job' })[0])

    const blurb = screen.getByLabelText('Company blurb (optional)')
    expect(blurb).toHaveValue('Saved Acme company context.')
    fireEvent.change(blurb, {
      target: { value: 'We build trustworthy hiring tools.' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: 'Save workspace default' }),
    )

    await screen.findByText('Saved as the workspace default.')
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/workspace',
        expect.objectContaining({ method: 'PATCH' }),
      )
    })
  })
})
