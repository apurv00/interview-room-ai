import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import CandidateWorkspace from '../CandidateWorkspace'

const navigation = vi.hoisted(() => ({
  search: '',
  pathname: '/workspace/jobs/111111111111111111111111/candidates',
  replace: vi.fn(),
  push: vi.fn(),
  back: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: navigation.replace, push: navigation.push, back: navigation.back }),
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(navigation.search),
}))

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

const JOB_ID = '111111111111111111111111'
const APPLICATION_ONE = '222222222222222222222222'
const APPLICATION_TWO = '333333333333333333333333'
const SELECTION_ID = '444444444444444444444444'

const rows = [
  {
    applicationId: APPLICATION_ONE,
    candidate: { id: '555555555555555555555555', name: 'Ada Lovelace', email: 'ada@example.com' },
    stage: 'new', source: 'apply_page', sourceHistory: ['apply_page'],
    appliedAt: '2026-08-25T07:00:00.000Z', lastActivityAt: '2026-08-25T07:30:00.000Z',
    attention: ['screening_pending'],
    jdMatch: { state: 'fresh', score: 88, rank: 1, denominator: 700, scoredAt: '2026-08-25T07:05:00.000Z' },
    humanReview: { state: 'pending', total: 2, submitted: 1, pending: 1, recommendations: { yes: 1 }, disagreement: false },
    aiInterview: { state: 'not_invited', overallScore: null, updatedAt: null },
    workspaceHistory: { previousApplications: 0 },
  },
  {
    applicationId: APPLICATION_TWO,
    candidate: { id: '666666666666666666666666', name: 'Grace Hopper', email: 'grace@example.com' },
    stage: 'screened', source: 'manual', sourceHistory: ['manual'],
    appliedAt: '2026-08-24T07:00:00.000Z', lastActivityAt: '2026-08-25T06:30:00.000Z',
    attention: ['human_scorecard_pending'],
    jdMatch: { state: 'stale', score: 76, rank: null, denominator: null, scoredAt: '2026-08-24T07:05:00.000Z' },
    humanReview: { state: 'mixed', total: 2, submitted: 2, pending: 0, recommendations: { yes: 1, no: 1 }, disagreement: true },
    aiInterview: { state: 'completed', overallScore: 81, updatedAt: '2026-08-25T06:00:00.000Z' },
    workspaceHistory: { previousApplications: 2 },
  },
]

function candidatePage(overrides: Record<string, unknown> = {}) {
  return {
    asOf: '2026-08-25T08:00:00.000Z',
    job: { jobId: JOB_ID, title: 'Senior Product Manager', status: 'open' },
    rows,
    pageInfo: { limit: 50, hasNextPage: true, nextCursor: 'next-opaque-cursor', snapshotAt: '2026-08-25T08:00:00.000Z' },
    ...overrides,
  }
}

function candidateSummary(overrides: Record<string, unknown> = {}) {
  return {
    asOf: '2026-08-25T08:00:00.000Z',
    job: { jobId: JOB_ID, title: 'Senior Product Manager', status: 'open' },
    counts: {
      total: 1_024, matching: 823,
      stages: { new: 600, screened: 120, interviewing: 50, shortlist: 25, offer: 10, hired: 4, rejected: 10, withdrawn: 4 },
      jdMatch: { fresh: 700, stale: 50, unscored: 40, pending: 33 },
      savedViews: { all: 1_024, scoring_attention: 123, screening_attention: 300, interview_attention: 80, decision_ready: 25, offers: 10 },
    },
    rankContext: { freshScoredTotal: 700, stale: 50, unscored: 40, pending: 33 },
    ...overrides,
  }
}

function snapshot() {
  return {
    selectionId: SELECTION_ID,
    count: 1,
    expiresAt: '2026-08-25T09:00:00.000Z',
    description: '1 explicitly selected candidate',
    homogeneousStage: 'new',
  }
}

function generatedRows(count: number, offset = 0) {
  return Array.from({ length: count }, (_, index) => {
    const sequence = offset + index + 1
    return {
      ...rows[0],
      applicationId: sequence.toString(16).padStart(24, '0'),
      candidate: {
        id: (sequence + 1000).toString(16).padStart(24, '0'),
        name: `Candidate ${sequence}`,
        email: `candidate-${sequence}@example.com`,
      },
      jdMatch: { ...rows[0].jdMatch, rank: sequence },
    }
  })
}

