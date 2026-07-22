import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import TrackerPage from '../page'

const JOB_ID = '507f1f77bcf86cd799439011'
const JOB_ID_2 = '507f1f77bcf86cd799439012'

beforeEach(() => {
  mockFetch.mockReset()
})

describe('Jobs tracker posting lifecycle', () => {
  it('distinguishes account deletion from ordinary sign-in expiry on the initial load', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ code: 'ACCOUNT_UNAVAILABLE' }),
    })

    const view = render(<TrackerPage />)

    expect(await screen.findByText('Your account is unavailable.')).toBeTruthy()
    expect(screen.getByText(/Account deletion has started or completed/i)).toBeTruthy()
    expect(screen.queryByText(/Sign in to see your job tracker/i)).toBeNull()

    view.unmount()
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: 'sign in required' }),
    })
    render(<TrackerPage />)

    expect(await screen.findByText('Sign in to see your job tracker.')).toBeTruthy()
    expect(screen.queryByText('Your account is unavailable.')).toBeNull()
  })

  it('clears rendered rows and open note state when a mutation reports account unavailability', async () => {
    const tracker = {
      groups: [{
        status: 'applied',
        count: 1,
        rows: [{
          jobPostingId: JOB_ID,
          title: 'Frontend Engineer',
          company: 'Acme',
          location: 'Remote',
          status: 'applied',
          postingState: 'live',
          daysInStatus: 3,
          practiceCount: 1,
          notes: 'private note',
          nudge: null,
          unconfirmedClick: false,
        }],
      }],
      confirmCard: null,
    }
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/jobs/tracker') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(tracker) })
      }
      return Promise.resolve({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ code: 'ACCOUNT_UNAVAILABLE' }),
      })
    })

    render(<TrackerPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit note' }))
    expect(screen.getByRole('textbox')).toHaveValue('private note')
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }))

    expect(await screen.findByText('Your account is unavailable.')).toBeTruthy()
    expect(screen.queryByText('Frontend Engineer')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  })

  it('keeps account deletion terminal when a slower ordinary 401 arrives afterward', async () => {
    let resolveNotes!: (value: unknown) => void
    let resolveStatus!: (value: unknown) => void
    const notesResponse = new Promise((resolve) => { resolveNotes = resolve })
    const statusResponse = new Promise((resolve) => { resolveStatus = resolve })
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/jobs/tracker') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            groups: [{
              status: 'applied',
              count: 1,
              rows: [{
                jobPostingId: JOB_ID,
                title: 'Frontend Engineer',
                company: 'Acme',
                location: 'Remote',
                status: 'applied',
                postingState: 'live',
                daysInStatus: 3,
                practiceCount: 1,
                notes: 'private note',
                nudge: null,
                unconfirmedClick: false,
              }],
            }],
            confirmCard: null,
          }),
        })
      }
      if (url.endsWith('/nudge-dismiss')) return notesResponse
      if (url.endsWith('/status')) return statusResponse
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
    })

    render(<TrackerPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit note' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }))
    fireEvent.click(screen.getByRole('button', { name: /Interview scheduled/ }))

    await act(async () => {
      resolveNotes({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ code: 'ACCOUNT_UNAVAILABLE' }),
      })
    })
    expect(await screen.findByText('Your account is unavailable.')).toBeTruthy()

    await act(async () => {
      resolveStatus({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: 'sign in required' }),
      })
    })
    expect(screen.getByText('Your account is unavailable.')).toBeTruthy()
    expect(screen.queryByText('Sign in to see your job tracker.')).toBeNull()
    expect(screen.queryByText('Frontend Engineer')).toBeNull()
  })

  it('ignores a slower successful mutation after account deletion becomes terminal', async () => {
    let resolveNotes!: (value: unknown) => void
    let resolveStatus!: (value: unknown) => void
    const notesResponse = new Promise((resolve) => { resolveNotes = resolve })
    const statusResponse = new Promise((resolve) => { resolveStatus = resolve })
    const tracker = {
      groups: [{
        status: 'applied',
        count: 1,
        rows: [{
          jobPostingId: JOB_ID,
          title: 'Frontend Engineer',
          company: 'Acme',
          location: 'Remote',
          status: 'applied',
          postingState: 'live',
          daysInStatus: 3,
          practiceCount: 1,
          notes: 'private note',
          nudge: null,
          unconfirmedClick: false,
        }],
      }],
      confirmCard: null,
    }
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/jobs/tracker') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(tracker) })
      }
      if (url.endsWith('/nudge-dismiss')) return notesResponse
      if (url.endsWith('/status')) return statusResponse
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
    })

    render(<TrackerPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit note' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }))
    fireEvent.click(screen.getByRole('button', { name: /Interview scheduled/ }))

    await act(async () => {
      resolveNotes({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ code: 'ACCOUNT_UNAVAILABLE' }),
      })
    })
    expect(await screen.findByText('Your account is unavailable.')).toBeTruthy()

    await act(async () => {
      resolveStatus({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) })
    })

    expect(screen.getByText('Your account is unavailable.')).toBeTruthy()
    expect(screen.queryByText('Frontend Engineer')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
    expect(mockFetch.mock.calls.filter(([input]) => String(input) === '/api/jobs/tracker')).toHaveLength(1)
  })

  it('does not let an older tracker refresh replace a newer mutation result', async () => {
    let resolveOlderLoad!: (value: unknown) => void
    let resolveNewerLoad!: (value: unknown) => void
    const olderLoad = new Promise((resolve) => { resolveOlderLoad = resolve })
    const newerLoad = new Promise((resolve) => { resolveNewerLoad = resolve })
    let trackerCalls = 0
    const trackerView = (title: string) => ({
      groups: [{
        status: 'applied',
        count: 1,
        rows: [{
          jobPostingId: JOB_ID,
          title,
          company: 'Acme',
          location: 'Remote',
          status: 'applied',
          postingState: 'live',
          daysInStatus: 3,
          practiceCount: 1,
          nudge: null,
          unconfirmedClick: false,
        }],
      }],
      confirmCard: null,
    })
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/jobs/tracker') {
        trackerCalls += 1
        if (trackerCalls === 1) {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(trackerView('Initial Job')) })
        }
        return trackerCalls === 2 ? olderLoad : newerLoad
      }
      if (url.endsWith('/status')) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) })
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
    })

    render(<TrackerPage />)
    await screen.findByText('Initial Job')
    fireEvent.click(screen.getByRole('button', { name: '→ Rejected' }))
    fireEvent.click(screen.getByRole('button', { name: '→ Withdrawn' }))
    await waitFor(() => expect(trackerCalls).toBe(3))

    await act(async () => {
      resolveNewerLoad({ ok: true, status: 200, json: () => Promise.resolve(trackerView('Newest Job')) })
    })
    expect(await screen.findByText('Newest Job')).toBeTruthy()

    await act(async () => {
      resolveOlderLoad({ ok: true, status: 200, json: () => Promise.resolve(trackerView('Stale Job')) })
    })
    expect(screen.getByText('Newest Job')).toBeTruthy()
    expect(screen.queryByText('Stale Job')).toBeNull()
  })

  it('keeps application status separate from a closed-posting badge and saved-detail navigation', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        groups: [{
          status: 'offer',
          count: 1,
          rows: [{
            jobPostingId: JOB_ID,
            title: 'Frontend Engineer',
            company: 'Acme',
            location: 'Remote',
            status: 'offer',
            postingState: 'archived',
            daysInStatus: 3,
            practiceCount: 1,
            appliedWith: { wasTailored: true },
            nudge: null,
            unconfirmedClick: false,
          }],
        }],
        confirmCard: null,
      }),
    })

    render(<TrackerPage />)

    expect(await screen.findByRole('heading', { level: 1, name: 'Job tracker' })).toBeTruthy()
    expect(screen.getByText('Tracked jobs, grouped by your current status.')).toBeTruthy()
    expect(await screen.findByText('Posting no longer active · saved details available')).toBeTruthy()
    expect(screen.getByRole('heading', { name: /Offer · 1/i })).toBeTruthy()
    expect(screen.getByText('This application used the tailored resume.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open saved details for Frontend Engineer at Acme' })).toHaveAttribute('href', `/jobs/${JOB_ID}`)
    expect(screen.getByRole('link', { name: 'View saved details for Frontend Engineer at Acme' })).toHaveAttribute('href', `/jobs/${JOB_ID}`)
  })

  it('renders durable Tailor history and asks which resume before marking a tailored row applied', async () => {
    const tailoredAt = '2026-07-14T11:00:00.000Z'
    const tracker = {
      groups: [{
        status: 'saved',
        count: 1,
        rows: [{
          jobPostingId: JOB_ID,
          title: 'Frontend Engineer',
          company: 'Acme',
          location: 'Remote',
          status: 'saved',
          postingState: 'live',
          daysInStatus: 1,
          practiceCount: 0,
          tailoredResume: { createdAt: tailoredAt },
          nudge: null,
          unconfirmedClick: false,
        }],
      }],
      confirmCard: null,
    }
    let statusBody: Record<string, unknown> | null = null
    mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/jobs/tracker') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(tracker) })
      }
      if (url.endsWith('/status')) {
        statusBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) })
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
    })

    render(<TrackerPage />)

    expect(await screen.findByText(/Tailored resume saved/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'View or update' })).toHaveAttribute(
      'href',
      `/resume/tailor?jobId=${JOB_ID}`,
    )
    fireEvent.click(screen.getByRole('button', { name: '→ Applied' }))
    expect(screen.getByText('Which resume did you apply with?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Tailored resume' }))

    await waitFor(() => expect(statusBody).toMatchObject({
      status: 'applied',
      appliedWith: { wasTailored: true, tailoredAt },
    }))
  })

  it('explains and refreshes a tailored-version conflict instead of silently dropping it', async () => {
    const tracker = {
      groups: [{
        status: 'saved',
        count: 1,
        rows: [{
          jobPostingId: JOB_ID,
          title: 'Frontend Engineer',
          company: 'Acme',
          location: 'Remote',
          status: 'saved',
          postingState: 'live',
          daysInStatus: 1,
          practiceCount: 0,
          tailoredResume: { createdAt: '2026-07-14T11:00:00.000Z' },
          nudge: null,
          unconfirmedClick: false,
        }],
      }],
      confirmCard: null,
    }
    let trackerCalls = 0
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/jobs/tracker') {
        trackerCalls += 1
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(tracker) })
      }
      if (url.endsWith('/status')) {
        return Promise.resolve({
          ok: false,
          status: 409,
          json: () => Promise.resolve({ code: 'TAILORED_VERSION_UNAVAILABLE' }),
        })
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
    })

    render(<TrackerPage />)
    fireEvent.click(await screen.findByRole('button', { name: '→ Applied' }))
    fireEvent.click(screen.getByRole('button', { name: 'Tailored resume' }))

    expect(await screen.findByText(/saved tailored version changed/i)).toBeTruthy()
    await waitFor(() => expect(trackerCalls).toBe(2))
    expect(screen.queryByText('Which resume did you apply with?')).toBeNull()
  })

  it('keeps a failed tailored confirmation retryable instead of silently reloading', async () => {
    let trackerCalls = 0
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/jobs/tracker') {
        trackerCalls += 1
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            groups: [],
            confirmCard: {
              jobPostingId: JOB_ID,
              company: 'Acme',
              clickedAgoHours: 24,
              tailoredResume: { createdAt: '2026-07-14T11:00:00.000Z' },
            },
          }),
        })
      }
      if (url.endsWith('/status')) {
        return Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) })
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
    })

    render(<TrackerPage />)
    fireEvent.click(await screen.findByRole('button', { name: '✓ Yes, with tailored resume' }))

    expect(await screen.findByText(/Couldn’t record that update just now/i)).toBeTruthy()
    expect(trackerCalls).toBe(1)
    expect(screen.getByRole('button', { name: '✓ Yes, with tailored resume' })).toBeTruthy()
  })

  it('announces an undoable tracker status change atomically', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        groups: [{
          status: 'applied',
          count: 1,
          rows: [{
            jobPostingId: JOB_ID,
            title: 'Frontend Engineer',
            company: 'Acme',
            location: 'Remote',
            status: 'applied',
            postingState: 'live',
            daysInStatus: 3,
            practiceCount: 1,
            nudge: null,
            unconfirmedClick: false,
          }],
        }],
        confirmCard: null,
      }),
    })

    render(<TrackerPage />)
    fireEvent.click(await screen.findByRole('button', { name: '→ Interview scheduled' }))

    const liveStatus = await screen.findByRole('status')
    await waitFor(() => expect(within(liveStatus).getByText('Moved to Interview scheduled')).toBeTruthy())
    expect(liveStatus).toHaveAttribute('aria-atomic', 'true')
    expect(within(liveStatus).getByRole('button', { name: 'Undo' })).toBeTruthy()
  })

  it('never offers a response outcome for an unconfirmed click, even with a stale nudge payload', async () => {
    const appliedJobId = '507f1f77bcf86cd799439012'
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        groups: [
          {
            status: 'apply_clicked',
            count: 1,
            rows: [{
              jobPostingId: JOB_ID,
              title: 'Frontend Engineer',
              company: 'Acme',
              location: 'Remote',
              status: 'apply_clicked',
              postingState: 'live',
              daysInStatus: 40,
              practiceCount: 0,
              nudge: 'ghost-prompt',
              unconfirmedClick: true,
            }],
          },
          {
            status: 'applied',
            count: 1,
            rows: [{
              jobPostingId: appliedJobId,
              title: 'Backend Engineer',
              company: 'Beta',
              location: 'Remote',
              status: 'applied',
              postingState: 'live',
              daysInStatus: 22,
              practiceCount: 0,
              nudge: 'ghost-prompt',
              unconfirmedClick: false,
            }],
          },
        ],
        confirmCard: null,
      }),
    })

    render(<TrackerPage />)

    const clicked = await screen.findByRole('region', { name: 'Clicked · not confirmed' })
    expect(within(clicked).getByRole('button', { name: '→ Applied' })).toBeTruthy()
    expect(within(clicked).getByRole('button', { name: '→ Withdrawn' })).toBeTruthy()
    expect(within(clicked).queryByText(/No tracker update for 3 weeks/i)).toBeNull()
    expect(within(clicked).queryByRole('button', { name: /No response/i })).toBeNull()

    const applied = screen.getByRole('region', { name: 'Applied' })
    expect(within(applied).getByText(/No tracker update for 3 weeks/i)).toBeTruthy()
    expect(within(applied).getByRole('button', { name: /Mark.*No response/i })).toBeTruthy()
  })

  it('renders the persisted click age instead of calling every old click yesterday', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        groups: [],
        confirmCard: { jobPostingId: JOB_ID, company: 'Acme', clickedAgoHours: 72 },
      }),
    })

    render(<TrackerPage />)

    expect(await screen.findByText('You clicked Acme 3 days ago — did you apply?')).toBeTruthy()
    expect(screen.queryByText(/yesterday/i)).toBeNull()
  })

  it('sends an explicit date separately from a saved week preference', async () => {
    const tracker = {
      groups: [{
        status: 'interview_scheduled',
        count: 1,
        rows: [{
          jobPostingId: JOB_ID,
          title: 'Frontend Engineer',
          company: 'Acme',
          location: 'Remote',
          status: 'interview_scheduled',
          postingState: 'live',
          daysInStatus: 1,
          practiceCount: 1,
          interviewDateConfidence: 'week',
          interviewDatePreference: 'this-week',
          nudge: null,
          unconfirmedClick: false,
        }],
      }],
      confirmCard: null,
    }
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      if (String(input) === '/api/jobs/tracker') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(tracker) })
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) })
    })

    render(<TrackerPage />)
    expect(await screen.findByText('Preferred interview window: this week')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add exact date' }))
    fireEvent.change(screen.getByLabelText('Exact interview date'), { target: { value: '2026-07-30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save exact date' }))

    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith(
      `/api/jobs/${JOB_ID}/interview-date`,
      expect.objectContaining({
        body: JSON.stringify({
          date: '2026-07-30',
          expectedCompletedRounds: 0,
          expectedOutcomeRevision: 0,
        }),
      }),
    ))
  })
})

