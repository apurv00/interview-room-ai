import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  outboxFindOneAndUpdate: vi.fn(),
  outboxFindOne: vi.fn(),
  outboxUpdateOne: vi.fn(),
  bindingFindOneAndUpdate: vi.fn(),
  bindingExists: vi.fn(),
  sessionFindOne: vi.fn(),
  sessionUpdateOne: vi.fn(),
  supportsAnalysis: vi.fn(),
  retentionPurged: vi.fn(),
  publish: vi.fn(),
  deleteObjects: vi.fn(),
}))

vi.mock('../models/HireRuntimeMultimodalAnalysisOutbox', () => ({
  HireRuntimeMultimodalAnalysisOutbox: {
    findOneAndUpdate: mocks.outboxFindOneAndUpdate,
    findOne: mocks.outboxFindOne,
    updateOne: mocks.outboxUpdateOne,
  },
}))
vi.mock('../models/HireRuntimeBinding', () => ({
  HireRuntimeBinding: {
    findOneAndUpdate: mocks.bindingFindOneAndUpdate,
    exists: mocks.bindingExists,
  },
}))
vi.mock('@shared/db/models/InterviewSession', () => ({
  InterviewSession: {
    findOne: mocks.sessionFindOne,
    updateOne: mocks.sessionUpdateOne,
  },
}))
vi.mock('@hire', () => ({
  supportsHireMultimodalObservations: mocks.supportsAnalysis,
}))
vi.mock('../services/multimodalObservationRetentionService', () => ({
  isHireRuntimeMultimodalObservationRetentionPurged: mocks.retentionPurged,
}))
vi.mock('../services/controlBridgeClient', () => ({
  publishMultimodalAnalysisToControl: mocks.publish,
}))
vi.mock('../services/runtimeMediaManifest', () => ({
  deleteRuntimePersonalObjects: mocks.deleteObjects,
}))

import { __hireRuntimeMultimodalAnalysisPublisher } from '../services/multimodalAnalysisPublisher'

const IDS = {
  workspaceId: 'a'.repeat(24),
  applicationId: 'b'.repeat(24),
  roundId: 'c'.repeat(24),
  principalId: 'd'.repeat(24),
  runtimeSessionId: 'e'.repeat(24),
  outboxId: 'f'.repeat(24),
}

function objectId(value: string) {
  return { toString: () => value }
}

function outbox(overrides: Record<string, unknown> = {}) {
  return {
    _id: objectId(IDS.outboxId),
    workspaceId: objectId(IDS.workspaceId),
    applicationId: objectId(IDS.applicationId),
    roundId: objectId(IDS.roundId),
    principalId: objectId(IDS.principalId),
    runtimeSessionId: objectId(IDS.runtimeSessionId),
    attempt: 1,
    revision: 1,
    consentVersion: 'hire-ai-v6-2026-08-20',
    policyVersion: 'hire-recorded-interview-analysis-v1',
    eventId: '1'.repeat(64),
    artifactDigest: '2'.repeat(64),
    capturedAt: new Date('2026-08-21T00:00:00.000Z'),
    landmarkArtifact: {
      sourceKey: 'landmarks/private/raw.json',
      contentType: 'application/json',
      sizeBytes: 1_024,
      sha256: '2'.repeat(64),
    },
    status: 'pending',
    payloadSnapshotProtocolVersion: 1,
    publishLeaseToken: 'lease-token',
    publishAttemptCount: 1,
    updatedAt: new Date('2026-08-21T00:01:00.000Z'),
    ...overrides,
  }
}

