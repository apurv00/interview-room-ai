import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
}))

vi.mock('@interview/utils/accountBoundArtifactUpload', () => ({
  requestAccountBoundJson: mocks.request,
}))

import {
  attachHireInterviewIntegrityPagehideFlush,
  createHireInterviewIntegrityReporter,
  createHireInterviewSpeechVideoSampler,
} from '@interview/utils/hireInterviewIntegrityReporter'

const USER_ID = 'a'.repeat(24)
const SESSION_ID = 'b'.repeat(24)

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('Hire interview integrity reporter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.request.mockImplementation(() => Promise.resolve(
      response({ accepted: true, outcome: 'accepted' }),
    ))
  })

  it('delivers only bounded neutral events and coarse speech/video booleans', async () => {
    const reporter = createHireInterviewIntegrityReporter({
      sessionId: SESSION_ID,
      originUserId: USER_ID,
      intent: { privacyGeneration: 1 },
    })
    expect(reporter.record({
      kind: 'fullscreen_exited',
      source: 'fullscreen',
      startMs: 10,
      endMs: 10,
    })).toBe(true)
    expect(reporter.recordSpeechVideoSample({
      atMs: 20,
      voiceActive: true,
      facePresent: false,
      facialSpeechActive: false,
    })).toBe(true)

    await expect(reporter.flush()).resolves.toBe('accepted')

    const [, body, , , options] = mocks.request.mock.calls[0]
    expect(body).toMatchObject({
      sessionId: SESSION_ID,
      revision: 1,
      cameraSamples: [],
      browserVisibility: { available: false, hiddenSpans: [] },
      integrity: {
        events: [{
          kind: 'fullscreen_exited',
          source: 'fullscreen',
          startMs: 10,
          endMs: 10,
        }],
        speechVideoCorroboration: {
          available: true,
          samples: [{
            atMs: 20,
            voiceActive: true,
            facePresent: false,
            facialSpeechActive: false,
          }],
        },
      },
    })
    expect(options).toEqual({ keepalive: undefined })
    await expect(reporter.flush()).resolves.toBe('unchanged')
  })

  it('persists the initial interruption immediately and updates one lifecycle event on closure', async () => {
    const reporter = createHireInterviewIntegrityReporter({
      sessionId: SESSION_ID,
      originUserId: USER_ID,
      intent: { privacyGeneration: 1 },
    })
    reporter.record({
      kind: 'fullscreen_exited',
      source: 'fullscreen',
      startMs: 1_000,
      endMs: 1_000,
    })
    await expect(reporter.flush()).resolves.toBe('accepted')

    expect(reporter.record({
      kind: 'fullscreen_exited',
      source: 'fullscreen',
      startMs: 1_000,
      endMs: 1_750,
    })).toBe(true)
    await expect(reporter.flush()).resolves.toBe('accepted')

    const [, initialBody] = mocks.request.mock.calls[0]
    const [, closedBody] = mocks.request.mock.calls[1]
    expect(initialBody).toMatchObject({
      revision: 1,
      integrity: {
        events: [{
          kind: 'fullscreen_exited',
          source: 'fullscreen',
          startMs: 1_000,
          endMs: 1_000,
        }],
      },
    })
    expect(closedBody).toMatchObject({
      revision: 2,
      integrity: {
        events: [{
          kind: 'fullscreen_exited',
          source: 'fullscreen',
          startMs: 1_000,
          endMs: 1_750,
        }],
      },
    })
  })

  it('reports only neutral display-share facts when V6 display capture is enabled', async () => {
    const reporter = createHireInterviewIntegrityReporter({
      sessionId: SESSION_ID,
      originUserId: USER_ID,
      intent: { privacyGeneration: 1 },
      availability: { displayShare: true },
    })
    expect(reporter.record({
      kind: 'screen_share_wrong_surface',
      source: 'display_surface',
      startMs: 0,
      endMs: 0,
    })).toBe(true)
    expect(reporter.record({
      kind: 'screen_share_interrupted',
      source: 'display_track',
      startMs: 5_000,
      endMs: 6_500,
    })).toBe(true)
    expect(reporter.record({
      kind: 'screen_recording_interrupted',
      source: 'display_recorder',
      startMs: 7_000,
      endMs: 7_000,
    })).toBe(true)

    await expect(reporter.flush()).resolves.toBe('accepted')

    expect(mocks.request.mock.calls[0][1]).toMatchObject({
      integrity: {
        displayShare: { available: true },
        events: [
          expect.objectContaining({ kind: 'screen_share_wrong_surface' }),
          expect.objectContaining({ kind: 'screen_share_interrupted' }),
          expect.objectContaining({ kind: 'screen_recording_interrupted' }),
        ],
      },
    })
  })

  it('allocates a later revision when new evidence arrives after an unavailable flush', async () => {
    mocks.request
      .mockResolvedValueOnce(response({ error: 'temporary' }, 503))
      .mockResolvedValueOnce(response({ accepted: true, outcome: 'accepted' }))
    const reporter = createHireInterviewIntegrityReporter({
      sessionId: SESSION_ID,
      originUserId: USER_ID,
      intent: { privacyGeneration: 1 },
    })
    reporter.record({
      kind: 'camera_interrupted',
      source: 'camera_track',
      startMs: 10,
      endMs: 10,
    })
    await expect(reporter.flush()).resolves.toBe('unavailable')

    reporter.record({
      kind: 'microphone_interrupted',
      source: 'microphone_track',
      startMs: 20,
      endMs: 20,
    })
    await expect(reporter.flush()).resolves.toBe('accepted')

    const [, retryBody] = mocks.request.mock.calls[1]
    expect(retryBody).toMatchObject({
      revision: 2,
      integrity: {
        events: [
          expect.objectContaining({ kind: 'camera_interrupted' }),
          expect.objectContaining({ kind: 'microphone_interrupted' }),
        ],
      },
    })
  })

  it('uses a later immutable revision for a final camera/visibility capture', async () => {
    const reporter = createHireInterviewIntegrityReporter({
      sessionId: SESSION_ID,
      originUserId: USER_ID,
      intent: { privacyGeneration: 1 },
    })
    reporter.record({
      kind: 'camera_interrupted',
      source: 'camera_track',
      startMs: 25,
      endMs: 25,
    })
    await reporter.flush()

    await expect(reporter.flush({
      capture: {
        cameraSamples: [{
          atMs: 0,
          gazeX: 0,
          gazeY: 0,
          headYaw: 0,
          headPitch: 0,
        }],
        browserVisibility: {
          available: true,
          hiddenSpans: [{ startMs: 50, endMs: 500 }],
        },
      },
    })).resolves.toBe('accepted')

    const [, body] = mocks.request.mock.calls[1]
    expect(body).toMatchObject({
      revision: 2,
      cameraSamples: [{ atMs: 0 }],
      browserVisibility: {
        available: true,
        hiddenSpans: [{ startMs: 50, endMs: 500 }],
      },
      integrity: {
        events: [expect.objectContaining({ kind: 'camera_interrupted' })],
      },
    })
  })

  it('does not supersede a delivered final capture with an empty teardown snapshot', async () => {
    const reporter = createHireInterviewIntegrityReporter({
      sessionId: SESSION_ID,
      originUserId: USER_ID,
      intent: { privacyGeneration: 1 },
    })

    await expect(reporter.flush({
      capture: {
        cameraSamples: [{
          atMs: 0,
          gazeX: 0,
          gazeY: 0,
          headYaw: 0,
          headPitch: 0,
        }],
        browserVisibility: {
          available: true,
          hiddenSpans: [],
        },
      },
    })).resolves.toBe('accepted')

    // Mirrors InterviewPage cleanup: an unchanged flush must preserve the
    // successful full final capture instead of creating a newer empty body.
    await expect(reporter.flush()).resolves.toBe('unchanged')
    expect(mocks.request).toHaveBeenCalledTimes(1)
    expect(mocks.request.mock.calls[0][1]).toMatchObject({
      revision: 1,
      cameraSamples: [{ atMs: 0 }],
      browserVisibility: { available: true, hiddenSpans: [] },
    })
  })

  it('uses keepalive for pagehide without blocking teardown', async () => {
    const reporter = createHireInterviewIntegrityReporter({
      sessionId: SESSION_ID,
      originUserId: USER_ID,
      intent: { privacyGeneration: 1 },
    })
    reporter.record({
      kind: 'microphone_interrupted',
      source: 'microphone_track',
      startMs: 5,
      endMs: 5,
    })
    const detach = attachHireInterviewIntegrityPagehideFlush(reporter)

    window.dispatchEvent(new Event('pagehide'))
    await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1))

    expect(mocks.request.mock.calls[0][4]).toEqual({ keepalive: true })
    detach()
  })

  it('keeps the optional speech/video sampler a no-op when AudioContext creation fails', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'AudioContext')
    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      value: class {
        constructor() {
          throw new Error('Audio graph unavailable')
        }
      },
    })
    try {
      const sampler = createHireInterviewSpeechVideoSampler({
        stream: {} as MediaStream,
        reporter: { recordSpeechVideoSample: vi.fn() },
        elapsedMs: () => 0,
        facePresent: () => true,
      })

      expect(() => sampler.start()).not.toThrow()
      expect(() => sampler.stop()).not.toThrow()
    } finally {
      if (original) Object.defineProperty(window, 'AudioContext', original)
      else delete (window as typeof window & { AudioContext?: typeof AudioContext }).AudioContext
    }
  })
})
