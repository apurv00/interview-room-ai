import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HIRE_MULTIMODAL_OBSERVATION_CONSENT_VERSION } from '@shared/contracts/hireMultimodalObservationBridge'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  bindingFindOne: vi.fn(),
  bindingUpdateOne: vi.fn(),
  outboxExists: vi.fn(),
  outboxFindOneAndUpdate: vi.fn(),
  outboxDeleteMany: vi.fn(),
  retentionExists: vi.fn(),
}))

vi.mock('../services/runtimeBoundary', () => ({
  connectHireRuntimeDB: mocks.connect,
}))

vi.mock('../models/HireRuntimeBinding', () => ({
  HireRuntimeBinding: {
    findOne: mocks.bindingFindOne,
    updateOne: mocks.bindingUpdateOne,
  },
}))

vi.mock('../models/HireRuntimeMultimodalObservationOutbox', () => ({
  HireRuntimeMultimodalObservationOutbox: {
    exists: mocks.outboxExists,
    findOneAndUpdate: mocks.outboxFindOneAndUpdate,
    deleteMany: mocks.outboxDeleteMany,
  },
}))
vi.mock('../services/multimodalObservationRetentionService', () => ({
  isHireRuntimeMultimodalObservationRetentionPurged: mocks.retentionExists,
}))

import {
  __hireRuntimeMultimodalCapture,
  captureHireRuntimeMultimodalObservation,
} from '../services/multimodalObservationCaptureService'

const IDS = {
  binding: 'a'.repeat(24),
  workspace: 'b'.repeat(24),
  application: 'c'.repeat(24),
  round: 'd'.repeat(24),
  principal: 'e'.repeat(24),
  session: 'f'.repeat(24),
}

function objectId(value: string) {
  return { toString: () => value }
}

function binding(overrides: Record<string, unknown> = {}) {
  return {
    _id: objectId(IDS.binding),
    workspaceId: objectId(IDS.workspace),
    applicationId: objectId(IDS.application),
    roundId: objectId(IDS.round),
    principalId: objectId(IDS.principal),
    runtimeSessionId: objectId(IDS.session),
    attemptCount: 1,
    status: 'completed',
    consentVersion: HIRE_MULTIMODAL_OBSERVATION_CONSENT_VERSION,
    ...overrides,
  }
}

function capture() {
  return {
    sessionId: IDS.session,
    cameraSamples: [0, 1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000, 8_000, 9_000].map(
      (atMs) => ({ atMs, gazeX: 0.9, gazeY: 0, headYaw: 0, headPitch: 0 }),
    ),
    browserVisibility: {
      available: true,
      hiddenSpans: [{ startMs: 200, endMs: 1_400 }],
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connect.mockResolvedValue(undefined)
  mocks.bindingFindOne.mockResolvedValue(binding())
  mocks.bindingUpdateOne.mockResolvedValue({ matchedCount: 1 })
  mocks.outboxExists.mockResolvedValue(null)
  mocks.outboxFindOneAndUpdate.mockResolvedValue({})
  mocks.outboxDeleteMany.mockResolvedValue({ acknowledged: true, deletedCount: 1 })
  mocks.retentionExists.mockResolvedValue(false)
})

describe('Hire-native multimodal capture', () => {
  it('derives only fixed neutral intervals from bounded source samples', () => {
    const report = __hireRuntimeMultimodalCapture.deriveHireRuntimeObservationReport(capture())

    expect(report).toEqual({
      status: 'completed',
      capture: { camera: 'captured', browserVisibility: 'captured' },
      events: [
        {
          kind: 'sustained_camera_away',
          source: 'camera',
          startMs: 0,
          endMs: 9_000,
        },
        {
          kind: 'browser_window_not_visible',
          source: 'browser_visibility',
          startMs: 200,
          endMs: 1_400,
        },
      ],
    })
  })

  it('never creates an outbox row for an existing v2 consent receipt', async () => {
    mocks.bindingFindOne.mockResolvedValue(
      binding({ consentVersion: 'hire-ai-v2-2026-08' }),
    )

    await expect(
      captureHireRuntimeMultimodalObservation({
        workspaceId: IDS.workspace,
        principalId: IDS.principal,
        capture: capture(),
      }),
    ).resolves.toBe('disabled')

    expect(mocks.bindingUpdateOne).not.toHaveBeenCalled()
    expect(mocks.outboxFindOneAndUpdate).not.toHaveBeenCalled()
  })

  it('does not stage a derived report when privacy revocation wins after the initial binding read', async () => {
    mocks.bindingUpdateOne.mockResolvedValue({ matchedCount: 0 })

    await expect(
      captureHireRuntimeMultimodalObservation({
        workspaceId: IDS.workspace,
        principalId: IDS.principal,
        capture: capture(),
      }),
    ).resolves.toBe('disabled')

    expect(mocks.outboxExists).not.toHaveBeenCalled()
    expect(mocks.outboxFindOneAndUpdate).not.toHaveBeenCalled()
  })

  it('stages only the sanitized report and never raw camera samples', async () => {
    await expect(
      captureHireRuntimeMultimodalObservation({
        workspaceId: IDS.workspace,
        principalId: IDS.principal,
        capture: capture(),
        now: new Date('2026-08-17T00:00:00.000Z'),
      }),
    ).resolves.toBe('accepted')

    const [, update] = mocks.outboxFindOneAndUpdate.mock.calls[0]
    expect(update.$setOnInsert).toMatchObject({
      workspaceId: expect.anything(),
      applicationId: expect.anything(),
      roundId: expect.anything(),
      principalId: expect.anything(),
      runtimeSessionId: expect.anything(),
      status: 'pending',
      report: {
        status: 'completed',
        capture: { camera: 'captured', browserVisibility: 'captured' },
      },
    })
    expect(JSON.stringify(update.$setOnInsert)).not.toContain('cameraSamples')
    expect(JSON.stringify(update.$setOnInsert)).not.toContain('gazeX')
    expect(JSON.stringify(update.$setOnInsert)).not.toContain('headYaw')
  })

  it('removes a report staged by a browser request when deadline retention wins', async () => {
    mocks.retentionExists
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)

    await expect(
      captureHireRuntimeMultimodalObservation({
        workspaceId: IDS.workspace,
        principalId: IDS.principal,
        capture: capture(),
      }),
    ).resolves.toBe('disabled')

    expect(mocks.outboxDeleteMany).toHaveBeenCalledWith({
      workspaceId: expect.anything(),
      applicationId: expect.anything(),
      roundId: expect.anything(),
    })
  })
})
