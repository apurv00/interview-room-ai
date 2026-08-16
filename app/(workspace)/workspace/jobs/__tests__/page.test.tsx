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

describe('workspace company description', () => {
  it('shows onboarding-owned company context without offering a per-job override', async () => {
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
      if (url === '/api/workspace') {
        return json({
          workspace: { companyDescription: 'Saved Acme company context.' },
          membership: { role: 'admin' },
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<JobsPage />)
    await screen.findByText('No jobs yet')
    fireEvent.click(screen.getAllByRole('button', { name: 'New job' })[0])

    expect(screen.getByText('Saved Acme company context.')).toBeInTheDocument()
    expect(screen.queryByLabelText(/company blurb/i)).not.toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/api/workspace',
      expect.objectContaining({ method: 'PATCH' }),
    )
  })

  it('holds new job authoring until a legacy workspace completes onboarding', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/workspace/jobs') return json({ jobs: [] })
      if (url === '/api/workspace/departments') {
        return json({
          departments: [
            { id: 'department-1', name: 'Engineering', status: 'active', kind: 'standard' },
          ],
        })
      }
      if (url === '/api/workspace') return json({ workspace: {}, membership: { role: 'admin' } })
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<JobsPage />)
    fireEvent.click((await screen.findAllByRole('button', { name: 'New job' }))[0])

    expect(screen.getByText(/Complete onboarding before creating a job/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Generate JD' })).toBeDisabled()
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
          workspace: { companyDescription: 'Acme builds trustworthy hiring tools.' },
          membership: { role: 'admin' },
        })
      }
      if (url === '/api/workspace/jobs/jd-builder') {
        expect(init).toEqual({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: 'Backend Engineer',
            level: 'manager',
            targetExperienceRange: { minYears: 3, maxYears: 8 },
            responsibilities: ['Own the backend platform roadmap'],
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
          level: 'manager',
          targetExperienceRange: { minYears: 3, maxYears: 8 },
          responsibilities: ['Own the backend platform roadmap'],
          mustHaves: ['Strong TypeScript'],
          niceToHaves: [],
          location: 'Remote',
          workMode: 'hybrid',
          departmentId: 'department-1',
          jdText,
          jdSource: 'ai_generated',
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
    fireEvent.change(screen.getByLabelText('Level'), { target: { value: 'manager' } })
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'Remote' } })
    fireEvent.change(screen.getByLabelText('Minimum years'), { target: { value: '3' } })
    fireEvent.change(screen.getByLabelText('Maximum years'), { target: { value: '8' } })
    fireEvent.change(screen.getByLabelText('Key responsibilities · one per line'), {
      target: { value: 'Own the backend platform roadmap' },
    })
    fireEvent.change(screen.getByLabelText('Must-haves · one per line'), {
      target: { value: 'Strong TypeScript' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Generate JD' }))
    await screen.findByLabelText('Reviewed AI-generated JD')
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
        return json({
          workspace: { companyDescription: 'Acme builds trustworthy hiring tools.' },
          membership: { role: 'admin' },
        })
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

  it('creates a job from a pasted JD without invoking the AI builder', async () => {
    const pastedJd = 'Own the backend platform roadmap and deliver reliable services with the engineering team.'
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/workspace/jobs' && !init?.method) return json({ jobs: [] })
      if (url === '/api/workspace/departments') {
        return json({
          departments: [
            { id: 'department-1', name: 'Engineering', status: 'active', kind: 'standard' },
          ],
        })
      }
      if (url === '/api/workspace') {
        return json({
          workspace: { companyDescription: 'Acme builds trustworthy hiring tools.' },
          membership: { role: 'admin' },
        })
      }
      if (url === '/api/workspace/jobs/jd-builder') {
        throw new Error('Manual JD must not call the AI builder')
      }
      if (url === '/api/workspace/jobs' && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual({
          title: 'Platform Manager',
          level: 'manager',
          targetExperienceRange: { minYears: 5, maxYears: 9 },
          responsibilities: ['Own the backend platform roadmap'],
          mustHaves: ['Production TypeScript'],
          niceToHaves: [],
          location: 'Remote',
          workMode: 'hybrid',
          departmentId: 'department-1',
          jdText: pastedJd,
          jdSource: 'manual',
        })
        return json({ job: { id: 'job-1', departmentId: 'department-1', title: 'Platform Manager' } }, 201)
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<JobsPage />)
    fireEvent.click((await screen.findAllByRole('button', { name: 'New job' }))[0])
    fireEvent.change(screen.getByLabelText('Department'), { target: { value: 'department-1' } })
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'Platform Manager' } })
    fireEvent.change(screen.getByLabelText('Level'), { target: { value: 'manager' } })
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'Remote' } })
    fireEvent.change(screen.getByLabelText('Minimum years'), { target: { value: '5' } })
    fireEvent.change(screen.getByLabelText('Maximum years'), { target: { value: '9' } })
    fireEvent.change(screen.getByLabelText('Key responsibilities · one per line'), {
      target: { value: 'Own the backend platform roadmap' },
    })
    fireEvent.change(screen.getByLabelText('Must-haves · one per line'), {
      target: { value: 'Production TypeScript' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Paste existing JD' }))
    fireEvent.change(screen.getByLabelText('Existing job description'), { target: { value: pastedJd } })
    fireEvent.click(screen.getByRole('button', { name: 'Create job' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/workspace/jobs', expect.objectContaining({
        method: 'POST',
      }))
    })
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/api/workspace/jobs/jd-builder',
      expect.anything(),
    )
  })
})
