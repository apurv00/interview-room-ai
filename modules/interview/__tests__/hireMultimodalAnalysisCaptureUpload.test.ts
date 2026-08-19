import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HIRE_MULTIMODAL_ANALYSIS_CAPTURE_MAX_BODY_BYTES,
} from '@shared/contracts/hireMultimodalAnalysisBridge'
import { captureReplayUploadIntent } from '@interview/utils/resumableUpload'
import { __resetReplayUploadPrivacyForTests } from '@shared/services/replayUploadPrivacy'
import {
  deliverHireMultimodalAnalysisCapture,
} from '@interview/utils/hireMultimodalAnalysisCaptureUpload'

const USER_ID = 'a'.repeat(24)
const SESSION_ID = 'b'.repeat(24)

const frame = {
  ts: 1,
  gazeX: 0,
  gazeY: 0,
  headPoseYaw: 0,
  headPosePitch: 0,
  expression: 'focused' as const,
  eyeContactScore: 0.9,
  blendshapes: { browDownLeft: 0.2 },
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('Hire multimodal capture delivery', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    __resetReplayUploadPrivacyForTests()
  })

  it('retries a transient offline/5xx capture and waits for the durable runtime receipt', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(response({ error: 'runtime unavailable' }, 503))
      .mockResolvedValueOnce(response({ accepted: true, outcome: 'accepted' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(deliverHireMultimodalAnalysisCapture({
      sessionId: SESSION_ID,
      frames: [frame],
      intent: captureReplayUploadIntent(USER_ID),
      originUserId: USER_ID,
    })).resolves.toBe('accepted')

    expect(fetchMock).toHaveBeenCalledTimes(3)
    const [, init] = fetchMock.mock.calls[2] as [string, RequestInit]
    expect(new TextEncoder().encode(String(init.body)).byteLength).toBeLessThanOrEqual(
      HIRE_MULTIMODAL_ANALYSIS_CAPTURE_MAX_BODY_BYTES,
    )
    expect(init.headers).toMatchObject({ 'x-origin-user-id': USER_ID })
  })

  it('does not retry an aligned client-side 413 rejection', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ error: 'too large' }, 413))
    vi.stubGlobal('fetch', fetchMock)

    await expect(deliverHireMultimodalAnalysisCapture({
      sessionId: SESSION_ID,
      frames: [frame],
      intent: captureReplayUploadIntent(USER_ID),
      originUserId: USER_ID,
    })).rejects.toThrow('413')

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
