import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, screen, act } from '@testing-library/react'
import MultimodalReplayShell from '../MultimodalReplayShell'

/**
 * Regression test for Codex P1 on PR #370:
 *
 *   When `loadedmetadata` reports `video.duration === Infinity` (common for
 *   MediaRecorder WebM blobs until EOF probing), this code stores that
 *   non-finite duration and forwards it to the parent; downstream timeline
 *   math then uses `Infinity` as the denominator, collapsing scrubber/
 *   markers/playhead and producing invalid time displays.
 *
 * The shell must:
 *   1. NOT forward Infinity / non-finite duration to `onDurationKnown`
 *   2. Trigger a probe by seeking to MAX_SAFE_INTEGER
 *   3. Forward the real duration once `durationchange` fires with a finite value
 *   4. Suppress `timeupdate` events while the probe is in flight
 */

beforeEach(() => {
  // jsdom doesn't implement HTMLMediaElement methods used by the shell.
  // Stub `.play()` so the playing-state effect doesn't throw.
  // (We don't actually drive playback — we drive events manually.)
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})

describe('MultimodalReplayShell — MediaRecorder duration probe (Codex P1)', () => {
  it('does NOT forward Infinity to onDurationKnown when loadedmetadata reports it', () => {
    const onDurationKnown = vi.fn()
    const { container } = render(
      <MultimodalReplayShell
        src="blob:fake"
        currentTimeSec={0}
        playing={false}
        setPlaying={() => {}}
        replayFullscreen={false}
        setReplayFullscreen={() => {}}
        onDurationKnown={onDurationKnown}
      />
    )
    const video = container.querySelector('video')! as HTMLVideoElement
    // Force duration = Infinity (MediaRecorder behavior).
    Object.defineProperty(video, 'duration', { configurable: true, get: () => Infinity })
    act(() => { fireEvent.loadedMetadata(video) })

    expect(onDurationKnown).not.toHaveBeenCalled()
  })

  it('triggers the duration probe (currentTime jumps to MAX_SAFE_INTEGER) on Infinity', () => {
    const { container } = render(
      <MultimodalReplayShell
        src="blob:fake"
        currentTimeSec={0}
        playing={false}
        setPlaying={() => {}}
        replayFullscreen={false}
        setReplayFullscreen={() => {}}
      />
    )
    const video = container.querySelector('video')! as HTMLVideoElement
    let lastSeek = 0
    Object.defineProperty(video, 'duration', { configurable: true, get: () => Infinity })
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      get: () => 0,
      set: (v) => { lastSeek = v },
    })
    act(() => { fireEvent.loadedMetadata(video) })

    expect(lastSeek).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('forwards the real duration once durationchange fires with a finite value', () => {
    const onDurationKnown = vi.fn()
    const { container } = render(
      <MultimodalReplayShell
        src="blob:fake"
        currentTimeSec={0}
        playing={false}
        setPlaying={() => {}}
        replayFullscreen={false}
        setReplayFullscreen={() => {}}
        onDurationKnown={onDurationKnown}
      />
    )
    const video = container.querySelector('video')! as HTMLVideoElement
    // Phase 1: loadedmetadata with Infinity (triggers probe)
    let currentTimeStored = 0
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      get: () => currentTimeStored,
      set: (v) => { currentTimeStored = v },
    })
    Object.defineProperty(video, 'duration', { configurable: true, get: () => Infinity })
    act(() => { fireEvent.loadedMetadata(video) })
    expect(onDurationKnown).not.toHaveBeenCalled()

    // Phase 2: durationchange with real value
    Object.defineProperty(video, 'duration', { configurable: true, get: () => 339 })
    act(() => { fireEvent.durationChange(video) })
    expect(onDurationKnown).toHaveBeenCalledWith(339)
    // And the playhead should have been reset to 0 after the probe.
    expect(currentTimeStored).toBe(0)
  })

  it('forwards the duration normally when loadedmetadata reports a finite value', () => {
    const onDurationKnown = vi.fn()
    const { container } = render(
      <MultimodalReplayShell
        src="blob:fake"
        currentTimeSec={0}
        playing={false}
        setPlaying={() => {}}
        replayFullscreen={false}
        setReplayFullscreen={() => {}}
        onDurationKnown={onDurationKnown}
      />
    )
    const video = container.querySelector('video')! as HTMLVideoElement
    Object.defineProperty(video, 'duration', { configurable: true, get: () => 120 })
    act(() => { fireEvent.loadedMetadata(video) })

    expect(onDurationKnown).toHaveBeenCalledWith(120)
  })

  it('suppresses timeupdate events while the duration probe is in flight', () => {
    const onTimeUpdate = vi.fn()
    const { container } = render(
      <MultimodalReplayShell
        src="blob:fake"
        currentTimeSec={0}
        playing={false}
        setPlaying={() => {}}
        replayFullscreen={false}
        setReplayFullscreen={() => {}}
        onTimeUpdate={onTimeUpdate}
      />
    )
    const video = container.querySelector('video')! as HTMLVideoElement
    Object.defineProperty(video, 'duration', { configurable: true, get: () => Infinity })
    Object.defineProperty(video, 'currentTime', { configurable: true, get: () => Number.MAX_SAFE_INTEGER })
    act(() => { fireEvent.loadedMetadata(video) })
    // While probing, simulated timeupdate events MUST NOT call onTimeUpdate.
    act(() => { fireEvent.timeUpdate(video) })
    expect(onTimeUpdate).not.toHaveBeenCalled()
  })

  it('does NOT forward non-finite currentTime even if a stray timeupdate fires', () => {
    const onTimeUpdate = vi.fn()
    const { container } = render(
      <MultimodalReplayShell
        src="blob:fake"
        currentTimeSec={0}
        playing={false}
        setPlaying={() => {}}
        replayFullscreen={false}
        setReplayFullscreen={() => {}}
        onTimeUpdate={onTimeUpdate}
      />
    )
    const video = container.querySelector('video')! as HTMLVideoElement
    // Skip probe — start with a finite duration so the probe gate is closed.
    Object.defineProperty(video, 'duration', { configurable: true, get: () => 120 })
    act(() => { fireEvent.loadedMetadata(video) })

    // Now force currentTime to Infinity (shouldn't happen in practice, but guard anyway).
    Object.defineProperty(video, 'currentTime', { configurable: true, get: () => Infinity })
    act(() => { fireEvent.timeUpdate(video) })
    expect(onTimeUpdate).not.toHaveBeenCalled()
  })
})

describe('MultimodalReplayShell — basic render', () => {
  it('renders the Q chip when activeQuestionLabel is provided', () => {
    render(
      <MultimodalReplayShell
        src="blob:fake"
        currentTimeSec={42}
        totalDurationSec={300}
        playing={false}
        setPlaying={() => {}}
        replayFullscreen={false}
        setReplayFullscreen={() => {}}
        activeQuestionLabel="Q3"
      />
    )
    expect(screen.getByText(/Q3 · 0:42 \/ 5:00/)).toBeInTheDocument()
  })

  it('renders the asked-question chip when askedQuestion is provided', () => {
    render(
      <MultimodalReplayShell
        src="blob:fake"
        currentTimeSec={0}
        playing={false}
        setPlaying={() => {}}
        replayFullscreen={false}
        setReplayFullscreen={() => {}}
        askedQuestion="Tell me about a tradeoff."
      />
    )
    expect(screen.getByText('Asked:')).toBeInTheDocument()
    expect(screen.getByText('Tell me about a tradeoff.')).toBeInTheDocument()
  })
})
