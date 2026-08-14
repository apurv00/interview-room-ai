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

describe('job duplication UI', () => {
  it('keeps the fresh public apply capability transient until HR copies it and continues', async () => {
    const capability = 'fresh-job-capability.abc123'
    const freshApplyLink = `${window.location.origin}/apply#apply=${encodeURIComponent(capability)}`
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/workspace/candidates') return json({ candidates: [] })
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
        })
      }
      if (url === '/api/workspace/jobs/job-1/duplicate') {
        expect(init).toEqual({ method: 'POST' })
        return json({
          job: { id: 'job-copy', title: 'Backend Engineer (copy)' },
          capability,
        }, 201)
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<JobPipelinePage params={{ jobId: 'job-1' }} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Duplicate job' }))
    expect(screen.getByRole('dialog', { name: 'Duplicate this job?' })).toBeInTheDocument()
    expect(screen.getByText(/zero candidates and a fresh public apply link/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Create duplicate' }))

    await screen.findByRole('heading', { name: 'Job duplicated' })
    expect(fetchMock).toHaveBeenCalledWith('/api/workspace/jobs/job-1/duplicate', {
      method: 'POST',
    })
    expect(screen.getByRole('textbox', { name: 'Fresh public apply link' })).toHaveValue(freshApplyLink)
    expect(screen.getByRole('link', { name: 'Continue to new job' })).toHaveAttribute(
      'href',
      '/workspace/jobs/job-copy',
    )
    expect(window.location.href).not.toContain(capability)

    fireEvent.click(screen.getByRole('button', { name: 'Copy apply link' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(freshApplyLink))
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })
})

describe('job candidate add/merge UI', () => {
  it('uses the one job-scoped merge command rather than split candidate/application writes', async () => {
    const operationId = '11111111-1111-4111-8111-111111111111'
    vi.stubGlobal('crypto', { randomUUID: () => operationId })
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/workspace/candidates') return json({ candidates: [] })
      if (url === '/api/workspace/jobs/job-1') {
        return json({
          job: {
            id: 'job-1',
            title: 'Backend Engineer',
            status: 'open',
            closeNote: null,
            closedByName: null,
            jdText: 'Build reliable systems.',
            applyPageEnabled: false,
          },
          entries: [],
        })
      }
      if (url === '/api/workspace/jobs/job-1/candidates') {
        expect(init?.method).toBe('POST')
        expect(JSON.parse(String(init?.body))).toEqual({
          name: 'Jane Candidate',
          email: 'jane@example.com',
          operationId,
        })
        return json({
          status: 'created',
          candidate: { id: 'candidate-1' },
          application: { id: 'application-1' },
          createdCandidate: true,
          createdApplication: true,
          sourceMerged: false,
        }, 201)
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<JobPipelinePage params={{ jobId: 'job-1' }} />)

    fireEvent.click((await screen.findAllByRole('button', { name: 'Add candidate' }))[0])
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Jane Candidate' } })
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'jane@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add to job' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/workspace/jobs/job-1/candidates',
        expect.objectContaining({ method: 'POST' }),
      )
    })
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/api/workspace/applications',
      expect.anything(),
    )
  })
})

