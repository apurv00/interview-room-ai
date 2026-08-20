import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const recorderMock = vi.hoisted(() => ({
  isRecording: true,
  startSucceeds: true,
  startRecording: vi.fn(),
  stopRecording: vi.fn(),
}))

vi.mock('../useMediaRecorder', () => ({
  useMediaRecorder: () => ({
    isRecording: recorderMock.isRecording,
    recordingDuration: 0,
    startRecording: recorderMock.startRecording,
    stopRecording: recorderMock.stopRecording,
    getDurationSeconds: () => null,
  }),
}))

import { useHireDisplayRecorder } from '../useHireDisplayRecorder'

class FakeVideoTrack extends EventTarget {
  readonly kind = 'video'
  readyState: MediaStreamTrackState = 'live'
  enabled = true
  muted = false
  readonly stop = vi.fn(() => {
    this.readyState = 'ended'
  })

  end() {
    this.readyState = 'ended'
    this.dispatchEvent(new Event('ended'))
  }

  mute() {
    this.muted = true
    this.dispatchEvent(new Event('mute'))
  }

  unmute() {
    this.muted = false
    this.dispatchEvent(new Event('unmute'))
  }
}

class FakeStream {
  constructor(
    readonly videoTracks: FakeVideoTrack[],
    readonly audioTracks: MediaStreamTrack[] = [],
  ) {}

  getTracks() {
    return [...this.videoTracks, ...this.audioTracks] as MediaStreamTrack[]
  }

  getVideoTracks() {
    return this.videoTracks as unknown as MediaStreamTrack[]
  }

  getAudioTracks() {
    return this.audioTracks
  }
}

const context = {
  fillStyle: '',
  fillRect: vi.fn(),
  drawImage: vi.fn(),
}
const captureStream = vi.fn()
let outputTrack: FakeVideoTrack
let outputStream: FakeStream
let stoppedBlob: Blob

beforeEach(() => {
  vi.clearAllMocks()
  recorderMock.isRecording = true
  recorderMock.startSucceeds = true
  stoppedBlob = new Blob(['display-recording'], { type: 'video/webm' })
  recorderMock.startRecording.mockImplementation(
    () => recorderMock.startSucceeds,
  )
  recorderMock.stopRecording.mockResolvedValue(stoppedBlob)

  outputTrack = new FakeVideoTrack()
  outputStream = new FakeStream([outputTrack])
  captureStream.mockReturnValue(outputStream)

  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => context as unknown as CanvasRenderingContext2D,
  )
  Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', {
    configurable: true,
    value: captureStream,
  })
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})

