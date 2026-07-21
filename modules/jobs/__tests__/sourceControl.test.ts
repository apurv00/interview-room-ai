import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockStartSession,
  mockWithTransaction,
  mockEndSession,
  mockConnectDB,
  mockSourceFindOne,
  mockSourceUpdateOne,
  mockMetaFindOne,
  mockMetaUpdateOne,
  mockPostingUpdateMany,
  mockPostingCountDocuments,
  mockCursorDeleteMany,
  mockAuditFindOne,
  mockAuditCountDocuments,
  mockAuditCreate,
  session,
} = vi.hoisted(() => {
  const mockStartSession = vi.fn()
  const mockWithTransaction = vi.fn()
  const mockEndSession = vi.fn()
  const session = { withTransaction: mockWithTransaction, endSession: mockEndSession }
  return {
    mockStartSession,
    mockWithTransaction,
    mockEndSession,
    mockConnectDB: vi.fn(),
    mockSourceFindOne: vi.fn(),
    mockSourceUpdateOne: vi.fn(),
    mockMetaFindOne: vi.fn(),
    mockMetaUpdateOne: vi.fn(),
    mockPostingUpdateMany: vi.fn(),
    mockPostingCountDocuments: vi.fn(),
    mockCursorDeleteMany: vi.fn(),
    mockAuditFindOne: vi.fn(),
    mockAuditCountDocuments: vi.fn(),
    mockAuditCreate: vi.fn(),
    session,
  }
})

vi.mock('mongoose', () => ({
  default: { startSession: mockStartSession },
}))

vi.mock('@shared/db/connection', () => ({ connectDB: mockConnectDB }))

vi.mock('@shared/db/models', () => ({
  JOB_SOURCE_CONTROL_META_ID: 'jobs-source-control',
  JOB_SOURCE_ID_PATTERN: /^(?:__legacy_unknown__|[a-z0-9][a-z0-9:_-]{0,99})$/,
  JOB_SOURCE_LINEAGE_UNKNOWN: '__legacy_unknown__',
  JobSourceControlMeta: { findOne: mockMetaFindOne, updateOne: mockMetaUpdateOne },
  JobSourceConfig: {
    findOne: mockSourceFindOne,
    updateOne: mockSourceUpdateOne,
  },
  JobPosting: { updateMany: mockPostingUpdateMany, countDocuments: mockPostingCountDocuments },
  JobIngestCursor: { deleteMany: mockCursorDeleteMany },
  JobSourceControlAudit: {
    findOne: mockAuditFindOne,
    countDocuments: mockAuditCountDocuments,
    create: mockAuditCreate,
  },
}))

import {
  SourceAuthorityChangedError,
  SourceControlCapacityError,
  SourceControlConflictError,
  SourceControlIntegrityError,
  SourceControlNotFoundError,
  SourceTransactionsRequiredError,
  assertSourceProbeAuthority,
  controlJobSource,
  withSourceWriteFence,
  type SourceControlCommand,
} from '../services/sourceControl'

function lean<T>(value: T) {
  return { lean: vi.fn().mockResolvedValue(value) }
}

const BASE_COMMAND: SourceControlCommand = {
  sourceId: 'gh:phonepe',
  action: 'revoke',
  expectedRevision: 2,
  operationId: 'op-revoke-2',
  actorUserId: '507f1f77bcf86cd799439011',
  reason: 'Provider legal request LEGAL-42',
}

const COMMITTED_AUDIT = {
  sourceId: BASE_COMMAND.sourceId,
  operationId: BASE_COMMAND.operationId,
  action: BASE_COMMAND.action,
  actorUserId: BASE_COMMAND.actorUserId,
  reason: BASE_COMMAND.reason,
  previousRevision: 2,
  revision: 3,
  from: { enabled: true, health: 'active' as const },
  to: { enabled: false, health: 'revoked' as const },
  affectedPostings: 7,
  unknownLineagePostings: 2,
  occurredAt: new Date('2026-07-21T07:59:59.000Z'),
  createdAt: new Date('2026-07-21T08:00:00.000Z'),
}

const PREVIOUS_RESTORE_AUDIT = {
  sourceId: BASE_COMMAND.sourceId,
  operationId: 'op-restore-1',
  action: 'restore' as const,
  actorUserId: '507f1f77bcf86cd799439012',
  reason: 'Previous legal clearance',
  previousRevision: 1,
  revision: 2,
  from: { enabled: false, health: 'revoked' as const },
  to: { enabled: false, health: 'quarantined' as const },
  affectedPostings: 0,
  unknownLineagePostings: 0,
  occurredAt: new Date('2026-07-20T08:00:00.000Z'),
  createdAt: new Date('2026-07-20T08:00:01.000Z'),
}

