import mongoose, { type ClientSession } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockSourceUpdateOne } = vi.hoisted(() => ({
  mockSourceUpdateOne: vi.fn(),
}))

vi.mock('@shared/db/connection', () => ({
  connectDB: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@shared/db/models/JobSourceConfig', () => ({
  JobSourceConfig: { updateOne: mockSourceUpdateOne },
}))
vi.mock('../services/sourceControl', () => ({
  controlRevisionFilter: (revision: number) => revision === 0
    ? { $or: [{ controlRevision: 0 }, { controlRevision: { $exists: false } }] }
    : { controlRevision: revision },
  operationalRevisionFilter: (revision: number) => revision === 0
    ? { $or: [{ operationalRevision: 0 }, { operationalRevision: { $exists: false } }] }
    : { operationalRevision: revision },
}))

import { JobQualityDecision } from '@shared/db/models/JobQualityDecision'
import {
  QualityDecisionConflictError,
  QualityDecisionTransactionsRequiredError,
  fenceQualityDecisionSources,
  getAutomaticQualityDecision,
  getQualityDecisionReviewHistory,
  hasRestoredQualityDecision,
  listQualityDecisionPage,
  listReviewableQualityDecisions,
  recordAutomaticQualityDecision,
  reviewQualityDecisionInSession,
  withQualityDecisionTransaction,
  type AutomaticQualityDecisionInput,
  type ReviewQualityDecisionCommand,
} from '../services/qualityDecisionService'

const POSTING_ID = '507f1f77bcf86cd799439011'
const ACTOR_ID = '507f191e810c19729de860ea'
const DECISION_ID = new mongoose.Types.ObjectId('507f1f77bcf86cd799439012')
const NOW = new Date('2026-07-22T04:00:00.000Z')

const sourceRevisions = [
  { sourceId: 'jsearch', controlRevision: 3, operationalRevision: 7 },
  { sourceId: 'greenhouse', controlRevision: 1, operationalRevision: 2 },
]

const hardDropInput: AutomaticQualityDecisionInput = {
  domain: 'hard-drop',
  action: 'drop',
  subjectKey: 'jsearch:provider-row-42',
  inputHash: 'a'.repeat(64),
  policyRevision: 'quality-gate:v3',
  sourceRevisions,
  occurredAt: NOW,
  evidence: {
    kind: 'hard-drop',
    reasonCodes: ['mass-repost', 'thin-jd'],
    bodyLength: 4_100,
    applyHosts: ['jobs.example.com'],
    massRepostCompanyCount: 4,
  },
  reviewOverlay: {
    title: 'Frontend Engineer',
    company: 'Example Ltd',
    city: 'Bengaluru',
    isRemote: false,
    description: 'x'.repeat(4_100),
    postedAt: '2026-07-21T00:00:00.000Z',
    validThrough: null,
    externalId: 'provider-row-42',
    viaSite: 'Example Jobs',
    applyOptions: [{ url: 'https://jobs.example.com/42', isDirect: true }],
    domainHint: 'frontend',
  },
}

function queryWithLean<T>(value: T) {
  const query = {
    session: vi.fn(),
    lean: vi.fn().mockResolvedValue(value),
  }
  query.session.mockReturnValue(query)
  return query
}

function sessionPromise<T>(value: T) {
  const result = Promise.resolve(value) as Promise<T> & { session: ReturnType<typeof vi.fn> }
  result.session = vi.fn(() => result)
  return result
}

function fakeSession(): ClientSession {
  return { id: { id: Buffer.from('test') } } as unknown as ClientSession
}

beforeEach(() => {
  vi.restoreAllMocks()
  mockSourceUpdateOne.mockReset()
})

