// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tapAudioElement, resetVoiceMixer } from '../voiceMixer'

/**
 * Guards the iOS gate in tapAudioElement: on Apple touch devices the TTS
 * element must NOT be routed through the mic-bound AudioContext (it would be
 * silenced by the iOS PlayAndRecord session conflict), so it plays natively.
 * On desktop / Android the element is still tapped so the AI voice is mixed
 * into the recording. The discriminating observable is whether
 * `createMediaElementSource` is invoked.
 */

function installAudioMock() {
  const connect = vi.fn()
  const createMediaElementSource = vi.fn(() => ({ connect }))
  const createMediaStreamDestination = vi.fn(() => ({ stream: {} }))
  const createMediaStreamSource = vi.fn(() => ({ connect }))

  class MockAudioContext {
    state = 'running'
    destination = {}
    createMediaElementSource = createMediaElementSource
    createMediaStreamDestination = createMediaStreamDestination
    createMediaStreamSource = createMediaStreamSource
    resume = vi.fn(() => Promise.resolve())
    close = vi.fn(() => Promise.resolve())
  }

  vi.stubGlobal('AudioContext', MockAudioContext as unknown as typeof AudioContext)
  ;(window as unknown as { AudioContext: unknown }).AudioContext = MockAudioContext
  return { createMediaElementSource }
}

function setDevice(userAgent: string, maxTouchPoints = 0) {
  Object.defineProperty(window.navigator, 'userAgent', { value: userAgent, configurable: true })
  Object.defineProperty(window.navigator, 'maxTouchPoints', { value: maxTouchPoints, configurable: true })
}

const UA = {
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  androidChrome: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15',
  iPhone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
  iPadAsMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15',
}

describe('voiceMixer.tapAudioElement — iOS native-playback gate', () => {
  let mock: ReturnType<typeof installAudioMock>

  beforeEach(() => {
    mock = installAudioMock()
  })

  afterEach(() => {
    resetVoiceMixer()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('taps the element into the AudioContext on desktop Windows/Chrome', () => {
    setDevice(UA.windows, 0)
    tapAudioElement({} as HTMLMediaElement)
    expect(mock.createMediaElementSource).toHaveBeenCalledTimes(1)
  })

  it('taps on Android Chrome (single-session conflict does not exist there)', () => {
    setDevice(UA.androidChrome, 5)
    tapAudioElement({} as HTMLMediaElement)
    expect(mock.createMediaElementSource).toHaveBeenCalledTimes(1)
  })

  it('taps on a real Mac (Macintosh UA, no touch)', () => {
    setDevice(UA.mac, 0)
    tapAudioElement({} as HTMLMediaElement)
    expect(mock.createMediaElementSource).toHaveBeenCalledTimes(1)
  })

  it('does NOT tap on iPhone — leaves the element on native playback', () => {
    setDevice(UA.iPhone, 5)
    tapAudioElement({} as HTMLMediaElement)
    expect(mock.createMediaElementSource).not.toHaveBeenCalled()
  })

  it('does NOT tap on iPad masquerading as Macintosh (maxTouchPoints > 1)', () => {
    setDevice(UA.iPadAsMac, 5)
    tapAudioElement({} as HTMLMediaElement)
    expect(mock.createMediaElementSource).not.toHaveBeenCalled()
  })
})
