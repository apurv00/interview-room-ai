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

function query(value: unknown) {
  return { select: () => ({ lean: async () => value }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.supportsAnalysis.mockReturnValue(true)
  mocks.retentionPurged.mockResolvedValue(false)
  mocks.bindingFindOneAndUpdate.mockResolvedValue({ _id: objectId('3'.repeat(24)) })
  mocks.bindingExists.mockResolvedValue({ _id: objectId('3'.repeat(24)) })
  mocks.sessionFindOne.mockReturnValue(query(session()))
  mocks.sessionUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.outboxUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.deleteObjects.mockResolvedValue(undefined)
})

describe('runtime multimodal analysis payload reservation', () => {
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
})
