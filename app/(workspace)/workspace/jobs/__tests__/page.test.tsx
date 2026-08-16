import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import JobsPage from '../page'

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Smart JD workspace company blurb', () => {
  it('prefills the saved workspace default and lets an admin update it explicitly', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/workspace/jobs') return json({ jobs: [] })
      if (url === '/api/workspace/departments') {
        return json({
          departments: [
            { id: 'department-1', name: 'Engineering', status: 'active', kind: 'standard' },
          ],
        })
      }
      if (url === '/api/workspace' && init?.method === 'PATCH') {
        expect(JSON.parse(String(init.body))).toEqual({
          companyBlurb: 'We build trustworthy hiring tools.',
        })
        return json({
          workspace: { companyBlurb: 'We build trustworthy hiring tools.' },
        })
      }
      if (url === '/api/workspace') {
        return json({
          workspace: { companyBlurb: 'Saved Acme company context.' },
          membership: { role: 'admin' },
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<JobsPage />)
    await screen.findByText('No jobs yet')
    fireEvent.click(screen.getAllByRole('button', { name: 'New job' })[0])

    const blurb = screen.getByLabelText('Company blurb (optional)')
    expect(blurb).toHaveValue('Saved Acme company context.')
    fireEvent.change(blurb, {
      target: { value: 'We build trustworthy hiring tools.' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: 'Save workspace default' }),
    )

    await screen.findByText('Saved as the workspace default.')
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/workspace',
        expect.objectContaining({ method: 'PATCH' }),
      )
    })
  })
})

describe('mandatory job departments', () => {
  it('uses only active standard choices and sends the department only with job creation', async () => {
    const jdText = 'Build reliable backend systems with a thoughtful and collaborative engineering team.'
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/workspace/jobs' && !init?.method) return json({ jobs: [] })
      if (url === '/api/workspace/departments') {
        return json({
          departments: [
            { id: 'department-1', name: 'Engineering', status: 'active', kind: 'standard' },
            { id: 'department-2', name: 'Former org', status: 'archived', kind: 'standard' },
            { id: 'department-3', name: 'Legacy import', status: 'active', kind: 'legacy' },
            { id: 'department-4', name: 'Practice records', status: 'active', kind: 'onboarding' },
          ],
        })
      }
      if (url === '/api/workspace') {
        return json({
          workspace: { companyBlurb: '' },
          membership: { role: 'admin' },
        })
      }
      if (url === '/api/workspace/jobs/jd-builder') {
        expect(init).toEqual({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: 'Backend Engineer',
            level: 'Senior',
            mustHaves: ['Strong TypeScript'],
            niceToHaves: [],
            location: 'Remote',
            workMode: 'hybrid',
          }),
        })
        return json({ jdText })
      }
      if (url === '/api/workspace/jobs' && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual({
          title: 'Backend Engineer',
          level: 'Senior',
          mustHaves: ['Strong TypeScript'],
          niceToHaves: [],
          location: 'Remote',
          workMode: 'hybrid',
          departmentId: 'department-1',
          jdText,
        })
        return json({
          job: {
            id: 'job-1',
            departmentId: 'department-1',
            title: 'Backend Engineer',
          },
        }, 201)
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<JobsPage />)
    fireEvent.click((await screen.findAllByRole('button', { name: 'New job' }))[0])

    expect(screen.getByRole('option', { name: 'Engineering' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Former org' })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Legacy import' })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Practice records' })).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Department'), { target: { value: 'department-1' } })
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'Backend Engineer' } })
    fireEvent.change(screen.getByLabelText('Level'), { target: { value: 'Senior' } })
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'Remote' } })
    fireEvent.change(screen.getByLabelText('Must-haves · one per line'), {
      target: { value: 'Strong TypeScript' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Generate JD' }))
    await screen.findByLabelText('Reviewed prose JD')
    fireEvent.click(screen.getByRole('button', { name: 'Create job' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/workspace/jobs', expect.objectContaining({
        method: 'POST',
      }))
    })
  })

  it('lets an admin add a standard department inline when the catalog is empty', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/workspace/jobs') return json({ jobs: [] })
      if (url === '/api/workspace/departments' && !init?.method) return json({ departments: [] })
      if (url === '/api/workspace/departments' && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual({ name: 'Engineering' })
        return json({
          department: { id: 'department-1', name: 'Engineering', status: 'active', kind: 'standard' },
        }, 201)
      }
      if (url === '/api/workspace') {
        return json({ workspace: { companyBlurb: '' }, membership: { role: 'admin' } })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<JobsPage />)
    fireEvent.click((await screen.findAllByRole('button', { name: 'New job' }))[0])
    await screen.findByText('A department is required before a job can be created.')
    fireEvent.change(screen.getByLabelText('New department name'), { target: { value: 'Engineering' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add department' }))

    await screen.findByText('Department “Engineering” added and selected.')
    expect(screen.getByLabelText('Department')).toHaveValue('department-1')
  })
})
