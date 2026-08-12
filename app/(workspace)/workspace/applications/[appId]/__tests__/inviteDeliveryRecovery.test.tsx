import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ApplicationCardPage from '../page'

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>{children}</a>
  ),
}))

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const INVITE_URL =
  'https://hire.interviewprep.guru/candidate/round-1#invite=111111111111111111111111.secret'

function card(deliveryStatus: 'failed' | 'sent', interviewInProgress = false) {
  return {
    application: {
      id: 'app-1',
      jobId: 'job-1',
      stage: 'new',
      decisionNote: null,
      offerDecision: null,
      resumeMatch: null,
      applicantSubmissions: [],
      events: [],
    },
    candidate: {
      id: 'candidate-1',
      name: 'Candidate One',
      email: 'candidate@example.com',
      phone: null,
      resumeText: null,
      resumeFileName: null,
    },
    job: { id: 'job-1', title: 'Platform Engineer', status: 'open' },
    rounds: [{
      id: 'round-1',
      status: 'invited',
      invitedAt: '2026-08-10T12:00:00.000Z',
      inviteExpiresAt: '2026-08-17T12:00:00.000Z',
      consentAt: null,
      linkedAt: null,
      revokedAt: null,
      config: { role: 'Platform Engineer', experience: '3-6', duration: 15 },
      attemptCount: 0,
      results: null,
      assessment: null,
      evidenceIndex: [],
      identityPhoto: null,
      mediaPurged: false,
      inviteDelivery: {
        status: deliveryStatus,
        attempts: deliveryStatus === 'failed' ? 1 : 2,
        expiresAt: '2026-08-17T12:00:00.000Z',
        sentAt: deliveryStatus === 'sent' ? '2026-08-10T12:01:00.000Z' : null,
        lastError: deliveryStatus === 'failed' ? 'Provider did not accept the invitation' : null,
        inviteUrl: INVITE_URL,
        recoverable: true,
      },
    }],
    activity: interviewInProgress ? [{ roundId: 'round-1', inProgress: true }] : [],
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('AI invitation delivery recovery UI', () => {
  it('shows the authenticated recovery link after reload and retries email idempotently', async () => {
    let retried = false
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/workspace/applications/app-1') {
        return json(card(retried ? 'sent' : 'failed'))
      }
      if (url === '/api/workspace/rounds/round-1/invite-delivery') {
        expect(init?.method).toBe('POST')
        retried = true
        return json({
          emailSent: true,
          delivery: card('sent').rounds[0].inviteDelivery,
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    render(<ApplicationCardPage params={{ appId: 'app-1' }} />)

    await screen.findByText('Invitation email failed · copy the link or retry')
    expect(screen.getByText(INVITE_URL)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Copy interview link' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(INVITE_URL))

    fireEvent.click(screen.getByRole('button', { name: 'Retry invitation email' }))
    await screen.findByText('Invitation email sent · recovery link available')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workspace/rounds/round-1/invite-delivery',
      { method: 'POST' },
    )
    expect(screen.queryByRole('button', { name: 'Retry invitation email' })).not.toBeInTheDocument()
  })

  it('refreshes until a published interview leaves the in-progress state', async () => {
    vi.useFakeTimers()
    let interviewInProgress = true
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('/api/workspace/applications/app-1')
      return json(card('sent', interviewInProgress))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<ApplicationCardPage params={{ appId: 'app-1' }} />)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByText('Interview in progress')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    interviewInProgress = false
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000)
      await Promise.resolve()
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('Interview in progress')).not.toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000)
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
