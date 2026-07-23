import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import JobsIngestPage from '../page'
import type { JobsOperationsPayload, SourceRow, SourceWindowMetrics } from '../types'

// This suite owns the source-operations fetch contract. The governance panel
// has focused tests of its own and must not consume this suite's ordered mocks.
vi.mock('../VerdictGovernancePanel', () => ({
  VerdictGovernancePanel: () => <section aria-label="Verdict governance test boundary" />,
}))

const OPERATION_ID = '550e8400-e29b-41d4-a716-446655440000'
const NEXT_OPERATION_ID = '18f6c3ec-5d75-4e76-9f7a-122d8466f4f4'
const EMPTY_METRICS: SourceWindowMetrics = {
  fetched: 0,
  normalized: 0,
  newCount: 0,
  merged: 0,
  refreshed: 0,
  quotaSpent: 0,
  driftNulls: 0,
  storeErrors: 0,
  drops: 0,
  cycles: 0,
}

const SOURCE: SourceRow = {
  sourceId: 'jsearch',
  displayName: 'JSearch',
  kind: 'aggregator-api',
  enabled: true,
  health: 'active',
  state: 'active',
  operationalRevision: 7,
  controlRevision: 2,
  lastControl: { revision: 2, action: 'restore', at: '2026-07-20T10:00:00.000Z' },
  credential: { status: 'ready', label: 'Configured' },
  settings: {
    cadenceMinutes: 1440,
    minIndiaPostings: null,
    perRunRequestCap: 180,
    dailyRequestCap: 220,
    monthlyRequestCap: 5000,
    llmVerdictOptOut: false,
    notes: '',
  },
  limits: {
    cadenceMinutes: { min: 15, max: 10080 },
    minIndiaPostings: { min: 0, max: 100000 },
    perRunRequestCap: { min: 0, max: 180 },
    dailyRequestCap: { min: 0, max: 220 },
    monthlyRequestCap: { min: 0, max: 5000 },
  },
  postings: { open: 25, retained: 40 },
  metrics24h: { ...EMPTY_METRICS, fetched: 20, normalized: 18, newCount: 4, quotaSpent: 2 },
  metrics7d: { ...EMPTY_METRICS, fetched: 100, normalized: 94, newCount: 30, quotaSpent: 14, driftNulls: 2 },
  budget: { status: 'available', usedToday: 2, usedThisMonth: 100, dailyCap: 220, monthlyCap: 5000, percent: 2, blocked: false },
  lastSyncAt: '2026-07-22T00:00:00.000Z',
  nextSyncAt: '2026-07-23T00:00:00.000Z',
  lastValidation: {
    status: 'passed',
    at: '2026-07-21T00:00:00.000Z',
    operationalRevision: 7,
    controlRevision: 2,
  },
  lastOperation: { action: 'enable', at: '2026-07-21T00:00:00.000Z', operationId: OPERATION_ID },
  allowedActions: ['run-now', 'pause', 'update-settings', 'validate', 'revoke'],
  blockers: {},
}

function payload(overrides: Partial<JobsOperationsPayload> = {}): JobsOperationsPayload {
  return {
    bootstrap: { required: false, catalogSources: 9, configuredSources: 1, allowed: true, blockers: [], repairs: [] },
    readiness: {
      database: { status: 'ready', label: 'Database authority', detail: 'Replica-set transaction fence ready.' },
      dispatch: { status: 'ready', label: 'Worker dispatch', detail: 'Inngest credentials configured.' },
      sourceControl: { status: 'ready', label: 'Source control', detail: 'Lineage and audit rail ready.' },
    },
    summary: {
      open: 25,
      closed: 15,
      retained: 40,
      retainedWarningAt: 20000,
      retainedLimit: 25000,
      retainedHeadroom: 24960,
      retainedWarning: false,
      activeSources: 1,
      atRiskSources: 0,
      attempts24h: 2,
      new24h: 4,
    },
    sources: [SOURCE],
    audit: [],
    verdict: {
      config: { collectionEnabled: false, enforceEnabled: false, dailyVerdictCap: 900, dailyBudgetUsd: 2.5, monthlyBudgetUsd: 75 },
      backlogPending: 0,
      tombstones: 0,
      distribution: {},
      cycles: [],
    },
    ...overrides,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(OPERATION_ID)
})