describe('CandidateWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    navigation.search = ''
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes(`/api/workspace/jobs/${JOB_ID}/candidates?`) && (!init?.method || init.method === 'GET')) return Promise.resolve(json(candidatePage()))
      if (url.includes(`/api/workspace/jobs/${JOB_ID}/candidates/summary`) && (!init?.method || init.method === 'GET')) return Promise.resolve(json(candidateSummary()))
      if (url.includes(`/api/workspace/jobs/${JOB_ID}/candidates/freshness`)) return Promise.resolve(json({ hasNewerResults: false, checkedAt: '2026-08-25T08:01:00.000Z' }))
      if (url.endsWith('/candidate-selections') && init?.method === 'POST') return Promise.resolve(json(snapshot(), 201))
      if (url.includes('/candidate-selections/') && (!init?.method || init.method === 'GET')) return Promise.resolve(json(snapshot()))
      if (url.includes('/candidate-selections/') && init?.method === 'DELETE') return Promise.resolve(json({ deleted: true }))
      if (url.includes('/stage') && init?.method === 'POST') return Promise.resolve(json({ status: 'updated' }))
      return Promise.resolve(json({ error: `Unexpected ${url}` }, 500))
    }))
  })

  it('renders semantic desktop rows and mobile cards from the same bounded page', async () => {
    render(<CandidateWorkspace jobId={JOB_ID} />)

    const table = await screen.findByRole('table', { name: 'Candidates for this job' })
    expect(within(table).getByRole('columnheader', { name: /Candidate/ })).toHaveAttribute('aria-sort', 'none')
    expect(within(table).getByRole('checkbox', { name: 'Select Ada Lovelace' })).toBeTruthy()
    expect(screen.getAllByText('Ada Lovelace')).toHaveLength(2)
    expect(screen.getAllByText('Rank #1 of 700')).toHaveLength(2)
    expect(screen.getByText('823 matching candidates')).toBeTruthy()
    expect(within(table).getAllByRole('row')).toHaveLength(3)
    expect(within(table).getByRole('columnheader', { name: /Recruiter decision/ })).toBeTruthy()
    expect(screen.getAllByText('Recruiter decision').length).toBeGreaterThan(1)
  })

  it('restores multi-value URL filters, uses the backend sort direction, and writes URL-backed controls', async () => {
    navigation.search = 'view=scoring_attention&sort=rank&stage=new%2Cscreened&source=apply_page%2Cpool&scoreState=fresh%2Cstale&humanReview=mixed%2Cdisagreement&aiInterview=invited%2Ccompleted&columns=jdMatch,history'
    render(<CandidateWorkspace jobId={JOB_ID} />)

    await screen.findByText('823 matching candidates')
    expect(screen.getByRole('button', { name: /Scoring attention 123 job total/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByLabelText('Direction')).toHaveValue('asc')
    expect(screen.getByRole('columnheader', { name: /JD match/ })).toHaveAttribute('aria-sort', 'ascending')
    fireEvent.click(screen.getByText(/Filters/))
    const stageGroup = screen.getByRole('group', { name: 'Stage' })
    expect(within(stageGroup).getByLabelText('New')).toBeChecked()
    expect(within(stageGroup).getByLabelText('Screened')).toBeChecked()
    const sourceGroup = screen.getByRole('group', { name: 'Candidate sources' })
    expect(within(sourceGroup).getByLabelText('Apply page')).toBeChecked()
    expect(within(sourceGroup).getByLabelText('Talent pool')).toBeChecked()
    const reviewGroup = screen.getByRole('group', { name: 'Human review' })
    expect(within(reviewGroup).getByLabelText('Submitted and pending')).toBeChecked()
    expect(within(reviewGroup).getByLabelText('Reviewers disagree')).toBeChecked()
    expect(screen.queryByText('Mixed recommendations')).toBeNull()

    expect(vi.mocked(fetch).mock.calls.some(([input]) => {
      const url = String(input)
      return url.includes('/candidates?') && url.includes('stage=new%2Cscreened') && url.includes('source=apply_page%2Cpool')
    })).toBe(true)

    fireEvent.change(screen.getByLabelText('Search candidates by name or email'), { target: { value: 'Ada' } })
    fireEvent.submit(screen.getByRole('search'))
    expect(navigation.replace).toHaveBeenCalledWith(
      expect.stringContaining('q=Ada'),
      { scroll: false },
    )
    fireEvent.click(screen.getByText('Columns'))
    fireEvent.click(screen.getAllByLabelText('Human review').find((element) => element.getAttribute('type') === 'checkbox')!)
    expect(navigation.replace).toHaveBeenCalledWith(expect.stringContaining('columns='), { scroll: false })
  })

  it('announces the URL sort direction truthfully and toggles the active table sort', async () => {
    navigation.search = 'sort=name&direction=desc'
    render(<CandidateWorkspace jobId={JOB_ID} />)

    const table = await screen.findByRole('table', { name: 'Candidates for this job' })
    const candidateHeader = within(table).getByRole('columnheader', { name: /Candidate/ })
    expect(candidateHeader).toHaveAttribute('aria-sort', 'descending')
    fireEvent.click(within(candidateHeader).getByRole('button'))
    expect(navigation.replace).toHaveBeenCalledWith(expect.stringContaining('direction=asc'), { scroll: false })
    expect(within(table).getByText('Actions for Ada Lovelace')).toHaveClass('sr-only')
  })

  it('creates an immutable snapshot before the screening handoff', async () => {
    render(<CandidateWorkspace jobId={JOB_ID} />)
    const table = await screen.findByRole('table', { name: 'Candidates for this job' })
    fireEvent.click(within(table).getByRole('checkbox', { name: 'Select Ada Lovelace' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send to screening' }))

    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith(`/workspace/jobs/${JOB_ID}/screening?selectionSnapshotId=${SELECTION_ID}`))
    const createCall = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input).endsWith('/candidate-selections') && init?.method === 'POST')
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({ mode: 'explicit', applicationIds: [APPLICATION_ONE] })
    expect(navigation.replace).toHaveBeenCalledWith(expect.stringContaining(`selectionId=${SELECTION_ID}`), { scroll: false })
  })

  it('retains selection across cursors but clears it when browser history changes the normalized filter', async () => {
    const view = render(<CandidateWorkspace jobId={JOB_ID} />)
    const table = await screen.findByRole('table', { name: 'Candidates for this job' })
    fireEvent.click(within(table).getByRole('checkbox', { name: 'Select Ada Lovelace' }))
    expect(screen.getByText('1 candidate selected')).toBeTruthy()

    navigation.search = 'cursor=page-two'
    view.rerender(<CandidateWorkspace jobId={JOB_ID} />)
    expect(screen.getByText('1 candidate selected')).toBeTruthy()

    navigation.search = 'cursor=page-two&stage=screened'
    view.rerender(<CandidateWorkspace jobId={JOB_ID} />)
    await waitFor(() => expect(screen.queryByText('1 candidate selected')).toBeNull())
  })

  it('traps the destructive row-action dialog, closes on Escape, and restores trigger focus', async () => {
    render(<CandidateWorkspace jobId={JOB_ID} />)
    const table = await screen.findByRole('table', { name: 'Candidates for this job' })
    fireEvent.click(within(table).getAllByText('Actions')[0])
    const reject = within(table).getAllByRole('button', { name: 'Reject…' })[0]
    fireEvent.click(reject)
    expect(await screen.findByRole('dialog')).toBeTruthy()
    await waitFor(() => expect(screen.getByLabelText('Structured reason')).toHaveFocus())
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toHaveAttribute('data-stage-action', `${APPLICATION_ONE}:reject`))
  })

  it('requires a reason and confirmation before recording an offer decline, then restores focus', async () => {
    const offerRows = [rows[0], { ...rows[1], stage: 'offer' }]
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/candidates/summary')) return Promise.resolve(json(candidateSummary()))
      if (url.includes('/candidates?')) return Promise.resolve(json(candidatePage({ rows: offerRows })))
      if (url.includes('/stage') && init?.method === 'POST') return Promise.resolve(json({ status: 'updated' }))
      return Promise.resolve(json({ error: 'Unexpected request' }, 500))
    })
    render(<CandidateWorkspace jobId={JOB_ID} />)
    const table = await screen.findByRole('table', { name: 'Candidates for this job' })
    fireEvent.click(within(table).getAllByText('Actions')[1])
    const offerDeclined = within(table).getByRole('button', { name: 'Record offer declined' })
    fireEvent.click(offerDeclined)

    expect(await screen.findByRole('dialog', { name: 'Record offer declined for Grace Hopper?' })).toBeTruthy()
    expect(vi.mocked(fetch).mock.calls.some(([input, init]) => String(input).includes('/stage') && init?.method === 'POST')).toBe(false)
    await waitFor(() => expect(screen.getByLabelText('Structured reason')).toHaveFocus())
    expect(screen.getByRole('option', { name: 'Candidate withdrew' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'Requirements mismatch' })).toBeNull()
    fireEvent.change(screen.getByLabelText('Structured reason'), { target: { value: 'candidate_withdrew' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))

    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input, init]) => String(input).includes('/stage') && init?.method === 'POST')).toBe(true))
    const stageCall = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input).includes('/stage') && init?.method === 'POST')
    expect(JSON.parse(String(stageCall?.[1]?.body))).toMatchObject({
      action: 'offer_declined',
      expectedFrom: 'offer',
      reasonCode: 'candidate_withdrew',
    })
    expect(JSON.parse(String(stageCall?.[1]?.body))).not.toHaveProperty('note')
    await waitFor(() => expect(document.activeElement).toHaveAttribute('data-stage-action', `${APPLICATION_TWO}:offer_declined`))
  })

  it.each([
    ['reject', 'Reject…', 'requirements_mismatch', 'Requirements mismatch', 'Candidate withdrew'],
    ['withdraw', 'Mark withdrawn…', 'candidate_withdrew', 'Candidate withdrew', 'Requirements mismatch'],
  ] as const)('sends only the action-valid structured reason for a row %s', async (action, buttonName, reasonCode, allowedLabel, forbiddenLabel) => {
    render(<CandidateWorkspace jobId={JOB_ID} />)
    const table = await screen.findByRole('table', { name: 'Candidates for this job' })
    fireEvent.click(within(table).getAllByText('Actions')[0])
    fireEvent.click(within(table).getAllByRole('button', { name: buttonName })[0])

    expect(await screen.findByRole('option', { name: allowedLabel })).toBeTruthy()
    expect(screen.queryByRole('option', { name: forbiddenLabel })).toBeNull()
    fireEvent.change(screen.getByLabelText('Structured reason'), { target: { value: reasonCode } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))

    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input, init]) => String(input).includes('/stage') && init?.method === 'POST')).toBe(true))
    const stageCall = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input).includes('/stage') && init?.method === 'POST')
    expect(JSON.parse(String(stageCall?.[1]?.body))).toMatchObject({
      action,
      expectedFrom: 'new',
      reasonCode,
    })
    expect(JSON.parse(String(stageCall?.[1]?.body))).not.toHaveProperty('note')
  })

  it('keeps a destructive row dialog open and non-cancellable until the server responds', async () => {
    let resolveStage!: (response: Response) => void
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/candidates/freshness')) return Promise.resolve(json({ hasNewerResults: false, checkedAt: '2026-08-25T08:01:00.000Z' }))
      if (url.includes('/candidates/summary')) return Promise.resolve(json(candidateSummary()))
      if (url.includes('/candidates?')) return Promise.resolve(json(candidatePage()))
      if (url.includes('/stage') && init?.method === 'POST') return new Promise<Response>((resolve) => { resolveStage = resolve })
      return Promise.resolve(json({ error: 'Unexpected request' }, 500))
    })

    render(<CandidateWorkspace jobId={JOB_ID} />)
    const table = await screen.findByRole('table', { name: 'Candidates for this job' })
    fireEvent.click(within(table).getAllByText('Actions')[0])
    fireEvent.click(within(table).getAllByRole('button', { name: 'Reject…' })[0])
    fireEvent.change(screen.getByLabelText('Structured reason'), { target: { value: 'requirements_mismatch' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))

    expect(screen.getByRole('button', { name: 'Confirming…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBeTruthy()

    resolveStage(json({ error: 'Recruiter decision changed elsewhere' }, 409))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Recruiter decision changed elsewhere')
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeEnabled()
  })

  it('offers a truthful bounded board and URL-addressable next/browser-back pagination', async () => {
    navigation.search = 'layout=board'
    const view = render(<CandidateWorkspace jobId={JOB_ID} />)
    await screen.findByLabelText('Candidate stage board')
    expect(screen.getByText(/Stage totals describe all candidates in this job/)).toBeTruthy()
    expect(screen.getByText('1 shown · 600 job total')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    expect(navigation.push).toHaveBeenCalledWith(expect.stringContaining('cursor=next-opaque-cursor'), { scroll: true })
    expect(navigation.push).toHaveBeenCalledWith(expect.not.stringContaining('cursorTrail='), { scroll: true })

    navigation.search = 'layout=board&cursor=next-opaque-cursor'
    view.rerender(<CandidateWorkspace jobId={JOB_ID} />)
    await waitFor(() => expect(screen.getByRole('heading', { name: '823 matching candidates' })).toHaveFocus())
    expect(screen.getByText(/Loaded 2 candidates on the next page/)).toHaveClass('sr-only')
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }))
    expect(navigation.back).toHaveBeenCalledTimes(1)

    navigation.search = 'layout=board'
    view.rerender(<CandidateWorkspace jobId={JOB_ID} />)
    await waitFor(() => expect(screen.getByRole('heading', { name: '823 matching candidates' })).toHaveFocus())
    expect(screen.getByText(/Loaded 2 candidates on the first page/)).toHaveClass('sr-only')
  })

  it('labels board-stage facets as job totals when the candidate list is filtered', async () => {
    navigation.search = 'layout=board&stage=screened'
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/candidates/summary')) return Promise.resolve(json(candidateSummary()))
      if (url.includes('/candidates?')) return Promise.resolve(json(candidatePage({ rows: [rows[1]] })))
      return Promise.resolve(json({ error: 'Unexpected request' }, 500))
    })

    render(<CandidateWorkspace jobId={JOB_ID} />)

    expect(await screen.findByText('1 shown · 120 job total')).toBeTruthy()
    expect(screen.getByText(/Stage totals describe all candidates in this job, independent of the current filters/)).toBeTruthy()
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes('/candidates/summary?') && String(input).includes('stage=screened'))).toBe(true)
  })

  it('restores a snapshot and durable bulk operation coordinate from the URL', async () => {
    navigation.search = `selectionId=${SELECTION_ID}&bulkOperationId=777777777777777777777777`
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/candidates?')) return Promise.resolve(json(candidatePage()))
      if (url.includes('/candidates/summary')) return Promise.resolve(json(candidateSummary()))
      if (url.includes(`/candidate-selections/${SELECTION_ID}`) && init?.method === 'DELETE') return Promise.resolve(json({ deleted: true }))
      if (url.includes(`/candidate-selections/${SELECTION_ID}`)) return Promise.resolve(json(snapshot()))
      if (url.includes('/candidate-bulk-operations/777777777777777777777777')) return Promise.resolve(json({ operation: { operationId: '777777777777777777777777', action: 'advance', status: 'completed', totalCount: 1, queuedCount: 0, processingCount: 0, succeededCount: 1, conflictCount: 0, failedCount: 0 }, issues: { items: [], nextCursor: null } }))
      return Promise.resolve(json({ error: 'Unexpected request' }, 500))
    })
    render(<CandidateWorkspace jobId={JOB_ID} />)

    expect(await screen.findByText('1 candidate selected')).toBeTruthy()
    expect(await screen.findByText('Bulk advance · completed')).toBeTruthy()
    expect(screen.getByText('1 processed · 1 succeeded · 0 conflicts · 0 controlled failures')).toBeTruthy()

    navigation.search = ''
    fireEvent.click(screen.getByRole('button', { name: 'Finish and choose candidates again' }))
    await waitFor(() => expect(screen.queryByText('1 candidate selected')).toBeNull())
    await waitFor(() => expect(screen.getByRole('heading', { name: '823 matching candidates' })).toHaveFocus())
    expect(vi.mocked(fetch).mock.calls.some(([input, init]) => String(input).includes(`/candidate-selections/${SELECTION_ID}`) && init?.method === 'DELETE')).toBe(true)
    expect(navigation.replace.mock.calls.some(([url]) => !String(url).includes('selectionId=') && !String(url).includes('bulkOperationId='))).toBe(true)
  })

  it('recovers a durable operation when its selection snapshot has expired without erasing the URL coordinate', async () => {
    const operationId = '777777777777777777777777'
    navigation.search = `selectionId=${SELECTION_ID}&bulkOperationId=${operationId}`
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/candidates?')) return Promise.resolve(json(candidatePage()))
      if (url.includes('/candidates/summary')) return Promise.resolve(json(candidateSummary()))
      if (url.includes(`/candidate-selections/${SELECTION_ID}`)) return Promise.resolve(json({ error: 'Selection expired' }, 404))
      if (url.includes(`/candidate-bulk-operations/${operationId}`)) return Promise.resolve(json({
        operation: { operationId, action: 'reject', status: 'partial', totalCount: 5000, succeededCount: 4998, conflictCount: 1, failedCount: 1 },
        issues: { items: [], nextCursor: null },
      }))
      return Promise.resolve(json({ error: 'Unexpected request' }, 500))
    })

    const view = render(<CandidateWorkspace jobId={JOB_ID} />)

    expect(await screen.findByText('Bulk operation status')).toBeTruthy()
    expect(await screen.findByText('Bulk reject · partial')).toBeTruthy()
    expect(screen.queryByText('1 candidate selected')).toBeNull()
    await waitFor(() => expect(navigation.replace.mock.calls.every(([url]) => String(url).includes(`bulkOperationId=${operationId}`))).toBe(true))

    navigation.search = `selectionId=${SELECTION_ID}&bulkOperationId=${operationId}&stage=screened`
    view.rerender(<CandidateWorkspace jobId={JOB_ID} />)
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`bulkOperationId=${operationId}(?=.*stage=screened)|stage=screened(?=.*bulkOperationId=${operationId})`)),
      { scroll: false },
    ))
    expect(screen.getByText('Bulk reject · partial')).toBeTruthy()
  })

  it('keeps cursor-page rows usable when aggregate summary loading fails and does not refetch summaries for cursors', async () => {
    let summaryCalls = 0
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/candidates/summary')) {
        summaryCalls += 1
        return Promise.resolve(json({ error: 'Summary unavailable' }, 503))
      }
      if (url.includes('/candidates?')) return Promise.resolve(json(candidatePage()))
      return Promise.resolve(json({ error: 'Unexpected request' }, 500))
    })
    const view = render(<CandidateWorkspace jobId={JOB_ID} />)

    expect(await screen.findByRole('table', { name: 'Candidates for this job' })).toBeTruthy()
    expect(await screen.findByText(/Summary unavailable.*candidates on this page remain available/)).toBeTruthy()
    expect(screen.getByText('2 candidates on this page')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'All candidates — job total' })).toBeTruthy()
    expect(screen.getAllByText('Rank #1 of 700')).toHaveLength(2)

    navigation.search = 'cursor=page-two'
    view.rerender(<CandidateWorkspace jobId={JOB_ID} />)
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes('/candidates?')).length).toBeGreaterThan(1))
    expect(summaryCalls).toBe(1)
  })

  it('caps explicit selection across pages at 100 and keeps the explanatory alert visible', async () => {
    let activeRows = generatedRows(50)
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/candidates/summary')) return Promise.resolve(json(candidateSummary({ counts: { ...candidateSummary().counts, matching: 150 } })))
      if (url.includes('/candidates?')) return Promise.resolve(json(candidatePage({ rows: activeRows })))
      return Promise.resolve(json({ error: 'Unexpected request' }, 500))
    })
    const view = render(<CandidateWorkspace jobId={JOB_ID} />)

    await screen.findAllByText('Candidate 1')
    fireEvent.click(screen.getByRole('button', { name: 'Select this page' }))
    expect(screen.getByText('50 candidates selected')).toBeTruthy()

    activeRows = generatedRows(50, 50)
    navigation.search = 'cursor=page-two'
    view.rerender(<CandidateWorkspace jobId={JOB_ID} />)
    await screen.findAllByText('Candidate 51')
    fireEvent.click(screen.getByRole('button', { name: 'Select this page' }))
    expect(screen.getByText('100 candidates selected')).toBeTruthy()

    activeRows = generatedRows(1, 100)
    navigation.search = 'cursor=page-three'
    view.rerender(<CandidateWorkspace jobId={JOB_ID} />)
    const table = await screen.findByRole('table', { name: 'Candidates for this job' })
    fireEvent.click(within(table).getByRole('checkbox', { name: 'Select Candidate 101' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Explicit selection is limited to 100 candidates')
    expect(screen.getByText('100 candidates selected')).toBeTruthy()
  }, 30_000)

  it.each([2, 50])('prepares an explicit %i-candidate server snapshot and focuses normal-flow bulk actions', async (count) => {
    const activeRows = generatedRows(50)
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/candidates/freshness')) return Promise.resolve(json({ hasNewerResults: false, checkedAt: '2026-08-25T08:01:00.000Z' }))
      if (url.includes('/candidates/summary')) return Promise.resolve(json(candidateSummary()))
      if (url.includes('/candidates?')) return Promise.resolve(json(candidatePage({ rows: activeRows })))
      if (url.endsWith('/candidate-selections') && init?.method === 'POST') return Promise.resolve(json({ ...snapshot(), count, description: `${count} selected candidates` }, 201))
      return Promise.resolve(json({ error: 'Unexpected request' }, 500))
    })
    render(<CandidateWorkspace jobId={JOB_ID} />)
    const table = await screen.findByRole('table', { name: 'Candidates for this job' })
    if (count === 50) fireEvent.click(screen.getByRole('button', { name: 'Select this page' }))
    else {
      fireEvent.click(within(table).getByRole('checkbox', { name: 'Select Candidate 1' }))
      fireEvent.click(within(table).getByRole('checkbox', { name: 'Select Candidate 2' }))
      expect(screen.getByRole('button', { name: 'Compare selected' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Send to screening' })).toBeTruthy()
    }
    fireEvent.click(screen.getByRole('button', { name: 'Prepare bulk actions' }))

    const heading = await screen.findByRole('heading', { name: 'Bulk actions for stable selection' })
    await waitFor(() => expect(heading).toHaveFocus())
    expect(heading.closest('section')).not.toHaveClass('sticky')
    expect(screen.getByRole('button', { name: 'Reject selected…' })).toBeTruthy()
    const createCall = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input).endsWith('/candidate-selections') && init?.method === 'POST')
    expect(JSON.parse(String(createCall?.[1]?.body)).applicationIds).toHaveLength(count)
    expect(screen.getByText(new RegExp(`${count} candidates selected in a stable server snapshot`))).toHaveClass('sr-only')
  }, 30_000)

  it('preserves every multi-value filter in an all-matching snapshot', async () => {
    navigation.search = 'stage=new%2Cscreened&source=apply_page%2Cpool&scoreState=fresh%2Cstale&humanReview=mixed%2Cdisagreement&aiInterview=invited%2Ccompleted'
    render(<CandidateWorkspace jobId={JOB_ID} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Select all 823 matching' }))

    const createCall = await waitFor(() => vi.mocked(fetch).mock.calls.find(([input, init]) => String(input).endsWith('/candidate-selections') && init?.method === 'POST'))
    expect(JSON.parse(String(createCall?.[1]?.body))).toMatchObject({
      mode: 'all_matching',
      query: {
        stage: ['new', 'screened'],
        source: ['apply_page', 'pool'],
        scoreState: ['fresh', 'stale'],
        humanReview: ['mixed', 'disagreement'],
        aiInterview: ['invited', 'completed'],
      },
    })
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Bulk actions for stable selection' })).toHaveFocus())
  })

  it.each(['on_hold', 'closed'] as const)('keeps %s jobs read-only while preserving compare', async (status) => {
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/candidates/freshness')) return Promise.resolve(json({ hasNewerResults: false, checkedAt: '2026-08-25T08:01:00.000Z' }))
      if (url.includes('/candidates/summary')) return Promise.resolve(json(candidateSummary({ job: { ...candidateSummary().job, status } })))
      if (url.includes('/candidates?')) return Promise.resolve(json(candidatePage({ job: { ...candidatePage().job, status } })))
      return Promise.resolve(json({ error: 'Unexpected request' }, 500))
    })
    render(<CandidateWorkspace jobId={JOB_ID} />)
    const table = await screen.findByRole('table', { name: 'Candidates for this job' })
    fireEvent.click(within(table).getByRole('checkbox', { name: 'Select Ada Lovelace' }))
    fireEvent.click(within(table).getByRole('checkbox', { name: 'Select Grace Hopper' }))

    expect(screen.getByRole('button', { name: 'Compare selected' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Prepare bulk actions' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Send to screening' })).toBeNull()
    expect(screen.getByText(new RegExp(`job is ${status === 'on_hold' ? 'on hold' : 'closed'} and is read-only`, 'i'))).toBeTruthy()
  })

  it('stores an intentional empty optional-column set and restores it from columns=none', async () => {
    navigation.search = 'columns=attention'
    const view = render(<CandidateWorkspace jobId={JOB_ID} />)
    await screen.findByRole('table', { name: 'Candidates for this job' })
    fireEvent.click(screen.getByText('Columns'))
    fireEvent.click(screen.getByLabelText('Attention'))
    expect(navigation.replace).toHaveBeenCalledWith(expect.stringContaining('columns=none'), { scroll: false })

    navigation.search = 'columns=none'
    view.rerender(<CandidateWorkspace jobId={JOB_ID} />)
    const table = await screen.findByRole('table', { name: 'Candidates for this job' })
    fireEvent.click(screen.getByText('Columns'))
    const columnsGroup = screen.getByRole('group', { name: 'Visible columns' })
    for (const label of ['Attention', 'JD match & rank', 'Human review', 'AI interview', 'Candidate sources', 'Applied', 'Last activity', 'Workspace history']) {
      expect(within(columnsGroup).getByLabelText(label)).not.toBeChecked()
    }
    expect(within(table).queryByRole('columnheader', { name: 'Attention' })).toBeNull()
    expect(within(screen.getByRole('list', { name: 'Candidates for this job' })).queryByText('JD match')).toBeNull()
  })

  it('canonicalizes contradictory applied-date deep links in the URL and API', async () => {
    navigation.search = 'sort=newest&direction=asc&columns=appliedAt'
    render(<CandidateWorkspace jobId={JOB_ID} />)

    const direction = await screen.findByLabelText('Direction')
    expect(direction).toHaveValue('desc')
    expect(direction).toBeDisabled()
    expect(navigation.replace).toHaveBeenCalledWith(expect.stringContaining('sort=newest&direction=desc'), { scroll: false })
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes('/candidates?') && String(input).includes('sort=newest') && String(input).includes('direction=desc'))).toBe(true)
    const table = screen.getByRole('table', { name: 'Candidates for this job' })
    const applied = within(table).getByRole('columnheader', { name: /Applied/ })
    expect(applied).toHaveAttribute('aria-sort', 'descending')
    fireEvent.click(within(applied).getByRole('button'))
    expect(navigation.replace).toHaveBeenCalledWith(expect.stringContaining('sort=oldest'), { scroll: false })
  })

  it('shows complete workspace source history for a talent-pool-filtered candidate', async () => {
    navigation.search = 'source=pool&columns=source'
    const provenanceRows = [{ ...rows[0], source: 'apply_page', sourceHistory: ['apply_page', 'pool'] }]
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/candidates/freshness')) return Promise.resolve(json({ hasNewerResults: false, checkedAt: '2026-08-25T08:01:00.000Z' }))
      if (url.includes('/candidates/summary')) return Promise.resolve(json(candidateSummary()))
      if (url.includes('/candidates?')) return Promise.resolve(json(candidatePage({ rows: provenanceRows })))
      return Promise.resolve(json({ error: 'Unexpected request' }, 500))
    })
    render(<CandidateWorkspace jobId={JOB_ID} />)
    const table = await screen.findByRole('table', { name: 'Candidates for this job' })
    expect(within(table).getByRole('columnheader', { name: 'Candidate sources' })).toBeTruthy()
    expect(within(table).getByText('apply page · pool')).toBeTruthy()
    fireEvent.click(screen.getByText(/Filters/))
    expect(within(screen.getByRole('group', { name: 'Candidate sources' })).getByLabelText('Talent pool')).toBeChecked()
    expect(screen.getByText(/How this person entered the workspace over time/)).toBeTruthy()
  })

  it('defensively mounts no more than 50 candidate rows or cards', async () => {
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/candidates/freshness')) return Promise.resolve(json({ hasNewerResults: false, checkedAt: '2026-08-25T08:01:00.000Z' }))
      if (url.includes('/candidates/summary')) return Promise.resolve(json(candidateSummary()))
      if (url.includes('/candidates?')) return Promise.resolve(json(candidatePage({ rows: generatedRows(75) })))
      return Promise.resolve(json({ error: 'Unexpected request' }, 500))
    })
    render(<CandidateWorkspace jobId={JOB_ID} />)
    const table = await screen.findByRole('table', { name: 'Candidates for this job' })
    expect(table.querySelectorAll('tbody tr')).toHaveLength(50)
    expect(within(screen.getByRole('list', { name: 'Candidates for this job' })).getAllByRole('listitem')).toHaveLength(50)
  })

  it('wraps a very long job title without permanently truncating it', async () => {
    const longTitle = 'PrincipalPlatformAndDistributedSystemsRecruitingLead'.repeat(4)
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/candidates/freshness')) return Promise.resolve(json({ hasNewerResults: false, checkedAt: '2026-08-25T08:01:00.000Z' }))
      if (url.includes('/candidates/summary')) return Promise.resolve(json(candidateSummary({ job: { ...candidateSummary().job, title: longTitle } })))
      if (url.includes('/candidates?')) return Promise.resolve(json(candidatePage({ job: { ...candidatePage().job, title: longTitle } })))
      return Promise.resolve(json({ error: 'Unexpected request' }, 500))
    })
    render(<CandidateWorkspace jobId={JOB_ID} />)
    const heading = await screen.findByRole('heading', { name: longTitle })
    expect(heading).toHaveClass('break-words')
    expect(heading).not.toHaveClass('truncate')
  })

  it('polls lightweight freshness on a cursor page and clears the notice on user refresh', async () => {
    navigation.search = 'cursor=opaque-page-two&stage=screened'
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/candidates/freshness')) return Promise.resolve(json({ hasNewerResults: true, checkedAt: '2026-08-25T08:01:00.000Z' }))
      if (url.includes('/candidates/summary')) return Promise.resolve(json(candidateSummary()))
      if (url.includes('/candidates?')) return Promise.resolve(json(candidatePage()))
      return Promise.resolve(json({ error: 'Unexpected request' }, 500))
    })
    render(<CandidateWorkspace jobId={JOB_ID} />)
    expect(await screen.findByText('New applications are available. Your current review page has not been reordered.')).toBeTruthy()
    const freshnessCall = vi.mocked(fetch).mock.calls.find(([input]) => String(input).includes('/candidates/freshness'))
    expect(String(freshnessCall?.[0])).toContain('snapshotAt=2026-08-25T08%3A00%3A00.000Z')
    expect(String(freshnessCall?.[0])).toContain('stage=screened')
    expect(String(freshnessCall?.[0])).not.toContain('cursor=')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh list' }))
    await waitFor(() => expect(screen.queryByText('New applications are available. Your current review page has not been reordered.')).toBeNull())
  })

  it('resets an invalid direct cursor, then focuses and announces the first page after it loads', async () => {
    navigation.search = 'cursor=expired-direct-cursor'
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/candidates/freshness')) return Promise.resolve(json({ hasNewerResults: false, checkedAt: '2026-08-25T08:01:00.000Z' }))
      if (url.includes('/candidates/summary')) return Promise.resolve(json(candidateSummary()))
      if (url.includes('/candidates?') && url.includes('cursor=')) return Promise.resolve(json({ error: 'Invalid cursor', code: 'JOB_CANDIDATES_INVALID_CURSOR' }, 400))
      if (url.includes('/candidates?')) return Promise.resolve(json(candidatePage()))
      return Promise.resolve(json({ error: 'Unexpected request' }, 500))
    })
    const view = render(<CandidateWorkspace jobId={JOB_ID} />)
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith(expect.not.stringContaining('cursor='), { scroll: false }))
    navigation.search = ''
    view.rerender(<CandidateWorkspace jobId={JOB_ID} />)
    await waitFor(() => expect(screen.getByRole('heading', { name: '823 matching candidates' })).toHaveFocus())
    expect(screen.getByText(/Loaded 2 candidates on the first page/)).toHaveClass('sr-only')
  })

  it('recovers a stale cursor without losing filters, view, or sort and explains the reset visibly', async () => {
    navigation.search = 'cursor=stale-page&snapshotAt=2026-08-25T08%3A00%3A00.000Z&stage=screened&view=scoring_attention&sort=rank&direction=asc'
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/candidates/freshness')) return Promise.resolve(json({ hasNewerResults: false, checkedAt: '2026-08-25T08:01:00.000Z' }))
      if (url.includes('/candidates/summary')) return Promise.resolve(json(candidateSummary()))
      if (url.includes('/candidates?') && url.includes('cursor=')) return Promise.resolve(json({ error: 'Candidate results changed', code: 'JOB_CANDIDATES_CURSOR_STALE' }, 409))
      if (url.includes('/candidates?')) return Promise.resolve(json(candidatePage()))
      return Promise.resolve(json({ error: 'Unexpected request' }, 500))
    })

    const view = render(<CandidateWorkspace jobId={JOB_ID} />)
    await waitFor(() => expect(navigation.replace).toHaveBeenCalled())
    const resetUrl = String(navigation.replace.mock.calls.at(-1)?.[0])
    expect(resetUrl).toContain('stage=screened')
    expect(resetUrl).toContain('view=scoring_attention')
    expect(resetUrl).toContain('sort=rank')
    expect(resetUrl).toContain('direction=asc')
    expect(resetUrl).not.toContain('cursor=')
    expect(resetUrl).not.toContain('snapshotAt=')
    expect(screen.getByText('Candidate results changed while you were paging. Returned to the first page and kept your filters, view, and sort.')).toBeVisible()
    expect(screen.queryByRole('alert')).toBeNull()

    navigation.search = 'stage=screened&view=scoring_attention&sort=rank&direction=asc'
    view.rerender(<CandidateWorkspace jobId={JOB_ID} />)
    await waitFor(() => expect(screen.getByRole('heading', { name: '823 matching candidates' })).toHaveFocus())
    expect(screen.getByText(/Loaded 2 candidates on the first page/)).toHaveClass('sr-only')
  })

  it('does not mistake a row for leaving the filtered view when its update makes a cursor stale', async () => {
    navigation.search = 'cursor=page-two&stage=new'
    let cursorPageCalls = 0
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/candidates/freshness')) return Promise.resolve(json({ hasNewerResults: false, checkedAt: '2026-08-25T08:01:00.000Z' }))
      if (url.includes('/candidates/summary')) return Promise.resolve(json(candidateSummary()))
      if (url.includes('/candidates?') && url.includes('cursor=')) {
        cursorPageCalls += 1
        return cursorPageCalls === 1
          ? Promise.resolve(json(candidatePage()))
          : Promise.resolve(json({ error: 'Candidate results changed', code: 'JOB_CANDIDATES_CURSOR_STALE' }, 409))
      }
      if (url.includes('/candidates?')) return Promise.resolve(json(candidatePage({ rows: [rows[1]] })))
      if (url.includes('/stage') && init?.method === 'POST') return Promise.resolve(json({ status: 'updated' }))
      return Promise.resolve(json({ error: 'Unexpected request' }, 500))
    })

    const view = render(<CandidateWorkspace jobId={JOB_ID} />)
    const table = await screen.findByRole('table', { name: 'Candidates for this job' })
    fireEvent.click(within(table).getAllByText('Actions')[0])
    fireEvent.click(within(table).getAllByRole('button', { name: 'Advance one stage' })[0])

    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith(expect.not.stringContaining('cursor='), { scroll: false }))
    expect(screen.getByText('Ada Lovelace was updated. Candidate results changed while you were paging. Returned to the first page and kept your filters, view, and sort.')).toBeVisible()
    navigation.search = 'stage=new'
    view.rerender(<CandidateWorkspace jobId={JOB_ID} />)
    await waitFor(() => expect(screen.getByRole('heading', { name: '823 matching candidates' })).toHaveFocus())
    expect(screen.queryByText(/Ada Lovelace left the current filtered view/)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('renders row-action HTTP and network failures as red alerts and clears them on success', async () => {
    let stageCalls = 0
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/candidates/freshness')) return Promise.resolve(json({ hasNewerResults: false, checkedAt: '2026-08-25T08:01:00.000Z' }))
      if (url.includes('/candidates/summary')) return Promise.resolve(json(candidateSummary()))
      if (url.includes('/candidates?')) return Promise.resolve(json(candidatePage()))
      if (url.includes('/stage') && init?.method === 'POST') {
        stageCalls += 1
        if (stageCalls === 1) return Promise.resolve(json({ error: 'Stage changed elsewhere' }, 409))
        if (stageCalls === 2) return Promise.reject(new Error('offline'))
        return Promise.resolve(json({ status: 'updated' }))
      }
      return Promise.resolve(json({ error: 'Unexpected request' }, 500))
    })
    render(<CandidateWorkspace jobId={JOB_ID} />)
    const advance = async () => {
      const table = await screen.findByRole('table', { name: 'Candidates for this job' })
      fireEvent.click(within(table).getAllByText('Actions')[0])
      fireEvent.click(within(table).getAllByRole('button', { name: 'Advance one stage' })[0])
    }
    await advance()
    expect(await screen.findByRole('alert')).toHaveTextContent('Stage changed elsewhere')
    expect(screen.queryByText('Ada Lovelace was updated.')).toBeNull()
    await advance()
    expect(await screen.findByRole('alert')).toHaveTextContent('Network error')
    await advance()
    expect(await screen.findByText('Ada Lovelace was updated.')).toHaveAttribute('role', 'status')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('focuses results and announces when a row action removes the candidate from the filtered view', async () => {
    let listCalls = 0
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/candidates/freshness')) return Promise.resolve(json({ hasNewerResults: false, checkedAt: '2026-08-25T08:01:00.000Z' }))
      if (url.includes('/candidates/summary')) return Promise.resolve(json(candidateSummary()))
      if (url.includes('/candidates?')) {
        listCalls += 1
        return Promise.resolve(json(candidatePage({ rows: listCalls === 1 ? rows : [rows[1]] })))
      }
      if (url.includes('/stage') && init?.method === 'POST') return Promise.resolve(json({ status: 'updated' }))
      return Promise.resolve(json({ error: 'Unexpected request' }, 500))
    })
    render(<CandidateWorkspace jobId={JOB_ID} />)
    const table = await screen.findByRole('table', { name: 'Candidates for this job' })
    fireEvent.click(within(table).getAllByText('Actions')[0])
    fireEvent.click(within(table).getAllByRole('button', { name: 'Advance one stage' })[0])
    await waitFor(() => expect(screen.getByRole('heading', { name: '823 matching candidates' })).toHaveFocus())
    expect(screen.getByText(/Ada Lovelace left the current filtered view/)).toHaveClass('sr-only')
  })
})
