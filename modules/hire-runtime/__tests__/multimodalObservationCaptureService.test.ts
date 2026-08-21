import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HIRE_AI_CONSENT_VERSION,
  HIRE_AI_V5_CONSENT_VERSION,
} from '@hire-multimodal-boundary'
import { HIRE_MULTIMODAL_OBSERVATION_V2_POLICY_VERSION } from '@shared/contracts/hireMultimodalObservationBridge'

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
    consentVersion: HIRE_AI_CONSENT_VERSION,
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
  mocks.outboxFindOneAndUpdate.mockImplementation((_, update) =>
    Promise.resolve(update.$setOnInsert),
  )
  mocks.outboxDeleteMany.mockResolvedValue({ acknowledged: true, deletedCount: 1 })
  mocks.retentionExists.mockResolvedValue(false)
})

describe('Hire-native multimodal capture', () => {
  it('derives only fixed neutral intervals from bounded source samples', () => {
    const report = __hireRuntimeMultimodalCapture.deriveHireRuntimeObservationReport(capture())

    expect(report).toEqual({
      status: 'completed',
      capture: {
        camera: 'captured',
        browserVisibility: 'captured',
        browserFocus: 'unavailable',
        fullscreen: 'unavailable',
        cameraTrack: 'unavailable',
        microphoneTrack: 'unavailable',
        displayShare: 'unavailable',
        speechVideoCorroboration: 'unavailable',
      },
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

  it('preserves an exact optional recorder clock in the immutable report', async () => {
    const exactCapture = {
      ...capture(),
      playbackClock: {
        protocolVersion: 1 as const,
        cameraRecorderStartOffsetMs: 325,
      },
    }

    expect(
      __hireRuntimeMultimodalCapture.deriveHireRuntimeObservationReport(
        exactCapture,
      ).playbackClock,
    ).toEqual(exactCapture.playbackClock)

    await expect(
      captureHireRuntimeMultimodalObservation({
        workspaceId: IDS.workspace,
        principalId: IDS.principal,
        capture: exactCapture,
      }),
    ).resolves.toBe('accepted')

    const [, update] = mocks.outboxFindOneAndUpdate.mock.calls[0]
    expect(update.$setOnInsert.report.playbackClock).toEqual(
      exactCapture.playbackClock,
    )
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

  it('derives bounded platform events and never accepts a browser-supplied speaker conclusion', () => {
    const report = __hireRuntimeMultimodalCapture.deriveHireRuntimeObservationReport({
      ...capture(),
      integrity: {
        browserFocus: { available: true },
        fullscreen: { available: true },
        cameraTrack: { available: true },
        microphoneTrack: { available: true },
        displayShare: { available: true },
        events: [
          {
            kind: 'fullscreen_exited',
            source: 'fullscreen',
            startMs: 10_000,
            endMs: 10_000,
          },
          {
            kind: 'camera_interrupted',
            source: 'camera_track',
            startMs: 12_000,
            endMs: 12_000,
          },
          {
            kind: 'screen_share_interrupted',
            source: 'display_track',
            startMs: 14_000,
            endMs: 15_000,
          },
        ],
        speechVideoCorroboration: {
          available: true,
          samples: [
            { atMs: 20_000, voiceActive: true, facePresent: false },
            { atMs: 23_000, voiceActive: true, facePresent: false },
          ],
        },
      },
    })

    expect(report.capture).toMatchObject({
      fullscreen: 'captured',
      cameraTrack: 'captured',
      microphoneTrack: 'captured',
      displayShare: 'captured',
      speechVideoCorroboration: 'captured',
    })
    expect(report.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'fullscreen_exited' }),
      expect.objectContaining({ kind: 'camera_interrupted' }),
      expect.objectContaining({ kind: 'screen_share_interrupted' }),
      expect.objectContaining({
        kind: 'speech_video_unverified',
        source: 'speech_video_corroboration',
        startMs: 20_000,
        endMs: 23_000,
      }),
    ]))
  })

  it('derives a neutral mouth-motion mismatch at the exact three-second reporter boundary', () => {
    const report = __hireRuntimeMultimodalCapture.deriveHireRuntimeObservationReport({
      ...capture(),
      integrity: {
        browserFocus: { available: true },
        fullscreen: { available: true },
        cameraTrack: { available: true },
        microphoneTrack: { available: true },
        displayShare: { available: false },
        events: [],
        speechVideoCorroboration: {
          available: true,
          samples: [
            {
              atMs: 20_000,
              voiceActive: true,
              facePresent: true,
              facialSpeechActive: false,
            },
            {
              atMs: 23_000,
              voiceActive: true,
              facePresent: true,
              facialSpeechActive: false,
            },
          ],
        },
      },
    })

    expect(report.capture.speechVideoCorroboration).toBe('captured')
    expect(report.events).toEqual(expect.arrayContaining([{
      kind: 'speech_video_unverified',
      source: 'speech_video_corroboration',
      startMs: 20_000,
      endMs: 23_000,
    }]))
  })

  it('keeps an unavailable facial-motion proxy neutral for an older V2 snapshot', () => {
    const report = __hireRuntimeMultimodalCapture.deriveHireRuntimeObservationReport({
      ...capture(),
      integrity: {
        browserFocus: { available: true },
        fullscreen: { available: true },
        cameraTrack: { available: true },
        microphoneTrack: { available: true },
        displayShare: { available: false },
        events: [],
        speechVideoCorroboration: {
          available: true,
          samples: [
            { atMs: 20_000, voiceActive: true, facePresent: true },
            { atMs: 23_000, voiceActive: true, facePresent: true },
          ],
        },
      },
    })

    expect(report.capture.speechVideoCorroboration).toBe('captured')
    expect(report.events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'speech_video_unverified' }),
    ]))
  })

  it('coalesces overlapping visibility observations from the gate and capture collector', () => {
    const report = __hireRuntimeMultimodalCapture.deriveHireRuntimeObservationReport({
      ...capture(),
      integrity: {
        browserFocus: { available: true },
        fullscreen: { available: true },
        cameraTrack: { available: true },
        microphoneTrack: { available: true },
        displayShare: { available: false },
        events: [{
          kind: 'browser_window_not_visible',
          source: 'browser_visibility',
          startMs: 1_200,
          endMs: 2_000,
        }],
        speechVideoCorroboration: { available: false, samples: [] },
      },
    })

    expect(report.events.filter((event) =>
      event.kind === 'browser_window_not_visible',
    )).toEqual([{
      kind: 'browser_window_not_visible',
      source: 'browser_visibility',
      startMs: 200,
      endMs: 2_000,
    }])
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

  it('keeps V5 validation active without collecting V6 display-share signals', async () => {
    mocks.bindingFindOne.mockResolvedValue(
      binding({ consentVersion: HIRE_AI_V5_CONSENT_VERSION }),
    )

    await expect(
      captureHireRuntimeMultimodalObservation({
        workspaceId: IDS.workspace,
        principalId: IDS.principal,
        capture: capture(),
      }),
    ).resolves.toBe('accepted')

    const [, update] = mocks.outboxFindOneAndUpdate.mock.calls[0]
    expect(update.$setOnInsert.policyVersion).toBe(
      HIRE_MULTIMODAL_OBSERVATION_V2_POLICY_VERSION,
    )
    expect(update.$setOnInsert.report.capture).not.toHaveProperty('displayShare')
  })

  it('accepts an in-flight V5 integrity snapshot created before display sharing existed', async () => {
    mocks.bindingFindOne.mockResolvedValue(
      binding({ consentVersion: HIRE_AI_V5_CONSENT_VERSION }),
    )

    await expect(
      captureHireRuntimeMultimodalObservation({
        workspaceId: IDS.workspace,
        principalId: IDS.principal,
        capture: {
          ...capture(),
          integrity: {
            browserFocus: { available: true },
            fullscreen: { available: true },
            cameraTrack: { available: true },
            microphoneTrack: { available: true },
            events: [],
            speechVideoCorroboration: { available: false, samples: [] },
          },
        },
      }),
    ).resolves.toBe('accepted')

    const [, update] = mocks.outboxFindOneAndUpdate.mock.calls[0]
    expect(update.$setOnInsert.policyVersion).toBe(
      HIRE_MULTIMODAL_OBSERVATION_V2_POLICY_VERSION,
    )
    expect(update.$setOnInsert.report.capture).not.toHaveProperty('displayShare')
  })

  it('refuses display-share signals for an immutable V5 receipt', async () => {
    mocks.bindingFindOne.mockResolvedValue(
      binding({ consentVersion: HIRE_AI_V5_CONSENT_VERSION }),
    )

    await expect(
      captureHireRuntimeMultimodalObservation({
        workspaceId: IDS.workspace,
        principalId: IDS.principal,
        capture: {
          ...capture(),
          integrity: {
            browserFocus: { available: true },
            fullscreen: { available: true },
            cameraTrack: { available: true },
            microphoneTrack: { available: true },
            displayShare: { available: true },
            events: [{
              kind: 'screen_share_interrupted',
              source: 'display_track',
              startMs: 1_000,
              endMs: 2_000,
            }],
            speechVideoCorroboration: { available: false, samples: [] },
          },
        },
      }),
    ).resolves.toBe('disabled')

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