describe('/cms/jobs-ingest Jobs Operations', () => {
  it('renders an honest paused bootstrap state and initializes through the audited command route', async () => {
    const empty = payload({
      bootstrap: { required: true, catalogSources: 9, configuredSources: 0, allowed: true, blockers: [], repairs: ['seed missing reviewed sources'] },
      sources: [],
    })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(empty))
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { operationId: OPERATION_ID } }))
      .mockResolvedValueOnce(jsonResponse(payload()))
    vi.stubGlobal('fetch', fetchMock)

    render(<JobsIngestPage />)
    expect(await screen.findByText('seed missing reviewed sources')).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: 'Initialize source catalog' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/does not start ingestion/i)).toBeTruthy()
    expect(within(dialog).getByText('seed missing reviewed sources')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Initialize sources' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/cms/jobs-ingest/sources',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Idempotency-Key': OPERATION_ID }),
        body: JSON.stringify({ action: 'bootstrap' }),
      }),
    ))
    expect(await screen.findByText(/bootstrap command committed/i)).toBeTruthy()
  })

  it('renders the bounded operator reason in command history', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(payload({
      audit: [{
        sourceId: 'jsearch', action: 'pause', at: '2026-07-22T01:00:00.000Z',
        actorLabel: 'Admin ••9011', outcome: 'succeeded', operationId: OPERATION_ID,
        reason: 'Maintenance window CHG-42',
      }],
    }))))

    render(<JobsIngestPage />)

    expect(await screen.findByText('Maintenance window CHG-42')).toBeTruthy()
  })

  it('shows terminal command outcome and failure code in the source row', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(payload({
      sources: [{
        ...SOURCE,
        lastOperation: {
          action: 'validate', at: '2026-07-22T01:00:00.000Z',
          completedAt: '2026-07-22T01:05:00.000Z', outcome: 'failed',
          errorCode: 'validation-failed-all-retries',
        },
      }],
    }))))

    render(<JobsIngestPage />)

    expect(await screen.findByText(/Last command: validate · failed/)).toHaveTextContent(
      /validation-failed-all-retries/,
    )
  })

  it('queues run-now with both authority revisions and never claims completion', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(payload()))
      .mockResolvedValueOnce(jsonResponse({ queued: true, result: { operationId: OPERATION_ID } }, 202))
      .mockResolvedValueOnce(jsonResponse(payload()))
    vi.stubGlobal('fetch', fetchMock)

    render(<JobsIngestPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Run now JSearch source' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Queue sync' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => url === '/api/cms/jobs-ingest/sources')
      expect(call).toBeTruthy()
      expect(JSON.parse(String(call![1].body))).toEqual({
        action: 'run-now',
        sourceId: 'jsearch',
        expectedControlRevision: 2,
        expectedOperationalRevision: 7,
      })
    })
    expect(await screen.findByText(/command queued.*Completion will appear/i)).toBeTruthy()
    expect(screen.queryByText(/sync succeeded/i)).toBeNull()
  })

  it('reuses the same idempotency key after an ambiguous service failure', async () => {
    vi.mocked(globalThis.crypto.randomUUID)
      .mockReturnValueOnce(OPERATION_ID)
      .mockReturnValueOnce(NEXT_OPERATION_ID)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(payload()))
      .mockResolvedValueOnce(jsonResponse({ error: 'dispatch unavailable', retryable: true }, 503))
      .mockResolvedValueOnce(jsonResponse({ queued: true, result: { operationId: OPERATION_ID } }, 202))
      .mockResolvedValueOnce(jsonResponse(payload()))
    vi.stubGlobal('fetch', fetchMock)

    render(<JobsIngestPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Run now JSearch source' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Queue sync' }))
    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent(/dispatch unavailable/i)
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Queue sync' }))

    await screen.findByText(/command queued/i)
    const commandCalls = fetchMock.mock.calls.filter(([url]) => url === '/api/cms/jobs-ingest/sources')
    expect(commandCalls).toHaveLength(2)
    expect(commandCalls.map(([, init]) => (init.headers as Record<string, string>)['Idempotency-Key']))
      .toEqual([OPERATION_ID, OPERATION_ID])
    expect(globalThis.crypto.randomUUID).toHaveBeenCalledTimes(1)
  })

  it('keeps blocked actions visible with their exact remediation', async () => {
    const blockedSource: SourceRow = {
      ...SOURCE,
      allowedActions: ['pause', 'update-settings', 'revoke'],
      blockers: { 'run-now': ['Redis quota enforcement is not configured.'] },
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(payload({ sources: [blockedSource] }))))

    render(<JobsIngestPage />)

    const blockedButton = await screen.findByRole('button', { name: 'Run now JSearch source' })
    expect(blockedButton).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText(/Run now blocked:/i).closest('p')).toHaveTextContent(/Redis quota enforcement is not configured/i)
  })

  it('preserves verdict distribution, incident, cost, and health telemetry', async () => {
    const base = payload()
    const withVerdicts = payload({
      verdict: {
        ...base.verdict,
        distribution: { genuine: 11, suspicious: 3, fraud: 2 },
        cycles: [{
          startedAt: '2026-07-22T01:00:00.000Z',
          finishedAt: '2026-07-22T01:05:00.000Z',
          healthTransitions: ['jsearch: active→degraded'],
          llm: {
            requested: 20,
            scored: 17,
            cacheHits: 4,
            errors: 2,
            timeouts: 1,
            softClosed: 2,
            verdictDistribution: { genuine: 11, suspicious: 3, fraud: 2 },
            reasonCodeCounts: {},
            llmFlaggedCleanRow: 1,
            llmClearedFlaggedRow: 2,
            costUsd: 0.125,
            epoch: 'verdict-v3',
            skips: { missing_jd: 3 },
          },
        }],
      },
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(withVerdicts)))

    render(<JobsIngestPage />)

    const monitor = await screen.findByRole('heading', { name: 'LLM verdict monitor' })
    const section = monitor.closest('section')!
    expect(within(section).getByText('11')).toBeTruthy()
    expect(within(section).getByText('$0.125')).toBeTruthy()
    expect(within(section).getByText(/missing_jd: 3/)).toBeTruthy()
    expect(within(section).getByText(/active→degraded/)).toBeTruthy()
    expect(within(section).getByText('verdict-v3')).toBeTruthy()
  })

  it('binds settings inputs to deploy-reviewed source ceilings', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(payload())))
    render(<JobsIngestPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Settings JSearch source' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByLabelText('Per-run request cap')).toHaveAttribute('max', '180')
    expect(within(dialog).getByLabelText('Daily request cap')).toHaveAttribute('max', '220')
    expect(within(dialog).getByLabelText('Monthly request cap')).toHaveAttribute('max', '5000')
    expect(within(dialog).getByText(/pauses the source if it is active/i)).toHaveTextContent(/Validate.*Enable explicitly/i)
    expect(within(dialog).getByRole('button', { name: 'Save settings and pause' })).toBeTruthy()
  })

  it('requires typed source identity and sends legal revoke to the legal authority route', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(payload()))
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { affectedPostings: 40 } }))
      .mockResolvedValueOnce(jsonResponse(payload()))
    vi.stubGlobal('fetch', fetchMock)
    render(<JobsIngestPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Revoke JSearch source' }))
    const dialog = screen.getByRole('dialog')
    const submit = within(dialog).getByRole('button', { name: 'Revoke source' })
    expect(submit).toBeDisabled()
    fireEvent.change(within(dialog).getByLabelText('Case reference or operational reason'), { target: { value: 'Legal case LEG-1042' } })
    fireEvent.change(within(dialog).getByLabelText('Type jsearch to confirm'), { target: { value: 'jsearch' } })
    fireEvent.click(submit)

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => url === '/api/jobs/admin/source-control')
      expect(JSON.parse(String(call![1].body))).toEqual({
        sourceId: 'jsearch',
        action: 'revoke',
        expectedRevision: 2,
        reason: 'Legal case LEG-1042',
      })
    })
  })

  it('lets keyboard users dismiss a revoke confirmation with Escape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(payload())))
    render(<JobsIngestPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Revoke JSearch source' }))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })

    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('closes a stale dialog and sends refreshed revisions from the next command', async () => {
    const refreshed = payload({ sources: [{ ...SOURCE, operationalRevision: 8 }] })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(payload()))
      .mockResolvedValueOnce(jsonResponse({ error: 'stale source revision', currentOperationalRevision: 8 }, 409))
      .mockResolvedValueOnce(jsonResponse(refreshed))
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { operationId: NEXT_OPERATION_ID } }))
      .mockResolvedValueOnce(jsonResponse(refreshed))
    vi.stubGlobal('fetch', fetchMock)
    render(<JobsIngestPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Pause JSearch source' }))
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('Case reference or operational reason'), { target: { value: 'Maintenance window' } })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Pause source' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/state has been refreshed/i)
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Pause JSearch source' }))
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('Case reference or operational reason'), { target: { value: 'Retry after review' } })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Pause source' }))

    await screen.findByText(/pause command committed/i)
    const commandBodies = fetchMock.mock.calls
      .filter(([url]) => url === '/api/cms/jobs-ingest/sources')
      .map(([, init]) => JSON.parse(String(init.body)))
    expect(commandBodies.map((body) => body.expectedOperationalRevision)).toEqual([7, 8])
  })
})