function lastControlFrom(audit: typeof COMMITTED_AUDIT | typeof PREVIOUS_RESTORE_AUDIT) {
  return {
    revision: audit.revision,
    operationId: audit.operationId,
    action: audit.action,
    actorUserId: audit.actorUserId,
    reason: audit.reason,
    at: audit.occurredAt,
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  mockStartSession.mockResolvedValue(session)
  mockWithTransaction.mockImplementation(async (work: () => Promise<void>) => {
    await work()
  })
  mockEndSession.mockResolvedValue(undefined)
  mockConnectDB.mockResolvedValue(undefined)
  mockSourceUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mockMetaFindOne.mockImplementation(() => lean({
    controlWriteSeq: 2,
    ingestWriteSeq: 0,
    retainedPostings: 7,
  }))
  mockMetaUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mockPostingUpdateMany.mockResolvedValue({ matchedCount: 7, modifiedCount: 7 })
  mockPostingCountDocuments.mockImplementation((filter: { sourceIds?: string }) => (
    filter.sourceIds === '__legacy_unknown__' ? Promise.resolve(2) : Promise.resolve(0)
  ))
  mockCursorDeleteMany.mockResolvedValue({ deletedCount: 4 })
  mockAuditFindOne.mockImplementation((filter: { sourceId?: string }) => (
    filter.sourceId === BASE_COMMAND.sourceId ? lean(PREVIOUS_RESTORE_AUDIT) : lean(null)
  ))
  mockAuditCountDocuments.mockResolvedValue(2)
  mockAuditCreate.mockResolvedValue([])
})

