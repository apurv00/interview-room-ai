import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  MockConfigConflictError,
  MockConfigMigrationRequiredError,
  MockConfigRepairRequiredError,
  MockConfigTransactionsRequiredError,
  MockQualityConflictError,
  mockAuditFind,
  mockCheckJobsRateLimit,
  mockFenceQualityDecisionSources,
  mockGetAutomaticQualityDecision,
  mockGetConfig,
  mockGetQualityDecisionReviewHistory,
  mockListQualityDecisionPage,
  mockQualityReviewRoot,
  mockReviewQualityDecision,
  mockReviewQualityDecisionInSession,
  mockWithQualityDecisionTransaction,
  mockPostingFindById,
  mockPostingFind,
  mockPostingUpdateOne,
  mockRequireCurrentPlatformAdmin,
  mockRollbackConfig,
  mockUpdateConfig,
} = vi.hoisted(() => {
  class TestConfigConflictError extends Error {
    constructor(message: string, public readonly currentRevision?: number) {
      super(message)
      this.name = 'JobsVerdictConfigConflictError'
    }
  }
  class TestConfigMigrationRequiredError extends Error {
    constructor() {
      super('multiple legacy verdict config rows require consolidation before governed changes')
      this.name = 'JobsVerdictConfigMigrationRequiredError'
    }
  }
  class TestConfigRepairRequiredError extends Error {
    constructor(message = 'stored verdict config requires repair: dailyBudgetUsd must be a finite number from 0 to 100') {
      super(message)
      this.name = 'JobsVerdictConfigRepairRequiredError'
    }
  }
  class TestConfigTransactionsRequiredError extends Error {
    constructor() {
      super('verdict config control requires MongoDB replica-set transactions')
      this.name = 'JobsVerdictConfigTransactionsRequiredError'
    }
  }
  class TestQualityConflictError extends Error {}
  return {
    MockConfigConflictError: TestConfigConflictError,
    MockConfigMigrationRequiredError: TestConfigMigrationRequiredError,
    MockConfigRepairRequiredError: TestConfigRepairRequiredError,
    MockConfigTransactionsRequiredError: TestConfigTransactionsRequiredError,
    MockQualityConflictError: TestQualityConflictError,
    mockAuditFind: vi.fn(),
    mockCheckJobsRateLimit: vi.fn(),
    mockFenceQualityDecisionSources: vi.fn(),
    mockGetAutomaticQualityDecision: vi.fn(),
    mockGetConfig: vi.fn(),
    mockGetQualityDecisionReviewHistory: vi.fn(),
    mockListQualityDecisionPage: vi.fn(),
    mockQualityReviewRoot: vi.fn(),
    mockReviewQualityDecision: vi.fn(),
    mockReviewQualityDecisionInSession: vi.fn(),
    mockWithQualityDecisionTransaction: vi.fn(),
    mockPostingFindById: vi.fn(),
    mockPostingFind: vi.fn(),
    mockPostingUpdateOne: vi.fn(),
    mockRequireCurrentPlatformAdmin: vi.fn(),
    mockRollbackConfig: vi.fn(),
    mockUpdateConfig: vi.fn(),
  }
})

vi.mock('@shared/db/models', () => ({
  JOB_SOURCE_LINEAGE_UNKNOWN: '__legacy_unknown__',
  JobPosting: { find: mockPostingFind, findById: mockPostingFindById, updateOne: mockPostingUpdateOne },
  JobsVerdictConfigAudit: { find: (...args: unknown[]) => mockAuditFind(...args) },
}))

vi.mock('@jobs/services/adminAuth', () => ({
  requireCurrentPlatformAdmin: (...args: unknown[]) => mockRequireCurrentPlatformAdmin(...args),
}))

vi.mock('@jobs/services/rateLimit', () => ({
  checkJobsRateLimit: (...args: unknown[]) => mockCheckJobsRateLimit(...args),
}))

