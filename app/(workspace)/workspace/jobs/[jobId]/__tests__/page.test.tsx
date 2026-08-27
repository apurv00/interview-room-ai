import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import JobOverview from '../JobOverview'

const router = { replace: vi.fn(), push: vi.fn() }

vi.mock('next/navigation', () => ({ useRouter: () => router }))

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

const overview = {
  asOf: '2026-08-25T08:00:00.000Z',
  job: {
    jobId: '111111111111111111111111',
    title: 'Senior Product Manager',
    status: 'open',
    department: { id: '222222222222222222222222', name: 'Product' },
    createdAt: '2026-08-01T08:00:00.000Z',
    daysOpen: 24,
  },
  counts: {
    total: 1_024,
    stages: { new: 700, screened: 150, interviewing: 80, shortlist: 40, offer: 10, hired: 4, rejected: 35, withdrawn: 5 },
    attention: { scoring: 18, screening: 63, interview: 12, decision: 8, offers: 10 },
  },
  recentActivity: [{ kind: 'application_created', occurredAt: '2026-08-25T07:00:00.000Z', actorName: 'Candidate', applicationId: '333333333333333333333333' }],
  acquisition: { applyPageEnabled: false },
  screening: {
    latestGate: null,
    latestBatch: { batchId: '444444444444444444444444', status: 'completed', plannedCount: 50, sentCount: 48, failedCount: 2, createdAt: '2026-08-24T08:00:00.000Z' },
    delivery: { pending: 0, sending: 0, sent: 48, failed: 2, cancelled: 0, skipped: 0 },
  },
}

