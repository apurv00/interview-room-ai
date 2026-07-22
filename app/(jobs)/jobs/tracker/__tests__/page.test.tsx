import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import TrackerPage from '../page'

const JOB_ID = '507f1f77bcf86cd799439011'

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
      expect.objectContaining({ body: JSON.stringify({ date: '2026-07-30' }) }),
    ))
  })
})
