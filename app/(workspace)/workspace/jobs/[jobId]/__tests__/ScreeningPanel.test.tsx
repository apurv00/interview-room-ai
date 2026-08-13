import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ScreeningPanel from '../ScreeningPanel'

const JOB_ID = 'job-1'
const APPLICATION_ONE = 'aaaaaaaaaaaaaaaaaaaaaaaa'
const APPLICATION_TWO = 'bbbbbbbbbbbbbbbbbbbbbbbb'
const APPLICATION_THREE = 'cccccccccccccccccccccccc'

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
          candidateId: '111111111111111111111111',
          applicationCreatedAt: '2026-08-10T10:00:00.000Z',
          rank: 1,
          score: 91,
          scoreState: 'scored',
          knockoutReasons: [],
          automaticallySelected: true,
          selected: true,
          selectionReason: 'top_n',
        },
        {
          applicationId: APPLICATION_TWO,
          candidateId: '222222222222222222222222',
          applicationCreatedAt: '2026-08-11T10:00:00.000Z',
          rank: 2,
          score: 81,
          scoreState: 'scored',
          knockoutReasons: [],
          automaticallySelected: true,
          selected: true,
          selectionReason: 'top_n',
        },
        {
          applicationId: APPLICATION_THREE,
          candidateId: '333333333333333333333333',
          applicationCreatedAt: '2026-08-12T10:00:00.000Z',
          rank: null,
          score: null,
          scoreState: 'unscored',
          knockoutReasons: ['experience'],
          automaticallySelected: false,
          selected: false,
          selectionReason: 'knockout',
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

  it('exposes a recruiter-only retry for an already failed batch', async () => {
    const failedGate = confirmedGate()
    failedGate.batches[0] = {
      ...failedGate.batches[0],
      status: 'failed',
      failedCount: 1,
      lastError: 'Temporary provider outage',
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
    fireEvent.click(screen.getByRole('button', { name: 'Requeue 1 failed invitation' }))
    await screen.findByText('Requeued 1 failed invitation using their existing secure delivery records.')
    expect(gateReads).toBeGreaterThanOrEqual(2)
  })
})