describe('source authority write fence', () => {
  it('touches source rows in deterministic order with exact authority and eligibility filters', async () => {
    mockSourceUpdateOne.mockResolvedValue({ matchedCount: 1 })
    const session = fakeSession()

    await fenceQualityDecisionSources([
      { sourceId: 'zeta', controlRevision: 0, operationalRevision: 0 },
      { sourceId: 'alpha', controlRevision: 3, operationalRevision: 5 },
    ], session, { requireVerdictEligibility: true })

    expect(mockSourceUpdateOne).toHaveBeenCalledTimes(2)
    expect(mockSourceUpdateOne.mock.calls[0]).toEqual([
      {
        sourceId: 'alpha',
        health: { $ne: 'revoked' },
        llmVerdictOptOut: { $ne: true },
        $and: [
          { controlRevision: 3 },
          { operationalRevision: 5 },
          {
            $or: [
              { ingestWriteSeq: { $lt: Number.MAX_SAFE_INTEGER } },
              { ingestWriteSeq: { $exists: false } },
            ],
          },
        ],
      },
      { $inc: { ingestWriteSeq: 1 } },
      { session, timestamps: false },
    ])
    expect(mockSourceUpdateOne.mock.calls[1][0]).toEqual({
      sourceId: 'zeta',
      health: { $ne: 'revoked' },
      llmVerdictOptOut: { $ne: true },
      $and: [
        { $or: [{ controlRevision: 0 }, { controlRevision: { $exists: false } }] },
        { $or: [{ operationalRevision: 0 }, { operationalRevision: { $exists: false } }] },
        {
          $or: [
            { ingestWriteSeq: { $lt: Number.MAX_SAFE_INTEGER } },
            { ingestWriteSeq: { $exists: false } },
          ],
        },
      ],
    })
  })

  it('fails closed at the first source whose authority no longer matches', async () => {
    mockSourceUpdateOne
      .mockResolvedValueOnce({ matchedCount: 1 })
      .mockResolvedValueOnce({ matchedCount: 0 })
    const session = fakeSession()

    await expect(fenceQualityDecisionSources([
      { sourceId: 'zeta', controlRevision: 4, operationalRevision: 8 },
      { sourceId: 'alpha', controlRevision: 1, operationalRevision: 2 },
      { sourceId: 'beta', controlRevision: 3, operationalRevision: 6 },
    ], session)).rejects.toThrow(
      'source authority changed before quality decision commit: beta',
    )

    expect(mockSourceUpdateOne).toHaveBeenCalledTimes(2)
    expect(mockSourceUpdateOne.mock.calls.map(([filter]) => filter.sourceId))
      .toEqual(['alpha', 'beta'])
  })
})