vi.mock('@jobs/services/verdictConfigControl', () => {
  class TestValidationError extends Error {}
  class TestRevisionNotFoundError extends Error {}
  return {
    getJobsVerdictConfigSnapshot: (...args: unknown[]) => mockGetConfig(...args),
    updateJobsVerdictConfig: (...args: unknown[]) => mockUpdateConfig(...args),
    rollbackJobsVerdictConfig: (...args: unknown[]) => mockRollbackConfig(...args),
    JobsVerdictConfigValidationError: TestValidationError,
    JobsVerdictConfigConflictError: MockConfigConflictError,
    JobsVerdictConfigRevisionNotFoundError: TestRevisionNotFoundError,
    JobsVerdictConfigMigrationRequiredError: MockConfigMigrationRequiredError,
    JobsVerdictConfigRepairRequiredError: MockConfigRepairRequiredError,
    JobsVerdictConfigTransactionsRequiredError: MockConfigTransactionsRequiredError,
  }
})

vi.mock('@jobs/services/qualityDecisionService', () => {
  class TestQualityValidationError extends Error {}
  class TestQualityNotFoundError extends Error {}
  class TestQualityTransactionsRequiredError extends Error {}
  return {
    fenceQualityDecisionSources: (...args: unknown[]) => mockFenceQualityDecisionSources(...args),
    getAutomaticQualityDecision: (...args: unknown[]) => mockGetAutomaticQualityDecision(...args),
    getQualityDecisionReviewHistory: (...args: unknown[]) => mockGetQualityDecisionReviewHistory(...args),
    listQualityDecisionPage: (...args: unknown[]) => mockListQualityDecisionPage(...args),
    reviewQualityDecision: (...args: unknown[]) => mockReviewQualityDecision(...args),
    reviewQualityDecisionInSession: (...args: unknown[]) => mockReviewQualityDecisionInSession(...args),
    withQualityDecisionTransaction: (...args: unknown[]) => mockWithQualityDecisionTransaction(...args),
    QualityDecisionValidationError: TestQualityValidationError,
    QualityDecisionConflictError: MockQualityConflictError,
    QualityDecisionNotFoundError: TestQualityNotFoundError,
    QualityDecisionTransactionsRequiredError: TestQualityTransactionsRequiredError,
  }
})

import { GET, POST } from '../route'

const URL = 'http://localhost/api/cms/jobs-ingest/verdict-governance'
const ACTOR_ID = '507f1f77bcf86cd799439011'
const OPERATION_ID = '550e8400-e29b-41d4-a716-446655440000'
const CONFIG = {
  collectionEnabled: true,
  enforceEnabled: false,
  rankingEnabled: false as const,
  dailyVerdictCap: 900,
  dailyBudgetUsd: 2.5,
  monthlyBudgetUsd: 75,
  perCompanyDailyCap: 25,
  perSourceDailyCap: 500,
  inputUsdPerMTok: 0.5,
  outputUsdPerMTok: 2,
  notes: 'Reviewed shadow cohort',
}
const UPDATE_BODY = {
  action: 'update-config' as const,
  expectedRevision: 3,
  config: CONFIG,
  reason: 'Enable reviewed shadow mode',
}

function postRequest(body: unknown = UPDATE_BODY, operationId: string | null = OPERATION_ID): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (operationId !== null) headers['idempotency-key'] = operationId
  return new Request(URL, { method: 'POST', headers, body: JSON.stringify(body) })
}

function rawPostRequest(body: string): Request {
  return new Request(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': OPERATION_ID },
    body,
  })
}

