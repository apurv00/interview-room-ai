import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import JobPipelinePage from '../page'

const router = vi.hoisted(() => ({
  replace: vi.fn(),
  refresh: vi.fn(),
}))

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => router,
}))

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  router.replace.mockReset()
  router.refresh.mockReset()
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

  it('submits an optional plain-text rejection template only with the close command', async () => {
    const operationId = '11111111-1111-4111-8111-111111111111'
    vi.stubGlobal('crypto', { randomUUID: () => operationId })
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/workspace/candidates') return json({ candidates: [] })
      if (url === '/api/workspace/jobs/job-1' && init?.method === 'PATCH') {
        expect(JSON.parse(String(init.body))).toEqual({
          status: 'closed',
          expectedStatus: 'open',
          operationId,
          closeNote: 'Role filled after panel review.',
          closeEmailTemplate: {
            subject: '{workspace_name}: update for {candidate_first_name}',
            body: 'Hi {candidate_first_name},\n\n{job_title} has closed.',
          },
        })
        return json({
          job: {
            id: 'job-1',
            title: 'Backend Engineer',
            status: 'closed',
            closeNote: 'Role filled after panel review.',
            closedByName: 'HR One',
            jdText: 'Build reliable systems.',
            applyPageEnabled: false,
          },
        })
      }
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
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<JobPipelinePage params={{ jobId: 'job-1' }} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Close job' }))
    fireEvent.change(screen.getByPlaceholderText(/Hired Jane Doe/i), {
      target: { value: 'Role filled after panel review.' },
    })
    fireEvent.click(screen.getByLabelText('Customize the candidate rejection email'))
    expect(screen.getByText(/This decision note stays internal/i)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Candidate email subject'), {
      target: { value: '{workspace_name}: update for {candidate_first_name}' },
    })
    fireEvent.change(screen.getByLabelText('Candidate email body'), {
      target: { value: 'Hi {candidate_first_name},\n\n{job_title} has closed.' },
    })

    fireEvent.click(screen.getAllByRole('button', { name: 'Close job' })[1])
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/workspace/jobs/job-1',
        expect.objectContaining({ method: 'PATCH' }),
      )
    })
  })
})

