'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Play, Pause, Maximize2, Minimize2 } from 'lucide-react'
import type { WhisperSegment } from '@shared/types/multimodal'
import VideoCaptionOverlay from './VideoCaptionOverlay'
import { FONT_MONO } from './tokens'

interface MultimodalReplayShellProps {
  src: string
  /** External time source — mirrors the existing `analysisVideoTime` pattern. */
  currentTimeSec: number
  onTimeUpdate?: (sec: number) => void
  /** Mirrors the existing `analysisSeekRef` callback pattern from VideoPlayer. */
  onSeekRef?: (fn: ((sec: number) => void) | null) => void
  /** Live transcript caption source. */
  whisperSegments?: WhisperSegment[]
  /** "Asked: …" question-title chip shown top-right. */
  askedQuestion?: string
  /** Q-chip label top-left (e.g. "Q1"). */
  activeQuestionLabel?: string
  totalDurationSec?: number
  /** External play/pause control. Lets the panel-level Scrubber play button trigger media. */
  playing: boolean
  setPlaying: (p: boolean) => void
  /** Fullscreen toggle on the video itself (top-right icon). */
  replayFullscreen: boolean
  setReplayFullscreen: (v: boolean) => void
  /** Optional callback when video metadata loads — useful for picking up duration. */
  onDurationKnown?: (sec: number) => void
  /**
   * Recorder-truth duration persisted at upload time. Skips the EOF probe
   * (which forces a full-file download at mount on cue-less MediaRecorder
   * webm). Legacy sessions without it keep the probe fallback.
   */
  knownDurationSeconds?: number | null
  /**
   * Mint a fresh presigned URL after a media error (expired presign TTL).
   * Parent swaps src; this component restores the playhead.
   */
  onRequestFreshUrl?: () => Promise<string | null>
}

const MAX_URL_REFRESH_ATTEMPTS = 2

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

const TIME_UPDATE_THROTTLE_MS = 150

/**
 * Bare-video shell — separate from the existing VideoPlayer.tsx so we don't
 * disturb its other callers. Controls match the prototype: Q chip top-left,
 * asked-question chip top-right (with fullscreen icon corner), centered
 * play/pause overlay, and the VideoCaptionOverlay anchored to the bottom.
 *
 * The actual scrubber + signal track + chapter row + metric chips live in
 * sibling components below this — they're NOT inside the video frame.
 */
