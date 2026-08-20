import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  hasLiveHireInterviewMedia,
  useHireInterviewIntegrityGate,
} from '../useHireInterviewIntegrityGate'

class FakeTrack extends EventTarget {
  readyState: MediaStreamTrackState = 'live'
  enabled = true
  muted = false
  readonly stop = vi.fn(() => {
    this.readyState = 'ended'
    this.dispatchEvent(new Event('ended'))
  })

  constructor(readonly kind: 'audio' | 'video') {
    super()
  }

  interrupt() {
    this.readyState = 'ended'
    this.dispatchEvent(new Event('ended'))
  }
}

function createStream() {
  const camera = new FakeTrack('video')
  const microphone = new FakeTrack('audio')
  const tracks = [camera, microphone]
  const stream = {
    getTracks: () => tracks,
    getVideoTracks: () => [camera],
    getAudioTracks: () => [microphone],
  } as unknown as MediaStream
  return { stream, camera, microphone }
}

class FakeDisplayTrack extends EventTarget {
  readyState: MediaStreamTrackState = 'live'
  enabled = true
  muted = false
  readonly stop = vi.fn(() => {
    this.readyState = 'ended'
    this.dispatchEvent(new Event('ended'))
  })

  constructor(readonly displaySurface?: string) {
    super()
  }

  getSettings() {
    return this.displaySurface ? { displaySurface: this.displaySurface } : {}
  }

  interrupt() {
    this.readyState = 'ended'
    this.dispatchEvent(new Event('ended'))
  }
}

function createDisplayStream(displaySurface?: string) {
  const display = new FakeDisplayTrack(displaySurface)
  const stream = {
    getTracks: () => [display],
    getVideoTracks: () => [display],
    getAudioTracks: () => [],
  } as unknown as MediaStream
  return { stream, display }
}

function installDisplayMediaStub(
  getDisplayMedia: ReturnType<typeof vi.fn<() => Promise<MediaStream>>>,
) {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia, getDisplayMedia },
  })
}

const originalFullscreenElement = Object.getOwnPropertyDescriptor(document, 'fullscreenElement')
const originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden')
const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
const originalRequestFullscreen = Object.getOwnPropertyDescriptor(
  document.documentElement,
  'requestFullscreen',
)
const originalExitFullscreen = Object.getOwnPropertyDescriptor(document, 'exitFullscreen')

let fullscreenElement: Element | null = null
let pageHidden = false
let getUserMedia = vi.fn<() => Promise<MediaStream>>()

function installBrowserStubs() {
  fullscreenElement = null
  pageHidden = false
  getUserMedia = vi.fn<() => Promise<MediaStream>>()

  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    get: () => fullscreenElement,
  })
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => pageHidden,
  })
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  })
  Object.defineProperty(document.documentElement, 'requestFullscreen', {
    configurable: true,
    value: vi.fn(async () => {
      fullscreenElement = document.documentElement
      document.dispatchEvent(new Event('fullscreenchange'))
    }),
  })
  Object.defineProperty(document, 'exitFullscreen', {
    configurable: true,
    value: vi.fn(async () => {
      fullscreenElement = null
      document.dispatchEvent(new Event('fullscreenchange'))
    }),
  })
}

function restoreProperty(
  target: object,
  key: string,
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) Object.defineProperty(target, key, descriptor)
  else Reflect.deleteProperty(target, key)
}

beforeEach(() => {
  installBrowserStubs()
})

afterEach(() => {
  vi.restoreAllMocks()
  restoreProperty(document, 'fullscreenElement', originalFullscreenElement)
  restoreProperty(document, 'hidden', originalHidden)
  restoreProperty(navigator, 'mediaDevices', originalMediaDevices)
  restoreProperty(document.documentElement, 'requestFullscreen', originalRequestFullscreen)
  restoreProperty(document, 'exitFullscreen', originalExitFullscreen)
})

