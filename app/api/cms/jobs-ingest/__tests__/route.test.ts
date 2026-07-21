import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockCountDocuments,
  mockCycleFind,
  mockGetConfig,
  mockGetControlPlane,
  mockLegalAuditFind,
  mockPostingAggregate,
  mockRequireCurrentPlatformAdmin,
} = vi.hoisted(() => ({
  mockCountDocuments: vi.fn(),
  mockCycleFind: vi.fn(),
  mockGetConfig: vi.fn(),
  mockGetControlPlane: vi.fn(),
  mockLegalAuditFind: vi.fn(),
  mockPostingAggregate: vi.fn(),
  mockRequireCurrentPlatformAdmin: vi.fn(),
}))

vi.mock('@jobs/services/adminAuth', () => ({
  requireCurrentPlatformAdmin: (...args: unknown[]) => mockRequireCurrentPlatformAdmin(...args),
}))
vi.mock('@jobs/services/sourceOperations', () => ({
  getJobSourceControlPlane: (...args: unknown[]) => mockGetControlPlane(...args),
}))
vi.mock('@shared/db/models', () => ({
  JobIngestCycle: { find: (...args: unknown[]) => mockCycleFind(...args) },
  JobPosting: {
    aggregate: (...args: unknown[]) => mockPostingAggregate(...args),
    countDocuments: (...args: unknown[]) => mockCountDocuments(...args),
  },
  JobSourceControlAudit: { find: (...args: unknown[]) => mockLegalAuditFind(...args) },
  JobsVerdictConfig: { getConfig: (...args: unknown[]) => mockGetConfig(...args) },
}))

import { GET } from '../route'

const EMPTY_METRICS = {
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

function sortedRows(rows: unknown[]) {
  return {
    sort: vi.fn().mockReturnValue({
      limit: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(rows) }),
      }),
    }),
  }
}

function controlPlane(quotaAvailable = true) {
  return {
    bootstrap: { required: false, allowed: true, blockers: [], repairs: [], catalogSources: 9, configuredSources: 1 },
    readiness: {
      transactionCapable: true,
      sourceControlReady: true,
      inngestCredentialsConfigured: true,
      redisReachable: quotaAvailable,
    },
    sources: [{
      sourceId: 'jsearch',
      definition: {
        sourceId: 'jsearch',
        displayName: 'JSearch',
        kind: 'aggregator-api',
        cadenceMinutes: 1440,
        requestBudget: { perRunRequestCap: 180, dailyRequestCap: 220, monthlyRequestCap: 5000 },
      },
      config: {
        kind: 'aggregator-api',
        displayName: 'JSearch',
        enabled: true,
        health: 'active',
        controlRevision: 2,
        operationalRevision: 7,
        cadenceMinutes: 1440,
        requestBudget: { perRunRequestCap: 180, dailyRequestCap: 220, monthlyRequestCap: 5000 },
        llmVerdictOptOut: false,
        lastSyncAt: new Date('2026-07-22T00:00:00.000Z'),
      },
      credential: {
        status: 'verified',
        configurationStatus: 'configured',
        lastValidationStatus: 'healthy',
        requiredEnv: 'RAPIDAPI_KEY',
      },
      supply: { open: 25, retained: 40 },
      metrics24h: { ...EMPTY_METRICS, fetched: 20, normalized: 18, newCount: 4, quotaSpent: 2, cycles: 96 },
      metrics7d: { ...EMPTY_METRICS, fetched: 100, normalized: 94, newCount: 30, quotaSpent: 14, cycles: 672 },
      cycles: [],
      quota: {
        available: quotaAvailable,
        usedToday: quotaAvailable ? 9 : null,
        usedThisMonth: quotaAvailable ? 101 : null,
      },
      lastOperation: null,
    }],
    audit: [],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireCurrentPlatformAdmin.mockResolvedValue({
    ok: true,
    actorUserId: '507f1f77bcf86cd799439011',
  })
  mockGetControlPlane.mockResolvedValue(controlPlane())
  mockPostingAggregate
    .mockResolvedValueOnce([{ _id: 'open', n: 25 }, { _id: 'closed', n: 15 }])
    .mockResolvedValueOnce([])
  mockCountDocuments.mockImplementation((filter: Record<string, unknown>) => {
    if (Object.keys(filter).length === 0) return Promise.resolve(40)
    return Promise.resolve(0)
  })
  mockCycleFind.mockReturnValue(sortedRows([]))
  mockLegalAuditFind.mockReturnValue(sortedRows([]))
  mockGetConfig.mockResolvedValue({
    collectionEnabled: false,
    enforceEnabled: false,
    dailyVerdictCap: 900,
    dailyBudgetUsd: 2.5,
    monthlyBudgetUsd: 75,
  })
})