function auditRows(rows: unknown[]) {
  return {
    sort: vi.fn().mockReturnValue({
      limit: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(rows) }),
    }),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCheckJobsRateLimit.mockResolvedValue(null)
  mockRequireCurrentPlatformAdmin.mockImplementation(async (
    options?: { beforeAuthorityLookup?: (actorUserId: string) => Promise<Response | null> },
  ) => {
    const blocked = await options?.beforeAuthorityLookup?.(ACTOR_ID)
    if (blocked) {
      return { ok: false, status: blocked.status, error: 'request blocked', response: blocked }
    }
    return { ok: true, actorUserId: ACTOR_ID }
  })
  mockGetConfig.mockResolvedValue({ ...CONFIG, revision: 3 })
  mockAuditFind.mockReturnValue(auditRows([]))
  mockGetAutomaticQualityDecision.mockResolvedValue(null)
  mockGetQualityDecisionReviewHistory.mockResolvedValue([])
  mockListQualityDecisionPage.mockResolvedValue({ items: [] })
  mockPostingFind.mockReturnValue({ lean: () => Promise.resolve([]) })
  mockFenceQualityDecisionSources.mockResolvedValue(undefined)
  mockPostingFindById.mockReturnValue({
    select: () => ({
      lean: () => Promise.resolve({
        status: 'closed',
        closedReason: 'llm-verdict',
        llmVerdict: { status: 'scored', verdictInputHash: 'a'.repeat(64), epoch: 'model:prompt-v1' },
        sourceIds: ['jsearch'],
        provenance: [],
        lastSeenAt: new Date(),
        updatedAt: new Date('2026-07-23T00:00:00.000Z'),
      }),
    }),
  })
  mockPostingUpdateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 })
  mockWithQualityDecisionTransaction.mockImplementation(async (work: (session: unknown) => Promise<unknown>) => work({ id: 'quality-session' }))
  mockReviewQualityDecisionInSession.mockImplementation(async (
    command: { decisionId: string },
    session: unknown,
    beforeCommit?: (transition: unknown, session: unknown, root: unknown) => Promise<void>,
  ) => {
    await beforeCommit?.(
      { decisionId: command.decisionId, action: 'restore' },
      session,
      mockQualityReviewRoot(),
    )
    return {
      decisionId: command.decisionId,
      decisionKey: 'quality:v1:test',
      domain: 'llm-verdict',
      reviewStatus: 'restored',
      reviewRevision: 1,
      operationId: OPERATION_ID,
      idempotent: false,
      session,
    }
  })
  mockReviewQualityDecision.mockResolvedValue({
    decisionId: '507f1f77bcf86cd799439012',
    reviewStatus: 'upheld',
    reviewRevision: 1,
  })
  mockUpdateConfig.mockResolvedValue({
    operationId: OPERATION_ID,
    action: 'update',
    previousRevision: 3,
    revision: 4,
    config: { ...CONFIG, revision: 4 },
    at: new Date('2026-07-23T00:00:00.000Z'),
    idempotent: false,
  })
  mockRollbackConfig.mockResolvedValue({
    operationId: OPERATION_ID,
    action: 'rollback',
    previousRevision: 4,
    revision: 5,
    targetRevision: 2,
    config: { ...CONFIG, revision: 5 },
    at: new Date('2026-07-23T00:05:00.000Z'),
    idempotent: false,
  })
})