describe('automatic quality-decision roots', () => {
  it('upserts one deterministic root with a bounded URL-free review overlay', async () => {
    const update = vi.spyOn(JobQualityDecision, 'updateOne')
      .mockResolvedValueOnce({ upsertedCount: 1, upsertedId: DECISION_ID } as never)
      .mockResolvedValueOnce({ upsertedCount: 0 } as never)

    const first = await recordAutomaticQualityDecision(hardDropInput)
    const second = await recordAutomaticQualityDecision({
      ...hardDropInput,
      sourceRevisions: [...sourceRevisions].reverse(),
      evidence: {
        ...hardDropInput.evidence,
        reasonCodes: [...hardDropInput.evidence.reasonCodes].reverse(),
      },
    })

    expect(first.inserted).toBe(true)
    expect(second).toEqual({ decisionKey: first.decisionKey, inserted: false })
    expect(first.decisionKey).toMatch(/^quality:v1:[a-f0-9]{64}$/)

    const [filter, mutation, options] = update.mock.calls[0]
    expect(filter).toEqual({ recordType: 'automatic', decisionKey: first.decisionKey })
    expect(mutation).toMatchObject({
      $setOnInsert: {
        recordType: 'automatic',
        domain: 'hard-drop',
        automaticAction: 'drop',
        inputHash: 'a'.repeat(64),
        policyRevision: 'quality-gate:v3',
        sourceRevisions: [
          { sourceId: 'greenhouse', controlRevision: 1, operationalRevision: 2 },
          { sourceId: 'jsearch', controlRevision: 3, operationalRevision: 7 },
        ],
        evidence: {
          kind: 'hard-drop',
          reasonCodes: ['mass-repost', 'thin-jd'],
          bodyLength: 4_100,
          applyHosts: ['jobs.example.com'],
          massRepostCompanyCount: 4,
        },
        serviceActor: 'jobs-ingest',
        reviewStatus: 'unreviewed',
        reviewRevision: 0,
        reviewOverlay: {
          title: 'Frontend Engineer',
          company: 'Example Ltd',
          city: 'Bengaluru',
          isRemote: false,
          descriptionExcerpt: 'x'.repeat(4_000),
          viaSite: 'Example Jobs',
          domainHint: 'frontend',
        },
      },
      $inc: { seenCount: 1 },
      $max: { lastSeenAt: NOW },
    })
    const persisted = (mutation as { $setOnInsert: Record<string, unknown> }).$setOnInsert
    expect(persisted.subjectKeyHash)
      .toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(mutation)).not.toContain(hardDropInput.subjectKey)
    expect(JSON.stringify(mutation)).not.toContain('https://jobs.example.com/42')
    expect(persisted).not.toHaveProperty('replaySnapshot')
    expect(persisted).not.toHaveProperty('evidenceDigest')
    expect(persisted).not.toHaveProperty('replayDigest')
    expect(persisted.reviewOverlay).not.toHaveProperty('applyOptions')
    expect(persisted.reviewOverlay).not.toHaveProperty('externalId')
    expect(persisted.reviewOverlay).not.toHaveProperty('postedAt')
    expect(persisted.reviewOverlay).not.toHaveProperty('validThrough')
    expect(options).toMatchObject({ upsert: true, runValidators: true })
  })

  it('drops non-allowlisted evidence and rejects inconsistent link actions', async () => {
    const update = vi.spyOn(JobQualityDecision, 'updateOne')
      .mockResolvedValue({ upsertedCount: 1 } as never)

    await recordAutomaticQualityDecision({
      ...hardDropInput,
      evidence: {
        ...hardDropInput.evidence,
        rawProviderBody: 'must-not-persist',
      },
    } as never)
    expect(JSON.stringify(update.mock.calls[0][1])).not.toContain('rawProviderBody')
    expect(JSON.stringify(update.mock.calls[0][1])).not.toContain('must-not-persist')

    await expect(recordAutomaticQualityDecision({
      domain: 'apply-link',
      action: 'demote',
      subjectKey: `${POSTING_ID}:opaque-link-generation`,
      postingId: POSTING_ID,
      serviceActor: 'jobs-link-check',
      inputHash: 'b'.repeat(64),
      policyRevision: 'link-governance:v2',
      sourceRevisions,
      occurredAt: NOW,
      evidence: {
        kind: 'apply-link',
        basis: 'machine',
        outcome: 'alive',
        generation: '2026-07-22T00:00:00.000Z',
        observedAt: NOW,
        checkedOptionCount: 1,
      },
    })).rejects.toThrow(/demote requires dead/)

    expect(update).toHaveBeenCalledTimes(1)
  })

  it('preserves empty normalized strings because missing fields can be the hard-drop evidence', async () => {
    const update = vi.spyOn(JobQualityDecision, 'updateOne')
      .mockResolvedValue({ upsertedCount: 1 } as never)

    await recordAutomaticQualityDecision({
      ...hardDropInput,
      reviewOverlay: {
        ...hardDropInput.reviewOverlay,
        title: '',
        company: '',
        city: '',
        description: '',
        viaSite: '',
        postedAt: '',
        validThrough: '',
        externalId: '',
        domainHint: '',
        applyOptions: [{ url: '', publisher: '' }],
      },
    })

    expect(update.mock.calls[0][1]).toMatchObject({
      $setOnInsert: {
        reviewOverlay: {
          title: '', company: '', city: '', descriptionExcerpt: '', viaSite: '',
          domainHint: '',
        },
      },
    })
  })

  it('redacts and bounds every permanent overlay field and truncates safe drop evidence', async () => {
    const update = vi.spyOn(JobQualityDecision, 'updateOne')
      .mockResolvedValue({ upsertedCount: 1 } as never)
    const hostile = [
      '<b>Recruiter</b>',
      'hr.team@agency.co.in',
      '+91 98765 43210',
      '+44 7700 900123',
      '@private_recruiter',
      'Telegram: hidden.handle',
      'https://careers.example.com/private?q=1',
      'www.agency.example/jobs',
      'agency.example',
      'x'.repeat(20_000),
    ].join(' ')

    await recordAutomaticQualityDecision({
      ...hardDropInput,
      evidence: {
        kind: 'hard-drop',
        reasonCodes: ['fee-fraud'],
        bodyLength: Number.MAX_SAFE_INTEGER,
        applyHosts: [
          'https://not-a-host.example/path',
          'x'.repeat(300),
          ...Array.from(
            { length: 12 },
            (_, index) => `jobs-${String(index).padStart(2, '0')}.example.com`,
          ),
        ],
      },
      reviewOverlay: {
        ...hardDropInput.reviewOverlay,
        title: hostile,
        company: hostile,
        city: hostile,
        description: hostile,
        viaSite: hostile,
        domainHint: hostile,
      },
    })

    const mutation = update.mock.calls[0][1] as {
      $setOnInsert: {
        evidence: { bodyLength: number; applyHosts: string[] }
        reviewOverlay: Record<string, string | boolean>
      }
    }
    const overlay = mutation.$setOnInsert.reviewOverlay
    expect(String(overlay.title)).toHaveLength(500)
    expect(String(overlay.company)).toHaveLength(500)
    expect(String(overlay.city)).toHaveLength(300)
    expect(String(overlay.descriptionExcerpt)).toHaveLength(4_000)
    expect(String(overlay.viaSite)).toHaveLength(200)
    expect(String(overlay.domainHint)).toHaveLength(100)
    const persistedOverlay = JSON.stringify(overlay)
    expect(persistedOverlay).not.toMatch(/hr\.team@|98765|7700|private_recruiter|hidden\.handle|https?:\/\/|www\.|agency\.example|<b>/i)
    expect(persistedOverlay).toContain('[email removed]')
    expect(persistedOverlay).toContain('[phone removed]')
    expect(persistedOverlay).toContain('[handle removed]')
    expect(persistedOverlay).toContain('[contact removed]')
    expect(persistedOverlay).toContain('[url removed]')
    expect(mutation.$setOnInsert.evidence).toMatchObject({
      bodyLength: Number.MAX_SAFE_INTEGER,
      applyHosts: Array.from(
        { length: 8 },
        (_, index) => `jobs-${String(index).padStart(2, '0')}.example.com`,
      ),
    })
  })

  it('requires prior evidence for link close/reopen but not first-observation ordering changes', async () => {
    vi.spyOn(JobQualityDecision, 'updateOne').mockResolvedValue({ upsertedCount: 1 } as never)
    const base = {
      domain: 'apply-link' as const,
      subjectKey: `${POSTING_ID}:opaque-link-generation`,
      postingId: POSTING_ID,
      serviceActor: 'jobs-link-check' as const,
      inputHash: 'c'.repeat(64),
      policyRevision: 'link-governance:v2',
      sourceRevisions,
      occurredAt: NOW,
    }

    await expect(recordAutomaticQualityDecision({
      ...base,
      action: 'demote',
      evidence: {
        kind: 'apply-link', basis: 'machine', outcome: 'dead', generation: 'generation-1', observedAt: NOW, checkedOptionCount: 2,
      },
    })).resolves.toMatchObject({ inserted: true })

    await expect(recordAutomaticQualityDecision({
      ...base,
      action: 'close',
      evidence: {
        kind: 'apply-link', basis: 'machine', outcome: 'dead', generation: 'generation-1', observedAt: NOW, checkedOptionCount: 2,
      },
    })).rejects.toThrow(/close requires prior/)
  })

  it('records crowd quorum honestly without fabricating a machine outcome', async () => {
    const update = vi.spyOn(JobQualityDecision, 'updateOne')
      .mockResolvedValue({ upsertedCount: 1 } as never)
    const input = {
      domain: 'apply-link' as const,
      action: 'demote' as const,
      subjectKey: `${POSTING_ID}:crowd-link-generation`,
      postingId: POSTING_ID,
      serviceActor: 'jobs-link-quorum' as const,
      inputHash: '9'.repeat(64),
      policyRevision: 'link-crowd-quorum:v2',
      sourceRevisions,
      occurredAt: NOW,
      evidence: {
        kind: 'apply-link' as const,
        basis: 'crowd' as const,
        generation: 'generation-2',
        reportCount: 3,
        quorum: 3,
      },
    }

    await expect(recordAutomaticQualityDecision(input)).resolves.toMatchObject({ inserted: true })
    expect(update.mock.calls[0][1]).toMatchObject({
      $setOnInsert: {
        serviceActor: 'jobs-link-quorum',
        evidence: {
          kind: 'apply-link',
          basis: 'crowd',
          generation: 'generation-2',
          reportCount: 3,
          quorum: 3,
        },
      },
    })
    expect(JSON.stringify(update.mock.calls[0][1])).not.toContain('outcome')
    expect(JSON.stringify(update.mock.calls[0][1])).not.toContain('checkedOptionCount')

    await expect(recordAutomaticQualityDecision({
      ...input,
      evidence: { ...input.evidence, reportCount: 2 },
    })).rejects.toThrow(/reportCount greater than or equal to quorum/)
  })
})

