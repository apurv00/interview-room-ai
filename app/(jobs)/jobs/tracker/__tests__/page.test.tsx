import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import TrackerPage from '../page'

const JOB_ID = '507f1f77bcf86cd799439011'

beforeEach(() => {
  mockFetch.mockReset()
})

describe('Jobs tracker posting lifecycle', () => {
  it('keeps application status separate from a closed-posting badge and saved-detail navigation', async () => {
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
            postingState: 'archived',
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

    expect(await screen.findByRole('heading', { level: 1, name: 'Job tracker' })).toBeTruthy()
    expect(screen.getByText('Tracked jobs, grouped by your current status.')).toBeTruthy()
    expect(await screen.findByText('Posting no longer active · saved details available')).toBeTruthy()
    expect(screen.getByRole('heading', { name: /Applied · 1/i })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open saved details for Frontend Engineer at Acme' })).toHaveAttribute('href', `/jobs/${JOB_ID}`)
    expect(screen.getByRole('link', { name: 'View saved details for Frontend Engineer at Acme' })).toHaveAttribute('href', `/jobs/${JOB_ID}`)
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
})