describe('/api/cms/jobs-ingest/verdict-governance', () => {
  it('requires authoritative admin access for reads and writes', async () => {
    mockRequireCurrentPlatformAdmin.mockResolvedValue({
      ok: false,
      status: 403,
      error: 'platform_admin required',
    })

    const read = await GET(new Request(URL))
    const write = await POST(postRequest())

    expect(read.status).toBe(403)
    expect(write.status).toBe(403)
    expect(mockGetConfig).not.toHaveBeenCalled()
    expect(mockAuditFind).not.toHaveBeenCalled()
    expect(mockUpdateConfig).not.toHaveBeenCalled()
  })

  it('requires a UUID idempotency key', async () => {
    const missing = await POST(postRequest(UPDATE_BODY, null))
    const malformed = await POST(postRequest(UPDATE_BODY, 'not-a-uuid'))

    expect(missing.status).toBe(400)
    expect(malformed.status).toBe(400)
    expect(mockUpdateConfig).not.toHaveBeenCalled()
  })

  it('rejects malformed JSON before service dispatch', async () => {
    const response = await POST(rawPostRequest('{'))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'invalid JSON' })
    expect(mockUpdateConfig).not.toHaveBeenCalled()
  })

  it.each([
    ['unknown root key', { ...UPDATE_BODY, unexpected: true }],
    ['partial config', { ...UPDATE_BODY, config: { collectionEnabled: true } }],
    ['unknown config key', { ...UPDATE_BODY, config: { ...CONFIG, unexpected: true } }],
    ['ranking enabled before GA', { ...UPDATE_BODY, config: { ...CONFIG, rankingEnabled: true } }],
    ['non-integer verdict cap', { ...UPDATE_BODY, config: { ...CONFIG, dailyVerdictCap: 1.5 } }],
    ['verdict cap above corpus ceiling', { ...UPDATE_BODY, config: { ...CONFIG, dailyVerdictCap: 25_001 } }],
    ['daily spend above hard ceiling', { ...UPDATE_BODY, config: { ...CONFIG, dailyBudgetUsd: 100.01 } }],
    ['monthly spend above hard ceiling', { ...UPDATE_BODY, config: { ...CONFIG, monthlyBudgetUsd: 3_100.01 } }],
    ['company cap above hard ceiling', { ...UPDATE_BODY, config: { ...CONFIG, perCompanyDailyCap: 1_001 } }],
    ['source cap above corpus ceiling', { ...UPDATE_BODY, config: { ...CONFIG, perSourceDailyCap: 25_001 } }],
    ['zero input-token price', { ...UPDATE_BODY, config: { ...CONFIG, inputUsdPerMTok: 0 } }],
    ['output-token price above hard ceiling', { ...UPDATE_BODY, config: { ...CONFIG, outputUsdPerMTok: 100.01 } }],
    ['company cap above nonzero global cap', { ...UPDATE_BODY, config: { ...CONFIG, dailyVerdictCap: 10, perCompanyDailyCap: 11 } }],
    ['source cap above nonzero global cap', { ...UPDATE_BODY, config: { ...CONFIG, dailyVerdictCap: 10, perCompanyDailyCap: 10, perSourceDailyCap: 11 } }],
    ['daily budget above monthly budget', { ...UPDATE_BODY, config: { ...CONFIG, dailyBudgetUsd: 3, monthlyBudgetUsd: 2 } }],
  ])('strictly rejects %s', async (_label, body) => {
    const response = await POST(postRequest(body))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid verdict-governance request' })
    expect(mockUpdateConfig).not.toHaveBeenCalled()
    expect(mockRollbackConfig).not.toHaveBeenCalled()
  })

  it('returns sanitized config, history, and decision summaries', async () => {
    const occurredAt = new Date('2026-07-22T10:00:00.000Z')
    mockAuditFind.mockReturnValue(auditRows([{
      _id: OPERATION_ID,
      action: 'update',
      commandHash: 'private-command-hash',
      actorUserId: ACTOR_ID,
      reason: 'Enable reviewed shadow mode',
      previousRevision: 2,
      revision: 3,
      from: { ...CONFIG, collectionEnabled: false },
      to: CONFIG,
      occurredAt,
    }]))
    mockListQualityDecisionPage.mockResolvedValue({ items: [
        {
          id: 'decision-hard-drop',
          decisionKey: 'quality:v1:hard-drop',
          domain: 'hard-drop',
          action: 'drop',
          reviewStatus: 'unreviewed',
          reviewRevision: 0,
          occurredAt,
          lastSeenAt: occurredAt,
          seenCount: 1,
          serviceActor: 'jobs-ingest',
          inputHash: 'a'.repeat(64),
          policyRevision: 'jobs-quality-gate:v1',
          sourceRevisions: [{ sourceId: 'jsearch', controlRevision: 4, operationalRevision: 9 }],
          evidence: {
            kind: 'hard-drop',
            reasonCodes: ['short_jd'],
            bodyLength: 72,
            massRepostCompanyCount: 5,
          },
          reviewOverlay: {
            title: 'Staff Engineer',
            company: 'Example Labs',
            city: 'Bengaluru',
            isRemote: true,
            descriptionExcerpt: 'Build the interview platform.',
            viaSite: 'JSearch',
            domainHint: 'example.test',
          },
        },
        {
          id: 'decision-verdict',
          decisionKey: 'quality:v1:verdict',
          domain: 'llm-verdict',
          action: 'close',
          reviewStatus: 'unreviewed',
          reviewRevision: 1,
          occurredAt,
          lastSeenAt: occurredAt,
          seenCount: 1,
          serviceActor: 'jobs-verdict',
          inputHash: 'b'.repeat(64),
          policyRevision: 'jobs-verdict:v2',
          configRevision: 3,
          sourceRevisions: [{ sourceId: 'jsearch', controlRevision: 4, operationalRevision: 9 }],
          evidence: {
            kind: 'llm-verdict',
            verdict: 'fraud',
            genuineness: 0.12,
            reasonCodes: ['fee_fraud'],
          },
        },
        {
          id: 'decision-link',
          decisionKey: 'quality:v1:link',
          domain: 'apply-link',
          action: 'close',
          reviewStatus: 'unreviewed',
          reviewRevision: 0,
          occurredAt,
          lastSeenAt: occurredAt,
          seenCount: 1,
          serviceActor: 'jobs-link-check',
          inputHash: 'c'.repeat(64),
          policyRevision: 'jobs-link-check:v1',
          sourceRevisions: [{ sourceId: 'jsearch', controlRevision: 4, operationalRevision: 9 }],
          evidence: { kind: 'apply-link', outcome: 'all-dead', checkedOptionCount: 3 },
        },
      ] })

    const response = await GET(new Request(URL))
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(payload.config).toEqual({ ...CONFIG, revision: 3 })
    expect(payload.history).toEqual([{
      revision: 3,
      action: 'update',
      reason: 'Enable reviewed shadow mode',
      actorUserId: ACTOR_ID,
      occurredAt: occurredAt.toISOString(),
      to: CONFIG,
    }])
    expect(payload.history[0]).not.toHaveProperty('commandHash')
    expect(payload.history[0]).not.toHaveProperty('from')
    expect(payload.decisions).toEqual([
      expect.objectContaining({ id: 'decision-hard-drop', evidenceSummary: 'short_jd; 72 normalized characters; 5 companies shared the body' }),
      expect.objectContaining({ id: 'decision-verdict', evidenceSummary: 'fraud (12% genuine); fee_fraud' }),
      expect.objectContaining({ id: 'decision-link', evidenceSummary: 'all-dead machine result across 3 current option(s)' }),
    ])
    expect(payload.decisions[0]).not.toHaveProperty('evidence')
    expect(payload.decisions[0]).toMatchObject({
      inputHash: 'a'.repeat(64),
      policyRevision: 'jobs-quality-gate:v1',
      serviceActor: 'jobs-ingest',
      sourceRevisions: [{ sourceId: 'jsearch', controlRevision: 4, operationalRevision: 9 }],
    })
    expect(payload.decisions[0].reviewOverlay).toEqual({
      title: 'Staff Engineer',
      company: 'Example Labs',
      city: 'Bengaluru',
      isRemote: true,
      descriptionExcerpt: 'Build the interview platform.',
      viaSite: 'JSearch',
      domainHint: 'example.test',
    })
    expect(payload.decisions[0].reviewOverlay).not.toHaveProperty('applyUrl')
    expect(mockListQualityDecisionPage).toHaveBeenCalledWith({
      reviewStatuses: ['unreviewed'],
      limit: 50,
    })
  })

  it('paginates the upheld queue with an exact occurredAt/ObjectId cursor', async () => {
    const beforeAt = '2026-07-22T10:00:00.000Z'
    const beforeId = '507f1f77bcf86cd799439019'
    const nextCursor = {
      occurredAt: new Date('2026-07-21T10:00:00.000Z'),
      id: '507f1f77bcf86cd799439018',
    }
    mockListQualityDecisionPage.mockResolvedValue({ items: [], nextCursor })

    const response = await GET(new Request(`${URL}?reviewStatus=upheld&beforeAt=${encodeURIComponent(beforeAt)}&beforeId=${beforeId}`))

    expect(response.status).toBe(200)
    expect(mockListQualityDecisionPage).toHaveBeenCalledWith({
      reviewStatuses: ['upheld'],
      limit: 50,
      before: { occurredAt: new Date(beforeAt), id: beforeId },
    })
    await expect(response.json()).resolves.toMatchObject({
      reviewStatus: 'upheld',
      nextDecisionCursor: { occurredAt: nextCursor.occurredAt.toISOString(), id: nextCursor.id },
    })
  })

  it('returns one exact automatic decision with its immutable review history', async () => {
    const decisionId = '507f1f77bcf86cd799439012'
    const occurredAt = new Date('2026-07-22T10:00:00.000Z')
    mockGetAutomaticQualityDecision.mockResolvedValue({
      id: decisionId,
      decisionKey: `quality:v1:${'a'.repeat(64)}`,
      domain: 'llm-verdict',
      action: 'close',
      postingId: '507f1f77bcf86cd799439013',
      inputHash: 'b'.repeat(64),
      policyRevision: 'jobs-verdict:v2',
      configRevision: 3,
      sourceRevisions: [{ sourceId: 'jsearch', controlRevision: 4, operationalRevision: 9 }],
      evidence: { kind: 'llm-verdict', verdict: 'fraud', genuineness: 0.1, reasonCodes: ['fee_fraud'] },
      serviceActor: 'jobs-verdict',
      reviewStatus: 'upheld',
      reviewRevision: 1,
      seenCount: 1,
      occurredAt,
      lastSeenAt: occurredAt,
    })
    mockGetQualityDecisionReviewHistory.mockResolvedValue([{
      id: '507f1f77bcf86cd799439014',
      operationId: OPERATION_ID,
      action: 'uphold',
      actorUserId: ACTOR_ID,
      reason: 'Confirmed against source evidence',
      fromReviewStatus: 'unreviewed',
      toReviewStatus: 'upheld',
      previousReviewRevision: 0,
      resultingReviewRevision: 1,
      occurredAt,
    }])
    mockPostingFind.mockReturnValue({
      lean: () => Promise.resolve([{
        _id: '507f1f77bcf86cd799439013',
        title: 'Staff Engineer',
        company: 'Example Labs',
        locations: ['Bengaluru'],
        isRemote: true,
        status: 'closed',
        closedReason: 'llm-verdict',
      }]),
    })

    const response = await GET(new Request(`${URL}?decisionId=${decisionId}`))
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload.audit.decision).toMatchObject({
      id: decisionId,
      posting: { title: 'Staff Engineer', company: 'Example Labs', status: 'closed' },
      policyRevision: 'jobs-verdict:v2',
    })
    expect(payload.audit.reviewHistory).toEqual([
      expect.objectContaining({ action: 'uphold', actorUserId: ACTOR_ID }),
    ])
    expect(mockGetConfig).not.toHaveBeenCalled()
    expect(mockListQualityDecisionPage).not.toHaveBeenCalled()
  })

  it('rejects a partial review cursor before any governance read', async () => {
    const response = await GET(new Request(`${URL}?beforeAt=${encodeURIComponent('2026-07-22T10:00:00.000Z')}`))

    expect(response.status).toBe(400)
    expect(mockGetConfig).not.toHaveBeenCalled()
    expect(mockListQualityDecisionPage).not.toHaveBeenCalled()
  })

  it('wires a validated full-config update with the authoritative actor', async () => {
    const response = await POST(postRequest({
      ...UPDATE_BODY,
      reason: `  ${UPDATE_BODY.reason}  `,
    }))

    expect(response.status).toBe(200)
    expect(mockCheckJobsRateLimit).toHaveBeenCalledWith(ACTOR_ID, 'admin-command')
    expect(mockUpdateConfig).toHaveBeenCalledWith({
      operationId: OPERATION_ID,
      actorUserId: ACTOR_ID,
      reason: UPDATE_BODY.reason,
      expectedRevision: 3,
      config: CONFIG,
    })
    await expect(response.json()).resolves.toMatchObject({ ok: true, result: { revision: 4 } })
  })

  it('wires rollback as a new revision command', async () => {
    const body = {
      action: 'rollback-config',
      expectedRevision: 4,
      targetRevision: 2,
      reason: 'Restore the reviewed stable config',
    }
    const response = await POST(postRequest(body))

    expect(response.status).toBe(200)
    expect(mockRollbackConfig).toHaveBeenCalledWith({
      operationId: OPERATION_ID,
      actorUserId: ACTOR_ID,
      expectedRevision: body.expectedRevision,
      targetRevision: body.targetRevision,
      reason: body.reason,
    })
  })

  it('restores an exact LLM closure with the review row in the same transaction', async () => {
    const decisionId = '507f1f77bcf86cd799439012'
    mockQualityReviewRoot.mockReturnValue({
      id: decisionId,
      decisionKey: 'quality:v1:test',
      domain: 'llm-verdict',
      action: 'close',
      postingId: '507f1f77bcf86cd799439013',
      inputHash: 'a'.repeat(64),
      evidence: { kind: 'llm-verdict', epoch: 'model:prompt-v1' },
      sourceRevisions: [{ sourceId: 'jsearch', controlRevision: 4, operationalRevision: 9 }],
      reviewRevision: 0,
    })
    const body = {
      action: 'review-decision',
      decisionId,
      expectedReviewRevision: 0,
      resolution: 'restored',
      reason: 'Confirmed model false positive',
    }

    const response = await POST(postRequest(body))

    expect(response.status).toBe(200)
    expect(mockWithQualityDecisionTransaction).toHaveBeenCalledOnce()
    expect(mockFenceQualityDecisionSources).toHaveBeenCalledWith(
      [{ sourceId: 'jsearch', controlRevision: 4, operationalRevision: 9 }],
      { id: 'quality-session' },
    )
    expect(mockPostingUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'closed',
        closedReason: 'llm-verdict',
        updatedAt: new Date('2026-07-23T00:00:00.000Z'),
        'llmVerdict.status': 'scored',
        'llmVerdict.verdictInputHash': 'a'.repeat(64),
      }),
      { $set: { status: 'open' }, $unset: { closedReason: 1, closedAt: 1, purgeAt: 1 } },
      { session: { id: 'quality-session' } },
    )
    expect(mockReviewQualityDecisionInSession).toHaveBeenCalledWith(
      expect.objectContaining({ decisionId, action: 'restore' }),
      { id: 'quality-session' },
      expect.any(Function),
    )
    await expect(response.json()).resolves.toMatchObject({ result: { effect: 'reopened' } })
  })

  it.each([
    ['new source lineage', { sourceIds: ['jsearch', 'greenhouse'] }],
    ['expired freshness', { lastSeenAt: new Date('2020-01-01T00:00:00.000Z') }],
  ])('rejects an LLM restoration after %s changes', async (_label, override) => {
    mockQualityReviewRoot.mockReturnValue({
      id: '507f1f77bcf86cd799439012',
      decisionKey: 'quality:v1:test',
      domain: 'llm-verdict',
      action: 'close',
      postingId: '507f1f77bcf86cd799439013',
      inputHash: 'a'.repeat(64),
      evidence: { kind: 'llm-verdict', epoch: 'model:prompt-v1' },
      sourceRevisions: [{ sourceId: 'jsearch', controlRevision: 4, operationalRevision: 9 }],
      reviewRevision: 0,
    })
    mockPostingFindById.mockReturnValue({
      select: () => ({
        lean: () => Promise.resolve({
          status: 'closed',
          closedReason: 'llm-verdict',
          llmVerdict: { status: 'scored', verdictInputHash: 'a'.repeat(64), epoch: 'model:prompt-v1' },
          sourceIds: ['jsearch'],
          provenance: [],
          lastSeenAt: new Date(),
          updatedAt: new Date('2026-07-23T00:00:00.000Z'),
          ...override,
        }),
      }),
    })

    const response = await POST(postRequest({
      action: 'review-decision',
      decisionId: '507f1f77bcf86cd799439012',
      expectedReviewRevision: 0,
      resolution: 'restored',
      reason: 'Attempt exact false-positive restoration',
    }))

    expect(response.status).toBe(409)
    expect(mockPostingUpdateOne).not.toHaveBeenCalled()
  })

  it('restores a link restriction by requesting verified recovery, never directly reopening', async () => {
    const decisionId = '507f1f77bcf86cd799439014'
    mockQualityReviewRoot.mockReturnValue({
      id: decisionId,
      decisionKey: 'quality:v1:link',
      domain: 'apply-link',
      action: 'demote',
      postingId: '507f1f77bcf86cd799439015',
      inputHash: 'b'.repeat(64),
      evidence: { kind: 'apply-link', basis: 'crowd' },
      sourceRevisions: [{ sourceId: 'jsearch', controlRevision: 4, operationalRevision: 9 }],
      reviewRevision: 0,
    })

    const response = await POST(postRequest({
      action: 'review-decision',
      decisionId,
      expectedReviewRevision: 0,
      resolution: 'restored',
      reason: 'Request machine recovery verification',
    }))

    expect(response.status).toBe(200)
    expect(mockPostingUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: '507f1f77bcf86cd799439015',
        $or: [{ status: 'open' }, { status: 'closed', closedReason: 'dead-apply-link' }],
      }),
      { $set: { linkCheckRequestedAt: expect.any(Date) } },
      { session: { id: 'quality-session' } },
    )
    const update = mockPostingUpdateOne.mock.calls[0][1]
    expect(update).not.toHaveProperty('$set.status')
    await expect(response.json()).resolves.toMatchObject({ result: { effect: 'recovery-check-requested' } })
  })

  it('marks an exact hard drop for admission on the next authorised source sync', async () => {
    const decisionId = '507f1f77bcf86cd799439016'
    mockQualityReviewRoot.mockReturnValue({
      id: decisionId,
      decisionKey: 'quality:v1:drop',
      domain: 'hard-drop',
      action: 'drop',
      inputHash: 'c'.repeat(64),
      evidence: { kind: 'hard-drop' },
      reviewOverlay: {
        title: '',
        company: '',
        city: '',
        isRemote: false,
        descriptionExcerpt: '',
        viaSite: '',
      },
      sourceRevisions: [{ sourceId: 'jsearch', controlRevision: 4, operationalRevision: 9 }],
      reviewRevision: 0,
    })

    const response = await POST(postRequest({
      action: 'review-decision',
      decisionId,
      expectedReviewRevision: 0,
      resolution: 'restored',
      reason: 'Allow this reviewed exact source row',
    }))

    expect(response.status).toBe(200)
    expect(mockPostingUpdateOne).not.toHaveBeenCalled()
    await expect(response.json()).resolves.toMatchObject({ result: { effect: 'allow-on-next-sync' } })
  })

  it('rejects restoration when source authority changed before the review commit', async () => {
    const decisionId = '507f1f77bcf86cd799439017'
    mockQualityReviewRoot.mockReturnValue({
      id: decisionId,
      decisionKey: 'quality:v1:drop',
      domain: 'hard-drop',
      action: 'drop',
      reviewOverlay: {
        title: 'Reviewed posting',
        company: 'Example Labs',
        city: 'Bengaluru',
        isRemote: false,
        descriptionExcerpt: 'Bounded review evidence',
        viaSite: 'JSearch',
      },
      sourceRevisions: [{ sourceId: 'jsearch', controlRevision: 3, operationalRevision: 9 }],
    })
    mockFenceQualityDecisionSources.mockRejectedValueOnce(
      new MockQualityConflictError('source authority changed before quality decision commit: jsearch'),
    )

    const response = await POST(postRequest({
      action: 'review-decision',
      decisionId,
      expectedReviewRevision: 0,
      resolution: 'restored',
      reason: 'Attempt stale authority restoration',
    }))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: 'source authority changed before quality decision commit: jsearch',
    })
  })

  it('returns the current revision on a stale-config conflict', async () => {
    mockUpdateConfig.mockRejectedValueOnce(new MockConfigConflictError('stale verdict config revision', 7))

    const response = await POST(postRequest())

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      error: 'stale verdict config revision',
      currentRevision: 7,
    })
  })

  it.each([
    ['migration requirement', new MockConfigMigrationRequiredError()],
    ['standalone MongoDB', new MockConfigTransactionsRequiredError()],
  ])('maps %s to retryable governance unavailability', async (_label, error) => {
    mockUpdateConfig.mockRejectedValueOnce(error)

    const response = await POST(postRequest())

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: error.message,
      code: 'VERDICT_GOVERNANCE_UNAVAILABLE',
    })
  })

  it('maps ambiguous legacy config on GET to its deployment-specific 503', async () => {
    const error = new MockConfigMigrationRequiredError()
    mockGetConfig.mockRejectedValueOnce(error)

    const response = await GET(new Request(URL))

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: error.message,
      code: 'VERDICT_CONFIG_MIGRATION_REQUIRED',
    })
  })

  it('maps an out-of-policy stored config to an explicit repair gate', async () => {
    const error = new MockConfigRepairRequiredError()
    mockGetConfig.mockRejectedValueOnce(error)

    const response = await GET(new Request(URL))

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: error.message,
      code: 'VERDICT_CONFIG_REPAIR_REQUIRED',
    })
  })
})
