'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

interface QuestionMarker {
  label: string
  offsetSeconds: number
}

interface AudioPlayerProps {
  src: string
  questionMarkers: QuestionMarker[]
  onTimeUpdate?: (currentTimeSeconds: number) => void
  onSeek?: (seekFn: (seconds: number) => void) => void
  /**
   * Recorder-truth duration persisted at upload time. When present, the
   * MediaRecorder-webm EOF probe is SKIPPED — the probe seeks to
   * MAX_SAFE_INTEGER to learn the duration, which forces the browser to
   * stream the whole file at mount (the mechanism behind the 394MB-for-a-
   * 157MB-recording DevTools capture). Legacy sessions without the field
   * keep the probe as fallback.
   */
  knownDurationSeconds?: number | null
  /**
   * Mint a fresh presigned URL after a media error (the presign TTL expires
   * under long-open tabs; R2 then 403s and the element dies). The parent
   * swaps the src prop; this component restores position/playback. Absent
   * for legacy non-presigned sources.
   */
  onRequestFreshUrl?: () => Promise<string | null>
}

import { formatTime } from '@shared/utils'

const SPEEDS = [0.5, 1, 1.25, 1.5, 2] as const
const THROTTLE_MS = 200
const MAX_URL_REFRESH_ATTEMPTS = 2

