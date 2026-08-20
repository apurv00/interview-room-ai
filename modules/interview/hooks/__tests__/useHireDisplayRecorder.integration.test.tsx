import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useHireDisplayRecorder } from '../useHireDisplayRecorder'

class FakeVideoTrack extends EventTarget {
  readonly kind = 'video'
  readyState: MediaStreamTrackState = 'live'
  enabled = true
  muted = false
  readonly stop = vi.fn(() => {
    this.readyState = 'ended'
  })
}

class FakeStream {
  constructor(readonly videoTrack: FakeVideoTrack) {}

  getTracks() {
    return [this.videoTrack] as unknown as MediaStreamTrack[]
  }

  getVideoTracks() {
    return [this.videoTrack] as unknown as MediaStreamTrack[]
  }

  getAudioTracks() {
    return [] as MediaStreamTrack[]
  }
}

class ControlledMediaRecorder {
  static readonly instances: ControlledMediaRecorder[] = []
  static isTypeSupported = vi.fn(() => true)

  state: RecordingState = 'inactive'
  ondataavailable: ((event: BlobEvent) => void) | null = null
  onstop: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(
    readonly stream: MediaStream,
    readonly options?: MediaRecorderOptions,
  ) {
    ControlledMediaRecorder.instances.push(this)
  }

  start() {
    this.state = 'recording'
  }

  stop() {
    this.state = 'inactive'
    this.onstop?.()
  }

  stopUnexpectedly(partialChunk: Blob) {
    this.ondataavailable?.({ data: partialChunk } as BlobEvent)
    this.state = 'inactive'
    this.onstop?.()
  }
}

const context = {
  fillStyle: '',
  fillRect: vi.fn(),
  drawImage: vi.fn(),
}
let outputTrack: FakeVideoTrack
let outputStream: FakeStream

beforeEach(() => {
  vi.clearAllMocks()
  ControlledMediaRecorder.instances.length = 0
  ControlledMediaRecorder.isTypeSupported.mockReturnValue(true)
  outputTrack = new FakeVideoTrack()
  outputStream = new FakeStream(outputTrack)

  vi.stubGlobal('MediaRecorder', ControlledMediaRecorder)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => context as unknown as CanvasRenderingContext2D,
  )
  Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', {
    configurable: true,
    value: vi.fn(() => outputStream),
  })
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})

afterEach(async () => {
  cleanup()
  await Promise.resolve()
  Reflect.deleteProperty(HTMLCanvasElement.prototype, 'captureStream')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('useHireDisplayRecorder with useMediaRecorder', () => {
  it('terminally blocks an unsolicited stop and returns its retained partial WebM', async () => {
    const sourceTrack = new FakeVideoTrack()
    const sourceStream = new FakeStream(sourceTrack) as unknown as MediaStream
    const { result } = renderHook(() => useHireDisplayRecorder())

    act(() => result.current.setSource(sourceStream))
    await waitFor(() => expect(result.current.isRecording).toBe(true))
    expect(ControlledMediaRecorder.instances).toHaveLength(1)

    const partialChunk = new Blob(['retained-partial-screen-recording'], {
      type: 'video/webm',
    })
    act(() => {
      ControlledMediaRecorder.instances[0].stopUnexpectedly(partialChunk)
    })

    await waitFor(() => {
      expect(result.current.isRecording).toBe(false)
      expect(result.current.hasTerminalFailure).toBe(true)
    })
    expect(result.current.error).toContain('cannot continue')

    act(() => result.current.setSource(sourceStream))
    expect(ControlledMediaRecorder.instances).toHaveLength(1)

    let retainedBlob: Blob | null = null
    await act(async () => {
      retainedBlob = await result.current.stopRecording()
    })

    expect(retainedBlob).not.toBeNull()
    expect(retainedBlob?.size).toBe(partialChunk.size)
    expect(retainedBlob?.type).toBe('video/webm;codecs=vp9')
  })
})