export default function MultimodalReplayShell({
  src,
  currentTimeSec,
  onTimeUpdate,
  onSeekRef,
  whisperSegments,
  askedQuestion,
  activeQuestionLabel,
  totalDurationSec,
  playing,
  setPlaying,
  replayFullscreen,
  setReplayFullscreen,
  onDurationKnown,
  knownDurationSeconds,
  onRequestFreshUrl,
}: MultimodalReplayShellProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const lastEmitRef = useRef(0)
  const [internalDuration, setInternalDuration] = useState(0)

  // Prop mirrors + recovery state for the listener effect below.
  const knownDurationRef = useRef(knownDurationSeconds)
  knownDurationRef.current = knownDurationSeconds
  const onRequestFreshUrlRef = useRef(onRequestFreshUrl)
  onRequestFreshUrlRef.current = onRequestFreshUrl
  const playingRef = useRef(false)
  playingRef.current = playing
  const refreshAttemptsRef = useRef(0)
  const restoreAfterRefreshRef = useRef<{ time: number; wasPlaying: boolean } | null>(null)
  const lastKnownTimeRef = useRef(0)
  const pendingSeekRef = useRef<number | null>(null)
  const requestProbeRef = useRef<(() => void) | null>(null)

  // Seek function exposed via the ref-callback pattern. Guard against
  // non-finite seconds (the existing VideoPlayer hit a TypeError here when
  // the duration hadn't loaded yet — same defensive check applies).
  const seekTo = useCallback((seconds: number) => {
    const v = videoRef.current
    if (!v || !Number.isFinite(seconds)) return
    // Seek guard: with the EOF probe skipped (knownDurationSeconds), the
    // element's own duration can still be Infinity, and a seek into
    // unbuffered territory on a cue-less webm can clamp to the buffered end
    // (a moment-click at 22:10 landing at 0:05). Run the probe first, then
    // complete the seek when the real duration lands — the full-read cost is
    // paid only when the user actually seeks.
    if (!Number.isFinite(v.duration) && seconds > 0.5) {
      pendingSeekRef.current = seconds
      // Probe only once metadata is loaded: a pre-metadata probe leaves
      // durationProbeInProgress set through the known-duration
      // loadedmetadata path, permanently suppressing timeupdate (frozen
      // timeline — Codex P2 #555). Pre-metadata seeks park in
      // pendingSeekRef; loadedmetadata resumes them.
      if (v.readyState >= HTMLMediaElement.HAVE_METADATA) {
        requestProbeRef.current?.()
      }
      return
    }
    v.currentTime = seconds
  }, [])

  useEffect(() => {
    onSeekRef?.(seekTo)
    return () => onSeekRef?.(null)
  }, [seekTo, onSeekRef])

  // Honor the external `playing` prop (panel-level Scrubber play button,
  // keyboard shortcut, etc.). Direct user clicks on the centered overlay
  // button go through `togglePlay` below, which calls v.play() inside the
  // gesture handler — this useEffect is the fallback for state-driven
  // changes that originate outside this component.
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    if (playing && v.paused) {
      v.play().catch(() => {
        // Autoplay blocked or other media error — flip external state back.
        setPlaying(false)
      })
    } else if (!playing && !v.paused) {
      v.pause()
    }
  }, [playing, setPlaying])

  // Direct gesture-bound play/pause for the centered overlay button.
  //
  // Codex P2 review on PR #370 caught that the previous `onClick` only
  // toggled React state and deferred `v.play()` to the useEffect above —
  // by the time the effect runs, browsers that enforce user-activation
  // playback rules (notably Safari and stricter autoplay contexts) have
  // lost the gesture context and reject the play() promise. The button
  // then flipped back to paused and the video never started.
  //
  // Calling `v.play()` synchronously from the click handler preserves the
  // user-activation token so playback is honored. We still update React
  // state so external listeners (panel Scrubber play button, etc.) stay
  // in sync, but the play() call itself no longer crosses an event-loop
  // boundary that strips the gesture.
  const togglePlay = useCallback(() => {
    const v = videoRef.current
    if (!v) {
      setPlaying(!playing)
      return
    }
    if (v.paused) {
      const result = v.play()
      // play() may return undefined in very old browsers; guard the chain.
      if (result && typeof result.then === 'function') {
        result.then(() => setPlaying(true)).catch(() => setPlaying(false))
      } else {
        setPlaying(true)
      }
    } else {
      v.pause()
      setPlaying(false)
    }
  }, [playing, setPlaying])

  // MediaRecorder-produced webm files don't include a duration header, so
  // `video.duration` is `Infinity` on `loadedmetadata` until the browser has
  // scanned to EOF. If we forward Infinity to the parent's `onDurationKnown`,
  // downstream timeline math uses it as the denominator (`currentTime /
  // Infinity * 100 = 0`), collapsing every scrubber/marker/playhead and
  // showing "Infinity" in time readouts. Ported from VideoPlayer.tsx's
  // probe-and-seek workaround — Codex P1 review on PR #370.
  //
  // Approach: on loadedmetadata, if duration is non-finite, seek to
  // MAX_SAFE_INTEGER to force the browser to read to EOF; the real duration
  // then arrives via `durationchange`, after which we seek back to 0 and
  // forward the real value.
  //
  // Use a single useEffect (instead of separate useCallbacks) so the probe
  // state (`durationProbeInProgress`) is correctly scoped to the listener
  // lifetime — if `playing`/etc. changes between events, the probe state
  // must persist.
  useEffect(() => {
    const v = videoRef.current
    if (!v) return

    let durationProbeInProgress = false

    const startProbe = () => {
      if (durationProbeInProgress) return
      durationProbeInProgress = true
      try {
        v.currentTime = Number.MAX_SAFE_INTEGER
      } catch {
        // Some browsers throw on non-finite seeks; nothing we can do
        // beyond leaving duration at 0. The flag deliberately stays set so
        // stray timeupdate events remain suppressed (original semantics).
      }
    }
    requestProbeRef.current = startProbe

    const restoreAfterRefresh = () => {
      const restore = restoreAfterRefreshRef.current
      if (!restore) return
      restoreAfterRefreshRef.current = null
      try { v.currentTime = restore.time } catch { /* ignore */ }
      if (restore.wasPlaying) {
        v.play().then(() => setPlaying(true)).catch(() => setPlaying(false))
      }
    }

    const onLoadedMetadata = () => {
      if (Number.isFinite(v.duration) && v.duration > 0) {
        setInternalDuration(v.duration)
        onDurationKnown?.(v.duration)
        restoreAfterRefresh()
        const pending = pendingSeekRef.current
        if (pending !== null) {
          pendingSeekRef.current = null
          try { v.currentTime = pending } catch { /* ignore */ }
        }
        return
      }
      const known = knownDurationRef.current
      if (typeof known === 'number' && known > 0) {
        // Probe skipped — recorder-truth duration drives the timeline. The
        // durationchange path below still lets the browser's own finite
        // value win when the file fully buffers.
        setInternalDuration(known)
        onDurationKnown?.(known)
        restoreAfterRefresh()
        // A seek parked before metadata loaded (seek guard defers the probe
        // until HAVE_METADATA) resumes here.
        if (pendingSeekRef.current !== null) startProbe()
        return
      }
      // Legacy session without a persisted duration — trigger the probe.
      startProbe()
    }

    const onDurationChange = () => {
      if (Number.isFinite(v.duration) && v.duration > 0) {
        setInternalDuration(v.duration)
        onDurationKnown?.(v.duration)
        if (durationProbeInProgress) {
          durationProbeInProgress = false
          // Restore playhead after the EOF probe — to the seek that
          // triggered it (seek guard), else to the start.
          const target = pendingSeekRef.current ?? 0
          pendingSeekRef.current = null
          try { v.currentTime = target } catch { /* ignore */ }
        }
      }
    }

    const onTimeUpdateEv = () => {
      // While probing, currentTime briefly spikes to MAX_SAFE_INTEGER;
      // suppress those events so neither our internal time nor the parent
      // gets a garbage value.
      if (durationProbeInProgress) return
      const now = performance.now()
      if (now - lastEmitRef.current < TIME_UPDATE_THROTTLE_MS) return
      lastEmitRef.current = now
      if (Number.isFinite(v.currentTime)) {
        lastKnownTimeRef.current = v.currentTime
        onTimeUpdate?.(v.currentTime)
      }
    }

    const onEnded = () => setPlaying(false)
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    const onCanPlay = () => {
      // Healthy load — reset the per-src refresh budget.
      refreshAttemptsRef.current = 0
    }
    const onError = () => {
      // This shell previously had NO error listener: when the presigned URL
      // expired (30-min TTL vs long-open tabs), play() rejected silently and
      // the button just died until a full reload. Recover by minting a fresh
      // URL (any error code — expired presigns surface as SRC_NOT_SUPPORTED
      // on load and NETWORK mid-play), bounded per src load.
      const refresh = onRequestFreshUrlRef.current
      if (!refresh || refreshAttemptsRef.current >= MAX_URL_REFRESH_ATTEMPTS) return
      refreshAttemptsRef.current += 1
      durationProbeInProgress = false
      restoreAfterRefreshRef.current = {
        time: lastKnownTimeRef.current,
        wasPlaying: playingRef.current,
      }
      setPlaying(false)
      void refresh().then((freshUrl) => {
        if (!freshUrl) restoreAfterRefreshRef.current = null
        // On success the parent swaps src; loadedmetadata restores position.
      })
    }

    v.addEventListener('loadedmetadata', onLoadedMetadata)
    v.addEventListener('durationchange', onDurationChange)
    v.addEventListener('timeupdate', onTimeUpdateEv)
    v.addEventListener('ended', onEnded)
    v.addEventListener('play', onPlay)
    v.addEventListener('pause', onPause)
    v.addEventListener('canplay', onCanPlay)
    v.addEventListener('error', onError)

    return () => {
      requestProbeRef.current = null
      v.removeEventListener('loadedmetadata', onLoadedMetadata)
      v.removeEventListener('durationchange', onDurationChange)
      v.removeEventListener('timeupdate', onTimeUpdateEv)
      v.removeEventListener('ended', onEnded)
      v.removeEventListener('play', onPlay)
      v.removeEventListener('pause', onPause)
      v.removeEventListener('canplay', onCanPlay)
      v.removeEventListener('error', onError)
    }
  }, [onTimeUpdate, onDurationKnown, setPlaying])

  const duration = totalDurationSec ?? internalDuration

  return (
    <div
      className="relative rounded-lg overflow-hidden flex-1 min-h-0"
      style={{
        background: 'linear-gradient(180deg, #18181b 0%, #27272a 100%)',
      }}
    >
      {/* The bare video — no native controls; we own the UX.
          All event listeners (loadedmetadata, durationchange, timeupdate,
          ended, play, pause) are registered via the useEffect above so the
          MediaRecorder duration-probe state stays scoped correctly. */}
      <video
        ref={videoRef}
        src={src}
        className="absolute inset-0 w-full h-full object-cover"
        playsInline
        preload="metadata"
      />

      {/* Top-left: Q chip with timestamp */}
      {activeQuestionLabel && (
        <div
          className="absolute top-3.5 left-3.5 flex items-center gap-2 rounded-md backdrop-blur-sm"
          style={{
            background: 'rgba(0,0,0,0.55)',
            color: '#fafafa',
            fontFamily: FONT_MONO,
            fontSize: 12,
            padding: '6px 11px',
          }}
        >
          <span style={{ color: '#fbbf24' }}>●</span>
          {activeQuestionLabel}
        </div>
      )}

      {/* Top-right offset: asked-question title chip */}
      {askedQuestion && (
        <div
          className="absolute top-3.5 right-[50px] rounded-md backdrop-blur-sm overflow-hidden whitespace-nowrap"
          style={{
            background: 'rgba(0,0,0,0.55)',
            color: 'rgba(255,255,255,0.85)',
            fontSize: 12,
            padding: '6px 11px',
            maxWidth: 380,
            textOverflow: 'ellipsis',
          }}
        >
          <span style={{ color: 'rgba(255,255,255,0.5)', marginRight: 6 }}>Asked:</span>
          {askedQuestion}
        </div>
      )}

      {/* Top-right corner: fullscreen toggle */}
      <button
        type="button"
        onClick={() => setReplayFullscreen(!replayFullscreen)}
        className="absolute top-3.5 right-3.5 w-7 h-7 grid place-items-center rounded-md text-stone-50 backdrop-blur-sm"
        style={{ background: 'rgba(0,0,0,0.55)' }}
        title={replayFullscreen ? 'Exit fullscreen (Esc)' : 'Expand replay'}
        aria-label={replayFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
      >
        {replayFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
      </button>

      {/* Centered play/pause button. Wrapper is `inset-0 pointer-events-none`
          so it can flex-center its child without capturing clicks across the
          whole frame — that was the Codex P1 bug (PR #370) where the play
          overlay stole clicks meant for the top-right fullscreen icon. Only
          the 60×60 button itself is clickable (`pointer-events-auto`). */}
      <div className="absolute inset-0 grid place-items-center pointer-events-none">
        <button
          type="button"
          onClick={togglePlay}
          className="w-[60px] h-[60px] rounded-full grid place-items-center text-stone-900 transition-transform hover:scale-105 pointer-events-auto"
          style={{ background: 'rgba(255,255,255,0.92)' }}
          aria-label={playing ? 'Pause video' : 'Play video'}
        >
          {playing ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5 translate-x-0.5" />}
        </button>
      </div>

      {/* Bottom: live transcript caption overlay */}
      <VideoCaptionOverlay
        whisperSegments={whisperSegments}
        currentTimeSec={currentTimeSec}
      />
    </div>
  )
}
