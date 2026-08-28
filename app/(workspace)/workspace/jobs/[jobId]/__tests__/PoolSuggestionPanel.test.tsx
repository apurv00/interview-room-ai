import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PoolSuggestionPanel from '../PoolSuggestionPanel'

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const SUGGESTION = {
  candidate: {
    id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
  },
  matchScore: 75,
  matchedRequirements: ['TypeScript', 'Distributed systems'],
  previouslySeenIn: [
    { jobId: 'bbbbbbbbbbbbbbbbbbbbbbbb', jobTitle: 'Platform Engineer', stage: 'rejected' },
  ],
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PoolSuggestionPanel', () => {
  it('keeps suggestions read-only until a member explicitly confirms adding the candidate', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/workspace/jobs/job-1/pool-suggestions') {
        expect(init?.cache).toBe('no-store')
        return json({ suggestions: [SUGGESTION] })
      }
      if (url === '/api/workspace/jobs/job-1/candidates') {
        expect(init?.method).toBe('POST')
        expect(init?.headers).toEqual({ 'Content-Type': 'application/json' })
        expect(JSON.parse(String(init?.body))).toEqual({
          candidateId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
          operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        })
        return json({
          status: 'created',
          candidateId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
          applicationId: 'cccccccccccccccccccccccc',
        }, 201)
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<PoolSuggestionPanel jobId="job-1" jobStatus="open" />)

    await screen.findByText('Ada Lovelace')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Add to job' }))
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Add Ada Lovelace')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Confirm add to job' }))
    await screen.findByText('Added Ada Lovelace to this job.')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('ada@example.com')).not.toBeInTheDocument()
  })

  it('does not load or expose a confirmation action for a non-open job', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    render(<PoolSuggestionPanel jobId="job-1" jobStatus="closed" />)

    expect(screen.getByText('Suggestions are available only while this job is open.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add to job' })).not.toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps the same in-memory operation id available for a network retry', async () => {
    const operations: string[] = []
    let calls = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/workspace/jobs/job-1/pool-suggestions') {
        return json({ suggestions: [SUGGESTION] })
      }
      calls += 1
      operations.push(JSON.parse(String(init?.body)).operationId)
      if (calls === 1) throw new Error('offline')
      return json({ status: 'queued' }, 201)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<PoolSuggestionPanel jobId="job-1" jobStatus="open" />)
    await screen.findByText('Ada Lovelace')
    fireEvent.click(screen.getByRole('button', { name: 'Add to job' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm add to job' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Network error')
    fireEvent.click(screen.getByRole('button', { name: 'Confirm add to job' }))
    await waitFor(() => expect(operations).toHaveLength(2))
    expect(operations[1]).toBe(operations[0])
  })

  it('keeps HTTP failures in a red alert and manages confirmation focus for the candidate-specific trigger', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/workspace/jobs/job-1/pool-suggestions') return json({ suggestions: [SUGGESTION] })
      if (url === '/api/workspace/jobs/job-1/candidates') return json({ error: 'Candidate is no longer eligible for this job.' }, 409)
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<PoolSuggestionPanel jobId="job-1" jobStatus="open" />)
    await screen.findByText('Ada Lovelace')

    const add = screen.getByRole('button', { name: 'Add to job' })
    fireEvent.click(add)
    const confirm = screen.getByRole('button', { name: 'Confirm add to job' })
    await waitFor(() => expect(confirm).toHaveFocus())
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(add).toHaveFocus())
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    fireEvent.click(add)
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm add to job' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Candidate is no longer eligible for this job.')
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('alertdialog')).toBeTruthy()
  })

  it('wraps valid long suggestion content and exposes fallback heading focus after addition', async () => {
    const longName = 'N'.repeat(120)
    const longEmail = `${'e'.repeat(242)}@example.com`
    const longRequirement = 'R'.repeat(200)
    const longJobTitle = 'J'.repeat(200)
    const longSuggestion = {
      ...SUGGESTION,
      candidate: { ...SUGGESTION.candidate, name: longName, email: longEmail },
      matchedRequirements: [longRequirement],
      previouslySeenIn: [{ ...SUGGESTION.previouslySeenIn[0], jobTitle: longJobTitle }],
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/workspace/jobs/job-1/pool-suggestions') return json({ suggestions: [longSuggestion] })
      if (url === '/api/workspace/jobs/job-1/candidates') {
        return json({ status: 'created', candidateId: longSuggestion.candidate.id, applicationId: 'cccccccccccccccccccccccc' }, 201)
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<PoolSuggestionPanel jobId="job-1" jobStatus="open" />)

    const candidateHeading = await screen.findByRole('heading', { name: longName })
    const suggestion = candidateHeading.closest('li')
    expect(suggestion).toHaveClass('min-w-0', 'max-w-full')
    expect(candidateHeading).toHaveClass('min-w-0', 'max-w-full', 'break-words')
    expect(screen.getByText(longEmail)).toHaveClass('max-w-full', 'break-words')
    expect(screen.getByText(`Matches: ${longRequirement}`)).toHaveClass('max-w-full', 'break-words')
    expect(screen.getByText(`Previously seen in: ${longJobTitle} (rejected)`)).toHaveClass('max-w-full', 'break-words')

    fireEvent.click(screen.getByRole('button', { name: 'Add to job' }))
    const dialog = screen.getByRole('alertdialog')
    expect(dialog.querySelector('#pool-confirm-heading')).toHaveClass('break-words')
    expect(dialog.querySelector('#pool-confirm-description')).toHaveClass('break-words')
    fireEvent.click(screen.getByRole('button', { name: 'Confirm add to job' }))

    const poolHeading = screen.getByRole('heading', { name: 'Past candidates who match this job' })
    await waitFor(() => expect(poolHeading).toHaveFocus())
    expect(poolHeading).toHaveAttribute('tabindex', '-1')
    expect(poolHeading).not.toHaveClass('focus:outline-none')
  })
})
