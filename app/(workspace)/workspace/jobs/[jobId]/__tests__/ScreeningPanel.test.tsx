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
      cutLine: {
        mode: 'top_n',
        requestedTopN: 2,
        applicationId: APPLICATION_TWO,
        rank: 2,
        score: 81,
      },
      rankedApplications: [
        {
          applicationId: APPLICATION_ONE,
          candidateId: CANDIDATE_ONE,
          applicationCreatedAt: '2026-08-10T10:00:00.000Z',
          rank: 1,
          score: 91,
          scoreState: 'scored',
          knockoutReasons: [],
          automaticallySelected: true,
          selected: true,
          selectionReason: 'top_n',
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
          scoreState: 'scored',
          knockoutReasons: [],
          automaticallySelected: true,
          selected: true,
          selectionReason: 'top_n',
          candidate: candidate(
            APPLICATION_TWO,
            CANDIDATE_TWO,
            'Grace Hopper',
            'grace@example.com',
          ),
        },
        {
          applicationId: APPLICATION_THREE,
          candidateId: CANDIDATE_THREE,
          applicationCreatedAt: '2026-08-12T10:00:00.000Z',
          rank: null,
          score: null,
          scoreState: 'unscored',
          knockoutReasons: ['experience'],
          automaticallySelected: false,
          selected: false,
          selectionReason: 'knockout',
          candidate: candidate(
            APPLICATION_THREE,
            CANDIDATE_THREE,
            'Katherine Johnson',
            'katherine@example.com',
          ),
        },
      ],
      exceptions,
      selectedApplicationIds: [APPLICATION_ONE, APPLICATION_TWO],
    },
    requirementVersion: {
      id: 'dddddddddddddddddddddddd',
      version: 3,
      contentHash: 'a'.repeat(64),
    },
    previewFingerprint: 'b'.repeat(64),
  }
}

