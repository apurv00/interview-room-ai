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

  it('a pre-metadata seek does not start the probe and does not freeze timeupdate (Codex P2 #555)', () => {
    const onTimeUpdate = vi.fn()
    let seek: ((sec: number) => void) | null = null
    const { container } = render(
      <MultimodalReplayShell
        src="blob:fake"
        currentTimeSec={0}
        playing={false}
        setPlaying={() => {}}
        replayFullscreen={false}
        setReplayFullscreen={() => {}}
        onTimeUpdate={onTimeUpdate}
        onSeekRef={(fn) => { seek = fn }}
        knownDurationSeconds={1800}
      />
    )
    const video = container.querySelector('video')! as HTMLVideoElement
    // Before metadata: duration NaN, readyState HAVE_NOTHING (jsdom default 0).
    Object.defineProperty(video, 'duration', { configurable: true, get: () => NaN })

    // Moment-click lands before loadedmetadata: must park, NOT probe — the
    // old code set durationProbeInProgress immediately (a seek browsers
    // discard pre-metadata), and the known-duration loadedmetadata path
    // returned without clearing it, suppressing every subsequent timeupdate
    // (frozen multimodal timeline).
    act(() => { seek!(1330) })

    // Pre-metadata timeupdates must NOT be suppressed (probe not started).
    Object.defineProperty(video, 'currentTime', { configurable: true, get: () => 12.5, set: () => {} })
    act(() => { fireEvent.timeUpdate(video) })
    expect(onTimeUpdate).toHaveBeenCalledWith(12.5)

    // Once metadata lands, the parked seek resumes via the probe, and the
    // probe completes through durationchange, applying the parked target.
    const seeks: number[] = []
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      get: () => 12.5,
      set: (v: number) => { seeks.push(v) },
    })
    act(() => { fireEvent.loadedMetadata(video) })
    expect(seeks).toContain(Number.MAX_SAFE_INTEGER)

    Object.defineProperty(video, 'duration', { configurable: true, get: () => 1789 })
    act(() => { fireEvent.durationChange(video) })
    expect(seeks).toContain(1330)
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

describe('MultimodalReplayShell — fullscreen overlay click capture (Codex P1 #2)', () => {
  it('renders the play button as a 60×60 element, NOT a full-frame absolute overlay', () => {
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
    // The play button itself must be sized (not `absolute inset-0`). The
    // wrapper centering it can be inset-0 but must be pointer-events-none.
    const playBtn = container.querySelector('button[aria-label="Play video"]') as HTMLElement
    expect(playBtn).toBeTruthy()
    // Regression: the button class must NOT include "inset-0" (which made
    // the whole frame swallow clicks meant for the fullscreen icon).
    expect(playBtn.className).not.toMatch(/inset-0/)
    // The wrapper that uses inset-0 must disable pointer events so the
    // surrounding video frame doesn't block other overlay buttons.
    const wrapper = playBtn.parentElement!
    expect(wrapper.className).toContain('inset-0')
    expect(wrapper.className).toContain('pointer-events-none')
  })

  it('fullscreen toggle button is reachable (not occluded by the play overlay)', () => {
    const setFullscreen = vi.fn()
    render(
      <MultimodalReplayShell
        src="blob:fake"
        currentTimeSec={0}
        playing={false}
        setPlaying={() => {}}
        replayFullscreen={false}
        setReplayFullscreen={setFullscreen}
      />
    )
    fireEvent.click(screen.getByLabelText('Enter fullscreen'))
    expect(setFullscreen).toHaveBeenCalledWith(true)
  })
})

describe('MultimodalReplayShell — basic render', () => {
  it('renders the Q chip when activeQuestionLabel is provided (label only, no timer)', () => {
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
    // The chip shows just the Q label now — the timer was removed because the
    // scrubber row right below already shows currentTime / totalDuration.
    expect(screen.getByText('Q3')).toBeInTheDocument()
    expect(screen.queryByText(/0:42/)).toBeNull()
    expect(screen.queryByText(/5:00/)).toBeNull()
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

/**
 * Regression test for Codex P2 (unresolved comment on PR #370):
 *
 *   The previous click handler only toggled `playing` state and deferred
 *   `video.play()` to a `useEffect`. By the time the effect ran, Safari
 *   and other strict-autoplay browsers had lost the user-activation
 *   token and rejected play() as non-gesture playback — the button
 *   flipped back to paused and the video never started.
 *
 * The fix: call `v.play()` synchronously from the onClick handler so the
 * gesture context is preserved. `setPlaying` is still updated for
 * external listeners (panel-level Scrubber play button, etc.).
 */
describe('MultimodalReplayShell — direct user-gesture play (Codex P2)', () => {
  it('calls video.play() synchronously inside the click handler', () => {
    const playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play')
      .mockImplementation(() => Promise.resolve())
    const setPlaying = vi.fn()
    const { container } = render(
      <MultimodalReplayShell
        src="blob:fake"
        currentTimeSec={0}
        playing={false}
        setPlaying={setPlaying}
        replayFullscreen={false}
        setReplayFullscreen={() => {}}
      />
    )
    // Force the video to look "paused" so togglePlay calls play().
    const video = container.querySelector('video') as HTMLVideoElement
    Object.defineProperty(video, 'paused', { configurable: true, value: true })

    const playBtn = screen.getByLabelText('Play video')
    fireEvent.click(playBtn)

    // The play() call must happen synchronously during the click event —
    // before any setState batch flushes — so the user-gesture token is
    // still valid when Safari evaluates the autoplay policy.
    expect(playSpy).toHaveBeenCalledTimes(1)
  })

  it('calls video.pause() synchronously inside the click handler when already playing', () => {
    const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause')
      .mockImplementation(() => {})
    const setPlaying = vi.fn()
    const { container } = render(
      <MultimodalReplayShell
        src="blob:fake"
        currentTimeSec={0}
        playing={true}
        setPlaying={setPlaying}
        replayFullscreen={false}
        setReplayFullscreen={() => {}}
      />
    )
    const video = container.querySelector('video') as HTMLVideoElement
    Object.defineProperty(video, 'paused', { configurable: true, value: false })

    const pauseBtn = screen.getByLabelText('Pause video')
    pauseSpy.mockClear() // ignore any pause() calls triggered by mount effects
    fireEvent.click(pauseBtn)

    expect(pauseSpy).toHaveBeenCalledTimes(1)
    expect(setPlaying).toHaveBeenCalledWith(false)
  })

  it('reverts external playing state to false when play() rejects (autoplay block)', async () => {
    const setPlaying = vi.fn()
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(
      () => Promise.reject(new Error('NotAllowedError'))
    )
    const { container } = render(
      <MultimodalReplayShell
        src="blob:fake"
        currentTimeSec={0}
        playing={false}
        setPlaying={setPlaying}
        replayFullscreen={false}
        setReplayFullscreen={() => {}}
      />
    )
    const video = container.querySelector('video') as HTMLVideoElement
    Object.defineProperty(video, 'paused', { configurable: true, value: true })

    const playBtn = screen.getByLabelText('Play video')
    await act(async () => {
      fireEvent.click(playBtn)
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(setPlaying).toHaveBeenLastCalledWith(false)
  })
})