afterEach(async () => {
  cleanup()
  await Promise.resolve()
  Reflect.deleteProperty(HTMLCanvasElement.prototype, 'captureStream')
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('useHireDisplayRecorder', () => {
  it('starts one bounded video-only canvas recorder and keeps it across source swaps', () => {
    const firstTrack = new FakeVideoTrack()
    const secondTrack = new FakeVideoTrack()
    const firstStream = new FakeStream([firstTrack]) as unknown as MediaStream
    const secondStream = new FakeStream([secondTrack]) as unknown as MediaStream
    const { result } = renderHook(() => useHireDisplayRecorder())

    act(() => result.current.setSource(firstStream))

    const video = document.body.querySelector('video')
    const canvas = captureStream.mock.instances[0] as HTMLCanvasElement
    expect(video?.srcObject).toBe(firstStream)
    expect(canvas.width).toBe(1_280)
    expect(canvas.height).toBe(720)
    expect(captureStream).toHaveBeenCalledWith(12)
    expect(recorderMock.startRecording).toHaveBeenCalledWith(
      outputStream,
      { videoBitsPerSecond: 900_000 },
    )
    expect(outputStream.getAudioTracks()).toEqual([])

    act(() => result.current.setSource(secondStream))

    expect(video?.srcObject).toBe(secondStream)
    expect(recorderMock.startRecording).toHaveBeenCalledTimes(1)

    act(() => firstTrack.end())
    expect(video?.srcObject).toBe(secondStream)
  })

  it('draws a neutral frame while the current share is muted or ended', () => {
    const sourceTrack = new FakeVideoTrack()
    const sourceStream = new FakeStream([sourceTrack]) as unknown as MediaStream
    const { result } = renderHook(() => useHireDisplayRecorder())

    act(() => result.current.setSource(sourceStream))
    const video = document.body.querySelector('video')
    const neutralFramesBeforeMute = context.fillRect.mock.calls.length

    act(() => sourceTrack.mute())
    expect(video?.srcObject).toBeNull()
    expect(context.fillRect.mock.calls.length).toBeGreaterThan(
      neutralFramesBeforeMute,
    )

    act(() => sourceTrack.unmute())
    expect(video?.srcObject).toBe(sourceStream)

    act(() => sourceTrack.end())
    expect(video?.srcObject).toBeNull()
  })

  it('returns one blob and releases only bridge-owned resources on stop', async () => {
    const sourceTrack = new FakeVideoTrack()
    const sourceStream = new FakeStream([sourceTrack]) as unknown as MediaStream
    const { result } = renderHook(() => useHireDisplayRecorder())
    act(() => result.current.setSource(sourceStream))

    let blob: Blob | null = null
    await act(async () => {
      blob = await result.current.stopRecording()
    })

    expect(blob).toBe(stoppedBlob)
    expect(recorderMock.stopRecording).toHaveBeenCalledTimes(1)
    expect(outputTrack.stop).toHaveBeenCalledTimes(1)
    expect(sourceTrack.stop).not.toHaveBeenCalled()
    expect(document.body.querySelector('video')).toBeNull()

    await act(async () => {
      await expect(result.current.stopRecording()).resolves.toBe(stoppedBlob)
    })
    expect(recorderMock.stopRecording).toHaveBeenCalledTimes(1)
  })

  it('surfaces synchronous recorder failure and allows a clean source retry', () => {
    const sourceTrack = new FakeVideoTrack()
    const sourceStream = new FakeStream([sourceTrack]) as unknown as MediaStream
    recorderMock.isRecording = false
    recorderMock.startSucceeds = false
    const { result } = renderHook(() => useHireDisplayRecorder())

    act(() => result.current.setSource(sourceStream))

    expect(result.current.isRecording).toBe(false)
    expect(result.current.error).toBe(
      'Display recording could not start. Please try again.',
    )
    const bridgeVideo = document.body.querySelector('video')
    expect(bridgeVideo).not.toBeNull()
    expect(bridgeVideo?.srcObject ?? null).toBeNull()

    recorderMock.isRecording = true
    recorderMock.startSucceeds = true
    act(() => result.current.setSource(sourceStream))

    expect(result.current.error).toBeNull()
    expect(recorderMock.startRecording).toHaveBeenCalledTimes(2)
    expect(captureStream).toHaveBeenCalledTimes(1)
    expect(bridgeVideo?.srcObject).toBe(sourceStream)
  })

  it('treats an unexpected recorder stop as terminal and refuses a silent restart', () => {
    const sourceTrack = new FakeVideoTrack()
    const sourceStream = new FakeStream([sourceTrack]) as unknown as MediaStream
    const { result, rerender } = renderHook(() => useHireDisplayRecorder())
    act(() => result.current.setSource(sourceStream))

    expect(result.current.isRecording).toBe(true)
    expect(result.current.error).toBeNull()
    expect(recorderMock.startRecording).toHaveBeenCalledTimes(1)

    act(() => {
      recorderMock.isRecording = false
      rerender()
    })

    expect(result.current.isRecording).toBe(false)
    expect(result.current.error).toBe(
      'Display recording stopped unexpectedly. This interview cannot continue; submit the partial interview for review.',
    )
    expect(result.current.hasTerminalFailure).toBe(true)
    expect(outputTrack.stop).toHaveBeenCalledTimes(1)
    expect(document.body.querySelector('video')).toBeNull()

    act(() => result.current.setSource(sourceStream))

    expect(result.current.isRecording).toBe(false)
    expect(result.current.hasTerminalFailure).toBe(true)
    expect(result.current.error).toBe(
      'Display recording stopped unexpectedly. This interview cannot continue; submit the partial interview for review.',
    )
    expect(captureStream).toHaveBeenCalledTimes(1)
    expect(recorderMock.startRecording).toHaveBeenCalledTimes(1)
  })
})