describe('exact restored override', () => {
  it('ignores audit-only config churn but changes the key when source authority changes', async () => {
    const exists = vi.spyOn(JobQualityDecision, 'exists')
      .mockReturnValueOnce(sessionPromise({ _id: DECISION_ID }) as never)
      .mockReturnValueOnce(sessionPromise({ _id: DECISION_ID }) as never)
      .mockReturnValueOnce(sessionPromise(null) as never)
    const session = fakeSession()
    const identity = {
      domain: 'llm-verdict' as const,
      action: 'close' as const,
      subjectKey: POSTING_ID,
      postingId: POSTING_ID,
      inputHash: 'd'.repeat(64),
      policyRevision: 'verdict-policy:v4',
      configRevision: 9,
      sourceRevisions,
    }

    await expect(hasRestoredQualityDecision(identity, session)).resolves.toBe(true)
    await expect(hasRestoredQualityDecision({ ...identity, configRevision: 10 }, session)).resolves.toBe(true)
    await expect(hasRestoredQualityDecision({
      ...identity,
      sourceRevisions: sourceRevisions.map((revision) => (
        revision.sourceId === 'jsearch'
          ? { ...revision, controlRevision: revision.controlRevision + 1 }
          : revision
      )),
    }, session)).resolves.toBe(false)

    const firstKey = (exists.mock.calls[0][0] as { decisionKey: string }).decisionKey
    const secondKey = (exists.mock.calls[1][0] as { decisionKey: string }).decisionKey
    const authorityChangedKey = (exists.mock.calls[2][0] as { decisionKey: string }).decisionKey
    expect(firstKey).toBe(secondKey)
    expect(authorityChangedKey).not.toBe(firstKey)
    expect(exists.mock.calls[0][0]).toMatchObject({ recordType: 'automatic', reviewStatus: 'restored' })
    expect((exists.mock.results[0].value as { session: ReturnType<typeof vi.fn> }).session).toHaveBeenCalledWith(session)
  })
})