describe('useHireInterviewIntegrityGate', () => {
  it('requires live camera + microphone and fullscreen before it starts', async () => {
    const first = createStream()
    getUserMedia.mockResolvedValue(first.stream)
    const onEvent = vi.fn()
    const { result } = renderHook(() =>
      useHireInterviewIntegrityGate({ enabled: true, onEvent }),
    )

    expect(result.current.hasStarted).toBe(false)
    expect(hasLiveHireInterviewMedia(first.stream)).toBe(true)

    await act(async () => {
      await expect(result.current.startAssessment()).resolves.toBe(true)
    })

    expect(result.current.hasStarted).toBe(true)
    expect(result.current.isPaused).toBe(false)
    expect(result.current.stream).toBe(first.stream)
    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(document.documentElement.requestFullscreen).toHaveBeenCalledTimes(1)
    // Start verification is local state; it is not an HR observation.
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('persists fullscreen exit immediately, then emits its closed factual duration after recheck', async () => {
    const first = createStream()
    getUserMedia.mockResolvedValue(first.stream)
    const onEvent = vi.fn()
    const { result } = renderHook(() =>
      useHireInterviewIntegrityGate({ enabled: true, onEvent }),
    )

    await act(async () => {
      await result.current.startAssessment()
    })

    act(() => {
      fullscreenElement = null
      document.dispatchEvent(new Event('fullscreenchange'))
    })

    await waitFor(() => expect(result.current.isPaused).toBe(true))
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'fullscreen_exited',
      startMs: expect.any(Number),
      endMs: expect.any(Number),
      durationMs: 0,
    }))

    await act(async () => {
      await result.current.recheck()
    })

    expect(result.current.isPaused).toBe(false)
    expect(onEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'fullscreen_exited',
      startMs: expect.any(Number),
      endMs: expect.any(Number),
      durationMs: expect.any(Number),
    }))
  })

  it('reports event offsets from the verified assessment start, never wall-clock time', async () => {
    const first = createStream()
    getUserMedia.mockResolvedValue(first.stream)
    const onEvent = vi.fn()
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const { result } = renderHook(() =>
      useHireInterviewIntegrityGate({ enabled: true, onEvent }),
    )

    await act(async () => {
      await result.current.startAssessment()
    })

    now += 2_000
    act(() => {
      fullscreenElement = null
      document.dispatchEvent(new Event('fullscreenchange'))
    })
    await waitFor(() => expect(result.current.isPaused).toBe(true))

    now += 750
    await act(async () => {
      await result.current.recheck()
    })

    expect(onEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({
      kind: 'fullscreen_exited',
      startMs: 2_000,
      endMs: 2_000,
      durationMs: 0,
    }))
    expect(onEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'fullscreen_exited',
      startMs: 2_000,
      endMs: 2_750,
      durationMs: 750,
    }))
  })

  it('flags and persists a hidden assessment window before recheck', async () => {
    const first = createStream()
    getUserMedia.mockResolvedValue(first.stream)
    const onEvent = vi.fn()
    const { result } = renderHook(() =>
      useHireInterviewIntegrityGate({ enabled: true, onEvent }),
    )

    await act(async () => {
      await result.current.startAssessment()
    })

    act(() => {
      pageHidden = true
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await waitFor(() => expect(result.current.isPaused).toBe(true))
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'browser_window_not_visible',
      durationMs: 0,
    }))

    pageHidden = false
    await act(async () => {
      await result.current.recheck()
    })

    expect(onEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'browser_window_not_visible',
      durationMs: expect.any(Number),
    }))
  })

  it('reacquires media after a camera interruption while persisting its initial fact', async () => {
    const first = createStream()
    const replacement = createStream()
    getUserMedia
      .mockResolvedValueOnce(first.stream)
      .mockResolvedValueOnce(replacement.stream)
    const onEvent = vi.fn()
    const { result } = renderHook(() =>
      useHireInterviewIntegrityGate({ enabled: true, onEvent }),
    )

    await act(async () => {
      await result.current.startAssessment()
    })

    act(() => first.camera.interrupt())
    await waitFor(() => expect(result.current.isPaused).toBe(true))
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'camera_interrupted',
      durationMs: 0,
    }))

    await act(async () => {
      await result.current.recheck()
    })

    expect(result.current.stream).toBe(replacement.stream)
    expect(onEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'camera_interrupted',
      durationMs: expect.any(Number),
    }))
  })

  it('requires and exposes a video-only entire-display share for marked Hire attempts', async () => {
    const camera = createStream()
    const monitor = createDisplayStream('monitor')
    const getDisplayMedia = vi.fn<() => Promise<MediaStream>>()
      .mockResolvedValue(monitor.stream)
    getUserMedia.mockResolvedValue(camera.stream)
    installDisplayMediaStub(getDisplayMedia)

    const { result } = renderHook(() =>
      useHireInterviewIntegrityGate({
        enabled: true,
        displayCaptureRequired: true,
      }),
    )

    await act(async () => {
      await expect(result.current.startAssessment()).resolves.toBe(true)
    })

    expect(result.current.displayStream).toBe(monitor.stream)
    expect(getDisplayMedia).toHaveBeenCalledWith({
      video: true,
      audio: false,
    })
  })

  it('reuses verified tracks when the display picker causes fullscreen loss', async () => {
    const camera = createStream()
    const monitor = createDisplayStream('monitor')
    let resolveDisplay!: (stream: MediaStream) => void
    const pendingDisplay = new Promise<MediaStream>((resolve) => {
      resolveDisplay = resolve
    })
    const getDisplayMedia = vi.fn<() => Promise<MediaStream>>()
      .mockReturnValue(pendingDisplay)
    getUserMedia.mockResolvedValue(camera.stream)
    installDisplayMediaStub(getDisplayMedia)

    const { result } = renderHook(() =>
      useHireInterviewIntegrityGate({
        enabled: true,
        displayCaptureRequired: true,
      }),
    )

    let startAssessment!: Promise<boolean>
    act(() => {
      startAssessment = result.current.startAssessment()
    })
    await waitFor(() => {
      expect(fullscreenElement).toBe(document.documentElement)
      expect(getDisplayMedia).toHaveBeenCalledTimes(1)
    })

    act(() => {
      fullscreenElement = null
      document.dispatchEvent(new Event('fullscreenchange'))
    })
    await act(async () => {
      resolveDisplay(monitor.stream)
      await expect(startAssessment).resolves.toBe(false)
    })

    expect(result.current.hasStarted).toBe(false)
    expect(result.current.stream).toBeNull()
    expect(result.current.displayStream).toBeNull()
    expect(result.current.error).toContain('Fullscreen')
    expect(camera.camera.stop).not.toHaveBeenCalled()
    expect(camera.microphone.stop).not.toHaveBeenCalled()
    expect(monitor.display.stop).not.toHaveBeenCalled()

    await act(async () => {
      await expect(result.current.startAssessment()).resolves.toBe(true)
    })

    expect(result.current.hasStarted).toBe(true)
    expect(result.current.stream).toBe(camera.stream)
    expect(result.current.displayStream).toBe(monitor.stream)
    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(getDisplayMedia).toHaveBeenCalledTimes(1)
    expect(document.documentElement.requestFullscreen).toHaveBeenCalledTimes(2)
  })

  it('rejects a tab/window choice, records the neutral fact, and retries the picker', async () => {
    const firstCamera = createStream()
    const replacementCamera = createStream()
    const tab = createDisplayStream('browser')
    const monitor = createDisplayStream('monitor')
    const getDisplayMedia = vi.fn<() => Promise<MediaStream>>()
      .mockResolvedValueOnce(tab.stream)
      .mockResolvedValueOnce(monitor.stream)
    getUserMedia
      .mockResolvedValueOnce(firstCamera.stream)
      .mockResolvedValueOnce(replacementCamera.stream)
    installDisplayMediaStub(getDisplayMedia)
    const onEvent = vi.fn()

    const { result } = renderHook(() =>
      useHireInterviewIntegrityGate({
        enabled: true,
        displayCaptureRequired: true,
        onEvent,
      }),
    )

    await act(async () => {
      await expect(result.current.startAssessment()).resolves.toBe(false)
    })

    expect(result.current.hasStarted).toBe(false)
    expect(result.current.error).toContain('entire screen')
    expect(tab.display.stop).toHaveBeenCalledTimes(1)
    expect(onEvent).toHaveBeenCalledWith({
      kind: 'screen_share_wrong_surface',
      startMs: 0,
      endMs: 0,
      durationMs: 0,
    })

    await act(async () => {
      await expect(result.current.startAssessment()).resolves.toBe(true)
    })

    expect(result.current.displayStream).toBe(monitor.stream)
    expect(getDisplayMedia).toHaveBeenCalledTimes(2)
  })

  it('pauses on display-share interruption and closes the event after recheck', async () => {
    const camera = createStream()
    const firstMonitor = createDisplayStream('monitor')
    const replacementMonitor = createDisplayStream('monitor')
    const getDisplayMedia = vi.fn<() => Promise<MediaStream>>()
      .mockResolvedValueOnce(firstMonitor.stream)
      .mockResolvedValueOnce(replacementMonitor.stream)
    getUserMedia.mockResolvedValue(camera.stream)
    installDisplayMediaStub(getDisplayMedia)
    const onEvent = vi.fn()

    const { result } = renderHook(() =>
      useHireInterviewIntegrityGate({
        enabled: true,
        displayCaptureRequired: true,
        onEvent,
      }),
    )

    await act(async () => {
      await result.current.startAssessment()
    })

    act(() => firstMonitor.display.interrupt())
    await waitFor(() => expect(result.current.isPaused).toBe(true))
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'screen_share_interrupted',
      durationMs: 0,
    }))

    await act(async () => {
      await expect(result.current.recheck()).resolves.toBe(true)
    })

    expect(result.current.isPaused).toBe(false)
    expect(result.current.displayStream).toBe(replacementMonitor.stream)
    expect(onEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'screen_share_interrupted',
      durationMs: expect.any(Number),
    }))
  })

  it('accepts a live display when the browser does not report its surface type', async () => {
    const camera = createStream()
    const monitorWithoutSurfaceMetadata = createDisplayStream()
    const getDisplayMedia = vi.fn<() => Promise<MediaStream>>()
      .mockResolvedValue(monitorWithoutSurfaceMetadata.stream)
    getUserMedia.mockResolvedValue(camera.stream)
    installDisplayMediaStub(getDisplayMedia)

    const { result } = renderHook(() =>
      useHireInterviewIntegrityGate({
        enabled: true,
        displayCaptureRequired: true,
      }),
    )

    await act(async () => {
      await expect(result.current.startAssessment()).resolves.toBe(true)
    })

    expect(result.current.displayStream).toBe(monitorWithoutSurfaceMetadata.stream)
  })

  it('does not activate browser enforcement outside Hire', () => {
    const { result } = renderHook(() =>
      useHireInterviewIntegrityGate({ enabled: false }),
    )

    act(() => {
      document.dispatchEvent(new Event('fullscreenchange'))
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('blur'))
    })

    expect(result.current.isPaused).toBe(false)
    expect(result.current.hasStarted).toBe(false)
  })
})