function session(overrides: Record<string, unknown> = {}) {
  return {
    _id: objectId(IDS.runtimeSessionId),
    status: 'completed',
    startedAt: new Date('2026-08-21T00:00:00.000Z'),
    completedAt: new Date('2026-08-21T00:01:00.000Z'),
    durationActualSeconds: 60,
    transcript: [{
      speaker: 'candidate',
      text: 'Original immutable answer',
      timestamp: 1_000,
      questionIndex: 0,
    }],
    liveTranscriptWords: [{
      word: 'Original',
      start: 1,
      end: 1.5,
      confidence: 0.99,
    }],
    ...overrides,
  }
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    eventId: '1'.repeat(64),
    workspaceId: IDS.workspaceId,
    applicationId: IDS.applicationId,
    roundId: IDS.roundId,
    runtimeSessionId: IDS.runtimeSessionId,
    attempt: 1,
    revision: 1,
    consentVersion: 'hire-ai-v6-2026-08-20',
    policyVersion: 'hire-recorded-interview-analysis-v1',
    capturedAt: '2026-08-21T00:00:00.000Z',
    durationMs: 60_000,
    landmarks: {
      kind: 'landmarks',
      sourceKey: 'landmarks/private/raw.json',
      contentType: 'application/json',
      sizeBytes: 1_024,
      sha256: '2'.repeat(64),
    },
    transcript: [],
    liveTranscriptWords: [],
    ...overrides,
  })
}

function query(value: unknown) {
  return { select: () => ({ lean: async () => value }) }
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.supportsAnalysis.mockReturnValue(true)
  mocks.retentionPurged.mockResolvedValue(false)
  mocks.bindingFindOneAndUpdate.mockResolvedValue({ _id: objectId('3'.repeat(24)) })
  mocks.bindingExists.mockResolvedValue({ _id: objectId('3'.repeat(24)) })
  mocks.sessionFindOne.mockReturnValue(query(session()))
  mocks.sessionUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.outboxUpdateOne.mockResolvedValue({ acknowledged: true, matchedCount: 1 })
  mocks.deleteObjects.mockResolvedValue(undefined)
})