describe('review CAS and immutable child evidence', () => {
  const command: ReviewQualityDecisionCommand = {
    operationId: '018f6f08-8c2d-7b2e-9ca1-4ad0e35f8321',
    decisionId: DECISION_ID,
    action: 'restore',
    expectedReviewRevision: 0,
    actorUserId: ACTOR_ID,
    reason: 'Confirmed false positive after source and lifecycle revalidation.',
  }

  const root = {
    _id: DECISION_ID,
    decisionKey: `quality:v1:${'e'.repeat(64)}`,
    domain: 'hard-drop' as const,
    automaticAction: 'drop' as const,
    subjectKeyHash: 'f'.repeat(64),
    inputHash: 'a'.repeat(64),
    policyRevision: 'quality-gate:v3',
    sourceRevisions,
    evidence: hardDropInput.evidence,
    reviewOverlay: {
      title: 'Frontend Engineer',
      company: 'Example Ltd',
      city: 'Bengaluru',
      isRemote: false,
      descriptionExcerpt: 'x'.repeat(4_000),
      viaSite: 'Example Jobs',
      domainHint: 'frontend',
    },
    serviceActor: 'jobs-ingest' as const,
    reviewStatus: 'unreviewed' as const,
    reviewRevision: 0,
    seenCount: 1,
    occurredAt: NOW,
    lastSeenAt: NOW,
  }

  it('runs the caller lifecycle hook inside the root CAS and child insert boundary', async () => {
    const session = fakeSession()
    const findOne = vi.spyOn(JobQualityDecision, 'findOne')
      .mockReturnValueOnce(queryWithLean(null) as never)
      .mockReturnValueOnce(queryWithLean(root) as never)
    const update = vi.spyOn(JobQualityDecision, 'updateOne')
      .mockResolvedValue({ matchedCount: 1 } as never)
    const create = vi.spyOn(JobQualityDecision, 'create')
      .mockResolvedValue([] as never)
    const beforeCommit = vi.fn(async (_transition, callbackSession, callbackRoot) => {
      expect(callbackSession).toBe(session)
      expect(callbackRoot).toMatchObject({
        id: String(DECISION_ID),
        decisionKey: root.decisionKey,
        subjectKeyHash: root.subjectKeyHash,
        reviewOverlay: root.reviewOverlay,
      })
      expect(callbackRoot).not.toHaveProperty('subjectKey')
      expect(callbackRoot).not.toHaveProperty('replaySnapshot')
      expect(create).not.toHaveBeenCalled()
    })

    const result = await reviewQualityDecisionInSession(command, session, beforeCommit)

    expect(result).toMatchObject({
      decisionId: String(DECISION_ID),
      domain: 'hard-drop',
      reviewStatus: 'restored',
      reviewRevision: 1,
      idempotent: false,
    })
    expect(findOne).toHaveBeenCalledTimes(2)
    expect(update).toHaveBeenCalledWith(
      {
        _id: DECISION_ID,
        recordType: 'automatic',
        reviewStatus: 'unreviewed',
        reviewRevision: 0,
      },
      { $set: { reviewStatus: 'restored' }, $inc: { reviewRevision: 1 } },
      { session, runValidators: true },
    )
    expect(beforeCommit).toHaveBeenCalledWith(expect.objectContaining({
      fromReviewStatus: 'unreviewed',
      toReviewStatus: 'restored',
      previousReviewRevision: 0,
      reviewRevision: 1,
    }), session, expect.objectContaining({
      subjectKeyHash: root.subjectKeyHash,
      reviewOverlay: root.reviewOverlay,
    }))
    expect(create).toHaveBeenCalledWith([expect.objectContaining({
      recordType: 'review',
      operationId: command.operationId,
      rootDecisionId: DECISION_ID,
      rootDecisionKey: root.decisionKey,
      reviewAction: 'restore',
      actorUserId: new mongoose.Types.ObjectId(ACTOR_ID),
      reason: command.reason,
      fromReviewStatus: 'unreviewed',
      toReviewStatus: 'restored',
      previousReviewRevision: 0,
      resultingReviewRevision: 1,
    })], { session })
  })

  it('fails a lost CAS without invoking lifecycle work or creating a child row', async () => {
    const session = fakeSession()
    vi.spyOn(JobQualityDecision, 'findOne')
      .mockReturnValueOnce(queryWithLean(null) as never)
      .mockReturnValueOnce(queryWithLean(root) as never)
    vi.spyOn(JobQualityDecision, 'updateOne').mockResolvedValue({ matchedCount: 0 } as never)
    const create = vi.spyOn(JobQualityDecision, 'create').mockResolvedValue([] as never)
    const beforeCommit = vi.fn()

    await expect(reviewQualityDecisionInSession(command, session, beforeCommit))
      .rejects.toThrow(QualityDecisionConflictError)
    expect(beforeCommit).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('replays an immutable review child without rerunning the lifecycle hook', async () => {
    const session = fakeSession()
    const commandHash = (await import('crypto')).createHash('sha256').update(JSON.stringify({
      operationId: command.operationId,
      decisionId: String(command.decisionId),
      action: command.action,
      expectedReviewRevision: command.expectedReviewRevision,
      actorUserId: command.actorUserId,
      reason: command.reason,
    })).digest('hex')
    vi.spyOn(JobQualityDecision, 'findOne').mockReturnValue(queryWithLean({
      operationId: command.operationId,
      commandHash,
      rootDecisionId: DECISION_ID,
      rootDecisionKey: root.decisionKey,
      domain: 'hard-drop',
      toReviewStatus: 'restored',
      resultingReviewRevision: 1,
    }) as never)
    const update = vi.spyOn(JobQualityDecision, 'updateOne')
    const create = vi.spyOn(JobQualityDecision, 'create')
    const beforeCommit = vi.fn()

    await expect(reviewQualityDecisionInSession(command, session, beforeCommit)).resolves.toMatchObject({
      idempotent: true,
      reviewStatus: 'restored',
    })
    expect(update).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    expect(beforeCommit).not.toHaveBeenCalled()
  })
})

describe('sanitized decision reads', () => {
  const listedRoot = {
    _id: DECISION_ID,
    decisionKey: `quality:v1:${'3'.repeat(64)}`,
    domain: 'hard-drop',
    automaticAction: 'drop',
    subjectKeyHash: '4'.repeat(64),
    inputHash: 'a'.repeat(64),
    policyRevision: 'quality-gate:v3',
    sourceRevisions,
    evidence: hardDropInput.evidence,
    reviewOverlay: {
      title: 'Frontend Engineer',
      company: 'Example Ltd',
      city: 'Bengaluru',
      isRemote: false,
      descriptionExcerpt: 'Bounded operator context.',
      viaSite: 'Example Jobs',
      domainHint: 'frontend',
    },
    serviceActor: 'jobs-ingest',
    reviewStatus: 'unreviewed',
    reviewRevision: 0,
    seenCount: 1,
    occurredAt: NOW,
    lastSeenAt: NOW,
    operationId: 'must-not-leak',
    commandHash: '7'.repeat(64),
    actorUserId: ACTOR_ID,
    reason: 'must-not-leak',
    rawUrl: 'https://jobs.example.com/private',
  }

  it('pages reviewable roots through an inclusion projection without review secrets or URLs', async () => {
    const olderId = new mongoose.Types.ObjectId('507f1f77bcf86cd799439013')
    const chain = {
      sort: vi.fn(),
      limit: vi.fn(),
      lean: vi.fn().mockResolvedValue([
        listedRoot,
        { ...listedRoot, _id: olderId, occurredAt: new Date(NOW.getTime() - 1_000) },
      ]),
    }
    chain.sort.mockReturnValue(chain)
    chain.limit.mockReturnValue(chain)
    const find = vi.spyOn(JobQualityDecision, 'find').mockReturnValue(chain as never)

    const result = await listQualityDecisionPage({
      reviewStatuses: ['unreviewed', 'upheld'],
      limit: 1,
    })

    expect(result.items).toEqual([expect.objectContaining({
      id: String(DECISION_ID),
      decisionKey: listedRoot.decisionKey,
      reviewStatus: 'unreviewed',
      reviewOverlay: listedRoot.reviewOverlay,
    })])
    expect(result.nextCursor).toEqual({ occurredAt: NOW, id: String(DECISION_ID) })
    expect(find).toHaveBeenCalledWith({
      recordType: 'automatic',
      reviewStatus: { $in: ['unreviewed', 'upheld'] },
    }, {
      decisionKey: 1,
      domain: 1,
      automaticAction: 1,
      postingId: 1,
      inputHash: 1,
      policyRevision: 1,
      configRevision: 1,
      sourceRevisions: 1,
      evidence: 1,
      reviewOverlay: 1,
      serviceActor: 1,
      reviewStatus: 1,
      reviewRevision: 1,
      seenCount: 1,
      occurredAt: 1,
      lastSeenAt: 1,
    })
    expect(chain.sort).toHaveBeenCalledWith({ occurredAt: -1, _id: -1 })
    expect(chain.limit).toHaveBeenCalledWith(2)
    expect(JSON.stringify(result)).not.toContain('must-not-leak')
    expect(JSON.stringify(result)).not.toContain('https://')
    expect(result.items[0]).not.toHaveProperty('subjectKeyHash')
    expect(result.items[0]).not.toHaveProperty('actorUserId')
  })

  it('uses a stable occurredAt/ObjectId cursor and preserves the reviewable compatibility query', async () => {
    const chain = {
      sort: vi.fn(),
      limit: vi.fn(),
      lean: vi.fn().mockResolvedValue([listedRoot]),
    }
    chain.sort.mockReturnValue(chain)
    chain.limit.mockReturnValue(chain)
    const find = vi.spyOn(JobQualityDecision, 'find').mockReturnValue(chain as never)

    await listQualityDecisionPage({
      reviewStatuses: ['restored'],
      limit: 20,
      before: { occurredAt: NOW, id: DECISION_ID },
    })
    expect(find.mock.calls[0][0]).toEqual({
      recordType: 'automatic',
      reviewStatus: { $in: ['restored'] },
      $or: [
        { occurredAt: { $lt: NOW } },
        { occurredAt: NOW, _id: { $lt: DECISION_ID } },
      ],
    })

    find.mockClear()
    await listReviewableQualityDecisions(20)
    expect(find.mock.calls[0][0]).toEqual({
      recordType: 'automatic',
      reviewStatus: { $in: ['unreviewed', 'upheld'] },
    })
  })

  it('gets one automatic root by exact ObjectId through the same safe projection', async () => {
    const query = queryWithLean(listedRoot)
    const findOne = vi.spyOn(JobQualityDecision, 'findOne').mockReturnValue(query as never)

    await expect(getAutomaticQualityDecision(DECISION_ID)).resolves.toEqual(
      expect.objectContaining({ id: String(DECISION_ID), reviewStatus: 'unreviewed' }),
    )
    expect(findOne.mock.calls[0][0]).toEqual({
      _id: DECISION_ID,
      recordType: 'automatic',
    })
    expect(JSON.stringify(findOne.mock.calls[0][1])).not.toContain('subjectKeyHash')
  })

  it('returns one decision immutable review history in chronological order', async () => {
    const reviewId = new mongoose.Types.ObjectId('507f1f77bcf86cd799439014')
    const chain = {
      sort: vi.fn(),
      limit: vi.fn(),
      lean: vi.fn().mockResolvedValue([{
        _id: reviewId,
        operationId: 'review-operation-1',
        reviewAction: 'restore',
        actorUserId: new mongoose.Types.ObjectId(ACTOR_ID),
        reason: 'Verified false positive.',
        fromReviewStatus: 'upheld',
        toReviewStatus: 'restored',
        previousReviewRevision: 1,
        resultingReviewRevision: 2,
        occurredAt: NOW,
      }]),
    }
    chain.sort.mockReturnValue(chain)
    chain.limit.mockReturnValue(chain)
    const find = vi.spyOn(JobQualityDecision, 'find').mockReturnValue(chain as never)

    await expect(getQualityDecisionReviewHistory(DECISION_ID)).resolves.toEqual([{
      id: String(reviewId),
      operationId: 'review-operation-1',
      action: 'restore',
      actorUserId: ACTOR_ID,
      reason: 'Verified false positive.',
      fromReviewStatus: 'upheld',
      toReviewStatus: 'restored',
      previousReviewRevision: 1,
      resultingReviewRevision: 2,
      occurredAt: NOW,
    }])
    expect(find.mock.calls[0][0]).toEqual({
      recordType: 'review',
      rootDecisionId: DECISION_ID,
    })
    expect(chain.sort).toHaveBeenCalledWith({ occurredAt: 1, _id: 1 })
    expect(chain.limit).toHaveBeenCalledWith(100)
  })
})

describe('quality-decision transaction helper', () => {
  it('uses a primary majority snapshot transaction and always ends the session', async () => {
    const session = {
      withTransaction: vi.fn(async (work: () => Promise<void>) => work()),
      endSession: vi.fn().mockResolvedValue(undefined),
    }
    vi.spyOn(mongoose, 'startSession').mockResolvedValue(session as never)

    await expect(withQualityDecisionTransaction(async (active) => {
      expect(active).toBe(session)
      return 'committed'
    })).resolves.toBe('committed')
    expect(session.withTransaction).toHaveBeenCalledWith(expect.any(Function), {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
      readPreference: 'primary',
    })
    expect(session.endSession).toHaveBeenCalledOnce()
  })

  it('maps standalone Mongo transaction failures to an explicit rollout error', async () => {
    const session = {
      withTransaction: vi.fn().mockRejectedValue(Object.assign(new Error('Transaction numbers are only allowed on a replica set member'), { code: 20 })),
      endSession: vi.fn().mockResolvedValue(undefined),
    }
    vi.spyOn(mongoose, 'startSession').mockResolvedValue(session as never)

    await expect(withQualityDecisionTransaction(async () => 'never'))
      .rejects.toBeInstanceOf(QualityDecisionTransactionsRequiredError)
    expect(session.endSession).toHaveBeenCalledOnce()
  })
})