function largePreviewResponse(count = 5_000, selectedCount = 5_000) {
  const response = previewResponse()
  const rankedApplications = Array.from({ length: count }, (_, index) => {
    const position = index + 1
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
        `Candidate ${String(position).padStart(3, '0')}`,
        `candidate${position}@example.com`,
      ),
    }
  })
  return {
    ...response,
    preview: {
      ...response.preview,
      rule: { mode: 'top_n' as const, topN: selectedCount, knockoutSettings: {} },
      evaluatedCount: count,
      eligibleCount: count,
      automaticallySelectedCount: selectedCount,
      selectedCount,
      cutLine: {
        mode: 'top_n' as const,
        requestedTopN: selectedCount,
        applicationId: rankedApplications[selectedCount - 1]?.applicationId,
        rank: selectedCount,
        score: rankedApplications[selectedCount - 1]?.score ?? null,
      },
      rankedApplications,
      selectedApplicationIds: rankedApplications
        .filter((entry) => entry.selected)
        .map((entry) => entry.applicationId),
    },
  }
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
    rankedApplications: [],
    exceptions: [],
    confirmedByName: 'HR One',
    confirmedAt: '2026-08-12T10:05:00.000Z',
    cancelledAt: null,
    cancelNote: null,
    createdAt: '2026-08-12T10:05:00.000Z',
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
  it('previews a deterministic cut line and only schedules staggered delivery after explicit confirmation', async () => {
    let gateReads = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === `/api/workspace/jobs/${JOB_ID}/screening`) {
        gateReads += 1
        return json({ gates: gateReads === 1 ? [] : [confirmedGate()] })
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
    expect(screen.getByText('Unknown / unscored')).toBeInTheDocument()
    expect(screen.getByText('Known knockouts')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Planned selection (2)' })).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/confirm'))).toBe(false)

    fireEvent.change(screen.getByLabelText('Planned send time'), {
      target: { value: '2026-08-13T09:00' },
    })
    fireEvent.click(screen.getByRole('checkbox', { name: /I reviewed the deterministic cut line/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & schedule 2 candidates' }))

    await screen.findByText(
      'Created a scheduled batch for 2 candidates. Staggered invitations begin at the planned time; no candidate was rejected or moved.',
    )
    await screen.findByText('Wave 1 · 2 planned · 0 sent')
    expect(screen.getByText('planned')).toBeInTheDocument()
    expect(screen.getByText('Recipient delivery details')).toBeInTheDocument()
  })

  it('requires a note for include/exclude overrides and refreshes the preview with the documented exception', async () => {
    const previewBodies: unknown[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === `/api/workspace/jobs/${JOB_ID}/screening`) return json({ gates: [] })
      if (url === `/api/workspace/jobs/${JOB_ID}/screening/preview`) {
        previewBodies.push(JSON.parse(String(init?.body)))
        return json(previewResponse())
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<ScreeningPanel jobId={JOB_ID} />)
    await screen.findByText('No screening gate has been confirmed yet.')
    fireEvent.click(screen.getByRole('button', { name: 'Preview screening selection' }))
    await screen.findByRole('heading', { name: 'Read-only preview' })

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

  it('searches and progressively renders a large preview without mounting every rich row or exception option', async () => {
    const response = largePreviewResponse()
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/workspace/jobs/${JOB_ID}/screening`) {
        return json({ gates: [] })
      }
      if (url === `/api/workspace/jobs/${JOB_ID}/screening/preview`) {
        return json(response)
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<ScreeningPanel jobId={JOB_ID} />)
    await screen.findByText('No screening gate has been confirmed yet.')
    fireEvent.click(
      screen.getByRole('button', { name: 'Preview screening selection' }),
    )

    await screen.findByRole('heading', { name: 'Planned selection (5000)' })
    const selectedList = screen.getByRole('list', {
      name: 'Planned selected applications',
    })
    expect(within(selectedList).getAllByRole('listitem')).toHaveLength(50)
    expect(
      screen.queryByRole('link', { name: 'Candidate 060' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('list', { name: 'Evaluated applications' }),
    ).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Search planned selection'), {
      target: { value: 'Candidate 060' },
    })
    expect(
      await screen.findByRole('link', { name: 'Candidate 060' }),
    ).toBeInTheDocument()
    expect(
      within(
        screen.getByRole('list', { name: 'Planned selected applications' }),
      ).getAllByRole('listitem'),
    ).toHaveLength(1)

    fireEvent.change(screen.getByLabelText('Search planned selection'), {
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
        name: 'Show next 50 selected applications',
      }),
    )
    expect(
      within(
        screen.getByRole('list', { name: 'Planned selected applications' }),
      ).getAllByRole('listitem'),
    ).toHaveLength(100)

    const exceptionSelect = screen.getByLabelText('Exception application')
    expect(within(exceptionSelect).getAllByRole('option')).toHaveLength(51)
    fireEvent.change(screen.getByLabelText('Search exception applications'), {
      target: { value: 'Candidate 5000' },
    })
    await waitFor(() =>
      expect(
        within(screen.getByLabelText('Exception application')).getAllByRole(
          'option',
        ),
      ).toHaveLength(2),
    )
    const application5000 = response.preview.rankedApplications[4_999].applicationId
    fireEvent.change(screen.getByLabelText('Exception application'), {
      target: { value: application5000 },
    })
    expect(screen.getByLabelText('Exception application')).toHaveValue(
      application5000,
    )

    fireEvent.click(
      screen.getByText('View all 5000 evaluated applications'),
    )
    const evaluatedList = await screen.findByRole('list', {
      name: 'Evaluated applications',
    })
    expect(within(evaluatedList).getAllByRole('listitem')).toHaveLength(50)
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Show next 50 evaluated applications',
      }),
    )
    expect(
      within(
        screen.getByRole('list', { name: 'Evaluated applications' }),
      ).getAllByRole('listitem'),
    ).toHaveLength(100)
    fireEvent.change(screen.getByLabelText('Search evaluated applications'), {
      target: { value: 'candidate5000@example.com' },
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
      ).getByRole('link', { name: 'Candidate 5000' }),
    ).toBeInTheDocument()
  })

  it('renders a retryable error for screening history without preventing a later successful load', async () => {
    let reads = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url !== `/api/workspace/jobs/${JOB_ID}/screening`) throw new Error(`Unexpected request: ${url}`)
      reads += 1
      return reads === 1
        ? json({ error: 'The screening service is unavailable.' }, 503)
        : json({ gates: [confirmedGate()] })
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<ScreeningPanel jobId={JOB_ID} />)

    await screen.findByRole('alert')
    expect(screen.getByRole('alert')).toHaveTextContent('The screening service is unavailable.')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    await screen.findByText('Wave 1 · 2 planned · 0 sent')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('fails closed when current candidate identity is privacy-protected or unavailable', async () => {
    const response = previewResponse()
    response.preview.rankedApplications[0].candidate = {
      applicationId: APPLICATION_ONE,
      candidateId: CANDIDATE_ONE,
      identityState: 'privacy_protected',
      displayName: null,
      email: null,
      applicationUrl: null,
    }
    response.preview.rankedApplications[1].candidate = {
      applicationId: APPLICATION_TWO,
      candidateId: CANDIDATE_TWO,
      identityState: 'unavailable',
      displayName: null,
      email: null,
      applicationUrl: null,
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/workspace/jobs/${JOB_ID}/screening`) return json({ gates: [] })
      if (url === `/api/workspace/jobs/${JOB_ID}/screening/preview`) return json(response)
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<ScreeningPanel jobId={JOB_ID} />)
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
        return json({ gates: [confirmedGate()] })
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
        return json({ gates: [gate] })
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
        expect(url).toContain('cursor=cursor-1')
        return json({ recipients: [redactedRecipient], hasMore: false, nextCursor: null })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<ScreeningPanel jobId={JOB_ID} />)
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
    fireEvent.click(screen.getByRole('button', { name: 'Load more recipients' }))

    await screen.findByText(
      'Candidate identity and delivery coordinates were removed for privacy.',
    )
    expect(screen.queryByRole('button', { name: 'Load more recipients' })).not.toBeInTheDocument()
    expect(recipientReads).toBe(3)
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
        return json({ gates: [failedGate] })
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
    await screen.findByText('Requeued 1 failed invitation using their existing secure delivery records.')
    expect(gateReads).toBeGreaterThanOrEqual(2)
  })
})
