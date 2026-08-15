import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import InterviewYourselfCta from '../InterviewYourselfCta'

const RAW_URL = 'https://hire.example/interview/round-1#invite=one-time-practice-capability'
const view = {
  id: 'test-drive-1',
  label: 'Interview yourself' as const,
  state: 'ready' as const,
  jobId: 'job-1',
  candidateId: 'candidate-1',
  applicationId: 'application-1',
  roundId: 'round-1',
  issuedAt: '2099-08-14T00:00:00.000Z',
  cleanupAfter: '2099-08-28T00:00:00.000Z',
  removedAt: null,
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('InterviewYourselfCta', () => {
  it('creates a practice graph for a new member, copies the one-time invite, then erases it from the DOM', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => '11111111-1111-4111-8111-111111111111' })
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method || init.method === 'GET') return json({ testDrive: null })
      expect(init.method).toBe('POST')
      expect(JSON.parse(String(init.body))).toEqual({
        operationId: '11111111-1111-4111-8111-111111111111',
      })
      return json({ testDrive: view, inviteUrl: RAW_URL, created: true, emailSent: true }, 201)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<InterviewYourselfCta priority />)
    expect(await screen.findByText('Start here')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Start practice interview' }))

    expect(await screen.findByDisplayValue(RAW_URL)).toBeTruthy()
    expect(document.body.textContent).toContain('normal consent and recording disclosure')
    fireEvent.click(screen.getByRole('button', { name: 'Copy practice link' }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(RAW_URL))
    expect(await screen.findByText('Practice link copied. The raw link is no longer shown.')).toBeTruthy()
    expect(screen.queryByDisplayValue(RAW_URL)).toBeNull()
    expect(document.body.innerHTML).not.toContain('one-time-practice-capability')
  })

  it('opens the one-time URL without persistence and removes it from React state afterward', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => '11111111-1111-4111-8111-111111111111' })
    const open = vi.spyOn(window, 'open').mockReturnValue({} as Window)
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method || init.method === 'GET') return json({ testDrive: null })
      return json({ testDrive: view, inviteUrl: RAW_URL, created: true, emailSent: false }, 201)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<InterviewYourselfCta />)
    await screen.findByRole('button', { name: 'Start practice interview' })
    fireEvent.click(screen.getByRole('button', { name: 'Start practice interview' }))
    await screen.findByDisplayValue(RAW_URL)
    fireEvent.click(screen.getByRole('button', { name: 'Open practice interview' }))

    expect(open).toHaveBeenCalledWith(RAW_URL, '_blank', 'noopener,noreferrer')
    expect(await screen.findByText('Practice interview opened. The raw link is no longer shown.')).toBeTruthy()
    expect(screen.queryByDisplayValue(RAW_URL)).toBeNull()
    expect(document.body.innerHTML).not.toContain('one-time-practice-capability')
  })

  it('does not render a raw link if an idempotent retry response contains one unexpectedly', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => '11111111-1111-4111-8111-111111111111' })
    const retrySecret = `${RAW_URL}-must-not-render`
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method || init.method === 'GET') return json({ testDrive: null })
      return json({ testDrive: view, inviteUrl: retrySecret, created: false, emailSent: null })
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<InterviewYourselfCta />)
    await screen.findByRole('button', { name: 'Start practice interview' })
    fireEvent.click(screen.getByRole('button', { name: 'Start practice interview' }))

    expect(await screen.findByText('Your practice interview is ready. Use the email sent to your current member address.')).toBeTruthy()
    expect(screen.queryByDisplayValue(retrySecret)).toBeNull()
    expect(document.body.innerHTML).not.toContain('must-not-render')
  })

  it('offers member-owned remove/revoke without taking a coordinate from the browser', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method || init.method === 'GET') return json({ testDrive: view })
      expect(init.method).toBe('DELETE')
      expect(init.body).toBeUndefined()
      return json({ testDrive: { ...view, state: 'removed', removedAt: '2099-08-15T00:00:00.000Z' } })
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<InterviewYourselfCta />)
    expect(await screen.findByText('Practice interview ready')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove practice interview' }))

    expect(await screen.findByText('Practice interview removed. Its invitation was revoked when it was still active.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Start practice interview' })).toBeTruthy()
  })

  it('does not use storage, history, or telemetry for the raw invite capability', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'app/(workspace)/workspace/jobs/InterviewYourselfCta.tsx'),
      'utf8',
    )
    expect(source).not.toMatch(/(?:localStorage|sessionStorage|history\.|analytics|track\()/)
  })
})
