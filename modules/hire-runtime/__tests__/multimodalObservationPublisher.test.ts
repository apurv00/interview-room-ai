import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  workspaceIds: vi.fn(),
  bindingFindOneAndUpdate: vi.fn(),
  bindingExists: vi.fn(),
  outboxFind: vi.fn(),
  outboxFindOneAndUpdate: vi.fn(),
  outboxUpdateOne: vi.fn(),
  publish: vi.fn(),
  retentionExists: vi.fn(),
}))

vi.mock('../services/runtimeBoundary', () => ({
  connectHireRuntimeDB: mocks.connect,
}))
vi.mock('../services/runtimeTenantScope', () => ({
  enumerateRuntimeWorkspaceIds: mocks.workspaceIds,
}))
vi.mock('../models/HireRuntimeBinding', () => ({
  HireRuntimeBinding: {
    findOneAndUpdate: mocks.bindingFindOneAndUpdate,
    exists: mocks.bindingExists,
  },
}))
vi.mock('../models/HireRuntimeMultimodalObservationOutbox', () => ({
  HireRuntimeMultimodalObservationOutbox: {
    find: mocks.outboxFind,
    findOneAndUpdate: mocks.outboxFindOneAndUpdate,
    updateOne: mocks.outboxUpdateOne,
  },
}))
vi.mock('../services/controlBridgeClient', () => ({
  publishMultimodalObservationToControl: mocks.publish,
}))
vi.mock('../services/multimodalObservationRetentionService', () => ({
  isHireRuntimeMultimodalObservationRetentionPurged: mocks.retentionExists,
}))

import { __hireMultimodalObservationPublisher } from '../services/multimodalObservationPublisher'

const IDS = {
  outbox: 'a'.repeat(24),
  workspace: 'b'.repeat(24),
  application: 'c'.repeat(24),
  round: 'd'.repeat(24),
  principal: 'e'.repeat(24),
  session: 'f'.repeat(24),
}

function objectId(value: string) {
  return { toString: () => value }
}

function outbox(overrides: Record<string, unknown> = {}) {
  return {
    _id: objectId(IDS.outbox),
    workspaceId: objectId(IDS.workspace),
    applicationId: objectId(IDS.application),
    roundId: objectId(IDS.round),
    principalId: objectId(IDS.principal),
    runtimeSessionId: objectId(IDS.session),
    attempt: 1,
    revision: 1,
    consentVersion: 'hire-ai-v3-2026-08-17',
    policyVersion: 'hire-supplemental-observations-v1',
    eventId: '1'.repeat(64),
    observationDigest: '2'.repeat(64),
    observedAt: new Date('2026-08-17T00:00:00.000Z'),
    report: {
      status: 'completed',
      capture: { camera: 'captured', browserVisibility: 'captured' },
      events: [
        {
          kind: 'browser_window_not_visible',
          source: 'browser_visibility',
          startMs: 100,
          endMs: 2_000,
        },
      ],
    },
    status: 'pending',
    publishAttemptCount: 0,
    publishLeaseToken: 'lease-token',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connect.mockResolvedValue(undefined)
  mocks.workspaceIds.mockResolvedValue([IDS.workspace])
  mocks.bindingFindOneAndUpdate.mockResolvedValue({ _id: objectId('9'.repeat(24)) })
  mocks.bindingExists.mockResolvedValue({ _id: objectId('9'.repeat(24)) })
  mocks.outboxFindOneAndUpdate.mockResolvedValue(outbox())
  mocks.outboxUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.publish.mockResolvedValue('processed')
  mocks.retentionExists.mockResolvedValue(false)
})