describe('runtime multimodal analysis payload reservation', () => {
  it('preserves an attempted legacy analysis row for operator reconciliation', async () => {
    const claimed = outbox({
      payloadSnapshotProtocolVersion: undefined,
      publishAttemptCount: 2,
    })
    mocks.outboxFindOneAndUpdate.mockResolvedValueOnce(claimed)

    await expect(
      __hireRuntimeMultimodalAnalysisPublisher.publishOne(claimed as never),
    ).resolves.toBe('skipped')
    expect(mocks.sessionFindOne).not.toHaveBeenCalled()
    expect(mocks.publish).not.toHaveBeenCalled()
    expect(mocks.outboxUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: claimed._id, status: 'pending' }),
      expect.objectContaining({
        $set: expect.objectContaining({
          failureCode: 'HIRE_MULTIMODAL_ANALYSIS_PUBLISH_FAILED',
        }),
      }),
    )
  })

  it('adopts an unattempted legacy row before a safe defer and snapshots it on retry', async () => {
    const candidate = outbox({
      payloadSnapshotProtocolVersion: undefined,
      publishLeaseToken: undefined,
      publishAttemptCount: 0,
    })
    const firstClaim = outbox({
      publishLeaseToken: 'first-lease',
      publishAttemptCount: 1,
    })
    mocks.outboxFindOneAndUpdate.mockResolvedValueOnce(firstClaim)
    mocks.bindingFindOneAndUpdate.mockResolvedValueOnce(null)

    await expect(
      __hireRuntimeMultimodalAnalysisPublisher.publishOne(candidate as never),
    ).resolves.toBe('deferred')
    expect(mocks.outboxFindOneAndUpdate.mock.calls[0][0]).toMatchObject({
      _id: candidate._id,
      payloadSnapshotProtocolVersion: { $exists: false },
      publishAttemptCount: 0,
    })
    expect(mocks.outboxFindOneAndUpdate.mock.calls[0][1]).toMatchObject({
      $set: { payloadSnapshotProtocolVersion: 1, publishAttemptCount: 1 },
    })
    expect(mocks.sessionFindOne).not.toHaveBeenCalled()
    expect(mocks.publish).not.toHaveBeenCalled()

    const retryClaim = outbox({
      publishLeaseToken: 'retry-lease',
      publishAttemptCount: 2,
    })
    mocks.outboxFindOneAndUpdate.mockResolvedValueOnce(retryClaim)
    mocks.bindingFindOneAndUpdate.mockResolvedValueOnce({
      _id: objectId('3'.repeat(24)),
    })
    mocks.publish.mockResolvedValueOnce('processed')

    await expect(
      __hireRuntimeMultimodalAnalysisPublisher.publishOne(retryClaim as never),
    ).resolves.toBe('published')
    expect(mocks.sessionFindOne).toHaveBeenCalledOnce()
    expect(mocks.publish).toHaveBeenCalledOnce()
  })

  it('rejects a snapshot whose consent provenance differs from its outbox', async () => {
    const claimed = outbox({
      payloadSnapshotJson: snapshot({ consentVersion: 'hire-ai-v5-2026-08-12' }),
    })
    mocks.outboxFindOneAndUpdate.mockResolvedValueOnce(claimed)

    await expect(
      __hireRuntimeMultimodalAnalysisPublisher.publishOne(claimed as never),
    ).resolves.toBe('skipped')
    expect(mocks.publish).not.toHaveBeenCalled()
    expect(mocks.sessionFindOne).not.toHaveBeenCalled()
  })

  it('rejects a snapshot whose policy provenance differs from its outbox', async () => {
    const claimed = outbox({
      policyVersion: 'unexpected-policy',
      payloadSnapshotJson: snapshot(),
    })
    mocks.outboxFindOneAndUpdate.mockResolvedValueOnce(claimed)

    await expect(
      __hireRuntimeMultimodalAnalysisPublisher.publishOne(claimed as never),
    ).resolves.toBe('skipped')
    expect(mocks.publish).not.toHaveBeenCalled()
    expect(mocks.sessionFindOne).not.toHaveBeenCalled()
  })

  it('replays byte-identical payload after ambiguous ack despite session mutation', async () => {
    const firstClaim = outbox()
    mocks.outboxFindOneAndUpdate.mockResolvedValueOnce(firstClaim)
    mocks.publish.mockRejectedValueOnce(
      new Error('connection closed after control commit'),
    )

    await expect(
      __hireRuntimeMultimodalAnalysisPublisher.publishOne(firstClaim as never),
    ).resolves.toBe('skipped')
    const firstPayload = mocks.publish.mock.calls[0][0]
    const snapshot = mocks.outboxUpdateOne.mock.calls.find(
      ([, update]) => update.$set?.payloadSnapshotJson,
    )?.[1].$set.payloadSnapshotJson as string
    expect(snapshot).toBe(JSON.stringify(firstPayload))

    mocks.sessionFindOne.mockReturnValue(
      query(session({
        transcript: [{
          speaker: 'candidate',
          text: 'Mutated after the ambiguous acknowledgement',
          timestamp: 5_000,
        }],
        liveTranscriptWords: [],
      })),
    )
    const retryClaim = outbox({
      publishLeaseToken: 'retry-lease-token',
      publishAttemptCount: 2,
      payloadSnapshotJson: snapshot,
    })
    mocks.outboxFindOneAndUpdate.mockResolvedValueOnce(retryClaim)
    mocks.publish.mockResolvedValueOnce('duplicate')

    await expect(
      __hireRuntimeMultimodalAnalysisPublisher.publishOne(retryClaim as never),
    ).resolves.toBe('published')

    expect(mocks.sessionFindOne).toHaveBeenCalledOnce()
    expect(mocks.publish.mock.calls[1][0]).toEqual(firstPayload)
    expect(JSON.stringify(mocks.publish.mock.calls[1][0])).toBe(snapshot)
    expect(mocks.outboxUpdateOne.mock.calls.at(-1)?.[1]).toMatchObject({
      $set: { status: 'published' },
      $unset: {
        payloadSnapshotJson: 1,
        landmarkArtifact: 1,
        publishLeaseToken: 1,
      },
    })
  })

  it('carries v2 nonce authority to control and erases it with the acknowledged artifact', async () => {
    const objectKeyNonce = '8'.repeat(64)
    const sourceKey = `landmarks/v2/${'9'.repeat(64)}`
    const claimed = outbox({
      landmarkArtifact: {
        sourceKey,
        objectKeyNonce,
        contentType: 'application/json',
        sizeBytes: 1_024,
        sha256: '2'.repeat(64),
      },
    })
    mocks.outboxFindOneAndUpdate.mockResolvedValueOnce(claimed)
    mocks.publish.mockResolvedValueOnce('processed')

    await expect(
      __hireRuntimeMultimodalAnalysisPublisher.publishOne(claimed as never),
    ).resolves.toBe('published')

    expect(mocks.publish.mock.calls[0]?.[0].landmarks).toMatchObject({
      sourceKey,
      objectKeyNonce,
    })
    expect(mocks.deleteObjects).toHaveBeenCalledWith({
      principalId: IDS.principalId,
      objects: [{
        key: sourceKey,
        runtimeSessionId: IDS.runtimeSessionId,
        objectKeyNonce,
      }],
    })
    expect(mocks.outboxUpdateOne.mock.calls.at(-1)?.[1].$unset).toMatchObject({
      landmarkArtifact: 1,
      payloadSnapshotJson: 1,
    })
    expect(mocks.outboxUpdateOne.mock.calls.at(-1)?.[2]).toEqual({
      writeConcern: { w: 'majority', j: true },
    })
  })

  it('does not cross control when the nonce-bearing snapshot lacks a majority acknowledgement', async () => {
    const claimed = outbox()
    mocks.outboxFindOneAndUpdate.mockResolvedValueOnce(claimed)
    mocks.outboxUpdateOne
      .mockResolvedValueOnce({ acknowledged: false, matchedCount: 1 })
      .mockResolvedValueOnce({ acknowledged: true, matchedCount: 1 })

    await expect(
      __hireRuntimeMultimodalAnalysisPublisher.publishOne(claimed as never),
    ).resolves.toBe('skipped')

    expect(mocks.publish).not.toHaveBeenCalled()
    expect(mocks.outboxUpdateOne.mock.calls[0]?.[2]).toEqual({
      writeConcern: { w: 'majority', j: true },
    })
    expect(mocks.outboxUpdateOne.mock.calls.at(-1)?.[1]).toMatchObject({
      $set: {
        failureCode: 'HIRE_MULTIMODAL_ANALYSIS_PUBLISH_FAILED',
      },
    })
  })

  it('does not report success when acknowledged nonce erasure lacks durable acknowledgement', async () => {
    const claimed = outbox({ payloadSnapshotJson: snapshot() })
    mocks.outboxFindOneAndUpdate.mockResolvedValueOnce(claimed)
    mocks.publish.mockResolvedValueOnce('processed')
    mocks.outboxUpdateOne
      .mockResolvedValueOnce({ acknowledged: false, matchedCount: 1 })
      .mockResolvedValueOnce({ acknowledged: true, matchedCount: 1 })

    await expect(
      __hireRuntimeMultimodalAnalysisPublisher.publishOne(claimed as never),
    ).resolves.toBe('skipped')

    expect(mocks.publish).toHaveBeenCalledOnce()
    expect(mocks.deleteObjects).toHaveBeenCalledOnce()
    expect(mocks.outboxUpdateOne.mock.calls[0]?.[1].$unset).toMatchObject({
      landmarkArtifact: 1,
      payloadSnapshotJson: 1,
    })
    expect(mocks.outboxUpdateOne.mock.calls[0]?.[2]).toEqual({
      writeConcern: { w: 'majority', j: true },
    })
    expect(mocks.outboxUpdateOne.mock.calls.at(-1)?.[1]).toMatchObject({
      $set: {
        failureCode: 'HIRE_MULTIMODAL_ANALYSIS_PUBLISH_FAILED',
      },
    })
  })
})