describe('withSourceWriteFence', () => {
  it('commits the config fence before invoking the writer with the same session', async () => {
    const order: string[] = []
    mockMetaUpdateOne.mockImplementation(async () => {
      order.push('global-fence')
      return { matchedCount: 1 }
    })
    mockSourceUpdateOne.mockImplementation(async () => {
      order.push('fence')
      return { matchedCount: 1 }
    })
    const work = vi.fn(async (receivedSession: typeof session) => {
      order.push('write')
      expect(receivedSession).toBe(session)
      return { stored: 3 }
    })

    await expect(withSourceWriteFence('jsearch', 0, work)).resolves.toEqual({ stored: 3 })

    expect(order).toEqual(['global-fence', 'fence', 'write'])
    expect(mockMetaUpdateOne).toHaveBeenCalledWith(
      {
        _id: 'jobs-source-control',
        sourceLineageVersion: 1,
        ingestWriteSeq: 0,
      },
      { $inc: { ingestWriteSeq: 1 } },
      { session },
    )
    expect(mockSourceUpdateOne).toHaveBeenCalledWith(
      {
        sourceId: 'jsearch',
        enabled: true,
        health: { $in: ['active', 'degraded'] },
        $or: [{ controlRevision: 0 }, { controlRevision: { $exists: false } }],
      },
      { $inc: { ingestWriteSeq: 1 } },
      { session }
    )
    expect(mockWithTransaction).toHaveBeenCalledWith(
      expect.any(Function),
      {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
        readPreference: 'primary',
      }
    )
    expect(mockEndSession).toHaveBeenCalledOnce()
  })

  it('does not invoke the writer when the authority epoch fence misses', async () => {
    mockSourceUpdateOne.mockResolvedValue({ matchedCount: 0 })
    const work = vi.fn()

    const error = await withSourceWriteFence('jsearch', 4, work).catch((caught) => caught)

    expect(error).toBeInstanceOf(SourceAuthorityChangedError)
    expect(error).toMatchObject({ sourceId: 'jsearch', expectedRevision: 4 })
    expect(work).not.toHaveBeenCalled()
    expect(mockEndSession).toHaveBeenCalledOnce()
  })

  it('fails closed with an operational error when Mongo transactions are unsupported', async () => {
    mockWithTransaction.mockRejectedValue({
      code: 20,
      codeName: 'IllegalOperation',
      message: 'Transaction numbers are only allowed on a replica set member or mongos',
    })

    await expect(withSourceWriteFence('jsearch', 0, vi.fn())).rejects.toBeInstanceOf(
      SourceTransactionsRequiredError
    )
    expect(mockEndSession).toHaveBeenCalledOnce()
  })

  it('serially admits actual inserts up to the retained bound', async () => {
    mockMetaFindOne.mockImplementation(() => lean({
      controlWriteSeq: 0,
      ingestWriteSeq: 8,
      retainedPostings: 24_999,
    }))

    await expect(withSourceWriteFence(
      'jsearch',
      0,
      async () => ({ newCount: 1 }),
      { insertedPostings: (result) => result.newCount },
    )).resolves.toEqual({ newCount: 1 })

    expect(mockMetaUpdateOne).toHaveBeenLastCalledWith(
      {
        _id: 'jobs-source-control',
        sourceLineageVersion: 1,
        ingestWriteSeq: 9,
        retainedPostings: 24_999,
      },
      { $inc: { retainedPostings: 1 } },
      { session },
    )
  })

  it('reconciles a stale-high counter after TTL deletion before admitting the freed slot', async () => {
    mockMetaFindOne.mockImplementation(() => lean({
      controlWriteSeq: 0,
      ingestWriteSeq: 8,
      retainedPostings: 25_000,
    }))
    mockPostingCountDocuments.mockResolvedValue(24_999)

    await expect(withSourceWriteFence(
      'jsearch',
      0,
      async () => ({ newCount: 1 }),
      {
        reconcileRetainedPostings: true,
        insertedPostings: (result) => result.newCount,
      },
    )).resolves.toEqual({ newCount: 1 })

    expect(mockMetaUpdateOne).toHaveBeenCalledWith(
      {
        _id: 'jobs-source-control',
        sourceLineageVersion: 1,
        ingestWriteSeq: 9,
      },
      { $set: { retainedPostings: 24_999 } },
      { session },
    )
    expect(mockMetaUpdateOne).toHaveBeenLastCalledWith(
      {
        _id: 'jobs-source-control',
        sourceLineageVersion: 1,
        ingestWriteSeq: 9,
        retainedPostings: 24_999,
      },
      { $inc: { retainedPostings: 1 } },
      { session },
    )
  })

  it('aborts a cross-source insert that would exceed the retained bound', async () => {
    mockMetaFindOne.mockImplementation(() => lean({
      controlWriteSeq: 0,
      ingestWriteSeq: 8,
      retainedPostings: 25_000,
    }))

    await expect(withSourceWriteFence(
      'jsearch',
      0,
      async () => ({ newCount: 1 }),
      { insertedPostings: (result) => result.newCount },
    )).rejects.toBeInstanceOf(SourceControlCapacityError)

    expect(mockMetaUpdateOne).toHaveBeenCalledTimes(1)
    expect(mockMetaUpdateOne).not.toHaveBeenCalledWith(
      expect.objectContaining({ retainedPostings: 25_000 }),
      expect.anything(),
      expect.anything(),
    )
  })
})

describe('assertSourceProbeAuthority', () => {
  it('allows a restored epoch only when the permanent audit head matches', async () => {
    mockSourceFindOne.mockReturnValue({
      select: () => lean({ controlRevision: 2 }),
    })
    mockAuditFindOne.mockReturnValue(lean(PREVIOUS_RESTORE_AUDIT))

    await expect(assertSourceProbeAuthority(BASE_COMMAND.sourceId, 2)).resolves.toBeUndefined()
  })

  it('rejects a deleted/reseeded epoch-zero config while a revoke audit survives', async () => {
    mockSourceFindOne.mockReturnValue({
      select: () => lean({ controlRevision: 0 }),
    })
    mockAuditFindOne.mockReturnValue(lean({ ...COMMITTED_AUDIT, previousRevision: 0, revision: 1 }))

    await expect(assertSourceProbeAuthority(BASE_COMMAND.sourceId, 0)).rejects.toBeInstanceOf(
      SourceAuthorityChangedError,
    )
  })
})

