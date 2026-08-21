import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HIRE_AI_CONSENT_VERSION } from '@hire-multimodal-boundary'

const mocks = vi.hoisted(() => ({
  interviewFindOne: vi.fn(),
  bindingFindOneAndUpdate: vi.fn(),
  bindingUpdateOne: vi.fn(),
}))

vi.mock('@shared/db/models/InterviewSession', () => ({
  InterviewSession: { findOne: mocks.interviewFindOne },
}))
vi.mock('../models/HireRuntimeBinding', () => ({
  HireRuntimeBinding: {
    findOneAndUpdate: mocks.bindingFindOneAndUpdate,
    updateOne: mocks.bindingUpdateOne,
  },
}))

import { terminalizeRuntimeReplayMedia } from '../services/mediaCompletionService'

const IDS = {
  binding: '1'.repeat(24),
  workspace: '2'.repeat(24),
  principal: '3'.repeat(24),
  session: '4'.repeat(24),
}

function objectId(value: string) {
  return { toString: () => value }
}

function binding(overrides: Record<string, unknown> = {}) {
  return {
    _id: objectId(IDS.binding),
    workspaceId: objectId(IDS.workspace),
    principalId: objectId(IDS.principal),
    runtimeSessionId: objectId(IDS.session),
    status: 'completed',
    consentVersion: HIRE_AI_CONSENT_VERSION,
    mediaCompletionContractVersion: 1,
    cameraMediaStatus: 'pending',
    screenMediaStatus: 'pending',
    ...overrides,
  }
}

function interviewQuery(value: unknown) {
  const query = {
    select: vi.fn(),
    lean: vi.fn().mockResolvedValue(value),
  }
  query.select.mockReturnValue(query)
  return query
}