describe('GET /api/cms/jobs-ingest', () => {
  it('uses exact backend aggregates rather than truncating telemetry to recent cycle rows', async () => {
    const response = await GET()
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload.sources[0].metrics24h).toMatchObject({ cycles: 96, newCount: 4, quotaSpent: 2 })
    expect(payload.sources[0].metrics7d).toMatchObject({ cycles: 672, newCount: 30, quotaSpent: 14 })
    expect(payload.summary).toMatchObject({ attempts24h: 2, new24h: 4 })
  })

  it('reports exact retained headroom and the warning threshold', async () => {
    mockCountDocuments.mockImplementation((filter: Record<string, unknown>) => (
      Promise.resolve(Object.keys(filter).length === 0 ? 20_000 : 0)
    ))

    const response = await GET()
    const payload = await response.json()

    expect(payload.summary).toMatchObject({
      retained: 20_000,
      retainedWarningAt: 20_000,
      retainedLimit: 25_000,
      retainedHeadroom: 5_000,
      retainedWarning: true,
    })
  })

  it('keeps unavailable Redis usage unknown and blocks dispatch without claiming exhaustion', async () => {
    mockGetControlPlane.mockResolvedValue(controlPlane(false))

    const response = await GET()
    const payload = await response.json()
    const source = payload.sources[0]

    expect(source.budget).toMatchObject({
      status: 'unavailable',
      usedToday: null,
      usedThisMonth: null,
      percent: null,
      blocked: true,
    })
    expect(source.blockers['run-now']).toContain('Shared request-meter usage is unavailable.')
    expect(source.blockers['run-now'].join(' ')).not.toMatch(/exhausted/i)
    expect(payload.readiness.sourceControl).toMatchObject({ status: 'blocked' })
  })

  it('allows revalidation after rotation despite a historical credential rejection', async () => {
    const plane = controlPlane()
    plane.sources[0] = {
      ...plane.sources[0],
      config: {
        ...plane.sources[0].config,
        enabled: false,
        health: 'quarantined',
        lastValidation: {
          status: 'failed',
          credentialStatus: 'rejected',
          controlRevision: 2,
          operationalRevision: 7,
          checkedAt: new Date('2026-07-21T00:00:00.000Z'),
        },
      },
      credential: {
        status: 'rejected',
        configurationStatus: 'configured',
        lastValidationStatus: 'rejected',
        requiredEnv: 'RAPIDAPI_KEY',
      },
    }
    mockGetControlPlane.mockResolvedValue(plane)

    const response = await GET()
    const payload = await response.json()
    const source = payload.sources[0]

    expect(source.credential).toMatchObject({
      status: 'configured-rejected',
      label: 'Configured; last validation rejected',
    })
    expect(source.allowedActions).toContain('validate')
    expect(source.blockers.validate).toBeUndefined()
    expect(source.blockers.enable).toContain('A current successful validation is required.')
  })

  it('does not leave a terminal failed validation in the validating state', async () => {
    const plane = controlPlane()
    plane.sources[0] = {
      ...plane.sources[0],
      config: { ...plane.sources[0].config, enabled: false },
      lastOperation: {
        operationId: 'validate-failed-1',
        action: 'validate',
        dispatchedAt: new Date('2026-07-22T01:00:00.000Z'),
        occurredAt: new Date('2026-07-22T01:00:00.000Z'),
        outcome: 'failed',
        errorCode: 'validation-failed-all-retries',
        completedAt: new Date('2026-07-22T01:05:00.000Z'),
      },
    }
    mockGetControlPlane.mockResolvedValue(plane)

    const response = await GET()
    const source = (await response.json()).sources[0]

    expect(source.state).toBe('paused')
    expect(source.lastValidation).toBeNull()
    expect(source.lastOperation).toMatchObject({ outcome: 'failed' })
    expect(source.lastOperation).toMatchObject({
      errorCode: 'validation-failed-all-retries',
      completedAt: '2026-07-22T01:05:00.000Z',
    })
  })

  it('blocks Validate when only this source quota counter is unavailable', async () => {
    const plane = controlPlane()
    plane.sources[0] = {
      ...plane.sources[0],
      config: { ...plane.sources[0].config, enabled: false },
      quota: { available: false, usedToday: null, usedThisMonth: null },
    }
    mockGetControlPlane.mockResolvedValue(plane)

    const response = await GET()
    const source = (await response.json()).sources[0]

    expect(source.allowedActions).not.toContain('validate')
    expect(source.blockers.validate).toContain('Shared request-meter usage is unavailable.')
  })

  it('keeps legal revoke but blocks doomed operational actions on catalog-policy drift', async () => {
    const plane = controlPlane()
    plane.sources[0] = {
      ...plane.sources[0],
      config: { ...plane.sources[0].config, operationalPolicyReady: false },
    }
    mockGetControlPlane.mockResolvedValue(plane)

    const response = await GET()
    const source = (await response.json()).sources[0]

    expect(source.allowedActions).toEqual(['revoke'])
    expect(source.blockers['update-settings']).toContain(
      'Bootstrap must repair this source catalog identity or policy before operational actions.',
    )
    expect(source.blockers.pause).toBeDefined()
    expect(source.blockers['run-now']).toBeDefined()
  })

  it('labels validation evidence from an older revision as stale, never passed', async () => {
    const plane = controlPlane()
    plane.sources[0] = {
      ...plane.sources[0],
      config: {
        ...plane.sources[0].config,
        enabled: false,
        lastValidation: {
          status: 'healthy', credentialStatus: 'configured', controlRevision: 2,
          operationalRevision: 6, checkedAt: new Date('2026-07-21T00:00:00.000Z'),
        },
      },
      credential: {
        ...plane.sources[0].credential,
        lastValidationStatus: 'stale',
      },
    }
    mockGetControlPlane.mockResolvedValue(plane)

    const response = await GET()
    const source = (await response.json()).sources[0]

    expect(source.lastValidation).toMatchObject({ status: 'stale' })
    expect(source.credential.label).toMatch(/stale/i)
  })

  it('returns sanitized operation reason and terminal outcome in audit history', async () => {
    const plane = controlPlane()
    plane.audit = [{
      sourceId: 'jsearch', operationId: 'pause-1', action: 'pause',
      actorLabel: 'Admin ••9011', reason: ' Maintenance\u0000 window ',
      outcome: 'succeeded', completedAt: new Date('2026-07-22T01:01:00.000Z'),
      occurredAt: new Date('2026-07-22T01:00:00.000Z'),
    }]
    mockGetControlPlane.mockResolvedValue(plane)

    const response = await GET()
    const audit = (await response.json()).audit[0]

    expect(audit).toMatchObject({ reason: 'Maintenance window', outcome: 'succeeded' })
  })

  it('fails closed when the current database role no longer authorizes the reader', async () => {
    mockRequireCurrentPlatformAdmin.mockResolvedValue({
      ok: false,
      status: 403,
      code: 'ADMIN_REQUIRED',
      error: 'platform_admin required',
    })

    const response = await GET()

    expect(response.status).toBe(403)
    expect(mockGetControlPlane).not.toHaveBeenCalled()
  })
})
