import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ScreeningPanel from '../ScreeningPanel'

const JOB_ID = 'job-1'
const APPLICATION_ONE = 'aaaaaaaaaaaaaaaaaaaaaaaa'
const APPLICATION_TWO = 'bbbbbbbbbbbbbbbbbbbbbbbb'
const APPLICATION_THREE = 'cccccccccccccccccccccccc'
const CANDIDATE_ONE = '111111111111111111111111'
const CANDIDATE_TWO = '222222222222222222222222'
const CANDIDATE_THREE = '333333333333333333333333'
const SELECTION_ID = 'eeeeeeeeeeeeeeeeeeeeeeee'

function candidate(
  applicationId: string,
  candidateId: string,
  displayName: string,
  email: string,
) {
  return {
    applicationId,
    candidateId,
    identityState: 'available' as const,
    displayName,
    email,
    applicationUrl: `/workspace/applications/${applicationId}`,
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function previewResponse(exceptions: unknown[] = []) {
  const rows = [
    {
      applicationId: APPLICATION_ONE,
      candidateId: CANDIDATE_ONE,
      applicationCreatedAt: '2026-08-10T10:00:00.000Z',
      rank: 1,
      score: 91,
      scoreState: 'scored' as const,
      knockoutReasons: [],
      automaticallySelected: true,
      selected: true,
      selectionReason: 'top_n' as const,
      candidate: candidate(
        APPLICATION_ONE,
        CANDIDATE_ONE,
        'Ada Lovelace',
        'ada@example.com',
      ),
    },
    {
      applicationId: APPLICATION_TWO,
      candidateId: CANDIDATE_TWO,
      applicationCreatedAt: '2026-08-11T10:00:00.000Z',
      rank: 2,
      score: 81,
      scoreState: 'scored' as const,
      knockoutReasons: [],
      automaticallySelected: true,
      selected: true,
      selectionReason: 'top_n' as const,
      candidate: candidate(
        APPLICATION_TWO,
        CANDIDATE_TWO,
        'Grace Hopper',
        'grace@example.com',
      ),
    },
  ]
  return {
    preview: {
      workspaceId: 'workspace-1',
      jobId: JOB_ID,
      rule: { mode: 'top_n', topN: 2, knockoutSettings: {} },
      generatedAt: '2026-08-12T10:00:00.000Z',
      evaluatedCount: 3,
      eligibleCount: 2,
      automaticallySelectedCount: 2,
      selectedCount: 2,
      scoreStateCounts: { scored: 2, stale: 0, unscored: 1 },
      knownKnockoutCount: 1,
      cutLine: {
        mode: 'top_n',
        requestedTopN: 2,
        applicationId: APPLICATION_TWO,
        rank: 2,
        score: 81,
        candidate: candidate(
          APPLICATION_TWO,
          CANDIDATE_TWO,
          'Grace Hopper',
          'grace@example.com',
        ),
      },
      exceptions,
      page: {
        scope: 'selected' as const,
        rows,
        total: 2,
        offset: 0,
        hasPrevious: false,
        previousCursor: null,
        hasNext: false,
        nextCursor: null,
      },
    },
    requirementVersion: {
      id: 'dddddddddddddddddddddddd',
      version: 3,
      contentHash: 'a'.repeat(64),
    },
    previewFingerprint: 'b'.repeat(64),
  }
}

function evaluatedPreviewResponse() {
  const response = previewResponse()
  return {
    ...response,
    preview: {
      ...response.preview,
      page: {
        scope: 'evaluated' as const,
        rows: [
          ...response.preview.page.rows,
          {
            applicationId: APPLICATION_THREE,
            candidateId: CANDIDATE_THREE,
            applicationCreatedAt: '2026-08-12T10:00:00.000Z',
            rank: null,
            score: null,
            scoreState: 'unscored' as const,
            knockoutReasons: ['experience'] as const,
            automaticallySelected: false,
            selected: false,
            selectionReason: 'knockout' as const,
            candidate: candidate(
              APPLICATION_THREE,
              CANDIDATE_THREE,
              'Katherine Johnson',
              'katherine@example.com',
            ),
          },
        ],
        total: 3,
        offset: 0,
        hasPrevious: false,
        previousCursor: null,
        hasNext: false,
        nextCursor: null,
      },
    },
  }
}

function focusedReviewPreviewResponse(scope: 'attention' | 'knockouts') {
  const response = evaluatedPreviewResponse()
  const source = response.preview.page.rows[2]
  const row = scope === 'attention'
    ? {
        ...source,
        scoreState: 'unscored' as const,
        knockoutReasons: [],
        selectionReason: 'stale_or_unscored' as const,
      }
    : {
        ...source,
        score: 67,
        scoreState: 'scored' as const,
        knockoutReasons: ['experience'] as const,
        selectionReason: 'knockout' as const,
      }
  return {
    ...response,
    preview: {
      ...response.preview,
      page: {
        scope,
        rows: [row],
        total: 1,
        offset: 0,
        hasPrevious: false,
        previousCursor: null,
        hasNext: false,
        nextCursor: null,
      },
    },
  }
}

function largePreviewEntry(position: number, count: number, selectedCount: number) {
  const applicationId = position.toString(16).padStart(24, '0')
  const candidateId = (position + count).toString(16).padStart(24, '0')
  const selected = position <= selectedCount
  return {
    applicationId,
    candidateId,
    applicationCreatedAt: new Date(
      Date.UTC(2026, 7, 12, 10, 0, position),
    ).toISOString(),
    rank: position,
    score: Math.max(1, 100 - position),
    scoreState: 'scored' as const,
    knockoutReasons: [],
    automaticallySelected: selected,
    selected,
    selectionReason: selected ? ('top_n' as const) : ('below_cut_line' as const),
    candidate: candidate(
      applicationId,
      candidateId,
      `Candidate ${String(position).padStart(4, '0')}`,
      `candidate${position}@example.com`,
    ),
  }
}

function largePreviewResponse({
  count = 5_000,
  selectedCount = 5_000,
  scope = 'selected',
  offset = 0,
}: {
  count?: number
  selectedCount?: number
  scope?: 'selected' | 'evaluated' | 'attention' | 'knockouts'
  offset?: number
} = {}) {
  const response = previewResponse()
  const total = scope === 'selected' ? selectedCount : count
  const rows = Array.from(
    { length: Math.min(50, Math.max(0, total - offset)) },
    (_, index) => largePreviewEntry(offset + index + 1, count, selectedCount),
  )
  const cutLineEntry = largePreviewEntry(selectedCount, count, selectedCount)
  return {
    ...response,
    preview: {
      ...response.preview,
      rule: { mode: 'top_n' as const, topN: selectedCount, knockoutSettings: {} },
      evaluatedCount: count,
      eligibleCount: count,
      automaticallySelectedCount: selectedCount,
      selectedCount,
      scoreStateCounts: { scored: count, stale: 0, unscored: 0 },
      knownKnockoutCount: 0,
      cutLine: {
        mode: 'top_n' as const,
        requestedTopN: selectedCount,
        applicationId: cutLineEntry.applicationId,
        rank: selectedCount,
        score: cutLineEntry.score,
        candidate: cutLineEntry.candidate,
      },
      page: {
        scope,
        rows,
        total,
        offset,
        hasPrevious: offset > 0,
        previousCursor: offset > 0 ? `${scope}:${Math.max(0, offset - 50)}` : null,
        hasNext: offset + rows.length < total,
        nextCursor: offset + rows.length < total ? `${scope}:${offset + 50}` : null,
      },
    },
  }
}

function historyResponse(
  gates: unknown[] = [],
  pageInfo = { limit: 10, hasNextPage: false, nextCursor: null as string | null },
) {
  return { gates, pageInfo }
}

function confirmedGate() {
  return {
    id: 'gate-1',
    status: 'confirmed',
    requirementVersion: { id: 'dddddddddddddddddddddddd', version: 3, contentHash: 'a'.repeat(64) },
    rule: {
      mode: 'top_n',
      topN: 2,
      scoreThreshold: null,
      knockoutSettings: { location: null, experienceFloorYears: null },
    },
    cutLine: {
      mode: 'top_n',
      requestedTopN: 2,
      scoreThreshold: null,
      applicationId: APPLICATION_TWO,
      rank: 2,
      score: 81,
    },
    counts: { evaluated: 3, eligible: 2, automaticallySelected: 2, selected: 2 },
    exceptionCount: 0,
    confirmedByName: 'HR One',
    confirmedAt: '2026-08-12T10:05:00.000Z',
    cancelledAt: null,
    cancelNote: null,
    createdAt: '2026-08-12T10:05:00.000Z',
    batchPageInfo: { limit: 10, hasNextPage: false, nextCursor: null },
    batches: [
      {
        id: 'batch-1',
        screeningGateId: 'gate-1',
        wave: 1,
        sendAfter: '2026-08-13T09:00:00.000Z',
        status: 'planned',
        plannedCount: 2,
        sentCount: 0,
        failedCount: 0,
        lastError: null,
        completedAt: null,
        cancelledAt: null,
        createdByName: 'HR One',
        createdAt: '2026-08-12T10:05:00.000Z',
        recipients: [
          {
            id: 'item-1',
            batchId: 'batch-1',
            applicationId: APPLICATION_ONE,
            candidate: candidate(
              APPLICATION_ONE,
              CANDIDATE_ONE,
              'Ada Lovelace',
              'ada@example.com',
            ),
            identityState: 'available',
            rank: 1,
            score: 91,
            scoreState: 'scored',
            selectionReason: 'top_n',
            sendAfter: '2026-08-13T09:00:00.000Z',
            status: 'pending',
            deliveryStatus: 'pending',
            attempts: 0,
            sentAt: null,
            issue: null,
          },
          {
            id: 'item-2',
            batchId: 'batch-1',
            applicationId: APPLICATION_TWO,
            candidate: candidate(
              APPLICATION_TWO,
              CANDIDATE_TWO,
              'Grace Hopper',
              'grace@example.com',
            ),
            identityState: 'available',
            rank: 2,
            score: 81,
            scoreState: 'scored',
            selectionReason: 'top_n',
            sendAfter: '2026-08-13T09:01:00.000Z',
            status: 'pending',
            deliveryStatus: 'pending',
            attempts: 0,
            sentAt: null,
            issue: null,
          },
        ],
      },
    ],
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ScreeningPanel', () => {
  it.each(['closed', 'on_hold'] as const)(
    'loads split-route job context and keeps commands disabled for %s jobs',
    async (status) => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === `/api/workspace/jobs/${JOB_ID}/summary`) {
          return json({
            job: {
              jobId: JOB_ID,
              title: 'Platform Engineer',
              status,
            },
          })
        }
        if (url === `/api/workspace/jobs/${JOB_ID}/screening`) {
          return json(historyResponse())
        }
        throw new Error(`Unexpected request: ${url}`)
      })
      vi.stubGlobal('fetch', fetchMock)

      render(<ScreeningPanel jobId={JOB_ID} />)

      expect(
        await screen.findByRole('heading', {
          name: 'Platform Engineer screening gate',
        }),
      ).toBeInTheDocument()
      expect(screen.getByText('job is not open')).toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: 'Preview screening selection' }),
      ).toBeDisabled()
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).endsWith('/screening/preview'),
        ),
      ).toBe(false)
    },
  )

  it('previews a deterministic cut line and only schedules staggered delivery after explicit confirmation', async () => {
    let gateReads = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === `/api/workspace/jobs/${JOB_ID}/screening`) {
        gateReads += 1
        return json(historyResponse(gateReads === 1 ? [] : [confirmedGate()]))
      }
      if (url === `/api/workspace/jobs/${JOB_ID}/screening/preview`) {
        expect(init?.method).toBe('POST')
        expect(JSON.parse(String(init?.body))).toEqual({ rule: { mode: 'top_n', topN: 2 }, exceptions: [] })
        return json(previewResponse())
      }
      if (url === `/api/workspace/jobs/${JOB_ID}/screening/confirm`) {
        expect(init?.method).toBe('POST')
        const body = JSON.parse(String(init?.body))
        expect(body.rule).toEqual({ mode: 'top_n', topN: 2 })
        expect(body.exceptions).toEqual([])
        expect(body.previewFingerprint).toBe('b'.repeat(64))
        expect(body.sendAfter).toBe(new Date('2026-08-13T09:00').toISOString())
        return json({ itemCount: 2, gate: confirmedGate(), batch: confirmedGate().batches[0] })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<ScreeningPanel jobId={JOB_ID} jobStatus="open" />)

    await screen.findByText('No screening gate has been confirmed yet.')
    fireEvent.change(screen.getByLabelText('Top N'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Preview screening selection' }))

    await screen.findByRole('heading', { name: 'Read-only preview' })
    expect(screen.getByText('Cut line: rank 2 · 81/100')).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: 'Ada Lovelace' })[0]).toHaveAttribute(
      'href',
      `/workspace/applications/${APPLICATION_ONE}`,
    )
    expect(screen.getAllByText('ada@example.com').length).toBeGreaterThan(0)
    expect(screen.getByText(/Times use your browser timezone:/)).toBeInTheDocument()
    expect(screen.getByText('Stale / unscored')).toBeInTheDocument()
    expect(screen.getByText('Known knockouts')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Planned selection (2)' })).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/confirm'))).toBe(false)

    fireEvent.change(screen.getByLabelText('Planned send time'), {
      target: { value: '2026-08-13T09:00' },
    })
    fireEvent.click(screen.getByRole('checkbox', { name: /I reviewed the deterministic cut line/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & schedule 2 candidates' }))

    const confirmationNotice = await screen.findByText(
      'Created a scheduled batch for 2 candidates. Staggered invitations begin at the planned time; no candidate was rejected or moved.',
    )
    await waitFor(() => expect(confirmationNotice).toHaveFocus())
    await screen.findByText('Wave 1 · 2 planned · 0 sent')
    expect(screen.getByText('planned')).toBeInTheDocument()
    expect(screen.getByText('Recipient delivery details')).toBeInTheDocument()
  })

  it('revokes confirmation authority immediately when a same-request preview refresh fails', async () => {
    let previewReads = 0
    let confirmWrites = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/workspace/jobs/${JOB_ID}/screening`) {
        return json(historyResponse())
      }
      if (url === `/api/workspace/jobs/${JOB_ID}/screening/preview`) {
        previewReads += 1
        return previewReads === 1
          ? json(previewResponse())
          : json({ error: 'The refreshed preview could not be built.' }, 503)
      }
      if (url === `/api/workspace/jobs/${JOB_ID}/screening/confirm`) {
        confirmWrites += 1
        return json({ error: 'This endpoint should stay unreachable.' }, 500)
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<ScreeningPanel jobId={JOB_ID} jobStatus="open" />)
    await screen.findByText('No screening gate has been confirmed yet.')
    fireEvent.click(screen.getByRole('button', { name: 'Preview screening selection' }))
    await screen.findByRole('heading', { name: 'Read-only preview' })

    const acknowledgement = screen.getByRole('checkbox', {
      name: /I reviewed the deterministic cut line/i,
    })
    const confirmButton = screen.getByRole('button', {
      name: 'Confirm & schedule 2 candidates',
    })
    fireEvent.click(acknowledgement)
    expect(confirmButton).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: 'Refresh screening preview' }))
    expect(acknowledgement).not.toBeChecked()
    expect(acknowledgement).toBeDisabled()
    expect(confirmButton).toBeDisabled()
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The refreshed preview could not be built.',
    )
    expect(screen.getByText('refresh required')).toBeInTheDocument()
    fireEvent.click(confirmButton)
    expect(confirmWrites).toBe(0)
  })

  it('requires a note for include/exclude overrides and refreshes the preview with the documented exception', async () => {
    const previewBodies: unknown[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === `/api/workspace/jobs/${JOB_ID}/screening`) return json(historyResponse())
      if (url === `/api/workspace/jobs/${JOB_ID}/screening/preview`) {
        const body = JSON.parse(String(init?.body))
        if (body.page?.scope === 'evaluated') {
          return json(evaluatedPreviewResponse())
        }
        previewBodies.push(body)
        return json(previewResponse())
      }
      if (url.startsWith(`/api/workspace/jobs/${JOB_ID}/screening/candidates?`)) {
        const cursor = new URL(url, 'http://screening.test').searchParams.get('cursor')
        if (cursor === 'candidate-page-2') {
          return json({
            candidates: [{
              applicationId: APPLICATION_TWO,
              candidateName: 'Margaret Hamilton',
              candidateEmail: 'margaret@example.com',
            }],
            pageInfo: { limit: 20, nextCursor: null },
          })
        }
        return json({
          candidates: [{
            applicationId: APPLICATION_THREE,
            candidateName: 'Katherine Johnson',
            candidateEmail: 'katherine@example.com',
          }],
          pageInfo: { limit: 20, nextCursor: 'candidate-page-2' },
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<ScreeningPanel jobId={JOB_ID} jobStatus="open" />)
    await screen.findByText('No screening gate has been confirmed yet.')
    fireEvent.click(screen.getByRole('button', { name: 'Preview screening selection' }))
    await screen.findByRole('heading', { name: 'Read-only preview' })

    fireEvent.change(screen.getByLabelText('Search exception applications'), {
      target: { value: 'K' },
    })
    expect(screen.getByText('Enter at least 2 characters to search this job.')).toBeInTheDocument()
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(fetchMock.mock.calls.filter(([input]) =>
      String(input).startsWith(`/api/workspace/jobs/${JOB_ID}/screening/candidates?`),
    )).toHaveLength(0)

    fireEvent.change(screen.getByLabelText('Search exception applications'), {
      target: { value: 'Katherine' },
    })
    await waitFor(() => expect(
      within(screen.getByLabelText('Exception application')).getAllByRole('option'),
    ).toHaveLength(2))

    fireEvent.change(screen.getByLabelText('Exception application'), {
      target: { value: APPLICATION_THREE },
    })
    fireEvent.change(screen.getByLabelText('Exception reason note'), {
      target: { value: 'This draft belongs only to the current review page.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Next candidate search page' }))
    await waitFor(() => expect(
      within(screen.getByLabelText('Exception application')).getByRole('option', {
        name: 'Margaret Hamilton · margaret@example.com',
      }),
    ).toBeInTheDocument())
    expect(screen.getByLabelText('Exception application')).toHaveValue('')
    expect(screen.getByLabelText('Exception reason note')).toHaveValue('')
    expect(screen.getByText(/bounded results · search page 2/)).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Previous candidate search page' }))
    await waitFor(() => expect(
      within(screen.getByLabelText('Exception application')).getByRole('option', {
        name: 'Katherine Johnson · katherine@example.com',
      }),
    ).toBeInTheDocument())
    expect(screen.getByText(/bounded results · search page 1/)).toHaveFocus()

    fireEvent.change(screen.getByLabelText('Exception application'), {
      target: { value: APPLICATION_THREE },
    })
    fireEvent.change(screen.getByLabelText('Exception reason note'), {
      target: { value: 'This draft belongs only to the current review page.' },
    })
    fireEvent.click(screen.getByText('View all 3 evaluated applications'))
    await screen.findByRole('list', { name: 'Evaluated applications' })
    expect(screen.getByLabelText('Exception application')).toHaveValue('')
    expect(screen.getByLabelText('Exception reason note')).toHaveValue('')

    fireEvent.change(screen.getByLabelText('Exception application'), {
      target: { value: APPLICATION_THREE },
    })
    fireEvent.change(screen.getByLabelText('Exception action'), { target: { value: 'include' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add exception' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Every include or exclude exception needs a note.')

    fireEvent.change(screen.getByLabelText('Exception reason note'), {
      target: { value: 'Hiring panel approved this exception after review.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add exception' }))

    expect(screen.getByRole('list', { name: 'Screening exceptions' })).toHaveTextContent('Hiring panel approved this exception after review.')
    expect(screen.getByText('refresh required')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh screening preview' }))

    await waitFor(() => expect(previewBodies).toHaveLength(2))
    expect(previewBodies[1]).toEqual({
      rule: { mode: 'top_n', topN: 10 },
      exceptions: [
        {
          applicationId: APPLICATION_THREE,
          action: 'include',
          note: 'Hiring panel approved this exception after review.',
        },
      ],
    })
  })

  it('verifies a server-owned candidate handoff and carries its documented rationale into preview', async () => {
    const previewBodies: unknown[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (
        url ===
        `/api/workspace/jobs/${JOB_ID}/candidate-selections/${SELECTION_ID}`
      ) {
        return json({
          selectionId: SELECTION_ID,
          count: 37,
          expiresAt: '2026-08-26T10:00:00.000Z',
          description: '37 candidates selected on the current Candidates view',
        })
      }
      if (url === `/api/workspace/jobs/${JOB_ID}/screening`) {
        return json(historyResponse())
      }
      if (url === `/api/workspace/jobs/${JOB_ID}/screening/preview`) {
        previewBodies.push(JSON.parse(String(init?.body)))
        return json(previewResponse())
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <ScreeningPanel
        jobId={JOB_ID}
        jobStatus="open"
        selectionSnapshotId={SELECTION_ID}
      />,
    )

    expect(
      await screen.findByText(
        /37 candidates selected on the current Candidates view/,
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Preview screening selection' }),
    ).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Inclusion rationale'), {
      target: {
        value: 'Recruiting lead approved this reviewed sourcing cohort.',
      },
    })
    fireEvent.click(
      screen.getByRole('button', { name: 'Preview screening selection' }),
    )

    await waitFor(() => expect(previewBodies).toHaveLength(1))
    expect(previewBodies[0]).toEqual({
      rule: { mode: 'top_n', topN: 10 },
      exceptions: [],
      selectionSnapshotId: SELECTION_ID,
      selectionNote: 'Recruiting lead approved this reviewed sourcing cohort.',
    })
    expect(
      screen.getByText(/never changes a pipeline stage/i),
    ).toBeInTheDocument()
  })

  it('keeps a 5,000-candidate preview server-bounded, replaces pages, and loads evaluated rows lazily', async () => {
    const previewBodies: Array<Record<string, unknown>> = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === `/api/workspace/jobs/${JOB_ID}/screening`) {
        return json(historyResponse())
      }
      if (url === `/api/workspace/jobs/${JOB_ID}/screening/preview`) {
        const body = JSON.parse(String(init?.body)) as {
          page?: {
            scope?: 'selected' | 'evaluated' | 'attention' | 'knockouts'
            cursor?: string
          }
        }
        previewBodies.push(body)
        if (!body.page) return json(largePreviewResponse())
        const offset = body.page.cursor?.endsWith(':50') ? 50 : 0
        return json(largePreviewResponse({ scope: body.page.scope, offset }))
      }
      if (url.startsWith(`/api/workspace/jobs/${JOB_ID}/screening/candidates?`)) {
        const application = largePreviewEntry(60, 5_000, 5_000)
        return json({
          candidates: [{
            applicationId: application.applicationId,
            candidateName: 'Candidate 0060',
            candidateEmail: 'candidate60@example.com',
          }],
          pageInfo: { limit: 20, nextCursor: null },
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<ScreeningPanel jobId={JOB_ID} jobStatus="open" />)
    await screen.findByText('No screening gate has been confirmed yet.')
    fireEvent.click(
      screen.getByRole('button', { name: 'Preview screening selection' }),
    )

    await screen.findByRole('heading', { name: 'Planned selection (5000)' })
    const selectedList = screen.getByRole('list', {
      name: 'Planned selected applications',
    })
    expect(within(selectedList).getAllByRole('listitem')).toHaveLength(50)
    expect(largePreviewResponse().preview.page.rows).toHaveLength(50)
    expect(
      screen.queryByRole('link', { name: 'Candidate 0060' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('list', { name: 'Evaluated applications' }),
    ).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Filter current selected page'), {
      target: { value: 'Candidate 0060' },
    })
    await screen.findByText('No selected applications match this search.')
    expect(screen.getByText(/0 of 50 applications on this page; 5000 selected total/)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Filter current selected page'), {
      target: { value: '' },
    })
    await waitFor(() =>
      expect(
        within(
          screen.getByRole('list', { name: 'Planned selected applications' }),
        ).getAllByRole('listitem'),
      ).toHaveLength(50),
    )
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Next selected page',
      }),
    )
    await screen.findByRole('link', { name: 'Candidate 0051' })
    expect(screen.queryByRole('link', { name: 'Candidate 0001' })).not.toBeInTheDocument()
    expect(
      within(screen.getByRole('list', { name: 'Planned selected applications' }))
        .getAllByRole('listitem'),
    ).toHaveLength(50)
    expect(previewBodies[1]).toMatchObject({
      page: {
        scope: 'selected',
        cursor: 'selected:50',
        expectedFingerprint: 'b'.repeat(64),
      },
    })

    const exceptionSelect = screen.getByLabelText('Exception application')
    expect(within(exceptionSelect).getAllByRole('option')).toHaveLength(1)
    fireEvent.change(screen.getByLabelText('Search exception applications'), {
      target: { value: 'Candidate 0060' },
    })
    await waitFor(() =>
      expect(
        within(screen.getByLabelText('Exception application')).getAllByRole(
          'option',
        ),
      ).toHaveLength(2),
    )
    const application60 = largePreviewEntry(60, 5_000, 5_000).applicationId
    fireEvent.change(screen.getByLabelText('Exception application'), {
      target: { value: application60 },
    })
    expect(screen.getByLabelText('Exception application')).toHaveValue(
      application60,
    )

    expect(previewBodies).toHaveLength(2)
    fireEvent.click(
      screen.getByText('View all 5000 evaluated applications'),
    )
    const evaluatedList = await screen.findByRole('list', {
      name: 'Evaluated applications',
    })
    expect(within(evaluatedList).getAllByRole('listitem')).toHaveLength(50)
    expect(previewBodies[2]).toMatchObject({
      page: {
        scope: 'evaluated',
        expectedFingerprint: 'b'.repeat(64),
      },
    })
    expect((previewBodies[2].page as { cursor?: string }).cursor).toBeUndefined()
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Next evaluated page',
      }),
    )
    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: 'Evaluated applications' }))
          .getAllByRole('listitem'),
      ).toHaveLength(50),
    )
    expect(screen.queryByRole('link', { name: 'Candidate 0001' })).not.toBeInTheDocument()
    expect(
      within(screen.getByRole('list', { name: 'Evaluated applications' }))
        .getByRole('link', { name: 'Candidate 0051' }),
    ).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Filter current evaluated page'), {
      target: { value: 'candidate60@example.com' },
    })
    await waitFor(() =>
      expect(
        within(
          screen.getByRole('list', { name: 'Evaluated applications' }),
        ).getAllByRole('listitem'),
      ).toHaveLength(1),
    )
    expect(
      within(
        screen.getByRole('list', { name: 'Evaluated applications' }),
      ).getByRole('link', { name: 'Candidate 0060' }),
    ).toBeInTheDocument()
    expect(previewBodies[3]).toMatchObject({
      page: {
        scope: 'evaluated',
        cursor: 'evaluated:50',
        expectedFingerprint: 'b'.repeat(64),
      },
    })
  }, 20_000)

  it('loads stale or unscored and known-knockout review pages directly', async () => {
    const pageScopes: string[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === `/api/workspace/jobs/${JOB_ID}/screening`) {
        return json(historyResponse())
      }
      if (url === `/api/workspace/jobs/${JOB_ID}/screening/preview`) {
        const body = JSON.parse(String(init?.body)) as {
          page?: { scope?: 'attention' | 'knockouts' }
        }
        if (body.page?.scope) {
          pageScopes.push(body.page.scope)
          return json(focusedReviewPreviewResponse(body.page.scope))
        }
        return json(previewResponse())
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<ScreeningPanel jobId={JOB_ID} jobStatus="open" />)
    await screen.findByText('No screening gate has been confirmed yet.')
    fireEvent.click(screen.getByRole('button', { name: 'Preview screening selection' }))
    await screen.findByRole('heading', { name: 'Read-only preview' })

    fireEvent.click(screen.getByText('Review 1 stale or unscored applications'))
    const attentionList = await screen.findByRole('list', {
      name: 'Stale or unscored applications',
    })
    expect(within(attentionList).getAllByRole('listitem')).toHaveLength(1)
    expect(within(attentionList).getByRole('link', { name: 'Katherine Johnson' })).toBeInTheDocument()
    expect(within(attentionList).getByText(/Unknown score/)).toBeInTheDocument()

    fireEvent.click(screen.getByText('Review 1 known knockout applications'))
    const knockoutList = await screen.findByRole('list', {
      name: 'Known knockout applications',
    })
    expect(within(knockoutList).getAllByRole('listitem')).toHaveLength(1)
    expect(within(knockoutList).getByText(/knockout: experience/)).toBeInTheDocument()
    expect(pageScopes).toEqual(['attention', 'knockouts'])
  })

  it('serializes expensive lazy review pages without aborting the active scope', async () => {
    const pageScopes: string[] = []
    let attentionSignal: AbortSignal | null = null
    let resolveAttention: ((response: Response) => void) | undefined
    const attentionResponse = new Promise<Response>((resolve) => {
      resolveAttention = resolve
    })
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === `/api/workspace/jobs/${JOB_ID}/screening`) {
        return json(historyResponse())
      }
      if (url === `/api/workspace/jobs/${JOB_ID}/screening/preview`) {
        const body = JSON.parse(String(init?.body)) as {
          page?: { scope?: 'attention' | 'knockouts' }
        }
        if (body.page?.scope) {
          pageScopes.push(body.page.scope)
          if (body.page.scope === 'attention') {
            attentionSignal = init?.signal as AbortSignal
            return attentionResponse
          }
          return json(focusedReviewPreviewResponse('knockouts'))
        }
        return json(previewResponse())
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<ScreeningPanel jobId={JOB_ID} jobStatus="open" />)
    await screen.findByText('No screening gate has been confirmed yet.')
    fireEvent.click(screen.getByRole('button', { name: 'Preview screening selection' }))
    await screen.findByRole('heading', { name: 'Read-only preview' })

    fireEvent.click(screen.getByText('Review 1 stale or unscored applications'))
    await screen.findByText('Loading attention applications…')
    const knockoutSummary = screen.getByText('Review 1 known knockout applications')
    expect(knockoutSummary).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(knockoutSummary)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Finish loading current review page before opening another.',
    )
    expect(pageScopes).toEqual(['attention'])
    expect(attentionSignal?.aborted).toBe(false)

    resolveAttention?.(json(focusedReviewPreviewResponse('attention')))
    const attentionList = await screen.findByRole('list', {
      name: 'Stale or unscored applications',
    })
    expect(within(attentionList).getByRole('link', { name: 'Katherine Johnson' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(knockoutSummary).toHaveAttribute('aria-disabled', 'false')

    fireEvent.click(knockoutSummary)
    const knockoutList = await screen.findByRole('list', {
      name: 'Known knockout applications',
    })
    expect(within(knockoutList).getByText(/knockout: experience/)).toBeInTheDocument()
    expect(pageScopes).toEqual(['attention', 'knockouts'])
  })

  it('ignores an old candidate-page response after a newer preview replaces its fingerprint', async () => {
    let previewReads = 0
    let resolveOldPage: ((response: Response) => void) | undefined
    const oldPageResponse = new Promise<Response>((resolve) => {
      resolveOldPage = resolve
    })
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === `/api/workspace/jobs/${JOB_ID}/screening`) {
        return json(historyResponse())
      }
      if (url === `/api/workspace/jobs/${JOB_ID}/screening/preview`) {
        const body = JSON.parse(String(init?.body)) as {
          page?: { scope?: string; cursor?: string }
        }
        if (body.page) return oldPageResponse
        previewReads += 1
        if (previewReads === 1) {
          return json(largePreviewResponse({ count: 100, selectedCount: 100 }))
        }
        const replacement = largePreviewResponse({ count: 100, selectedCount: 1 })
        replacement.previewFingerprint = 'c'.repeat(64)
        return json(replacement)
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<ScreeningPanel jobId={JOB_ID} jobStatus="open" />)
    await screen.findByText('No screening gate has been confirmed yet.')
    fireEvent.click(screen.getByRole('button', { name: 'Preview screening selection' }))
    await screen.findByRole('heading', { name: 'Planned selection (100)' })

    fireEvent.click(screen.getByRole('button', { name: 'Next selected page' }))
    await screen.findByRole('button', { name: 'Loading selected page…' })
    fireEvent.change(screen.getByLabelText('Top N'), { target: { value: '1' } })
    await screen.findByText('refresh required')
    resolveOldPage?.(json(largePreviewResponse({ count: 100, selectedCount: 100, offset: 50 })))
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'Candidate 0051' })).not.toBeInTheDocument()
      expect(screen.getByRole('heading', { name: 'Planned selection (100)' })).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Refresh screening preview' }))
    await screen.findByRole('heading', { name: 'Planned selection (1)' })
    expect(screen.getAllByRole('link', { name: 'Candidate 0001' }).length).toBeGreaterThan(0)
    expect(screen.queryByRole('link', { name: 'Candidate 0051' })).not.toBeInTheDocument()
    expect(screen.getByText('ready to confirm')).toBeInTheDocument()
  })

  it('renders a retryable error for screening history without preventing a later successful load', async () => {
    let reads = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url !== `/api/workspace/jobs/${JOB_ID}/screening`) throw new Error(`Unexpected request: ${url}`)
      reads += 1
      return reads === 1
        ? json({ error: 'The screening service is unavailable.' }, 503)
        : json(historyResponse([confirmedGate()]))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<ScreeningPanel jobId={JOB_ID} jobStatus="open" />)

    await screen.findByRole('alert')
    expect(screen.getByRole('alert')).toHaveTextContent('The screening service is unavailable.')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    await screen.findByText('Wave 1 · 2 planned · 0 sent')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('uses history pageInfo to replace the current bounded gate-summary page', async () => {
    const firstGate = {
      ...confirmedGate(),
      exceptionCount: 2,
      batchPageInfo: { limit: 10, hasNextPage: true, nextCursor: 'waves-2' },
    }
    const secondGate = {
      ...confirmedGate(),
      id: 'gate-2',
      confirmedByName: 'HR Two',
      batches: [],
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/workspace/jobs/${JOB_ID}/screening`) {
        return json(historyResponse(
          [firstGate],
          { limit: 10, hasNextPage: true, nextCursor: 'history-2' },
        ))
      }
      if (url === `/api/workspace/jobs/${JOB_ID}/screening?cursor=history-2`) {
        return json(historyResponse([secondGate]))
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<ScreeningPanel jobId={JOB_ID} jobStatus="open" />)

    await screen.findByText(/Confirmed by HR One/)
    expect(screen.getByText('2 documented exceptions')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'View older waves' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Load more confirmed batches' }))

    await screen.findByText(/Confirmed by HR Two/)
    expect(screen.queryByText(/Confirmed by HR One/)).not.toBeInTheDocument()
    expect(screen.getByText(
      'Durable gates and invitation-batch progress for this job only · page 2.',
    )).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Previous confirmed-batch page' }))

    await screen.findByText(/Confirmed by HR One/)
    expect(screen.queryByText(/Confirmed by HR Two/)).not.toBeInTheDocument()
    expect(screen.getByText(
      'Durable gates and invitation-batch progress for this job only · page 1.',
    )).toHaveFocus()
  })

  it('ignores an older history page after a post-retry refresh becomes authoritative', async () => {
    const failedGate = confirmedGate()
    failedGate.batches[0] = {
      ...failedGate.batches[0],
      status: 'failed',
      failedCount: 1,
      lastError: 'One invitation needs attention.',
    }
    const refreshedGate = {
      ...failedGate,
      batches: [{
        ...failedGate.batches[0],
        status: 'planned' as const,
        wave: 9,
        failedCount: 0,
        lastError: null,
      }],
    }
    const staleGate = {
      ...confirmedGate(),
      id: 'gate-stale',
      confirmedByName: 'Stale HR',
    }
    let baseReads = 0
    let resolveOlderHistory: ((response: Response) => void) | undefined
    const olderHistory = new Promise<Response>((resolve) => {
      resolveOlderHistory = resolve
    })
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/workspace/jobs/${JOB_ID}/screening`) {
        baseReads += 1
        return baseReads === 1
          ? json(historyResponse(
              [failedGate],
              { limit: 10, hasNextPage: true, nextCursor: 'history-2' },
            ))
          : json(historyResponse([refreshedGate]))
      }
      if (url === `/api/workspace/jobs/${JOB_ID}/screening?cursor=history-2`) {
        return olderHistory
      }
      if (url === `/api/workspace/jobs/${JOB_ID}/screening/batches/batch-1/retry`) {
        return json({ requeued: 1, itemIds: ['item-1'] })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<ScreeningPanel jobId={JOB_ID} jobStatus="open" />)
    await screen.findByRole('button', { name: 'Requeue 1 failed invitation' })
    fireEvent.click(screen.getByRole('button', { name: 'Load more confirmed batches' }))
    await screen.findByRole('button', { name: 'Loading more batches…' })
    fireEvent.click(screen.getByRole('button', { name: 'Requeue 1 failed invitation' }))

    await screen.findByText('Wave 9 · 2 planned · 0 sent')
    resolveOlderHistory?.(json(historyResponse([staleGate])))
    await waitFor(() => {
      expect(screen.queryByText(/Confirmed by Stale HR/)).not.toBeInTheDocument()
      expect(screen.getByText('Wave 9 · 2 planned · 0 sent')).toBeInTheDocument()
    })
    expect(baseReads).toBe(2)
  })

  it('replaces invitation-wave pages and lets recruiters return to the latest failed or scheduled waves', async () => {
    const baseGate = confirmedGate()
    const latestBatch = {
      ...baseGate.batches[0],
      id: 'batch-latest',
      wave: 12,
    }
    const olderBatch = {
      ...baseGate.batches[0],
      id: 'batch-old',
      wave: 2,
      status: 'failed' as const,
      failedCount: 1,
      lastError: 'One invitation still needs attention.',
    }
    const gate = {
      ...baseGate,
      batches: [latestBatch],
      batchPageInfo: { limit: 10, hasNextPage: true, nextCursor: 'waves-2' },
    }
    let batchReads = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/workspace/jobs/${JOB_ID}/screening`) {
        return json(historyResponse([gate]))
      }
      if (url === `/api/workspace/jobs/${JOB_ID}/screening/gates/gate-1/batches?cursor=waves-2`) {
        batchReads += 1
        return json({
          batches: [olderBatch],
          pageInfo: { limit: 10, hasNextPage: false, nextCursor: null },
        })
      }
      if (url === `/api/workspace/jobs/${JOB_ID}/screening/gates/gate-1/batches`) {
        batchReads += 1
        return json({
          batches: [latestBatch],
          pageInfo: { limit: 10, hasNextPage: true, nextCursor: 'waves-2' },
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<ScreeningPanel jobId={JOB_ID} jobStatus="open" />)
    await screen.findByText('Wave 12 · 2 planned · 0 sent')
    fireEvent.click(screen.getByRole('button', { name: 'View older waves' }))

    await screen.findByText('Wave 2 · 2 planned · 0 sent · 1 failed')
    expect(screen.queryByText('Wave 12 · 2 planned · 0 sent')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Requeue 1 failed invitation' })).toBeInTheDocument()
    expect(screen.getByText('Invitation wave page 2 · up to 10 waves shown')).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Previous wave page' }))

    await screen.findByText('Wave 12 · 2 planned · 0 sent')
    expect(screen.queryByText('Wave 2 · 2 planned · 0 sent · 1 failed')).not.toBeInTheDocument()
    expect(screen.getByText('Invitation wave page 1 · up to 10 waves shown')).toHaveFocus()
    expect(batchReads).toBe(2)
  })

  it('ignores a slow older-wave response after the parent history is refreshed', async () => {
    const baseGate = confirmedGate()
    const latestBatch = {
      ...baseGate.batches[0],
      id: 'batch-latest',
      wave: 12,
    }
    const refreshedBatch = {
      ...latestBatch,
      wave: 13,
    }
    const olderBatch = {
      ...baseGate.batches[0],
      id: 'batch-old',
      wave: 2,
    }
    const initialGate = {
      ...baseGate,
      batches: [latestBatch],
      batchPageInfo: { limit: 10, hasNextPage: true, nextCursor: 'waves-2' },
    }
    const refreshedGate = {
      ...baseGate,
      batches: [refreshedBatch],
      batchPageInfo: { limit: 10, hasNextPage: true, nextCursor: 'waves-3' },
    }
    let historyReads = 0
    let resolveOlderWaves: ((response: Response) => void) | undefined
    const olderWaves = new Promise<Response>((resolve) => {
      resolveOlderWaves = resolve
    })
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/workspace/jobs/${JOB_ID}/screening`) {
        historyReads += 1
        return json(historyResponse([
          historyReads === 1 ? initialGate : refreshedGate,
        ]))
      }
      if (url === `/api/workspace/jobs/${JOB_ID}/screening/gates/gate-1/batches?cursor=waves-2`) {
        return olderWaves
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<ScreeningPanel jobId={JOB_ID} jobStatus="open" />)
    await screen.findByText('Wave 12 · 2 planned · 0 sent')
    fireEvent.click(screen.getByRole('button', { name: 'View older waves' }))
    await screen.findByRole('button', { name: 'Loading wave page…' })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))

    await screen.findByText('Wave 13 · 2 planned · 0 sent')
    expect(screen.getByText(
      'Durable gates and invitation-batch progress for this job only · page 1.',
    )).toHaveFocus()
    resolveOlderWaves?.(json({
      batches: [olderBatch],
      pageInfo: { limit: 10, hasNextPage: false, nextCursor: null },
    }))
    await waitFor(() => {
      expect(screen.queryByText('Wave 2 · 2 planned · 0 sent')).not.toBeInTheDocument()
      expect(screen.getByText('Wave 13 · 2 planned · 0 sent')).toBeInTheDocument()
    })
    expect(historyReads).toBe(2)
  })

  it('fails closed when current candidate identity is privacy-protected or unavailable', async () => {
    const response = previewResponse()
    response.preview.page.rows[0].candidate = {
      applicationId: APPLICATION_ONE,
      candidateId: CANDIDATE_ONE,
      identityState: 'privacy_protected',
      displayName: null,
      email: null,
      applicationUrl: null,
    }
    response.preview.page.rows[1].candidate = {
      applicationId: APPLICATION_TWO,
      candidateId: CANDIDATE_TWO,
      identityState: 'unavailable',
      displayName: null,
      email: null,
      applicationUrl: null,
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/workspace/jobs/${JOB_ID}/screening`) return json(historyResponse())
      if (url === `/api/workspace/jobs/${JOB_ID}/screening/preview`) return json(response)
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<ScreeningPanel jobId={JOB_ID} jobStatus="open" />)
    await screen.findByText('No screening gate has been confirmed yet.')
    fireEvent.click(screen.getByRole('button', { name: 'Preview screening selection' }))

    await screen.findByRole('heading', { name: 'Read-only preview' })
    expect(screen.getAllByText('Candidate details unavailable').length).toBeGreaterThan(1)
    expect(screen.getAllByText(
      'Identity is hidden because privacy processing is active or complete.',
    ).length).toBeGreaterThan(0)
    expect(screen.getAllByText(
      'The current candidate record could not be loaded. Refresh before acting.',
    ).length).toBeGreaterThan(0)
    expect(screen.queryByText('Ada Lovelace')).not.toBeInTheDocument()
    expect(screen.queryByText('ada@example.com')).not.toBeInTheDocument()
  })

  it('requires an explicit confirmation before scheduling the next waterfall wave', async () => {
    let gateReads = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === `/api/workspace/jobs/${JOB_ID}/screening`) {
        gateReads += 1
        return json(historyResponse([confirmedGate()]))
      }
      if (url === `/api/workspace/jobs/${JOB_ID}/screening/gates/gate-1/waterfall`) {
        expect(init?.method).toBe('POST')
        expect(JSON.parse(String(init?.body))).toEqual({ count: 3 })
        return json({ batchId: 'batch-2', itemIds: ['item-1', 'item-2', 'item-3'], count: 3 }, 201)
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<ScreeningPanel jobId={JOB_ID} jobStatus="open" />)

    await screen.findByRole('region', { name: 'Invite next wave for gate-1' })
    const confirmButton = screen.getByRole('button', { name: 'Confirm & schedule next wave' })
    expect(confirmButton).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Next-wave size for gate-1'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Confirm next-wave schedule for gate-1' }))
    expect(confirmButton).toBeEnabled()
    fireEvent.click(confirmButton)

    await screen.findByText(
      'Scheduled the next wave for 3 candidates. Delivery is staggered from now; previous reservations remain excluded.',
    )
    expect(gateReads).toBeGreaterThanOrEqual(2)
  })

  it('loads recipient delivery lazily with retryable error and cursor pagination', async () => {
    const gate = confirmedGate()
    const failedRecipient = {
      ...gate.batches[0].recipients[0],
      status: 'failed' as const,
      deliveryStatus: 'failed' as const,
      attempts: 3,
      issue: {
        code: 'delivery_failed' as const,
        message: 'Invitation delivery failed after the available attempts.',
      },
    }
    const redactedRecipient = {
      ...gate.batches[0].recipients[1],
      id: 'item-redacted',
      applicationId: null,
      candidate: null,
      identityState: 'privacy_redacted' as const,
      status: 'skipped' as const,
      deliveryStatus: null,
      issue: {
        code: 'privacy_redacted' as const,
        message: 'Candidate identity and delivery coordinates were removed for privacy.',
      },
    }
    let recipientReads = 0
    let resolveFirstRead: ((response: Response) => void) | undefined
    const firstRead = new Promise<Response>((resolve) => {
      resolveFirstRead = resolve
    })
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/workspace/jobs/${JOB_ID}/screening`) {
        return json(historyResponse([gate]))
      }
      if (url.includes('/batches/batch-1/recipients?')) {
        recipientReads += 1
        if (recipientReads === 1) return firstRead
        if (recipientReads === 2) {
          return json({
            recipients: [failedRecipient],
            hasMore: true,
            nextCursor: 'cursor-1',
          })
        }
        if (recipientReads === 3) {
          expect(url).toContain('cursor=cursor-1')
          return json({ recipients: [redactedRecipient], hasMore: false, nextCursor: null })
        }
        expect(url).not.toContain('cursor=')
        return json({ recipients: [failedRecipient], hasMore: true, nextCursor: 'cursor-1' })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<ScreeningPanel jobId={JOB_ID} jobStatus="open" />)
    const summary = await screen.findByText('Recipient delivery details')
    fireEvent.click(summary)
    await screen.findByText('Loading recipient delivery status…')
    resolveFirstRead?.(json({ error: 'Recipient delivery is temporarily unavailable.' }, 503))

    await screen.findByRole('button', { name: 'Try loading recipients again' })
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Recipient delivery is temporarily unavailable.',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Try loading recipients again' }))

    await screen.findByText('Invitation delivery failed after the available attempts.')
    expect(screen.getByText(/3 attempts/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Ada Lovelace' })).toHaveAttribute(
      'href',
      `/workspace/applications/${APPLICATION_ONE}`,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Next recipient page' }))

    await screen.findByText(
      'Candidate identity and delivery coordinates were removed for privacy.',
    )
    expect(screen.getByText('Recipient page 2 · 1 of at most 25 rows shown')).toHaveFocus()
    expect(screen.queryByText('Invitation delivery failed after the available attempts.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Previous recipient page' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Return to first recipients' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Next recipient page' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Previous recipient page' }))

    await screen.findByText('Invitation delivery failed after the available attempts.')
    expect(screen.getByText('Recipient page 1 · 1 of at most 25 rows shown')).toHaveFocus()
    expect(screen.queryByText(
      'Candidate identity and delivery coordinates were removed for privacy.',
    )).not.toBeInTheDocument()
    expect(recipientReads).toBe(4)
  })

  it('reloads an open recipient ledger after parent history refreshes the same batch', async () => {
    const initialGate = confirmedGate()
    const failedRecipient = {
      ...initialGate.batches[0].recipients[0],
      status: 'failed' as const,
      deliveryStatus: 'failed' as const,
      attempts: 3,
      issue: {
        code: 'delivery_failed' as const,
        message: 'Invitation delivery failed before the history refresh.',
      },
    }
    const sentRecipient = {
      ...failedRecipient,
      status: 'sent' as const,
      deliveryStatus: 'sent' as const,
      attempts: 4,
      sentAt: '2026-08-13T09:05:00.000Z',
      issue: null,
    }
    const refreshedGate = {
      ...initialGate,
      batches: [{
        ...initialGate.batches[0],
        sentCount: 1,
      }],
    }
    let historyReads = 0
    let recipientReads = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/workspace/jobs/${JOB_ID}/screening`) {
        historyReads += 1
        return json(historyResponse([
          historyReads === 1 ? initialGate : refreshedGate,
        ]))
      }
      if (url.includes('/batches/batch-1/recipients?')) {
        recipientReads += 1
        return json({
          recipients: [recipientReads === 1 ? failedRecipient : sentRecipient],
          hasMore: false,
          nextCursor: null,
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<ScreeningPanel jobId={JOB_ID} jobStatus="open" />)
    fireEvent.click(await screen.findByText('Recipient delivery details'))
    await screen.findByText('Invitation delivery failed before the history refresh.')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))

    await screen.findByText('Wave 1 · 2 planned · 1 sent')
    await waitFor(() => {
      const ledger = screen.getByRole('list', { name: 'Recipient delivery status' })
      expect(within(ledger).getByText('sent')).toBeInTheDocument()
      expect(within(ledger).getByText(/4 attempts/)).toBeInTheDocument()
    })
    expect(screen.queryByText(
      'Invitation delivery failed before the history refresh.',
    )).not.toBeInTheDocument()
    expect(screen.getByText(
      'Durable gates and invitation-batch progress for this job only · page 1.',
    )).toHaveFocus()
    expect(recipientReads).toBe(2)
  })

  it('keeps the recipient DOM bounded even if a 1,000-row response is returned', async () => {
    const gate = confirmedGate()
    gate.batches[0] = {
      ...gate.batches[0],
      plannedCount: 1_000,
      recipients: [],
    }
    const template = confirmedGate().batches[0].recipients[0]
    const recipients = Array.from({ length: 1_000 }, (_, index) => {
      const position = index + 1
      const applicationId = position.toString(16).padStart(24, '0')
      const candidateId = (position + 2_000).toString(16).padStart(24, '0')
      return {
        ...template,
        id: `recipient-${position}`,
        applicationId,
        candidate: candidate(
          applicationId,
          candidateId,
          `Recipient ${String(position).padStart(4, '0')}`,
          `recipient${position}@example.com`,
        ),
      }
    })
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/workspace/jobs/${JOB_ID}/screening`) {
        return json(historyResponse([gate]))
      }
      if (url.includes('/batches/batch-1/recipients?')) {
        return json({ recipients, hasMore: false, nextCursor: null })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<ScreeningPanel jobId={JOB_ID} jobStatus="open" />)
    fireEvent.click(await screen.findByText('Recipient delivery details'))

    const recipientList = await screen.findByRole('list', {
      name: 'Recipient delivery status',
    })
    expect(within(recipientList).getAllByRole('listitem')).toHaveLength(25)
    expect(within(recipientList).getByRole('link', { name: 'Recipient 0025' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Recipient 0026' })).not.toBeInTheDocument()
    expect(screen.getByText('Recipient page 1 · 25 of at most 25 rows shown')).toBeInTheDocument()
  })

  it('exposes a recruiter-only retry for an already failed batch', async () => {
    const failedGate = confirmedGate()
    failedGate.batches[0] = {
      ...failedGate.batches[0],
      status: 'failed',
      failedCount: 1,
      lastError: 'One or more invitation deliveries need attention.',
      recipients: failedGate.batches[0].recipients.map((recipient, index) =>
        index === 0
          ? {
              ...recipient,
              status: 'failed',
              deliveryStatus: 'failed',
              attempts: 3,
              issue: {
                code: 'delivery_failed',
                message: 'Invitation delivery failed after the available attempts.',
              },
            }
          : recipient,
      ),
    }
    let gateReads = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === `/api/workspace/jobs/${JOB_ID}/screening`) {
        gateReads += 1
        return json(historyResponse([failedGate]))
      }
      if (url === `/api/workspace/jobs/${JOB_ID}/screening/batches/batch-1/retry`) {
        expect(init?.method).toBe('POST')
        expect(JSON.parse(String(init?.body))).toEqual({})
        return json({ requeued: 1, itemIds: ['item-1'] })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<ScreeningPanel jobId={JOB_ID} jobStatus="open" />)

    await screen.findByRole('button', { name: 'Requeue 1 failed invitation' })
    expect(screen.queryByText(/provider outage/i)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Requeue 1 failed invitation' }))
    const retryNotice = await screen.findByText(
      'Requeued 1 failed invitation using their existing secure delivery records.',
    )
    await waitFor(() => expect(retryNotice).toHaveFocus())
    expect(gateReads).toBeGreaterThanOrEqual(2)
  })
})