describe('job duplication UI', () => {
  it('shows the fresh public apply capability and makes clear it remains available on the new job page', async () => {
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
      if (url === '/api/workspace/departments') {
        return json({
          departments: [
            { id: 'department-1', name: 'Engineering', status: 'active', kind: 'standard' },
            { id: 'department-2', name: 'Product', status: 'active', kind: 'standard' },
            { id: 'department-3', name: 'Former org', status: 'archived', kind: 'standard' },
            { id: 'department-4', name: 'Legacy import', status: 'active', kind: 'legacy' },
            { id: 'department-5', name: 'Practice records', status: 'active', kind: 'onboarding' },
          ],
        })
      }
      if (url === '/api/workspace') return json({ membership: { role: 'admin' } })
      if (url === '/api/workspace/jobs/job-1') {
        return json({
          job: {
            id: 'job-1',
            departmentId: 'department-1',
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
        expect(init).toEqual({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ departmentId: 'department-2' }),
        })
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
    expect(screen.getByRole('option', { name: 'Engineering' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Product' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Former org' })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Legacy import' })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Practice records' })).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Department for duplicate'), {
      target: { value: 'department-2' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Create duplicate' }))

    await screen.findByRole('heading', { name: 'Job duplicated' })
    expect(fetchMock).toHaveBeenCalledWith('/api/workspace/jobs/job-1/duplicate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ departmentId: 'department-2' }),
    })
    expect(screen.getByRole('textbox', { name: 'Fresh public apply link' })).toHaveValue(freshApplyLink)
    expect(screen.getByText(/also available from the new job page/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Continue to new job' })).toHaveAttribute(
      'href',
      '/workspace/jobs/job-copy',
    )
    expect(window.location.href).not.toContain(capability)

    fireEvent.click(screen.getByRole('button', { name: 'Copy apply link' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(freshApplyLink))
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })

  it('lets an admin reassign only to active standard departments', async () => {
    let currentDepartmentId = 'department-1'
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/workspace/candidates') return json({ candidates: [] })
      if (url === '/api/workspace/departments') {
        return json({
          departments: [
            { id: 'department-1', name: 'Engineering', status: 'active', kind: 'standard' },
            { id: 'department-2', name: 'Product', status: 'active', kind: 'standard' },
            { id: 'department-3', name: 'Former org', status: 'archived', kind: 'standard' },
            { id: 'department-4', name: 'Legacy import', status: 'active', kind: 'legacy' },
          ],
        })
      }
      if (url === '/api/workspace') return json({ membership: { role: 'admin' } })
      if (url === '/api/workspace/jobs/job-1/department') {
        expect(init).toEqual({
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ departmentId: 'department-2' }),
        })
        currentDepartmentId = 'department-2'
        return json({
          job: {
            id: 'job-1',
            departmentId: currentDepartmentId,
          },
        })
      }
      if (url === '/api/workspace/jobs/job-1') {
        return json({
          job: {
            id: 'job-1',
            departmentId: 'department-2',
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
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<JobPipelinePage params={{ jobId: 'job-1' }} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Change department' }))
    expect(screen.getByRole('heading', { name: 'Change department' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Engineering' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Product' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Former org' })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Legacy import' })).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Department'), {
      target: { value: 'department-2' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save department' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/workspace/jobs/job-1/department', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ departmentId: 'department-2' }),
      })
    })
    expect(screen.getByText('Department:')).toBeInTheDocument()
    expect(screen.getByText('Product')).toBeInTheDocument()
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
    expect(screen.getByRole('button', { name: 'Quick add (unscored)' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Quick add (unscored)' }))

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

  it('routes a manual résumé through the durable intake queue and exposes only safe recovery state', async () => {
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
      if (url === '/api/workspace/jobs/job-1/intake' && init?.method === 'POST') {
        expect(init.body).toBeInstanceOf(FormData)
        const formData = init.body as FormData
        expect((formData.get('file') as File).name).toBe('jane.pdf')
        expect(formData.get('name')).toBe('Jane Candidate')
        expect(formData.get('email')).toBe('jane@example.com')
        return json({
          task: {
            taskId: 'task-1',
            status: 'queued',
            attempts: 0,
            dispatch: {
              status: 'failed',
              attempts: 1,
              lastErrorCode: 'inngest_dispatch_unavailable',
            },
          },
        }, 202)
      }
      if (url === '/api/workspace/jobs/job-1/intake/task-1') {
        expect(init?.cache).toBe('no-store')
        return json({
          task: {
            taskId: 'task-1',
            status: 'queued',
            attempts: 0,
            dispatch: {
              status: 'failed',
              attempts: 1,
              lastErrorCode: 'inngest_dispatch_unavailable',
            },
          },
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<JobPipelinePage params={{ jobId: 'job-1' }} />)

    fireEvent.click((await screen.findAllByRole('button', { name: 'Add candidate' }))[0])
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Jane Candidate' } })
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'jane@example.com' } })
    fireEvent.change(screen.getByLabelText(/Résumé/), {
      target: { files: [new File(['resume'], 'jane.pdf', { type: 'application/pdf' })] },
    })

    expect(screen.getByRole('button', { name: 'Queue résumé & score against JD' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Queue résumé & score against JD' }))

    expect(await screen.findByText(/automatic recovery will retry/i)).toBeInTheDocument()
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/workspace/jobs/job-1/intake',
        expect.objectContaining({ method: 'POST' }),
      )
    })
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => String(url) === '/api/workspace/jobs/job-1/candidates' && init?.method === 'POST',
      ),
    ).toBe(false)
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

describe('visible public apply links', () => {
  function openJobResponse({
    applyPageEnabled = true,
    status = 'open',
  }: {
    applyPageEnabled?: boolean
    status?: 'open' | 'on_hold' | 'closed'
  } = {}) {
    return json({
      job: {
        id: 'job-1',
        departmentId: 'department-1',
        title: 'Backend Engineer',
        status,
        closeNote: null,
        closedByName: null,
        jdText: 'Build reliable systems.',
        applyPageEnabled,
      },
      entries: [],
    })
  }

  it('shows the same fragment-based URL returned to the authenticated HR member', async () => {
    const capability = '111111111111111111111111.' + 'a'.repeat(64)
    const applyLink = `${window.location.origin}/apply#apply=${encodeURIComponent(capability)}`
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/workspace/candidates') return json({ candidates: [] })
      if (url === '/api/workspace/departments') return json({ departments: [] })
      if (url === '/api/workspace') return json({ membership: { role: 'member' } })
      if (url === '/api/workspace/jobs/job-1') return openJobResponse()
      if (url === '/api/workspace/jobs/job-1/apply-link') {
        expect(init).toEqual({ cache: 'no-store' })
        return json({ capability })
      }
      if (url.endsWith('/screening')) return json({ gates: [] })
      if (url.endsWith('/pool-suggestions')) return json({ suggestions: [] })
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<JobPipelinePage params={{ jobId: 'job-1' }} />)

    expect(await screen.findByDisplayValue(applyLink)).toBeInTheDocument()
    expect(screen.getByText(/remains available to workspace members/i)).toBeInTheDocument()
    expect(window.location.href).not.toContain(capability)
  })

  it('asks HR to replace a live legacy link that cannot be recovered', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/workspace/candidates') return json({ candidates: [] })
      if (url === '/api/workspace/departments') return json({ departments: [] })
      if (url === '/api/workspace') return json({ membership: { role: 'member' } })
      if (url === '/api/workspace/jobs/job-1') return openJobResponse()
      if (url === '/api/workspace/jobs/job-1/apply-link') {
        return json({ capability: null })
      }
      if (url.endsWith('/screening')) return json({ gates: [] })
      if (url.endsWith('/pool-suggestions')) return json({ suggestions: [] })
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<JobPipelinePage params={{ jobId: 'job-1' }} />)

    expect(await screen.findByText(/live link cannot be recovered here/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Replace link' })).toBeInTheDocument()
  })

  it('does not present a temporary retrieval error as a reason to revoke a valid link', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/workspace/candidates') return json({ candidates: [] })
      if (url === '/api/workspace/departments') return json({ departments: [] })
      if (url === '/api/workspace') return json({ membership: { role: 'member' } })
      if (url === '/api/workspace/jobs/job-1') return openJobResponse()
      if (url === '/api/workspace/jobs/job-1/apply-link') {
        return json({ error: 'Could not retrieve the active link' }, 503)
      }
      if (url.endsWith('/screening')) return json({ gates: [] })
      if (url.endsWith('/pool-suggestions')) return json({ suggestions: [] })
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<JobPipelinePage params={{ jobId: 'job-1' }} />)

    expect(await screen.findByText(/may still be live; try again before replacing/i))
      .toBeInTheDocument()
    expect(screen.queryByText(/live link cannot be recovered here/i)).not.toBeInTheDocument()
  })

  it('keeps a just-created URL visible when a routine recovery read is temporarily unavailable', async () => {
    const capability = '111111111111111111111111.' + 'b'.repeat(64)
    const applyLink = `${window.location.origin}/apply#apply=${encodeURIComponent(capability)}`
    let enabled = false
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/workspace/candidates') return json({ candidates: [] })
      if (url === '/api/workspace/departments') return json({ departments: [] })
      if (url === '/api/workspace') return json({ membership: { role: 'member' } })
      if (url === '/api/workspace/jobs/job-1') return openJobResponse({ applyPageEnabled: enabled })
      if (url === '/api/workspace/jobs/job-1/apply-link' && init?.method === 'POST') {
        enabled = true
        return json({ enabled: true, capability })
      }
      if (url === '/api/workspace/jobs/job-1/apply-link') {
        throw new Error('temporary protected-read failure')
      }
      if (url.endsWith('/screening')) return json({ gates: [] })
      if (url.endsWith('/pool-suggestions')) return json({ suggestions: [] })
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<JobPipelinePage params={{ jobId: 'job-1' }} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Create link' }))

    expect(await screen.findByDisplayValue(applyLink)).toBeInTheDocument()
    expect(screen.queryByText(/live link cannot be recovered here/i)).not.toBeInTheDocument()
  })

  it('keeps a live on-hold link visible because public resolution remains enabled until close or turn-off', async () => {
    const capability = '111111111111111111111111.' + 'c'.repeat(64)
    const applyLink = `${window.location.origin}/apply#apply=${encodeURIComponent(capability)}`
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/workspace/candidates') return json({ candidates: [] })
      if (url === '/api/workspace/departments') return json({ departments: [] })
      if (url === '/api/workspace') return json({ membership: { role: 'member' } })
      if (url === '/api/workspace/jobs/job-1') {
        return openJobResponse({ applyPageEnabled: true, status: 'on_hold' })
      }
      if (url === '/api/workspace/jobs/job-1/apply-link') {
        return json({ capability })
      }
      if (url.endsWith('/screening')) return json({ gates: [] })
      if (url.endsWith('/pool-suggestions')) return json({ suggestions: [] })
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<JobPipelinePage params={{ jobId: 'job-1' }} />)

    expect(await screen.findByDisplayValue(applyLink)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Replace link' })).toBeInTheDocument()
  })
})

describe('empty-job deletion UI', () => {
  function emptyJobResponse({ applyPageEnabled = false }: { applyPageEnabled?: boolean } = {}) {
    return json({
      job: {
        id: 'job-1',
        departmentId: 'department-1',
        title: 'Backend Engineer',
        status: 'open',
        closeNote: null,
        closedByName: null,
        jdText: 'Build reliable systems.',
        applyPageEnabled,
      },
      entries: [],
    })
  }

  it('keeps deletion admin-only and requires the exact title plus acknowledgement', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/workspace/candidates') return json({ candidates: [] })
      if (url === '/api/workspace/departments') return json({ departments: [] })
      if (url === '/api/workspace') return json({ membership: { role: 'member' } })
      if (url === '/api/workspace/jobs/job-1') return emptyJobResponse()
      if (url.endsWith('/screening')) return json({ gates: [] })
      if (url.endsWith('/pool-suggestions')) return json({ suggestions: [] })
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<JobPipelinePage params={{ jobId: 'job-1' }} />)
    await screen.findByRole('heading', { name: 'Backend Engineer' })
    expect(screen.queryByRole('button', { name: 'Delete empty job' })).not.toBeInTheDocument()
  })

  it('requires the public apply link to be turned off before deletion can be opened', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/workspace/candidates') return json({ candidates: [] })
      if (url === '/api/workspace/departments') return json({ departments: [] })
      if (url === '/api/workspace') return json({ membership: { role: 'admin' } })
      if (url === '/api/workspace/jobs/job-1') return emptyJobResponse({ applyPageEnabled: true })
      if (url === '/api/workspace/jobs/job-1/apply-link') {
        return json({ capability: null })
      }
      if (url.endsWith('/screening')) return json({ gates: [] })
      if (url.endsWith('/pool-suggestions')) return json({ suggestions: [] })
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<JobPipelinePage params={{ jobId: 'job-1' }} />)

    const deleteButton = await screen.findByRole('button', { name: 'Delete empty job' })
    expect(deleteButton).toBeDisabled()
    expect(deleteButton).toHaveAttribute(
      'title',
      'Turn off the public apply link before deleting this job.',
    )
  })

  it('submits one guarded DELETE command and redirects only after server confirmation', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/workspace/candidates') return json({ candidates: [] })
      if (url === '/api/workspace/departments') return json({ departments: [] })
      if (url === '/api/workspace') return json({ membership: { role: 'admin' } })
      if (url === '/api/workspace/jobs/job-1' && init?.method === 'DELETE') {
        expect(JSON.parse(String(init.body))).toEqual({
          confirmationTitle: 'Backend Engineer',
          acknowledgeEmptyJobDeletion: true,
        })
        return json({ deleted: true, jobId: 'job-1' })
      }
      if (url === '/api/workspace/jobs/job-1') return emptyJobResponse()
      if (url.endsWith('/screening')) return json({ gates: [] })
      if (url.endsWith('/pool-suggestions')) return json({ suggestions: [] })
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<JobPipelinePage params={{ jobId: 'job-1' }} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete empty job' }))

    expect(screen.getByRole('dialog', { name: 'Delete this empty job?' })).toBeInTheDocument()
    const deleteButton = screen.getByRole('button', { name: 'Delete job permanently' })
    expect(deleteButton).toBeDisabled()
    fireEvent.change(screen.getByLabelText(/Type Backend Engineer to confirm/), {
      target: { value: 'Backend Engineer' },
    })
    expect(deleteButton).toBeDisabled()
    fireEvent.click(screen.getByLabelText(/I understand that this permanently deletes/i))
    expect(deleteButton).toBeEnabled()
    fireEvent.click(deleteButton)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/workspace/jobs/job-1', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirmationTitle: 'Backend Engineer',
          acknowledgeEmptyJobDeletion: true,
        }),
      })
    })
    expect(router.replace).toHaveBeenCalledWith('/workspace/jobs')
    expect(router.refresh).toHaveBeenCalledOnce()
  })

  it('keeps the dialog open and shows the server safety block', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/workspace/candidates') return json({ candidates: [] })
      if (url === '/api/workspace/departments') return json({ departments: [] })
      if (url === '/api/workspace') return json({ membership: { role: 'admin' } })
      if (url === '/api/workspace/jobs/job-1' && init?.method === 'DELETE') {
        return json({ error: 'This job has hiring activity and cannot be deleted. Close the job instead.' }, 409)
      }
      if (url === '/api/workspace/jobs/job-1') return emptyJobResponse()
      if (url.endsWith('/screening')) return json({ gates: [] })
      if (url.endsWith('/pool-suggestions')) return json({ suggestions: [] })
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<JobPipelinePage params={{ jobId: 'job-1' }} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete empty job' }))
    fireEvent.change(screen.getByLabelText(/Type Backend Engineer to confirm/), {
      target: { value: 'Backend Engineer' },
    })
    fireEvent.click(screen.getByLabelText(/I understand that this permanently deletes/i))
    fireEvent.click(screen.getByRole('button', { name: 'Delete job permanently' }))

    expect(await screen.findByText(/This job has hiring activity/i)).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Delete this empty job?' })).toBeInTheDocument()
    expect(router.replace).not.toHaveBeenCalled()
  })
})