function snapshots(...values: unknown[]) {
  values.forEach((value) => {
    mocks.interviewFindOne.mockReturnValueOnce(interviewQuery(value))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.bindingUpdateOne.mockResolvedValue({ matchedCount: 1 })
})

describe('runtime replay terminalization CAS', () => {
  it('claims and rechecks capabilities, manifest, per-kind drain, and exact artifact version', async () => {
    const current = binding()
    const snapshot = {
      status: 'completed',
      recordingR2Key: null,
      recordingSizeBytes: null,
      recordingArtifactVersion: 3,
    }
    snapshots(snapshot, snapshot)
    mocks.bindingFindOneAndUpdate
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(binding({
        cameraMediaStatus: 'unavailable',
        cameraMediaUnavailableReason: 'retry_exhausted',
      }))

    await expect(terminalizeRuntimeReplayMedia({
      binding: current as never,
      kind: 'camera',
      reason: 'retry_exhausted',
      now: new Date('2026-08-10T00:00:00.000Z'),
    })).resolves.toBe('recorded')

    const [claimFilter, claimUpdate] = mocks.bindingFindOneAndUpdate.mock.calls[0]
    expect(claimFilter).toMatchObject({
      cameraMediaStatus: { $nin: ['published', 'unavailable'] },
      pendingMediaManifest: { $exists: false },
      issuedObjectCapabilities: {
        $not: { $elemMatch: { key: expect.any(RegExp), expiresAt: { $gt: expect.any(Date) } } },
      },
      issuedMultipartCapabilities: {
        $not: { $elemMatch: { key: expect.any(RegExp), expiresAt: { $gt: expect.any(Date) } } },
      },
      mediaWriteReservations: {
        $not: { $elemMatch: { kind: 'camera', expiresAt: { $gt: expect.any(Date) } } },
      },
      runtimeWriteDrainUntil: { $not: { $gt: expect.any(Date) } },
      revokedAt: { $exists: false },
      purgePersonalData: { $ne: true },
    })
    expect(claimUpdate.$set).toMatchObject({
      cameraMediaTerminalClaimToken: expect.stringMatching(/^[a-f0-9]{64}$/),
      cameraMediaTerminalClaimArtifactVersion: 3,
    })

    const [finalFilter, finalUpdate] = mocks.bindingFindOneAndUpdate.mock.calls[1]
    expect(finalFilter).toMatchObject({
      cameraMediaTerminalClaimToken: claimUpdate.$set.cameraMediaTerminalClaimToken,
      cameraMediaTerminalClaimArtifactVersion: 3,
      pendingMediaManifest: { $exists: false },
      mediaWriteReservations: {
        $not: { $elemMatch: { kind: 'camera', expiresAt: { $gt: expect.any(Date) } } },
      },
      runtimeWriteDrainUntil: { $not: { $gt: expect.any(Date) } },
      revokedAt: { $exists: false },
      purgePersonalData: { $ne: true },
    })
    expect(finalUpdate).toMatchObject({
      $set: {
        cameraMediaStatus: 'unavailable',
        cameraMediaUnavailableReason: 'retry_exhausted',
        publishRetryAt: expect.any(Date),
      },
      $unset: {
        cameraMediaTerminalClaimToken: 1,
        cameraMediaTerminalClaimArtifactVersion: 1,
        cameraMediaUnavailableReportedAt: 1,
      },
    })
  })

  it('terminalizes an ordinary revoked binding only after its durable media deadline', async () => {
    const now = new Date('2026-08-10T00:00:00.000Z')
    const revokedAt = new Date('2026-08-09T22:00:00.000Z')
    const mediaCompletionDeadlineAt = new Date('2026-08-09T23:00:00.000Z')
    const current = binding({
      status: 'revoked',
      revokedAt,
      purgePersonalData: false,
      mediaCompletionDeadlineAt,
    })
    const snapshot = {
      status: 'completed',
      recordingR2Key: null,
      recordingSizeBytes: null,
      recordingArtifactVersion: 6,
    }
    snapshots(snapshot, snapshot)
    mocks.bindingFindOneAndUpdate
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(binding({
        status: 'revoked',
        revokedAt,
        mediaCompletionDeadlineAt,
        cameraMediaStatus: 'unavailable',
        cameraMediaUnavailableReason: 'upload_expired',
      }))

    await expect(terminalizeRuntimeReplayMedia({
      binding: current as never,
      kind: 'camera',
      reason: 'upload_expired',
      now,
    })).resolves.toBe('recorded')

    const [claimFilter] = mocks.bindingFindOneAndUpdate.mock.calls[0]
    expect(claimFilter).toMatchObject({
      status: 'revoked',
      revokedAt,
      mediaCompletionDeadlineAt,
      purgePersonalData: { $ne: true },
      pendingMediaManifest: expect.any(Object),
      issuedObjectCapabilities: expect.any(Object),
      issuedMultipartCapabilities: expect.any(Object),
      mediaWriteReservations: expect.any(Object),
      runtimeWriteDrainUntil: expect.any(Object),
    })
    const [finalFilter, finalUpdate] = mocks.bindingFindOneAndUpdate.mock.calls[1]
    expect(finalFilter).toMatchObject({
      status: 'revoked',
      revokedAt,
      mediaCompletionDeadlineAt,
      purgePersonalData: { $ne: true },
      cameraMediaTerminalClaimArtifactVersion: 6,
      pendingMediaManifest: expect.any(Object),
      issuedObjectCapabilities: expect.any(Object),
      issuedMultipartCapabilities: expect.any(Object),
      mediaWriteReservations: expect.any(Object),
      runtimeWriteDrainUntil: expect.any(Object),
    })
    expect(finalUpdate.$set).toMatchObject({
      cameraMediaStatus: 'unavailable',
      cameraMediaUnavailableReason: 'upload_expired',
      cameraMediaUnavailableAt: now,
    })
  })

  it('does not terminalize an ordinary revoked binding before its media deadline', async () => {
    const now = new Date('2026-08-10T00:00:00.000Z')

    await expect(terminalizeRuntimeReplayMedia({
      binding: binding({
        status: 'revoked',
        revokedAt: new Date('2026-08-09T22:00:00.000Z'),
        mediaCompletionDeadlineAt: new Date('2026-08-10T00:00:00.001Z'),
      }) as never,
      kind: 'camera',
      reason: 'upload_expired',
      now,
    })).resolves.toBe('in_flight')

    expect(mocks.interviewFindOne).not.toHaveBeenCalled()
    expect(mocks.bindingFindOneAndUpdate).not.toHaveBeenCalled()
  })

  it('rejects a privacy-purge binding before reading or claiming replay state', async () => {
    await expect(terminalizeRuntimeReplayMedia({
      binding: binding({
        status: 'revoked',
        revokedAt: new Date('2026-08-09T22:00:00.000Z'),
        purgePersonalData: true,
      }) as never,
      kind: 'camera',
      reason: 'upload_expired',
    })).resolves.toBe('state_changed')

    expect(mocks.interviewFindOne).not.toHaveBeenCalled()
    expect(mocks.bindingFindOneAndUpdate).not.toHaveBeenCalled()
    expect(mocks.bindingUpdateOne).not.toHaveBeenCalled()
  })

  it('fails closed when privacy purge wins after an ordinary-revocation claim', async () => {
    const now = new Date('2026-08-10T00:00:00.000Z')
    const revokedAt = new Date('2026-08-09T22:00:00.000Z')
    const current = binding({
      status: 'revoked',
      revokedAt,
      mediaCompletionDeadlineAt: new Date('2026-08-09T23:00:00.000Z'),
    })
    const snapshot = {
      status: 'completed',
      recordingR2Key: null,
      recordingSizeBytes: null,
      recordingArtifactVersion: 2,
    }
    snapshots(snapshot, snapshot)
    mocks.bindingFindOneAndUpdate
      .mockResolvedValueOnce(current)
      // The final `$ne: true` CAS rejects the row after privacy flips the flag.
      .mockResolvedValueOnce(null)

    await expect(terminalizeRuntimeReplayMedia({
      binding: current as never,
      kind: 'camera',
      reason: 'upload_expired',
      now,
    })).resolves.toBe('state_changed')

    const [finalFilter] = mocks.bindingFindOneAndUpdate.mock.calls[1]
    expect(finalFilter).toMatchObject({
      status: 'revoked',
      revokedAt,
      purgePersonalData: { $ne: true },
      cameraMediaTerminalClaimArtifactVersion: 2,
    })
    expect(mocks.bindingUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        cameraMediaTerminalClaimToken: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        $unset: expect.objectContaining({
          cameraMediaTerminalClaimToken: 1,
        }),
      }),
    )
  })

  it('blocks terminalization while an exact empty-manifest result snapshot is staged', async () => {
    const current = binding({
      pendingMediaManifest: [],
      pendingResultPayloadJson: JSON.stringify({ revision: 1 }),
    })
    snapshots({
      status: 'completed',
      recordingR2Key: null,
      recordingSizeBytes: null,
      recordingArtifactVersion: 0,
    })
    mocks.bindingFindOneAndUpdate.mockResolvedValueOnce(null)

    await expect(terminalizeRuntimeReplayMedia({
      binding: current as never,
      kind: 'camera',
      reason: 'upload_expired',
    })).resolves.toBe('in_flight')

    expect(mocks.bindingFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        pendingMediaManifest: { $exists: false },
      }),
      expect.any(Object),
      expect.any(Object),
    )
    expect(mocks.bindingUpdateOne).not.toHaveBeenCalled()
  })

  it.each([
    ['capability'],
    ['pending manifest'],
    ['held multipart finalization'],
  ])('returns in-flight when the claim CAS observes a concurrent %s', async () => {
    snapshots({
      status: 'completed',
      recordingR2Key: null,
      recordingSizeBytes: null,
      recordingArtifactVersion: 0,
    })
    mocks.bindingFindOneAndUpdate.mockResolvedValueOnce(null)

    await expect(terminalizeRuntimeReplayMedia({
      binding: binding() as never,
      kind: 'camera',
      reason: 'upload_rejected',
    })).resolves.toBe('in_flight')

    expect(mocks.bindingFindOneAndUpdate).toHaveBeenCalledOnce()
    expect(mocks.bindingUpdateOne).not.toHaveBeenCalled()
  })

  it('releases its claim when concurrent finalization advances the artifact version', async () => {
    const current = binding()
    snapshots(
      {
        status: 'completed',
        recordingR2Key: null,
        recordingSizeBytes: null,
        recordingArtifactVersion: 4,
      },
      {
        status: 'completed',
        recordingR2Key: `recordings/${IDS.principal}/${IDS.session}-1700000000000.webm`,
        recordingSizeBytes: 1024,
        recordingArtifactVersion: 5,
      },
    )
    mocks.bindingFindOneAndUpdate.mockResolvedValueOnce(current)

    await expect(terminalizeRuntimeReplayMedia({
      binding: current as never,
      kind: 'camera',
      reason: 'retry_exhausted',
    })).resolves.toBe('in_flight')

    expect(mocks.bindingFindOneAndUpdate).toHaveBeenCalledOnce()
    expect(mocks.bindingUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        cameraMediaTerminalClaimToken: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      {
        $unset: {
          cameraMediaTerminalClaimToken: 1,
          cameraMediaTerminalClaimExpiresAt: 1,
          cameraMediaTerminalClaimArtifactVersion: 1,
        },
      },
    )
  })

  it('reports an already-associated artifact separately so the publisher can ingest it', async () => {
    snapshots({
      status: 'completed',
      recordingR2Key: `recordings/${IDS.principal}/${IDS.session}-1700000000000.webm`,
      recordingSizeBytes: 1024,
      recordingArtifactVersion: 1,
    })

    await expect(terminalizeRuntimeReplayMedia({
      binding: binding() as never,
      kind: 'camera',
      reason: 'upload_expired',
    })).resolves.toBe('artifact_present')

    expect(mocks.bindingFindOneAndUpdate).not.toHaveBeenCalled()
  })

  it('does not report success if the final CAS loses to a new durable state', async () => {
    const current = binding()
    const snapshot = {
      status: 'completed',
      screenRecordingR2Key: null,
      screenRecordingSizeBytes: null,
      screenRecordingArtifactVersion: 2,
    }
    snapshots(snapshot, snapshot)
    mocks.bindingFindOneAndUpdate
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(null)

    await expect(terminalizeRuntimeReplayMedia({
      binding: current as never,
      kind: 'screen',
      reason: 'upload_expired',
    })).resolves.toBe('state_changed')

    expect(mocks.bindingUpdateOne).toHaveBeenCalledOnce()
    expect(mocks.bindingFindOneAndUpdate.mock.calls[1][0]).toMatchObject({
      runtimeWriteDrainUntil: { $not: { $gt: expect.any(Date) } },
    })
  })
})
