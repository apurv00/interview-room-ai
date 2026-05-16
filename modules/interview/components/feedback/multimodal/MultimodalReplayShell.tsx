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
}

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
}: MultimodalReplayShellProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const lastEmitRef = useRef(0)
  const [internalDuration, setInternalDuration] = useState(0)

  // Seek function exposed via the ref-callback pattern. Guard against
  // non-finite seconds (the existing VideoPlayer hit a TypeError here when
  // the duration hadn't loaded yet — same defensive check applies).
  const seekTo = useCallback((seconds: number) => {
    if (!videoRef.current || !Number.isFinite(seconds)) return
    videoRef.current.currentTime = seconds
  }, [])

  useEffect(() => {
    onSeekRef?.(seekTo)
    return () => onSeekRef?.(null)
  }, [seekTo, onSeekRef])

  // Honor the external `playing` prop. Avoid calling play()/pause()
  // unnecessarily — only call when the actual paused state diverges.
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    if (playing && v.paused) {
      v.play().catch(() => {
        // Autoplay blocked or other media error — flip external state back
        setPlaying(false)
      })
    } else if (!playing && !v.paused) {
      v.pause()
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

    const onLoadedMetadata = () => {
      if (Number.isFinite(v.duration) && v.duration > 0) {
        setInternalDuration(v.duration)
        onDurationKnown?.(v.duration)
        return
      }
      // Trigger the probe.
      durationProbeInProgress = true
      try {
        v.currentTime = Number.MAX_SAFE_INTEGER
      } catch {
        // Some browsers throw on non-finite seeks; nothing we can do
        // beyond leaving duration at 0.
      }
    }

    const onDurationChange = () => {
      if (Number.isFinite(v.duration) && v.duration > 0) {
        setInternalDuration(v.duration)
        onDurationKnown?.(v.duration)
        if (durationProbeInProgress) {
          durationProbeInProgress = false
          // Restore playhead to start after the EOF probe.
          try { v.currentTime = 0 } catch { /* ignore */ }
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
        onTimeUpdate?.(v.currentTime)
      }
    }

    const onEnded = () => setPlaying(false)
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)

    v.addEventListener('loadedmetadata', onLoadedMetadata)
    v.addEventListener('durationchange', onDurationChange)
    v.addEventListener('timeupdate', onTimeUpdateEv)
    v.addEventListener('ended', onEnded)
    v.addEventListener('play', onPlay)
    v.addEventListener('pause', onPause)

    return () => {
      v.removeEventListener('loadedmetadata', onLoadedMetadata)
      v.removeEventListener('durationchange', onDurationChange)
      v.removeEventListener('timeupdate', onTimeUpdateEv)
      v.removeEventListener('ended', onEnded)
      v.removeEventListener('play', onPlay)
      v.removeEventListener('pause', onPause)
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
          {activeQuestionLabel} · {formatTime(currentTimeSec)} / {formatTime(duration)}
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

      {/* Centered play/pause button */}
      <button
        type="button"
        onClick={() => setPlaying(!playing)}
        className="absolute inset-0 grid place-items-center group"
        aria-label={playing ? 'Pause video' : 'Play video'}
      >
        <span
          className="w-[60px] h-[60px] rounded-full grid place-items-center text-stone-900 transition-transform group-hover:scale-105"
          style={{ background: 'rgba(255,255,255,0.92)' }}
        >
          {playing ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5 translate-x-0.5" />}
        </span>
      </button>

      {/* Bottom: live transcript caption overlay */}
      <VideoCaptionOverlay
        whisperSegments={whisperSegments}
        currentTimeSec={currentTimeSec}
      />
    </div>
  )
}