export default function AudioPlayer({ src, questionMarkers, onTimeUpdate, onSeek, knownDurationSeconds, onRequestFreshUrl }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const lastUpdateRef = useRef(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [speed, setSpeed] = useState(1)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Prop mirrors for the stable (empty-deps) listener effect below.
  const knownDurationRef = useRef(knownDurationSeconds)
  knownDurationRef.current = knownDurationSeconds
  const onRequestFreshUrlRef = useRef(onRequestFreshUrl)
  onRequestFreshUrlRef.current = onRequestFreshUrl
  const isPlayingRef = useRef(false)
  isPlayingRef.current = isPlaying

  // Cross-src state for error recovery + the deferred seek probe.
  const refreshAttemptsRef = useRef(0)
  const restoreAfterRefreshRef = useRef<{ time: number; wasPlaying: boolean } | null>(null)
  const lastKnownTimeRef = useRef(0)
  const pendingSeekRef = useRef<number | null>(null)
  const requestProbeRef = useRef<(() => void) | null>(null)

  const seekTo = useCallback((seconds: number) => {
    const audio = audioRef.current
    if (!audio) return
    // Seek guard: on a cue-less MediaRecorder webm whose real duration the
    // element doesn't know yet (probe skipped thanks to knownDurationSeconds),
    // a forward seek into unbuffered territory can clamp to the buffered end.
    // Run the EOF probe first — its full linear read is what makes arbitrary
    // seeks reliable — and complete this seek when the real duration lands.
    // The cost lands only on sessions where the user actually seeks.
    if (!Number.isFinite(audio.duration) && seconds > 0.5) {
      pendingSeekRef.current = seconds
      setCurrentTime(seconds)
      requestProbeRef.current?.()
      return
    }
    audio.currentTime = seconds
    setCurrentTime(seconds)
  }, [])

  // Expose seekTo to parent
  useEffect(() => {
    onSeek?.(seekTo)
  }, [onSeek, seekTo])

  // Stable ref for onTimeUpdate to avoid re-attaching listeners
  const onTimeUpdateRef = useRef(onTimeUpdate)
  onTimeUpdateRef.current = onTimeUpdate

  // Audio event listeners
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    // MediaRecorder-produced WebM files don't include a duration header, so
    // `audio.duration` is Infinity until the browser has scanned to the end.
    // When the recorder-truth duration was persisted (knownDurationSeconds)
    // we use it directly and skip the scan; otherwise (legacy sessions — a
    // self-extinguishing population, replay videos are retention-deleted
    // after 30 days) keep the probe: seek to a very large value to force
    // the browser to read to EOF; the real duration then arrives via
    // `durationchange`, after which we seek back.
    let durationProbeInProgress = false

    const startProbe = () => {
      if (durationProbeInProgress) return
      durationProbeInProgress = true
      try {
        audio.currentTime = Number.MAX_SAFE_INTEGER
      } catch {
        // Some browsers throw on non-finite seeks; bail out gracefully. The
        // flag stays set so stray timeupdate events remain suppressed
        // (original semantics).
        setIsLoading(false)
      }
    }
    requestProbeRef.current = startProbe

    const handleTimeUpdate = () => {
      // While probing for duration we may receive timeupdate events with
      // very large currentTime values — ignore them so the UI doesn't
      // flicker to "Infinity".
      if (durationProbeInProgress) return
      const now = performance.now()
      if (now - lastUpdateRef.current < THROTTLE_MS) return
      lastUpdateRef.current = now
      lastKnownTimeRef.current = audio.currentTime
      setCurrentTime(audio.currentTime)
      onTimeUpdateRef.current?.(audio.currentTime)
    }
    const restoreAfterRefresh = () => {
      const restore = restoreAfterRefreshRef.current
      if (!restore) return
      restoreAfterRefreshRef.current = null
      try {
        audio.currentTime = restore.time
      } catch { /* ignore */ }
      setCurrentTime(restore.time)
      if (restore.wasPlaying) {
        audio.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false))
      }
    }
    const handleLoadedMetadata = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setDuration(audio.duration)
        setIsLoading(false)
        setError(null)
        restoreAfterRefresh()
        return
      }
      const known = knownDurationRef.current
      if (typeof known === 'number' && known > 0) {
        // Probe skipped — recorder-truth duration sizes the scrubber. The
        // durationchange handler below still lets the browser's own finite
        // value win if/when the file fully buffers (drift correction for
        // recorder stalls).
        setDuration(known)
        setIsLoading(false)
        setError(null)
        restoreAfterRefresh()
        return
      }
      startProbe()
    }
    const handleDurationChange = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setDuration(audio.duration)
        if (durationProbeInProgress) {
          durationProbeInProgress = false
          const target = pendingSeekRef.current ?? 0
          pendingSeekRef.current = null
          try {
            audio.currentTime = target
          } catch {
            /* ignore */
          }
          setCurrentTime(target)
          setIsLoading(false)
          setError(null)
        }
      }
    }
    const handleCanPlay = () => {
      setIsLoading(false)
      // Healthy load — reset the per-src refresh budget.
      refreshAttemptsRef.current = 0
    }
    const handleEnded = () => setIsPlaying(false)
    const showMediaError = () => {
      const mediaErr = audio.error
      if (mediaErr) {
        switch (mediaErr.code) {
          case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
            setError('Audio format not supported. Try a different browser.')
            break
          case MediaError.MEDIA_ERR_NETWORK:
            setError('Network error loading audio.')
            break
          case MediaError.MEDIA_ERR_DECODE:
            setError('Audio file could not be decoded.')
            break
          default:
            setError('Unable to play audio.')
        }
      } else {
        setError('Unable to play audio.')
      }
    }
    const handleError = () => {
      // Expired presigned URLs surface as code 4 (SRC_NOT_SUPPORTED — the R2
      // 403 XML body fails demuxing) on load, or code 2 (NETWORK) on a range
      // request mid-play — so recovery triggers on ANY code, bounded per src
      // load. Without recovery the play button just dies silently until a
      // full reload (which used to cost another full-file download).
      const refresh = onRequestFreshUrlRef.current
      if (refresh && refreshAttemptsRef.current < MAX_URL_REFRESH_ATTEMPTS) {
        refreshAttemptsRef.current += 1
        durationProbeInProgress = false
        restoreAfterRefreshRef.current = {
          time: lastKnownTimeRef.current,
          wasPlaying: isPlayingRef.current,
        }
        setIsPlaying(false)
        setIsLoading(true)
        void refresh().then((freshUrl) => {
          if (!freshUrl) {
            restoreAfterRefreshRef.current = null
            setIsLoading(false)
            showMediaError()
          }
          // On success the parent swaps the src prop; loadedmetadata on the
          // new source runs restoreAfterRefresh().
        })
        return
      }
      setIsLoading(false)
      showMediaError()
    }

    audio.addEventListener('timeupdate', handleTimeUpdate)
    audio.addEventListener('loadedmetadata', handleLoadedMetadata)
    audio.addEventListener('durationchange', handleDurationChange)
    audio.addEventListener('canplay', handleCanPlay)
    audio.addEventListener('ended', handleEnded)
    audio.addEventListener('error', handleError)

    return () => {
      requestProbeRef.current = null
      audio.removeEventListener('timeupdate', handleTimeUpdate)
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata)
      audio.removeEventListener('durationchange', handleDurationChange)
      audio.removeEventListener('canplay', handleCanPlay)
      audio.removeEventListener('ended', handleEnded)
      audio.removeEventListener('error', handleError)
    }
  }, []) // stable — uses refs for callbacks

  function togglePlay() {
    const audio = audioRef.current
    if (!audio || error) return
    if (isPlaying) {
      audio.pause()
      setIsPlaying(false)
    } else {
      audio.play().then(() => setIsPlaying(true)).catch((err: unknown) => {
        const name = (err as { name?: string })?.name
        // AbortError: a load interrupted the play() — benign, the next
        // gesture retries. NotAllowedError: autoplay policy — stay paused
        // without an error banner (guaranteed on iOS for non-gesture play).
        if (name === 'AbortError' || name === 'NotAllowedError') {
          setIsPlaying(false)
          return
        }
        setIsPlaying(false)
        setError('Playback failed. The file may be unavailable.')
      })
    }
  }

  function handleSeek(e: React.ChangeEvent<HTMLInputElement>) {
    const val = parseFloat(e.target.value)
    seekTo(val)
  }

  function changeSpeed(s: number) {
    setSpeed(s)
    if (audioRef.current) {
      audioRef.current.playbackRate = s
    }
  }

  // Single <audio> element across BOTH branches: the previous error branch
  // rendered a second, positionally distinct element that the empty-deps
  // listener effect had never wired — URL-refresh recovery would have driven
  // a deaf element.
  const audioElement = <audio ref={audioRef} src={src} preload="metadata" />

  // Error state
  if (error) {
    return (
      <div className="bg-white border border-red-500/30 rounded-2xl p-4 sticky top-[172px] z-[8]" role="alert">
        {audioElement}
        <div className="flex items-center gap-3">
          <div className="shrink-0 w-9 h-9 rounded-full bg-red-600/20 flex items-center justify-center">
            <svg className="w-4 h-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <p className="text-sm text-red-400">{error}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="bg-white/95 backdrop-blur-md border border-[#e1e8ed] rounded-2xl p-4 sticky top-[172px] z-[8] shadow-sm">
      {audioElement}

      {/* Top row: play/pause + seek bar + time */}
      <div className="flex items-center gap-3">
        {/* Play/Pause */}
        <button
          onClick={togglePlay}
          disabled={isLoading}
          className="shrink-0 w-11 h-11 sm:w-9 sm:h-9 rounded-full bg-blue-600 hover:bg-blue-500 disabled:bg-[#e1e8ed] disabled:cursor-not-allowed flex items-center justify-center transition"
          aria-label={isLoading ? 'Loading audio' : isPlaying ? 'Pause' : 'Play'}
        >
          {isLoading ? (
            <div className="w-4 h-4 rounded-full border-2 border-white/40 border-t-white animate-spin" />
          ) : isPlaying ? (
            <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 24 24">
              <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
            </svg>
          ) : (
            <svg className="w-4 h-4 text-white ml-0.5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>

        {/* Seek bar with question markers */}
        <div className="flex-1 relative group">
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={currentTime}
            onChange={handleSeek}
            disabled={isLoading}
            aria-label="Seek audio position"
            aria-valuemin={0}
            aria-valuemax={duration || 0}
            aria-valuenow={currentTime}
            className="w-full h-1.5 bg-[#e1e8ed] rounded-full appearance-none cursor-pointer disabled:cursor-not-allowed
              [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 sm:[&::-webkit-slider-thumb]:w-3 sm:[&::-webkit-slider-thumb]:h-3
              [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-blue-600
              [&::-webkit-slider-thumb]:hover:bg-blue-500 [&::-webkit-slider-thumb]:transition"
            style={{
              background: duration
                ? `linear-gradient(to right, #2563eb 0%, #2563eb ${(currentTime / duration) * 100}%, #e1e8ed ${(currentTime / duration) * 100}%, #e1e8ed 100%)`
                : '#e1e8ed',
            }}
          />
          {/* Question markers */}
          {duration > 0 &&
            questionMarkers.map((m) => {
              const left = Math.min(100, Math.max(0, (m.offsetSeconds / duration) * 100))
              return (
                <div
                  key={m.label}
                  className="absolute top-1/2 -translate-y-1/2 pointer-events-none"
                  style={{ left: `${left}%` }}
                >
                  <div className="w-2.5 h-2.5 -ml-[5px] rounded-full bg-amber-400/70 border border-amber-300/50" />
                  <span className="absolute -top-5 left-1/2 -translate-x-1/2 text-[9px] text-amber-600 font-medium opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
                    {m.label}
                  </span>
                </div>
              )
            })}
        </div>

        {/* Time */}
        <span className="text-xs text-[#536471] tabular-nums whitespace-nowrap shrink-0">
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>
      </div>

      {/* Bottom row: speed selector */}
      <div className="flex items-center gap-1.5 mt-2.5">
        <span className="text-[10px] text-[#8b98a5] uppercase tracking-wider mr-1">Speed</span>
        {SPEEDS.map((s) => (
          <button
            key={s}
            onClick={() => changeSpeed(s)}
            aria-label={`Playback speed ${s}x`}
            aria-pressed={speed === s}
            className={`px-2.5 py-1 sm:px-2 sm:py-0.5 rounded-md text-xs font-medium transition ${
              speed === s
                ? 'bg-blue-600 text-white'
                : 'bg-[#eff3f4] text-[#536471] hover:bg-[#e1e8ed]'
            }`}
          >
            {s}x
          </button>
        ))}
      </div>
    </div>
  )
}