describe('Jobs tracker interview outcome loop', () => {
  const jsonResponse = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  })

  const outcomeRow = (over: Record<string, unknown> = {}) => ({
    jobPostingId: JOB_ID,
    title: 'Frontend Engineer',
    company: 'Acme',
    location: 'Remote',
    status: 'interview_scheduled',
    postingState: 'live',
    daysInStatus: 1,
    practiceCount: 1,
    interviewDate: '2026-07-20T00:00:00.000Z',
    interviewDateConfidence: 'exact',
    nudge: null,
    unconfirmedClick: false,
    outcome: { roundsCompleted: 0, revision: 0 },
    nextOutcomeRound: 1,
    outcomePromptDue: false,
    canCorrectOutcome: false,
    ...over,
  })

  const trackerView = (row: ReturnType<typeof outcomeRow>) => ({
    groups: [{ status: row.status, count: 1, rows: [row] }],
    confirmCard: null,
  })

  it('renders a due check-in as an accessible fieldset and keeps explicit closure controls', async () => {
    const view = trackerView(outcomeRow({ outcomePromptDue: true }))
    mockFetch.mockResolvedValue(jsonResponse(view))

    render(<TrackerPage />)

    const checkIn = await screen.findByRole('group', { name: 'How did Frontend Engineer, round 1, at Acme go?' })
    expect(checkIn).toHaveAttribute('aria-busy', 'false')
    expect(within(checkIn).getByRole('button', { name: 'Advanced to another round' })).toBeTruthy()
    expect(within(checkIn).getByRole('button', { name: 'Waiting to hear' })).toBeTruthy()
    expect(within(checkIn).getByRole('button', { name: 'Rejected' })).toBeTruthy()
    expect(within(checkIn).getByRole('button', { name: 'Received an offer' })).toBeTruthy()
    expect(within(checkIn).getByRole('button', { name: /remind me for this round/i })).toBeTruthy()
    expect(within(checkIn).getByText(/won.t change readiness scores/i)).toBeTruthy()
    const scheduled = screen.getByRole('region', { name: 'Interview scheduled' })
    expect(within(scheduled).getByRole('button', { name: '→ No response' })).toBeTruthy()
    expect(within(scheduled).getByRole('button', { name: '→ Withdrawn' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Record interview outcome/ })).toBeNull()
  })

  it('keeps a not-yet-due outcome manual and opens it only on request', async () => {
    const view = trackerView(outcomeRow())
    mockFetch.mockResolvedValue(jsonResponse(view))

    render(<TrackerPage />)

    expect(screen.queryByRole('group', { name: /How did Frontend Engineer, round 1/i })).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: /Record interview outcome/ }))
    expect(screen.getByRole('group', { name: 'How did Frontend Engineer, round 1, at Acme go?' })).toBeTruthy()
  })

  it.each([
    ['Advanced to another round', 'advanced'],
    ['Waiting to hear', 'waiting'],
    ['Rejected', 'rejected'],
    ['Received an offer', 'offer'],
    ['Don’t remind me for this round', 'skip'],
  ] as const)('sends the exact %s raw outcome payload', async (label, result) => {
    const view = trackerView(outcomeRow())
    mockFetch.mockImplementation((input: RequestInfo | URL) => (
      String(input).endsWith('/outcome')
        ? Promise.resolve(jsonResponse({ ok: true, changed: true, deferred: result === 'skip', status: 'interview_scheduled' }))
        : Promise.resolve(jsonResponse(view))
    ))

    render(<TrackerPage />)
    fireEvent.click(await screen.findByRole('button', { name: /Record interview outcome/ }))
    fireEvent.click(screen.getByRole('button', { name: label }))

    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith(
      `/api/jobs/${JOB_ID}/outcome`,
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ result, round: 1 }),
      }),
    ))
  })

  it('moves a waiting report into the Interviewed group and renders only the factual round summary', async () => {
    const before = trackerView(outcomeRow())
    const afterRow = outcomeRow({
      status: 'interviewed',
      interviewDate: undefined,
      interviewDateConfidence: 'unknown',
      outcome: {
        roundsCompleted: 1,
        latestResult: 'waiting',
        latestRound: 1,
        latestReportedAt: '2026-07-22T10:00:00.000Z',
        revision: 1,
        lastInterviewedAt: '2026-07-22T09:00:00.000Z',
      },
      nextOutcomeRound: undefined,
      canCorrectOutcome: true,
    })
    const after = trackerView(afterRow)
    let trackerCalls = 0
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      if (String(input).endsWith('/outcome')) {
        return Promise.resolve(jsonResponse({ ok: true, changed: true, deferred: false, status: 'interviewed' }))
      }
      trackerCalls += 1
      return Promise.resolve(jsonResponse(trackerCalls === 1 ? before : after))
    })

    render(<TrackerPage />)
    fireEvent.click(await screen.findByRole('button', { name: /Record interview outcome/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Waiting to hear' }))

    expect(await screen.findByRole('heading', { name: 'Interviewed · 1' })).toBeTruthy()
    expect(screen.getByText(/Latest outcome · Round 1: Interviewed · waiting to hear/i)).toBeTruthy()
    expect(screen.queryByText(/readiness band|readiness score|better odds/i)).toBeNull()
    const interviewed = screen.getByRole('region', { name: 'Interviewed' })
    expect(within(interviewed).getByRole('button', { name: '→ No response' })).toBeTruthy()
    expect(within(interviewed).getByRole('button', { name: '→ Withdrawn' })).toBeTruthy()
  })

  it('opens the existing date controls for the next round after Advanced', async () => {
    const before = trackerView(outcomeRow())
    const after = trackerView(outcomeRow({
      outcome: {
        roundsCompleted: 1,
        latestResult: 'advanced',
        latestRound: 1,
        latestReportedAt: '2026-07-22T10:00:00.000Z',
        revision: 1,
        lastInterviewedAt: '2026-07-22T09:00:00.000Z',
      },
      interviewDate: undefined,
      interviewDateConfidence: 'unknown',
      nextOutcomeRound: 2,
      canCorrectOutcome: true,
    }))
    let resolveRefresh!: (value: unknown) => void
    const refresh = new Promise((resolve) => { resolveRefresh = resolve })
    let trackerCalls = 0
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      if (String(input).endsWith('/outcome')) {
        return Promise.resolve(jsonResponse({ ok: true, changed: true, deferred: false, status: 'interview_scheduled' }))
      }
      trackerCalls += 1
      return trackerCalls === 1 ? Promise.resolve(jsonResponse(before)) : refresh
    })

    render(<TrackerPage />)
    fireEvent.click(await screen.findByRole('button', { name: /Record interview outcome/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Advanced to another round' }))

    expect(await screen.findByLabelText('Exact interview date')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Tomorrow' })).toBeDisabled()

    await act(async () => {
      resolveRefresh(jsonResponse(after))
    })
    expect(await screen.findByText('Next round timing')).toBeTruthy()
    expect(screen.getByLabelText('Exact interview date')).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Tomorrow' })).toBeEnabled()
  })

  it('blocks outcome controls while the interview date write is unresolved', async () => {
    const view = trackerView(outcomeRow())
    let resolveDate!: (value: unknown) => void
    const dateResponse = new Promise((resolve) => { resolveDate = resolve })
    let outcomeCalls = 0
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/interview-date')) return dateResponse
      if (url.endsWith('/outcome')) {
        outcomeCalls += 1
        return Promise.resolve(jsonResponse({ ok: true }))
      }
      return Promise.resolve(jsonResponse(view))
    })

    render(<TrackerPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Change date' }))
    fireEvent.change(screen.getByLabelText('Exact interview date'), { target: { value: '2026-08-01' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save exact date' }))

    expect(await screen.findByText('Saving interview timing…')).toBeTruthy()
    const outcomeButton = screen.getByRole('button', { name: /Record interview outcome/ })
    expect(outcomeButton).toBeDisabled()
    fireEvent.click(outcomeButton)
    expect(outcomeCalls).toBe(0)

    await act(async () => {
      resolveDate(jsonResponse({ ok: true }))
    })
    await waitFor(() => expect(outcomeButton).toBeEnabled())
  })

  it('corrects only the canonical latest round through the same outcome endpoint', async () => {
    const row = outcomeRow({
      status: 'rejected',
      outcome: {
        roundsCompleted: 2,
        latestResult: 'rejected',
        latestRound: 2,
        latestReportedAt: '2026-07-22T10:00:00.000Z',
        revision: 4,
      },
      nextOutcomeRound: undefined,
      canCorrectOutcome: true,
    })
    const view = trackerView(row)
    mockFetch.mockImplementation((input: RequestInfo | URL) => (
      String(input).endsWith('/outcome')
        ? Promise.resolve(jsonResponse({ ok: true, changed: true, deferred: false, status: 'offer' }))
        : Promise.resolve(jsonResponse(view))
    ))

    render(<TrackerPage />)
    fireEvent.click(await screen.findByRole('button', { name: /Correct interview outcome/ }))
    expect(screen.getByRole('group', { name: 'Correct Frontend Engineer, round 2, at Acme' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /remind me for this round/i })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Received an offer' }))

    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith(
      `/api/jobs/${JOB_ID}/outcome`,
      expect.objectContaining({
        body: JSON.stringify({
          result: 'offer',
          round: 2,
          expectedRevision: 4,
          expectedStatus: 'rejected',
        }),
      }),
    ))
  })

  it.each(['ghosted', 'withdrawn'] as const)('keeps canonical outcome correction available after a %s closure', async (status) => {
    const row = outcomeRow({
      status,
      outcome: {
        roundsCompleted: 1,
        latestResult: 'waiting',
        latestRound: 1,
        latestReportedAt: '2026-07-22T10:00:00.000Z',
        revision: 2,
      },
      nextOutcomeRound: undefined,
      outcomePromptDue: false,
      canCorrectOutcome: true,
    })
    mockFetch.mockResolvedValue(jsonResponse(trackerView(row)))

    render(<TrackerPage />)

    expect(await screen.findByRole('button', { name: /Update interview outcome/ })).toBeTruthy()
  })

  it('clears an open date sheet when a non-advanced outcome is saved', async () => {
    const view = trackerView(outcomeRow())
    mockFetch.mockImplementation((input: RequestInfo | URL) => (
      String(input).endsWith('/outcome')
        ? Promise.resolve(jsonResponse({ ok: true, changed: true, deferred: false, status: 'interviewed' }))
        : Promise.resolve(jsonResponse(view))
    ))

    render(<TrackerPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Change date' }))
    expect(screen.getByLabelText('Exact interview date')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Record interview outcome/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Waiting to hear' }))

    await waitFor(() => expect(screen.queryByLabelText('Exact interview date')).toBeNull())
  })

  it('drops an open panel when a later tracker read advances the row', async () => {
    const before = trackerView(outcomeRow())
    const after = trackerView(outcomeRow({
      outcome: {
        roundsCompleted: 1,
        latestResult: 'advanced',
        latestRound: 1,
        latestReportedAt: '2026-07-22T10:00:00.000Z',
        revision: 1,
      },
      nextOutcomeRound: 2,
      canCorrectOutcome: true,
    }))
    let trackerCalls = 0
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/jobs/tracker') {
        trackerCalls += 1
        return Promise.resolve(jsonResponse(trackerCalls === 1 ? before : after))
      }
      return Promise.resolve(jsonResponse({ ok: true }))
    })

    render(<TrackerPage />)
    fireEvent.click(await screen.findByRole('button', { name: /Record interview outcome/ }))
    expect(screen.getByRole('group', { name: 'How did Frontend Engineer, round 1, at Acme go?' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }))

    await waitFor(() => expect(trackerCalls).toBe(2))
    await waitFor(() => expect(screen.queryByRole('group', { name: 'How did Frontend Engineer, round 1, at Acme go?' })).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: /Record interview outcome/ }))
    expect(screen.getByRole('group', { name: 'How did Frontend Engineer, round 2, at Acme go?' })).toBeTruthy()
  })

  it('refreshes a stale round conflict before allowing another update', async () => {
    const before = trackerView(outcomeRow())
    const after = trackerView(outcomeRow({ outcome: { roundsCompleted: 1 }, nextOutcomeRound: 2 }))
    let trackerCalls = 0
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      if (String(input).endsWith('/outcome')) {
        return Promise.resolve(jsonResponse({ error: 'stale outcome', code: 'OUTCOME_STATE_CONFLICT', currentRound: 2 }, 409))
      }
      trackerCalls += 1
      return Promise.resolve(jsonResponse(trackerCalls === 1 ? before : after))
    })

    render(<TrackerPage />)
    fireEvent.click(await screen.findByRole('button', { name: /Record interview outcome/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Waiting to hear' }))

    expect(await screen.findByText(/refreshed after another outcome update/i)).toBeTruthy()
    await waitFor(() => expect(trackerCalls).toBe(2))
    fireEvent.click(screen.getByRole('button', { name: /Record interview outcome/ }))
    expect(screen.getByRole('group', { name: 'How did Frontend Engineer, round 2, at Acme go?' })).toBeTruthy()
  })

  it('keeps outcomes locked when a 409 refresh fails and unlocks only after Retry succeeds', async () => {
    const view = trackerView(outcomeRow())
    let trackerCalls = 0
    let outcomeCalls = 0
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/outcome')) {
        outcomeCalls += 1
        return Promise.resolve(jsonResponse({ code: 'OUTCOME_STATE_CONFLICT' }, 409))
      }
      trackerCalls += 1
      return Promise.resolve(trackerCalls === 2
        ? jsonResponse({ error: 'unavailable' }, 503)
        : jsonResponse(view))
    })

    render(<TrackerPage />)
    fireEvent.click(await screen.findByRole('button', { name: /Record interview outcome/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Waiting to hear' }))

    expect(await screen.findByText(/Retry loading the tracker before editing outcomes/i)).toBeTruthy()
    const recordButton = screen.getByRole('button', { name: /Record interview outcome/ })
    expect(recordButton).toBeDisabled()
    fireEvent.click(recordButton)
    expect(outcomeCalls).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(trackerCalls).toBe(3))
    await waitFor(() => expect(recordButton).toBeEnabled())
  })

  it('permits only one in-flight outcome across multiple tracker rows', async () => {
    const first = outcomeRow({ outcomePromptDue: true })
    const second = outcomeRow({
      jobPostingId: JOB_ID_2,
      title: 'Backend Engineer',
      company: 'Beta',
      outcomePromptDue: true,
    })
    const view = {
      groups: [{ status: 'interview_scheduled', count: 2, rows: [first, second] }],
      confirmCard: null,
    }
    let resolveOutcome!: (value: unknown) => void
    const outcomeResponse = new Promise((resolve) => { resolveOutcome = resolve })
    let outcomeCalls = 0
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      if (String(input).endsWith('/outcome')) {
        outcomeCalls += 1
        return outcomeResponse
      }
      return Promise.resolve(jsonResponse(view))
    })

    render(<TrackerPage />)
    const firstRow = (await screen.findByRole('link', { name: 'Open job for Frontend Engineer at Acme' })).closest('li')!
    const secondRow = screen.getByRole('link', { name: 'Open job for Backend Engineer at Beta' }).closest('li')!
    fireEvent.click(within(firstRow).getByRole('button', { name: 'Waiting to hear' }))

    await waitFor(() => expect(within(firstRow).getByRole('group', { name: /How did Frontend Engineer, round 1/ })).toHaveAttribute('aria-busy', 'true'))
    const secondOutcome = within(secondRow).getByRole('button', { name: 'Waiting to hear' })
    expect(secondOutcome).toBeDisabled()
    expect(within(firstRow).getByRole('button', { name: 'Change date' })).toBeDisabled()
    fireEvent.click(secondOutcome)
    expect(outcomeCalls).toBe(1)

    await act(async () => {
      resolveOutcome(jsonResponse({ ok: true, changed: true, deferred: false, status: 'interviewed' }))
    })
    await waitFor(() => expect(secondOutcome).toBeEnabled())
  })

  it('keeps a failed outcome open and retryable without moving the row', async () => {
    const view = trackerView(outcomeRow())
    let outcomeCalls = 0
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      if (String(input).endsWith('/outcome')) {
        outcomeCalls += 1
        return Promise.resolve(outcomeCalls === 1
          ? jsonResponse({ error: 'unavailable' }, 503)
          : jsonResponse({ ok: true, changed: true, deferred: false, status: 'interviewed' }))
      }
      return Promise.resolve(jsonResponse(view))
    })

    render(<TrackerPage />)
    fireEvent.click(await screen.findByRole('button', { name: /Record interview outcome/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Waiting to hear' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/Nothing changed.*try again/i)
    expect(screen.getByRole('group', { name: 'How did Frontend Engineer, round 1, at Acme go?' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Waiting to hear' }))
    await waitFor(() => expect(outcomeCalls).toBe(2))
  })

  it('clears an open outcome panel when account deletion wins the mutation', async () => {
    const view = trackerView(outcomeRow())
    mockFetch.mockImplementation((input: RequestInfo | URL) => (
      String(input).endsWith('/outcome')
        ? Promise.resolve(jsonResponse({ code: 'ACCOUNT_UNAVAILABLE' }, 401))
        : Promise.resolve(jsonResponse(view))
    ))

    render(<TrackerPage />)
    fireEvent.click(await screen.findByRole('button', { name: /Record interview outcome/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Waiting to hear' }))

    expect(await screen.findByText('Your account is unavailable.')).toBeTruthy()
    expect(screen.queryByRole('group', { name: /round 1/i })).toBeNull()
    expect(screen.queryByText('Frontend Engineer')).toBeNull()
  })

  it('never exposes outcome actions on an unconfirmed apply click', async () => {
    const row = outcomeRow({
      status: 'apply_clicked',
      outcome: {
        roundsCompleted: 1,
        latestResult: 'waiting',
        latestRound: 1,
        latestReportedAt: '2026-07-22T10:00:00.000Z',
        revision: 1,
      },
      nextOutcomeRound: 2,
      outcomePromptDue: true,
      canCorrectOutcome: false,
      unconfirmedClick: true,
    })
    mockFetch.mockResolvedValue(jsonResponse(trackerView(row)))

    render(<TrackerPage />)
    const clicked = await screen.findByRole('region', { name: 'Clicked · not confirmed' })
    expect(within(clicked).queryByRole('button', { name: /Record interview outcome/ })).toBeNull()
    expect(within(clicked).queryByRole('button', { name: /Correct interview outcome/ })).toBeNull()
    expect(within(clicked).queryByRole('group', { name: /round/i })).toBeNull()
  })

  it('does not offer an impossible Undo when leaving the server-owned Interviewed status', async () => {
    const row = outcomeRow({
      status: 'interviewed',
      outcome: {
        roundsCompleted: 1,
        latestResult: 'waiting',
        latestRound: 1,
        latestReportedAt: '2026-07-22T10:00:00.000Z',
        revision: 1,
      },
      nextOutcomeRound: undefined,
      outcomePromptDue: false,
      canCorrectOutcome: true,
    })
    const view = trackerView(row)
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(view)))

    render(<TrackerPage />)
    const interviewed = await screen.findByRole('region', { name: 'Interviewed' })
    fireEvent.click(within(interviewed).getByRole('button', { name: '→ No response' }))

    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith(
      `/api/jobs/${JOB_ID}/status`,
      expect.objectContaining({ body: JSON.stringify({ status: 'ghosted' }) }),
    ))
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  })
})