describe('Job overview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/summary')) return Promise.resolve(json(overview))
      if (url.endsWith('/departments')) return Promise.resolve(json({ departments: [{ id: overview.job.department.id, name: 'Product', status: 'active', kind: 'standard' }] }))
      if (url.endsWith('/api/workspace')) return Promise.resolve(json({ membership: { role: 'admin' } }))
      return Promise.resolve(json({ error: 'Unexpected request' }, 500))
    }))
  })

  it('renders bounded aggregate tasks without loading or rendering candidate rows', async () => {
    render(<JobOverview jobId={overview.job.jobId} />)

    expect(await screen.findByRole('heading', { name: overview.job.title })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Candidates' })).toHaveAttribute('href', `/workspace/jobs/${overview.job.jobId}/candidates`)
    expect(screen.getByText('1,024 candidates')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Needs attention' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Candidate funnel' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Screening' })).toBeTruthy()
    expect(screen.queryByText('Ranked queue')).toBeNull()
    expect(screen.queryByText('Past candidates who match this job')).toBeNull()

    await waitFor(() => {
      const calls = vi.mocked(fetch).mock.calls.map(([input]) => String(input))
      expect(calls).toContain(`/api/workspace/jobs/${overview.job.jobId}/summary`)
      expect(calls.some((url) => url === `/api/workspace/jobs/${overview.job.jobId}`)).toBe(false)
      expect(calls.some((url) => url.includes('/candidates?'))).toBe(false)
    })
  })

  it('keeps destructive administration under Manage job and submits the strict empty-delete contract', async () => {
    const empty = { ...overview, counts: { ...overview.counts, total: 0, stages: Object.fromEntries(Object.keys(overview.counts.stages).map((stage) => [stage, 0])) } }
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/summary')) return Promise.resolve(json(empty))
      if (url.endsWith('/departments')) return Promise.resolve(json({ departments: [] }))
      if (url.endsWith('/api/workspace')) return Promise.resolve(json({ membership: { role: 'admin' } }))
      if (url === `/api/workspace/jobs/${overview.job.jobId}` && init?.method === 'DELETE') return Promise.resolve(json({ deleted: true }))
      return Promise.resolve(json({ error: 'Unexpected request' }, 500))
    })
    render(<JobOverview jobId={overview.job.jobId} />)

    await screen.findByRole('heading', { name: overview.job.title })
    fireEvent.click(screen.getByText('Manage job'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete empty job…' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Delete empty job…' }))
    fireEvent.change(screen.getByLabelText(`Type ${overview.job.title} to confirm`), { target: { value: overview.job.title } })
    fireEvent.click(screen.getByLabelText('I understand this action never deletes candidate records.'))
    fireEvent.click(screen.getByRole('button', { name: 'Delete empty job' }))

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/workspace/jobs'))
    const deleteCall = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input) === `/api/workspace/jobs/${overview.job.jobId}` && init?.method === 'DELETE')
    expect(JSON.parse(String(deleteCall?.[1]?.body))).toEqual({ confirmationTitle: overview.job.title, acknowledgeEmptyJobDeletion: true })
  })

  it('keeps every job tab reachable while the overview loads and after its content request fails', async () => {
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/summary')) return Promise.resolve(json({ error: 'Summary unavailable' }, 503))
      if (url.endsWith('/departments')) return Promise.resolve(json({ departments: [] }))
      if (url.endsWith('/api/workspace')) return Promise.resolve(json({ membership: { role: 'member' } }))
      return Promise.resolve(json({ error: 'Unexpected request' }, 500))
    })

    render(<JobOverview jobId={overview.job.jobId} />)

    const navigation = screen.getByRole('navigation', { name: 'Job workspace' })
    expect(within(navigation).getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page')
    expect(within(navigation).getByRole('link', { name: 'Candidates' })).toHaveAttribute('href', `/workspace/jobs/${overview.job.jobId}/candidates`)
    expect(await screen.findByRole('alert')).toHaveTextContent('Summary unavailable')
    expect(screen.getByRole('navigation', { name: 'Job workspace' })).toBeTruthy()
  })

  it('labels management selects and restores focus when an inline management task is cancelled', async () => {
    render(<JobOverview jobId={overview.job.jobId} />)
    await screen.findByRole('heading', { name: overview.job.title })

    const manageTrigger = screen.getByText('Manage job')
    fireEvent.click(manageTrigger)
    fireEvent.click(screen.getByRole('button', { name: 'Change department' }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Change department' })).toHaveFocus())
    expect(screen.getByLabelText('Active department')).toHaveValue(overview.job.department.id)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(manageTrigger).toHaveFocus())

    fireEvent.click(manageTrigger)
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate job' }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Duplicate job' })).toHaveFocus())
    expect(screen.getByLabelText('Department for duplicate')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(manageTrigger).toHaveFocus())
  })

  it('shows every nonzero screening delivery outcome, the latest gate, and a truthful created age for a closed job', async () => {
    const closedOverview = {
      ...overview,
      job: { ...overview.job, status: 'closed', daysOpen: 24 },
      screening: {
        ...overview.screening,
        latestGate: { gateId: '555555555555555555555555', status: 'confirmed', selectedCount: 11, confirmedAt: '2026-08-24T07:00:00.000Z' },
        delivery: { pending: 1, sending: 2, sent: 3, failed: 4, cancelled: 5, skipped: 6 },
      },
    }
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/summary')) return Promise.resolve(json(closedOverview))
      if (url.endsWith('/departments')) return Promise.resolve(json({ departments: [] }))
      if (url.endsWith('/api/workspace')) return Promise.resolve(json({ membership: { role: 'member' } }))
      return Promise.resolve(json({ error: 'Unexpected request' }, 500))
    })

    render(<JobOverview jobId={overview.job.jobId} />)
    await screen.findByRole('heading', { name: overview.job.title })

    expect(screen.getByText('Created 24 days ago')).toBeTruthy()
    expect(screen.queryByText('24 days open')).toBeNull()
    const screening = screen.getByRole('heading', { name: 'Screening' }).closest('section')
    expect(screening).not.toBeNull()
    expect(within(screening!).getByText(/Latest gate/)).toHaveTextContent('confirmed · 11 selected')
    for (const [label, count] of [['Pending', '1'], ['Sending', '2'], ['Sent', '3'], ['Failed', '4'], ['Cancelled', '5'], ['Skipped', '6']]) {
      const term = within(screening!).getByText(label)
      expect(term.parentElement).toHaveTextContent(count)
    }
  })

  it('requires a focus-managed confirmation before replacing or turning off an active apply link', async () => {
    const activeOverview = { ...overview, acquisition: { applyPageEnabled: true } }
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/summary')) return Promise.resolve(json(activeOverview))
      if (url.endsWith('/departments')) return Promise.resolve(json({ departments: [] }))
      if (url.endsWith('/api/workspace')) return Promise.resolve(json({ membership: { role: 'member' } }))
      if (url.endsWith('/apply-link') && init?.method === 'POST') return Promise.resolve(json({ capability: 'replacement-capability' }, 201))
      if (url.endsWith('/apply-link') && init?.method === 'DELETE') return Promise.resolve(json({ disabled: true }))
      if (url.endsWith('/apply-link')) return Promise.resolve(json({ capability: 'active-capability' }))
      return Promise.resolve(json({ error: 'Unexpected request' }, 500))
    })

    render(<JobOverview jobId={overview.job.jobId} />)
    await screen.findByLabelText('Active public apply link')

    const replace = screen.getByRole('button', { name: 'Replace link' })
    fireEvent.click(replace)
    expect(screen.getByRole('alertdialog')).toHaveTextContent('current public URL will stop working immediately')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm replacement' })).toHaveFocus())
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(replace).toHaveFocus())
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)

    const turnOff = screen.getByRole('button', { name: 'Turn off' })
    fireEvent.click(turnOff)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm turn off' })).toHaveFocus())
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(turnOff).toHaveFocus())
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)

    fireEvent.click(replace)
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm replacement' }))
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true))
  })
})