describe('Hire-native multimodal observation publisher', () => {
  it('bridges the exact digest-covered recorder clock without reinterpretation', () => {
    const exactReport = {
      status: 'completed' as const,
      capture: {
        camera: 'captured' as const,
        browserVisibility: 'captured' as const,
        displayShare: 'captured' as const,
      },
      events: [],
      playbackClock: {
        protocolVersion: 1 as const,
        cameraRecorderStartOffsetMs: 250,
        screenRecorderStartOffsetMs: 75,
      },
    }
    const payload = __hireMultimodalObservationPublisher.bridgePayload(
      outbox({
        consentVersion: 'hire-ai-v6-2026-08-20',
        policyVersion: 'hire-supplemental-observations-v3',
        report: exactReport,
      }) as never,
    )

    expect(payload?.schemaVersion).toBe(2)
    expect(payload?.report.playbackClock).toEqual(exactReport.playbackClock)
  })

  it('waits for a result-linked binding before bridging the supplemental report', async () => {
    mocks.bindingFindOneAndUpdate.mockResolvedValue(null)
    mocks.bindingExists.mockResolvedValue({ _id: objectId('9'.repeat(24)) })

    await expect(
      __hireMultimodalObservationPublisher.publishOneObservation(
        outbox() as never,
        new Date('2026-08-17T00:00:00.000Z'),
      ),
    ).resolves.toBe('deferred')

    expect(mocks.publish).not.toHaveBeenCalled()
    expect(mocks.outboxUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending' }),
      expect.objectContaining({
        $set: expect.objectContaining({ publishRetryAt: expect.any(Date) }),
      }),
    )
  })

  it('marks a selected report stale without bridge egress when privacy purge wins', async () => {
    mocks.bindingFindOneAndUpdate.mockResolvedValue(null)
    mocks.bindingExists.mockResolvedValue(null)

    await expect(
      __hireMultimodalObservationPublisher.publishOneObservation(
        outbox() as never,
        new Date('2026-08-17T00:00:00.000Z'),
      ),
    ).resolves.toBe('stale')

    expect(mocks.publish).not.toHaveBeenCalled()
    expect(mocks.outboxUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending' }),
      expect.objectContaining({
        $set: { status: 'stale', publishedAt: expect.any(Date) },
        $unset: expect.objectContaining({ report: 1 }),
      }),
    )
  })

  it('bridges the bounded report only after the binding is reserved twice and clears it on acknowledgement', async () => {
    const candidate = outbox()
    mocks.outboxFindOneAndUpdate.mockResolvedValue(candidate)

    await expect(
      __hireMultimodalObservationPublisher.publishOneObservation(
        candidate as never,
        new Date('2026-08-17T00:00:00.000Z'),
      ),
    ).resolves.toBe('published')

    expect(mocks.bindingFindOneAndUpdate).toHaveBeenCalledTimes(2)
    expect(mocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: IDS.workspace,
        applicationId: IDS.application,
        roundId: IDS.round,
        runtimeSessionId: IDS.session,
        report: candidate.report,
      }),
    )
    expect(mocks.outboxUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending' }),
      expect.objectContaining({
        $set: { status: 'published', publishedAt: expect.any(Date) },
        $unset: expect.objectContaining({ report: 1 }),
      }),
    )
  })

  it('still bridges observations after late replay advances the result revision', async () => {
    const candidate = outbox()
    mocks.outboxFindOneAndUpdate.mockResolvedValue(candidate)
    mocks.bindingFindOneAndUpdate.mockResolvedValue({
      _id: objectId('9'.repeat(24)),
      publishedRevision: 3,
    })

    await expect(
      __hireMultimodalObservationPublisher.publishOneObservation(
        candidate as never,
        new Date('2026-08-17T00:00:00.000Z'),
      ),
    ).resolves.toBe('published')

    expect(mocks.bindingFindOneAndUpdate).toHaveBeenCalledTimes(2)
    for (const [filter] of mocks.bindingFindOneAndUpdate.mock.calls) {
      expect(filter).toEqual(expect.objectContaining({
        publishedRevision: { $gte: 1 },
      }))
    }
    expect(mocks.publish).toHaveBeenCalledOnce()
  })

  it('does not bridge a claimed report once the runtime deadline tombstone exists', async () => {
    mocks.retentionExists.mockResolvedValueOnce(true)

    await expect(
      __hireMultimodalObservationPublisher.publishOneObservation(
        outbox() as never,
        new Date('2026-08-17T00:00:00.000Z'),
      ),
    ).resolves.toBe('stale')

    expect(mocks.bindingFindOneAndUpdate).not.toHaveBeenCalled()
    expect(mocks.publish).not.toHaveBeenCalled()
  })
})
