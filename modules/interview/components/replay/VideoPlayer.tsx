'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Play, Pause, Volume2, VolumeX, Loader2 } from 'lucide-react'

interface QuestionMarker {
  label: string
  offsetSeconds: number
}

interface VideoPlayerProps {
  src: string
  questionMarkers: QuestionMarker[]
  onTimeUpdate?: (currentTimeSeconds: number) => void
  onSeek?: (seekFn: (seconds: number) => void) => void
}

const SPEEDS = [0.5, 1, 1.25, 1.5, 2] as const
const THROTTLE_MS = 200

export default function VideoPlayer({ src, questionMarkers, onTimeUpdate, onSeek }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const lastUpdateRef = useRef(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [speed, setSpeed] = useState(1)
  const [isLoading, setIsLoading] = useState(true)
  const [isMuted, setIsMuted] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const seekTo = useCallback((seconds: number) => {
    // Guard against NaN/Infinity from upstream callers (e.g. progress bar
    // clicks before duration is known) — setting currentTime to a
    // non-finite value throws a TypeError on HTMLMediaElement.
    if (!videoRef.current || !Number.isFinite(seconds)) return
    videoRef.current.currentTime = seconds
    setCurrentTime(seconds)
  }, [])

  useEffect(() => {
    onSeek?.(seekTo)
  }, [onSeek, seekTo])

  const onTimeUpdateRef = useRef(onTimeUpdate)
  onTimeUpdateRef.current = onTimeUpdate

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    // MediaRecorder-produced webm files don't include a duration header,
    // so `video.duration` is Infinity until the browser has scanned to
    // the end. Workaround: on loadedmetadata, if duration is non-finite,
    // seek to a very large value to force the browser to read to EOF;
    // the real duration then arrives via the `durationchange` event,
    // after which we seek back to 0.
    let durationProbeInProgress = false

    const handleLoadedMetadata = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        setDuration(video.duration)
        setIsLoading(false)
        return
      }
      // Trigger the probe — set a flag so handleDurationChange knows to
      // restore currentTime when the real duration arrives.
      durationProbeInProgress = true
      try {
        video.currentTime = Number.MAX_SAFE_INTEGER
      } catch {
        // Some browsers throw immediately on non-finite seeks; nothing we
        // can do beyond leaving the duration at 0 in the UI.
        setIsLoading(false)
      }
    }

    const handleDurationChange = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        setDuration(video.duration)
        if (durationProbeInProgress) {
          durationProbeInProgress = false
          // Restore playhead to the start now that the browser knows the
          // real duration. Use 0 (not the previous currentTime) because
          // we just jumped to MAX_SAFE_INTEGER.
          try {
            video.currentTime = 0
          } catch {
            /* ignore */
          }
          setCurrentTime(0)
          setIsLoading(false)
        }
      }
    }

    const handleTimeUpdate = () => {
      // While probing for duration we may receive timeupdate events with
      // very large currentTime values — ignore them so the UI doesn't
      // flicker to "Infinity".
      if (durationProbeInProgress) return
      const now = Date.now()
      if (now - lastUpdateRef.current < THROTTLE_MS) return
      lastUpdateRef.current = now
      setCurrentTime(video.currentTime)
      onTimeUpdateRef.current?.(video.currentTime)
    }
    const handlePlay = () => setIsPlaying(true)
    const handlePause = () => setIsPlaying(false)
    const handleError = () => {
      setError('Failed to load video')
      setIsLoading(false)
    }
    const handleWaiting = () => setIsLoading(true)
    const handleCanPlay = () => setIsLoading(false)

    video.addEventListener('loadedmetadata', handleLoadedMetadata)
    video.addEventListener('durationchange', handleDurationChange)
    video.addEventListener('timeupdate', handleTimeUpdate)
    video.addEventListener('play', handlePlay)
    video.addEventListener('pause', handlePause)
    video.addEventListener('error', handleError)
    video.addEventListener('waiting', handleWaiting)
    video.addEventListener('canplay', handleCanPlay)

    return () => {
      video.removeEventListener('loadedmetadata', handleLoadedMetadata)
      video.removeEventListener('durationchange', handleDurationChange)
      video.removeEventListener('timeupdate', handleTimeUpdate)
      video.removeEventListener('play', handlePlay)
      video.removeEventListener('pause', handlePause)
      video.removeEventListener('error', handleError)
      video.removeEventListener('waiting', handleWaiting)
      video.removeEventListener('canplay', handleCanPlay)
    }
  }, [])

  const togglePlay = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) video.play()
    else video.pause()
  }, [])

  const toggleMute = useCallback(() => {
    if (videoRef.current) {
      videoRef.current.muted = !videoRef.current.muted
      setIsMuted(!isMuted)
    }
  }, [isMuted])

  const cycleSpeed = useCallback(() => {
    const idx = SPEEDS.indexOf(speed as typeof SPEEDS[number])
    const next = SPEEDS[(idx + 1) % SPEEDS.length]
    setSpeed(next)
    if (videoRef.current) videoRef.current.playbackRate = next
  }, [speed])

  const handleSeekBarClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = (e.clientX - rect.left) / rect.width
    const newTime = ratio * duration
    seekTo(newTime)
  }, [duration, seekTo])

  const formatTime = (s: number) => {
    if (!Number.isFinite(s) || s < 0) return '0:00'
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return `${m}:${sec.toString().padStart(2, '0')}`
  }

  if (error) {
    return (
      <div className="rounded-xl bg-red-500/10 border border-red-500/20 p-6 text-center text-red-600">
        {error}
      </div>
    )
  }

  const progress = Number.isFinite(duration) && duration > 0 ? (currentTime / duration) * 100 : 0

  return (
    <div className="rounded-xl border border-[#e1e8ed] overflow-hidden bg-white">
      {/* Video element */}
      <div className="relative aspect-video bg-[#0f1419]">
        <video
          ref={videoRef}
          src={src}
          className="w-full h-full object-contain"
          playsInline
          preload="metadata"
        />
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40">
            <Loader2 className="w-8 h-8 animate-spin text-white/70" />
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="px-4 py-3 space-y-2">
        {/* Seek bar with question markers */}
        <div
          className="relative h-2 bg-[#e1e8ed] rounded-full cursor-pointer group"
          onClick={handleSeekBarClick}
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(currentTime)}
        >
          <div
            className="absolute inset-y-0 left-0 bg-blue-600 rounded-full transition-[width] duration-100"
            style={{ width: `${progress}%` }}
          />
          {/* Question markers */}
          {questionMarkers.map((marker, i) => {
            const markerPos = duration > 0 ? (marker.offsetSeconds / duration) * 100 : 0
            return (
              <div
                key={i}
                className="absolute top-1/2 -translate-y-1/2 w-2 h-2 bg-amber-400 rounded-full opacity-70 hover:opacity-100 z-10"
                style={{ left: `${markerPos}%` }}
                title={marker.label}
              />
            )
          })}
        </div>

        {/* Buttons row */}
        <div className="flex items-center justify-between text-sm text-[#536471]">
          <div className="flex items-center gap-3">
            <button
              onClick={togglePlay}
              className="p-1.5 rounded-lg hover:bg-[#f8fafc] transition-colors"
              aria-label={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
            </button>
            <button
              onClick={toggleMute}
              className="p-1.5 rounded-lg hover:bg-[#f8fafc] transition-colors"
              aria-label={isMuted ? 'Unmute' : 'Mute'}
            >
              {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
            </button>
            <span className="text-xs text-[#71767b] tabular-nums">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
          </div>

          <button
            onClick={cycleSpeed}
            className="px-2 py-1 text-xs rounded-md bg-[#f8fafc] hover:bg-[#eff3f4] border border-[#e1e8ed] text-[#536471] tabular-nums transition-colors"
          >
            {speed}x
          </button>
        </div>
      </div>
    </div>
  )
}