describe('ranked pipeline visibility', () => {
  it('keeps fresh rank and other in-workspace job history visible on the candidate card', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/workspace/candidates') return json({ candidates: [] })
      if (url === '/api/workspace/jobs/job-1/screening') return json({ gates: [] })
      if (url === '/api/workspace/jobs/job-1') {
        return json({
          job: {
            id: 'job-1',
            title: 'Backend Engineer',
            status: 'open',
            closeNote: null,
            closedByName: null,
            jdText: 'Build reliable systems.',
            applyPageEnabled: false,
          },
          entries: [
            {
              application: {
                id: 'application-1',
                stage: 'new',
                decisionNote: null,
                offerDecision: null,
                resumeMatch: { score: 92, stale: false },
                createdAt: '2026-08-13T00:00:00.000Z',
              },
              candidate: {
                id: 'candidate-1',
                name: 'Candidate One',
                email: 'candidate@example.com',
              },
              latestRound: null,
              ranking: { scoreState: 'scored', rank: 1 },
              previouslySeenIn: [
                { jobId: 'job-before', jobTitle: 'Platform Engineer', stage: 'screened' },
              ],
            },
          ],
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<JobPipelinePage params={{ jobId: 'job-1' }} />)

    await screen.findByText('Pool rank #1 · 92')
    expect(screen.getByText(/Previously seen in/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Platform Engineer' })).toHaveAttribute(
      'href',
      '/workspace/jobs/job-before',
    )
  })

  it('offers direct navigation to the bottom of a fifty-resume ranked queue', async () => {
    const entries = Array.from({ length: 50 }, (_, index) => ({
      application: {
        id: `application-${index + 1}`,
        stage: 'new',
        decisionNote: null,
        offerDecision: null,
        resumeMatch: { score: 100 - index, stale: false },
        createdAt: `2026-08-13T00:${String(index).padStart(2, '0')}:00.000Z`,
      },
      candidate: {
        id: `candidate-${index + 1}`,
        name: `Candidate ${index + 1}`,
        email: `candidate-${index + 1}@example.com`,
      },
      latestRound: null,
      ranking: { scoreState: 'scored', rank: index + 1 },
      previouslySeenIn: [],
    }))
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/workspace/candidates') return json({ candidates: [] })
      if (url === '/api/workspace/jobs/job-1/screening') return json({ gates: [] })
      if (url === '/api/workspace/jobs/job-1/pool-suggestions') return json({ suggestions: [] })
      if (url === '/api/workspace/jobs/job-1') {
        return json({
          job: {
            id: 'job-1',
            title: 'Backend Engineer',
            status: 'open',
            closeNote: null,
            closedByName: null,
            jdText: 'Build reliable systems.',
            applyPageEnabled: false,
          },
          entries,
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<JobPipelinePage params={{ jobId: 'job-1' }} />)

    const queueNavigation = await screen.findByRole('navigation', { name: 'Ranked candidate queue' })
    expect(queueNavigation).toHaveTextContent('50 fresh JD-match scores ranked')
    expect(screen.getByRole('link', { name: 'View ranked queue' })).toHaveAttribute('href', '#ranked-queue')
    expect(screen.getByRole('link', { name: 'Jump to rank #50' })).toHaveAttribute(
      'href',
      '#ranked-queue-bottom',
    )
    expect(document.getElementById('ranked-queue-bottom')).toHaveTextContent('Rank #50')
    expect(document.getElementById('ranked-queue-bottom')).toHaveTextContent('Candidate 50')
  })
})

describe('human-round pipeline visibility', () => {
  it('renders pending human scorecards as a separate chip from AI interview state', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/workspace/candidates') return json({ candidates: [] })
      if (url === '/api/workspace/jobs/job-1/screening') return json({ gates: [] })
      if (url === '/api/workspace/jobs/job-1/pool-suggestions') return json({ suggestions: [] })
      if (url === '/api/workspace/jobs/job-1') {
        return json({
          job: {
            id: 'job-1',
            title: 'Backend Engineer',
            status: 'open',
            closeNote: null,
            closedByName: null,
            jdText: 'Build reliable systems.',
            applyPageEnabled: false,
          },
          entries: [{
            application: {
              id: 'application-1',
              stage: 'interviewing',
              decisionNote: null,
              offerDecision: null,
              resumeMatch: null,
              createdAt: '2026-08-13T00:00:00.000Z',
            },
            candidate: { id: 'candidate-1', name: 'Candidate One', email: 'candidate@example.com' },
            latestRound: null,
            humanRoundSummary: {
              total: 1,
              completed: 0,
              pendingScorecard: 1,
              revoked: 0,
              rounds: [{
                id: 'human-round-1',
                mode: 'guest_kit',
                status: 'pending_scorecard',
                openedAt: null,
                scorecardSubmittedAt: null,
                revokedAt: null,
                createdAt: '2026-08-13T00:00:00.000Z',
              }],
            },
            ranking: { scoreState: 'unscored', rank: null },
            previouslySeenIn: [],
          }],
        })
      }
      return json({})
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<JobPipelinePage params={{ jobId: 'job-1' }} />)

    expect(await screen.findByText('1 human scorecard pending')).toBeInTheDocument()
    expect(screen.queryByText('AI in progress')).not.toBeInTheDocument()
  })
})