describe('controlJobSource', () => {
  it('atomically revokes the config before restricting every provenance row and writing the permanent audit', async () => {
    const order: string[] = []
    mockSourceFindOne.mockImplementation(() => lean({
      sourceId: BASE_COMMAND.sourceId,
      enabled: true,
      health: 'active',
      controlRevision: 2,
      lastControl: lastControlFrom(PREVIOUS_RESTORE_AUDIT),
    }))
    mockSourceUpdateOne.mockImplementation(async () => {
      order.push('transition')
      return { matchedCount: 1 }
    })
    mockPostingCountDocuments.mockImplementation(async (filter: Record<string, unknown>) => {
      if (Object.keys(filter).length === 0) {
        order.push('corpus-scan')
        return 7
      }
      return filter.sourceIds === '__legacy_unknown__' ? 2 : 0
    })
    mockPostingUpdateMany.mockImplementation(async () => {
      order.push('closure')
      return { matchedCount: 7, modifiedCount: 7 }
    })
    mockAuditCreate.mockImplementation(async () => {
      order.push('audit')
      return []
    })

    const result = await controlJobSource(BASE_COMMAND)

    expect(order).toEqual(['transition', 'corpus-scan', 'closure', 'audit'])
    expect(mockMetaUpdateOne).toHaveBeenCalledWith(
      { _id: 'jobs-source-control', sourceLineageVersion: 1, controlWriteSeq: 2 },
      { $inc: { controlWriteSeq: 1 } },
      { session }
    )
    expect(mockSourceFindOne).toHaveBeenCalledWith(
      { sourceId: BASE_COMMAND.sourceId },
      null,
      { session }
    )
    expect(mockSourceUpdateOne).toHaveBeenCalledWith(
      {
        sourceId: BASE_COMMAND.sourceId,
        enabled: true,
        health: 'active',
        controlRevision: 2,
      },
      {
        $set: expect.objectContaining({
          enabled: false,
          health: 'revoked',
          controlRevision: 3,
          lastControl: expect.objectContaining({
            revision: 3,
            operationId: BASE_COMMAND.operationId,
            action: 'revoke',
            actorUserId: BASE_COMMAND.actorUserId,
            reason: BASE_COMMAND.reason,
            at: expect.any(Date),
          }),
        }),
      },
      { session }
    )
    // Deliberately no status predicate: open, normally archived, and
    // multi-source canonical rows all become legally restricted.
    expect(mockPostingUpdateMany).toHaveBeenCalledWith(
      { sourceIds: { $in: [BASE_COMMAND.sourceId, '__legacy_unknown__'] } },
      {
        $set: {
          status: 'closed',
          closedReason: 'source-revoked',
          closedAt: expect.any(Date),
        },
        $unset: { purgeAt: 1 },
      },
      { session, hint: 'sourceIds_1' }
    )
    expect(mockPostingCountDocuments).toHaveBeenCalledWith(
      { sourceIds: '__legacy_unknown__' },
      { session, hint: 'sourceIds_1' },
    )
    expect(mockPostingCountDocuments).toHaveBeenCalledWith({}, { session })
    expect(mockPostingCountDocuments).toHaveBeenCalledWith(
      expect.objectContaining({ 'provenance.sourceId': BASE_COMMAND.sourceId }),
      { session, hint: 'provenance.sourceId_1' },
    )
    expect(mockPostingCountDocuments).toHaveBeenCalledWith(
      expect.objectContaining({ $and: expect.any(Array) }),
      { session },
    )
    const malformedLineageFilter = mockPostingCountDocuments.mock.calls.find(
      (call) => JSON.stringify(call[0]).includes('$allElementsTrue'),
    )?.[0]
    expect(JSON.stringify(malformedLineageFilter)).toContain('$isArray')
    expect(JSON.stringify(malformedLineageFilter)).toContain('$regexMatch')
    expect(JSON.stringify(malformedLineageFilter)).toContain('$allElementsTrue')
    expect(mockPostingUpdateMany).toHaveBeenCalledOnce()
    expect(mockAuditCreate).toHaveBeenCalledWith(
      [expect.objectContaining({
        sourceId: BASE_COMMAND.sourceId,
        operationId: BASE_COMMAND.operationId,
        action: 'revoke',
        actorUserId: BASE_COMMAND.actorUserId,
        reason: BASE_COMMAND.reason,
        previousRevision: 2,
        revision: 3,
        from: { enabled: true, health: 'active' },
        to: { enabled: false, health: 'revoked' },
        affectedPostings: 7,
        unknownLineagePostings: 2,
        occurredAt: expect.any(Date),
      })],
      { session }
    )
    expect(result).toMatchObject({
      previousRevision: 2,
      revision: 3,
      enabled: false,
      health: 'revoked',
      affectedPostings: 7,
      unknownLineagePostings: 2,
      idempotent: false,
    })
    expect(mockEndSession).toHaveBeenCalledOnce()
  })

  it('adds a disjoint fail-closed update when malformed lineage is detected', async () => {
    mockSourceFindOne.mockImplementation(() => lean({
      sourceId: BASE_COMMAND.sourceId,
      enabled: true,
      health: 'active',
      controlRevision: 2,
      lastControl: lastControlFrom(PREVIOUS_RESTORE_AUDIT),
    }))
    mockPostingCountDocuments
      .mockResolvedValueOnce(7) // retained corpus admission
      .mockResolvedValueOnce(1) // indexed unknown sentinel
      .mockResolvedValueOnce(0) // provenance drift
      .mockResolvedValueOnce(2) // malformed fallback
    mockPostingUpdateMany
      .mockResolvedValueOnce({ matchedCount: 5, modifiedCount: 5 })
      .mockResolvedValueOnce({ matchedCount: 2, modifiedCount: 2 })

    const result = await controlJobSource(BASE_COMMAND)

    expect(mockPostingUpdateMany).toHaveBeenCalledTimes(2)
    expect(mockPostingUpdateMany.mock.calls[0]).toEqual([
      { sourceIds: { $in: [BASE_COMMAND.sourceId, '__legacy_unknown__'] } },
      expect.any(Object),
      { session, hint: 'sourceIds_1' },
    ])
    expect(mockPostingUpdateMany.mock.calls[1]).toEqual([
      expect.objectContaining({ $and: expect.any(Array) }),
      expect.any(Object),
      { session },
    ])
    expect(JSON.stringify(mockPostingUpdateMany.mock.calls[1][0])).toContain('$regexMatch')
    expect(JSON.stringify(mockPostingUpdateMany.mock.calls[1][0])).toContain('$nin')
    expect(JSON.stringify(mockPostingUpdateMany.mock.calls[1][0])).toContain('__legacy_unknown__')
    expect(result).toMatchObject({ affectedPostings: 7, unknownLineagePostings: 3 })
    expect(mockAuditCreate).toHaveBeenCalledWith(
      [expect.objectContaining({ affectedPostings: 7, unknownLineagePostings: 3 })],
      { session },
    )
  })

  it('uses the provenance index to close valid-looking rows whose durable lineage drifted', async () => {
    mockSourceFindOne.mockImplementation(() => lean({
      sourceId: BASE_COMMAND.sourceId,
      enabled: true,
      health: 'active',
      controlRevision: 2,
      lastControl: lastControlFrom(PREVIOUS_RESTORE_AUDIT),
    }))
    mockPostingCountDocuments
      .mockResolvedValueOnce(10) // retained corpus admission
      .mockResolvedValueOnce(0) // unknown sentinel
      .mockResolvedValueOnce(2) // target provenance missing from sourceIds
      .mockResolvedValueOnce(0) // malformed
    mockPostingUpdateMany
      .mockResolvedValueOnce({ matchedCount: 5, modifiedCount: 5 })
      .mockResolvedValueOnce({ matchedCount: 2, modifiedCount: 2 })

    const result = await controlJobSource(BASE_COMMAND)

    expect(mockPostingUpdateMany).toHaveBeenCalledTimes(2)
    expect(mockPostingUpdateMany.mock.calls[1]).toEqual([
      expect.objectContaining({
        'provenance.sourceId': BASE_COMMAND.sourceId,
        sourceIds: { $nin: [BASE_COMMAND.sourceId, '__legacy_unknown__'] },
        $nor: [expect.objectContaining({ $expr: expect.any(Object) })],
      }),
      expect.any(Object),
      { session, hint: 'provenance.sourceId_1' },
    ])
    expect(result).toMatchObject({ affectedPostings: 7 })
  })

  it('rolls back the ordered source transition when the retained corpus is over limit', async () => {
    mockSourceFindOne.mockImplementation(() => lean({
      sourceId: BASE_COMMAND.sourceId,
      enabled: true,
      health: 'active',
      controlRevision: 2,
      lastControl: lastControlFrom(PREVIOUS_RESTORE_AUDIT),
    }))
    mockPostingCountDocuments.mockResolvedValueOnce(25_001)

    await expect(controlJobSource(BASE_COMMAND)).rejects.toBeInstanceOf(SourceControlCapacityError)
    // The source transition deliberately acquires the per-source row before
    // the corpus scan. The enclosing transaction rolls it back on capacity.
    expect(mockSourceUpdateOne).toHaveBeenCalledOnce()
    expect(mockPostingUpdateMany).not.toHaveBeenCalled()
    expect(mockAuditCreate).not.toHaveBeenCalled()
  })

  it('restores only into disabled quarantine, clears cursors, and never reopens postings', async () => {
    const command: SourceControlCommand = {
      ...BASE_COMMAND,
      action: 'restore',
      expectedRevision: 3,
      operationId: 'op-restore-3',
      reason: 'Legal clearance received; revalidation still required',
    }
    mockSourceFindOne.mockImplementation(() => lean({
      sourceId: command.sourceId,
      enabled: false,
      health: 'revoked',
      controlRevision: 3,
      lastControl: lastControlFrom(COMMITTED_AUDIT),
    }))
    mockMetaFindOne.mockImplementation(() => lean({ controlWriteSeq: 3 }))
    mockAuditCountDocuments.mockResolvedValue(3)
    mockAuditFindOne.mockImplementation((filter: { sourceId?: string }) => (
      filter.sourceId === command.sourceId ? lean(COMMITTED_AUDIT) : lean(null)
    ))

    const result = await controlJobSource(command)

    expect(mockSourceUpdateOne).toHaveBeenCalledWith(
      {
        sourceId: command.sourceId,
        enabled: false,
        health: 'revoked',
        controlRevision: 3,
      },
      {
        $set: expect.objectContaining({
          enabled: false,
          health: 'quarantined',
          controlRevision: 4,
          lastControl: expect.objectContaining({ action: 'restore', revision: 4 }),
        }),
      },
      { session }
    )
    expect(mockCursorDeleteMany).toHaveBeenCalledWith(
      { sourceId: command.sourceId },
      { session }
    )
    expect(mockPostingUpdateMany).not.toHaveBeenCalled()
    expect(mockAuditCreate).toHaveBeenCalledWith(
      [expect.objectContaining({
        action: 'restore',
        previousRevision: 3,
        revision: 4,
        from: { enabled: false, health: 'revoked' },
        to: { enabled: false, health: 'quarantined' },
        affectedPostings: 0,
      })],
      { session }
    )
    expect(result).toMatchObject({
      revision: 4,
      enabled: false,
      health: 'quarantined',
      affectedPostings: 0,
      idempotent: false,
    })
  })

  it.each([
    {
      name: 'stale revision',
      command: BASE_COMMAND,
      source: { enabled: true, health: 'active', controlRevision: 3 },
      message: 'stale source revision',
    },
    {
      name: 'epoch-zero restore',
      command: { ...BASE_COMMAND, action: 'restore' as const, expectedRevision: 0 },
      source: { enabled: false, health: 'revoked' },
      message: 'epoch-zero restore is forbidden',
    },
  ])('rejects $name without mutating source state', async ({ command, source, message }) => {
    if (command.expectedRevision === 0) {
      mockMetaFindOne.mockImplementation(() => lean({ controlWriteSeq: 0 }))
      mockAuditCountDocuments.mockResolvedValue(0)
      mockAuditFindOne.mockImplementation(() => lean(null))
    }
    mockSourceFindOne.mockImplementation(() => lean({ sourceId: command.sourceId, ...source }))

    await expect(controlJobSource(command)).rejects.toThrow(message)

    expect(mockSourceUpdateOne).not.toHaveBeenCalled()
    expect(mockPostingUpdateMany).not.toHaveBeenCalled()
    expect(mockCursorDeleteMany).not.toHaveBeenCalled()
    expect(mockAuditCreate).not.toHaveBeenCalled()
  })

  it('rejects an unknown source without recording a control transition', async () => {
    mockSourceFindOne.mockImplementation(() => lean(null))

    await expect(controlJobSource(BASE_COMMAND)).rejects.toBeInstanceOf(SourceControlNotFoundError)
    expect(mockSourceUpdateOne).not.toHaveBeenCalled()
    expect(mockAuditCreate).not.toHaveBeenCalled()
  })

  it('fails closed before reading the source when the global lineage migration is not ready', async () => {
    mockMetaFindOne.mockImplementation(() => lean(null))

    await expect(controlJobSource(BASE_COMMAND)).rejects.toThrow('durable-lineage repair')

    expect(mockMetaUpdateOne).not.toHaveBeenCalled()
    expect(mockSourceFindOne).not.toHaveBeenCalled()
    expect(mockPostingUpdateMany).not.toHaveBeenCalled()
    expect(mockAuditCreate).not.toHaveBeenCalled()
  })

  it('rejects a reset global sequence whose marker no longer equals the permanent audit count', async () => {
    mockMetaFindOne.mockImplementation(() => lean({ controlWriteSeq: 1 }))

    const error = await controlJobSource(BASE_COMMAND).catch((caught) => caught)
    expect(error).toBeInstanceOf(SourceControlIntegrityError)
    expect(error).toMatchObject({ message: 'global source-control integrity failure: sequence 1 does not match 2 audit rows' })

    expect(mockMetaUpdateOne).not.toHaveBeenCalled()
    expect(mockSourceFindOne).not.toHaveBeenCalled()
    expect(mockAuditCreate).not.toHaveBeenCalled()
  })

  it('fails closed when the global sequence CAS loses a concurrent control transition', async () => {
    mockMetaUpdateOne.mockResolvedValue({ matchedCount: 0 })

    await expect(controlJobSource(BASE_COMMAND)).rejects.toThrow(
      'global source-control sequence changed during the transition',
    )

    expect(mockSourceFindOne).not.toHaveBeenCalled()
    expect(mockAuditCreate).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'missing historical transition',
      latestAudit: PREVIOUS_RESTORE_AUDIT,
      sourceAuditCount: 1,
      source: {
        enabled: true,
        health: 'active',
        controlRevision: 2,
        lastControl: lastControlFrom(PREVIOUS_RESTORE_AUDIT),
      },
      message: 'does not have a complete audit chain',
    },
    {
      name: 'audit head at the wrong revision',
      latestAudit: { ...PREVIOUS_RESTORE_AUDIT, previousRevision: 0, revision: 1 },
      sourceAuditCount: 2,
      source: {
        enabled: true,
        health: 'active',
        controlRevision: 2,
        lastControl: lastControlFrom(PREVIOUS_RESTORE_AUDIT),
      },
      message: 'does not have a complete audit chain',
    },
    {
      name: 'config summary drift',
      latestAudit: PREVIOUS_RESTORE_AUDIT,
      sourceAuditCount: 2,
      source: {
        enabled: true,
        health: 'active',
        controlRevision: 2,
        lastControl: {
          ...lastControlFrom(PREVIOUS_RESTORE_AUDIT),
          operationId: 'tampered-operation',
        },
      },
      message: 'config summary does not match',
    },
    {
      name: 'non-alternating audit head',
      latestAudit: { ...PREVIOUS_RESTORE_AUDIT, action: 'revoke' as const },
      sourceAuditCount: 2,
      source: {
        enabled: false,
        health: 'revoked',
        controlRevision: 2,
        lastControl: {
          ...lastControlFrom(PREVIOUS_RESTORE_AUDIT),
          action: 'revoke' as const,
        },
      },
      message: 'invalid revoke audit head',
    },
    {
      name: 'invalid audit destination',
      latestAudit: {
        ...PREVIOUS_RESTORE_AUDIT,
        to: { enabled: true, health: 'active' as const },
      },
      sourceAuditCount: 2,
      source: {
        enabled: true,
        health: 'active',
        controlRevision: 2,
        lastControl: lastControlFrom(PREVIOUS_RESTORE_AUDIT),
      },
      message: 'invalid destination state',
    },
    {
      name: 'restored head with revoked config state',
      latestAudit: PREVIOUS_RESTORE_AUDIT,
      sourceAuditCount: 2,
      source: {
        enabled: false,
        health: 'revoked',
        controlRevision: 2,
        lastControl: lastControlFrom(PREVIOUS_RESTORE_AUDIT),
      },
      message: 'restored audit head disagrees',
    },
  ])('rejects $name before any control mutation', async ({ latestAudit, sourceAuditCount, source, message }) => {
    mockSourceFindOne.mockImplementation(() => lean({ sourceId: BASE_COMMAND.sourceId, ...source }))
    mockAuditFindOne.mockImplementation((filter: { sourceId?: string }) => (
      filter.sourceId === BASE_COMMAND.sourceId ? lean(latestAudit) : lean(null)
    ))
    mockAuditCountDocuments
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(sourceAuditCount)

    const error = await controlJobSource(BASE_COMMAND).catch((caught) => caught)
    expect(error).toBeInstanceOf(SourceControlIntegrityError)
    expect(error).toMatchObject({ message: expect.stringContaining(message) })

    expect(mockSourceUpdateOne).not.toHaveBeenCalled()
    expect(mockPostingUpdateMany).not.toHaveBeenCalled()
    expect(mockAuditCreate).not.toHaveBeenCalled()
  })

  it('rejects repeating the audit-head action under a fresh operation id', async () => {
    const command = { ...BASE_COMMAND, action: 'restore' as const }
    mockSourceFindOne.mockImplementation(() => lean({
      sourceId: command.sourceId,
      enabled: false,
      health: 'quarantined',
      controlRevision: 2,
      lastControl: lastControlFrom(PREVIOUS_RESTORE_AUDIT),
    }))

    await expect(controlJobSource(command)).rejects.toThrow(
      'source control actions must alternate',
    )

    expect(mockSourceUpdateOne).not.toHaveBeenCalled()
    expect(mockAuditCreate).not.toHaveBeenCalled()
  })

  it('rejects an epoch-zero config carrying orphaned control evidence', async () => {
    mockMetaFindOne.mockImplementation(() => lean({ controlWriteSeq: 1 }))
    mockAuditCountDocuments.mockResolvedValue(1)
    mockAuditFindOne.mockImplementation((filter: { sourceId?: string }) => (
      filter.sourceId === BASE_COMMAND.sourceId
        ? lean({ ...COMMITTED_AUDIT, previousRevision: 0, revision: 1 })
        : lean(null)
    ))
    mockSourceFindOne.mockImplementation(() => lean({
      sourceId: BASE_COMMAND.sourceId,
      enabled: true,
      health: 'active',
    }))

    const error = await controlJobSource({ ...BASE_COMMAND, expectedRevision: 0 }).catch((caught) => caught)
    expect(error).toBeInstanceOf(SourceControlIntegrityError)
    expect(error).toMatchObject({ message: expect.stringContaining('epoch-zero source has control history') })

    expect(mockSourceUpdateOne).not.toHaveBeenCalled()
    expect(mockAuditCreate).not.toHaveBeenCalled()
  })

  it('adopts a pre-A02 epoch-zero revocation into the audited protocol', async () => {
    mockMetaFindOne.mockImplementation(() => lean({ controlWriteSeq: 0 }))
    mockAuditCountDocuments.mockResolvedValue(0)
    mockAuditFindOne.mockImplementation(() => lean(null))
    mockSourceFindOne.mockImplementation(() => lean({
      sourceId: BASE_COMMAND.sourceId,
      enabled: false,
      health: 'revoked',
    }))

    const result = await controlJobSource({ ...BASE_COMMAND, expectedRevision: 0 })

    expect(result).toMatchObject({ previousRevision: 0, revision: 1, health: 'revoked' })
    expect(mockPostingUpdateMany).toHaveBeenCalledOnce()
    expect(mockAuditCreate).toHaveBeenCalledOnce()
  })

  it('replays an already-committed operation without opening another transaction', async () => {
    mockAuditFindOne.mockImplementation(() => lean(COMMITTED_AUDIT))

    const result = await controlJobSource(BASE_COMMAND)

    expect(result).toEqual({
      sourceId: BASE_COMMAND.sourceId,
      action: 'revoke',
      previousRevision: 2,
      revision: 3,
      enabled: false,
      health: 'revoked',
      affectedPostings: 7,
      unknownLineagePostings: 2,
      operationId: BASE_COMMAND.operationId,
      at: COMMITTED_AUDIT.occurredAt,
      idempotent: true,
    })
    expect(mockStartSession).not.toHaveBeenCalled()
    expect(mockSourceUpdateOne).not.toHaveBeenCalled()
    expect(mockPostingUpdateMany).not.toHaveBeenCalled()
    expect(mockAuditCreate).not.toHaveBeenCalled()
  })

  it('replays a duplicate operation discovered inside the transaction', async () => {
    mockAuditFindOne
      .mockImplementationOnce(() => lean(null))
      .mockImplementationOnce(() => lean(COMMITTED_AUDIT))

    const result = await controlJobSource(BASE_COMMAND)

    expect(result.idempotent).toBe(true)
    expect(mockSourceFindOne).not.toHaveBeenCalled()
    expect(mockSourceUpdateOne).not.toHaveBeenCalled()
    expect(mockAuditCreate).not.toHaveBeenCalled()
    expect(mockEndSession).toHaveBeenCalledOnce()
  })

  it('rejects reuse of an operation id for a different command', async () => {
    mockAuditFindOne.mockImplementation(() => lean(COMMITTED_AUDIT))

    await expect(controlJobSource({
      ...BASE_COMMAND,
      reason: 'A different legal request',
    })).rejects.toBeInstanceOf(SourceControlConflictError)

    expect(mockStartSession).not.toHaveBeenCalled()
    expect(mockSourceUpdateOne).not.toHaveBeenCalled()
  })
})
