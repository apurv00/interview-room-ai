import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import BulkUploadPanel from '../BulkUploadPanel'

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function upload(file = new File(['resume'], 'ada.pdf', { type: 'application/pdf' })) {
  const input = screen.getByLabelText(/choose résumé files or browse/i)
  fireEvent.change(input, { target: { files: [file] } })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('BulkUploadPanel', () => {
  it('enqueues a file once, polls durable task state, and refreshes after completion', async () => {
    const onSettled = vi.fn()
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/workspace/jobs/job-1/intake') {
        expect(init?.method).toBe('POST')
        expect(init?.body).toBeInstanceOf(FormData)
        return json({ task: { taskId: 'task-1', status: 'queued' } }, 202)
      }
      if (url === '/api/workspace/jobs/job-1/intake/task-1') {
        expect(init?.cache).toBe('no-store')
        return json({
          task: {
            taskId: 'task-1',
            status: 'completed',
            attempts: 1,
            candidateId: 'candidate-1',
            applicationId: 'application-1',
          },
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<BulkUploadPanel jobId="job-1" onSettled={onSettled} />)
    upload()

    await screen.findByText('added')
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/task-1'))).toHaveLength(1)
  })

  it('supplies email through PATCH and resumes the saved task without a second upload', async () => {
    const onSettled = vi.fn()
    let statusReads = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/workspace/jobs/job-1/intake') {
        return json({ task: { taskId: 'task-2', status: 'queued' } }, 202)
      }
      if (url === '/api/workspace/jobs/job-1/intake/task-2' && init?.method === 'PATCH') {
        expect(init.body).toBe(JSON.stringify({ email: 'ada@example.com' }))
        return json({ task: { taskId: 'task-2', status: 'queued', attempts: 1 } })
      }
      if (url === '/api/workspace/jobs/job-1/intake/task-2') {
        statusReads += 1
        return statusReads === 1
          ? json({
              task: {
                taskId: 'task-2',
                status: 'needs_identity',
                attempts: 1,
                lastError: 'No email address was found in this resume',
              },
            })
          : json({
              task: {
                taskId: 'task-2',
                status: 'completed',
                attempts: 2,
                candidateId: 'candidate-2',
                applicationId: 'application-2',
              },
            })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<BulkUploadPanel jobId="job-1" onSettled={onSettled} />)
    upload()

    await screen.findByText('needs email')
    // A missing parsed email is a recoverable task state, but other completed
    // rows must still become visible in the parent ranked pipeline now.
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByLabelText('Candidate email address'), {
      target: { value: 'ada@example.com' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add email' }))

    await screen.findByText('added')
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(2))
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/api/workspace/jobs/job-1/intake'))
      .toHaveLength(1)
  })

  it('makes failed and cancelled worker states visible without pretending the resume was saved', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/workspace/jobs/job-1/intake') {
        return json({ task: { taskId: 'task-3', status: 'queued' } }, 202)
      }
      if (url === '/api/workspace/jobs/job-1/intake/task-3') {
        return json({
          task: {
            taskId: 'task-3',
            status: 'cancelled',
            attempts: 1,
            lastError: 'This job is no longer accepting applications',
          },
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<BulkUploadPanel jobId="job-1" onSettled={vi.fn()} />)
    upload()

    await screen.findByText('cancelled')
    expect(screen.getByText('This job is no longer accepting applications')).toBeInTheDocument()
    expect(screen.queryByText('Candidate and application saved. The ranked pipeline will refresh when this batch settles.'))
      .not.toBeInTheDocument()
  })

  it('shows a safe recovery cue when the durable task was saved but its event handoff failed', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/workspace/jobs/job-1/intake') {
        return json({
          task: {
            taskId: 'task-queue-failure',
            status: 'queued',
            dispatch: {
              status: 'failed',
              attempts: 1,
              lastErrorCode: 'inngest_dispatch_unavailable',
            },
          },
        }, 202)
      }
      if (url === '/api/workspace/jobs/job-1/intake/task-queue-failure') {
        return json({
          task: {
            taskId: 'task-queue-failure',
            status: 'queued',
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

    render(<BulkUploadPanel jobId="job-1" onSettled={vi.fn()} />)
    upload()

    expect(await screen.findByText(/automatic recovery will retry/i)).toBeInTheDocument()
    expect(screen.queryByText(/provider-secret/i)).not.toBeInTheDocument()
  })

  it('accepts a fifty-resume Phase 2 batch and leaves any excess file out of the queue', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/workspace/jobs/job-1/intake') {
        return json({ task: { taskId: `task-${fetchMock.mock.calls.length}`, status: 'queued' } }, 202)
      }
      // Keep every accepted task queued: this test asserts browser admission,
      // not worker completion or the polling contract covered above.
      return json({ task: { taskId: 'unused', status: 'queued', attempts: 0 } })
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<BulkUploadPanel jobId="job-1" onSettled={vi.fn()} />)
    const files = Array.from({ length: 51 }, (_, index) =>
      new File([`resume-${index}`], `candidate-${index}.pdf`, { type: 'application/pdf' }),
    )
    const input = screen.getByLabelText(/choose résumé files or browse/i)
    expect(input).toHaveClass('sr-only')
    expect(input).not.toHaveClass('hidden')
    fireEvent.change(input, {
      target: { files },
    })

    await waitFor(() => {
      expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/api/workspace/jobs/job-1/intake'))
        .toHaveLength(50)
    })
    expect(screen.getAllByText('queued')).toHaveLength(50)
  })
})
