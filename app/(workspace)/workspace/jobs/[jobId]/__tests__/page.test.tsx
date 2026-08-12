import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import JobPipelinePage from '../page'

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}))

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('job close-rejection email delivery', () => {
  it('shows terminal failures and safely requeues them from the job screen', async () => {
    let retried = false
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/workspace/candidates') return json({ candidates: [] })
      if (url === '/api/workspace/jobs/job-1/email-delivery/retry') {
        expect(init?.method).toBe('POST')
        retried = true
        return json({ requeued: 1 })
      }
      if (url === '/api/workspace/jobs/job-1') {
        return json({
          job: {
            id: 'job-1',
            title: 'Backend Engineer',
            status: 'closed',
            closeNote: 'Role filled.',
            closedByName: 'HR One',
            jdText: 'Build reliable systems.',
            applyPageEnabled: false,
          },
          entries: [],
          emailDelivery: retried
            ? {
                total: 1,
                pending: 1,
                sending: 0,
                sent: 0,
                failed: 0,
                failures: [],
              }
            : {
                total: 1,
                pending: 0,
                sending: 0,
                sent: 0,
                failed: 1,
                failures: [
                  {
                    recipientEmail: 'candidate@example.com',
                    recipientName: 'Candidate One',
                    attempts: 5,
                    lastError: 'Provider did not accept the message',
                    failedAt: '2026-08-10T11:00:00.000Z',
                  },
                ],
              },
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<JobPipelinePage params={{ jobId: 'job-1' }} />)

    await screen.findByRole('heading', {
      name: '1 rejection email could not be delivered',
    })
    expect(screen.getByText(/Candidate One \(candidate@example.com\)/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry failed email' }))

    await screen.findByText('1 failed email was requeued for delivery.')
    await waitFor(() => {
      expect(
        screen.queryByRole('heading', {
          name: '1 rejection email could not be delivered',
        }),
      ).not.toBeInTheDocument()
    })
  })
})
