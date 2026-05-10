import { renderHook, act } from '@testing-library/react'
import { useMediaRecorder } from '../hooks/useMediaRecorder'

describe('useMediaRecorder', () => {
  const start = vi.fn()
  const stop = vi.fn()
  const mediaRecorderConstructor = vi.fn()

  class MockMediaRecorder {
    static isTypeSupported = vi.fn(() => true)
    state = 'recording'
    ondataavailable: ((event: BlobEvent) => void) | null = null
    onstop: (() => void) | null = null
    onerror: (() => void) | null = null

    constructor(stream: MediaStream, options?: MediaRecorderOptions) {
      mediaRecorderConstructor(stream, options)
    }

    start = start
    stop = stop
  }

  class MockMediaStream {
    constructor(public tracks: MediaStreamTrack[] = []) {}

    getAudioTracks() {
      return this.tracks.filter((track) => track.kind === 'audio')
    }

    getVideoTracks() {
      return this.tracks.filter((track) => track.kind === 'video')
    }
  }

  const audioTrack = { kind: 'audio' } as MediaStreamTrack
  const videoTrack = { kind: 'video' } as MediaStreamTrack

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('MediaRecorder', MockMediaRecorder)
    vi.stubGlobal('MediaStream', MockMediaStream)
  })

  it('passes bitrate caps through to the browser MediaRecorder for camera recording', () => {
    const stream = new MockMediaStream([audioTrack, videoTrack]) as unknown as MediaStream
    const { result } = renderHook(() => useMediaRecorder())

    act(() => {
      result.current.startRecording(stream, {
        videoBitsPerSecond: 800_000,
        audioBitsPerSecond: 64_000,
      })
    })

    expect(mediaRecorderConstructor).toHaveBeenCalledWith(stream, {
      mimeType: 'video/webm;codecs=vp9,opus',
      videoBitsPerSecond: 800_000,
      audioBitsPerSecond: 64_000,
    })
    expect(start).toHaveBeenCalledWith(1000)
  })

  it('keeps audio-only recording audio-only while preserving the audio bitrate cap', () => {
    const sourceStream = new MockMediaStream([audioTrack]) as unknown as MediaStream
    const { result } = renderHook(() => useMediaRecorder())

    act(() => {
      result.current.startRecording(sourceStream, {
        audioBitsPerSecond: 64_000,
      })
    })

    const [recordingStream, options] = mediaRecorderConstructor.mock.calls[0]
    expect(recordingStream).not.toBe(sourceStream)
    expect((recordingStream as MockMediaStream).getAudioTracks()).toEqual([audioTrack])
    expect(options).toEqual({
      mimeType: 'audio/webm;codecs=opus',
      audioBitsPerSecond: 64_000,
    })
  })
})
