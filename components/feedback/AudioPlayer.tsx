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
}

import { formatTime } from '@/lib/utils'

const SPEEDS = [0.5, 1, 1.25, 1.5, 2] as const
const THROTTLE_MS = 200

export default function AudioPlayer({ src, questionMarkers, onTimeUpdate, onSeek }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const lastUpdateRef = useRef(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [speed, setSpeed] = useState(1)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const seekTo = useCallback((seconds: number) => {
    if (audioRef.current) {
      audioRef.current.currentTime = seconds
      setCurrentTime(seconds)
    }
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

    const handleTimeUpdate = () => {
      const now = performance.now()
      if (now - lastUpdateRef.current < THROTTLE_MS) return
      lastUpdateRef.current = now
      setCurrentTime(audio.currentTime)
      onTimeUpdateRef.current?.(audio.currentTime)
    }
    const handleLoadedMetadata = () => {
      setDuration(audio.duration)
      setIsLoading(false)
      setError(null)
    }
    const handleCanPlay = () => {
      setIsLoading(false)
    }
    const handleEnded = () => setIsPlaying(false)
    const handleError = () => {
      setIsLoading(false)
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

    audio.addEventListener('timeupdate', handleTimeUpdate)
    audio.addEventListener('loadedmetadata', handleLoadedMetadata)
    audio.addEventListener('canplay', handleCanPlay)
    audio.addEventListener('ended', handleEnded)
    audio.addEventListener('error', handleError)

    return () => {
      audio.removeEventListener('timeupdate', handleTimeUpdate)
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata)
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
    } else {
      audio.play().catch(() => {
        setError('Playback failed. The file may be unavailable.')
      })
    }
    setIsPlaying(!isPlaying)
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

  // Error state
  if (error) {
    return (
      <div className="bg-slate-900 border border-red-500/30 rounded-2xl p-4 sticky top-28 z-10" role="alert">
        <audio ref={audioRef} src={src} preload="metadata" />
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
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 sticky top-28 z-10">
      <audio ref={audioRef} src={src} preload="metadata" />

      {/* Top row: play/pause + seek bar + time */}
      <div className="flex items-center gap-3">
        {/* Play/Pause */}
        <button
          onClick={togglePlay}
          disabled={isLoading}
          className="shrink-0 w-9 h-9 rounded-full bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-700 disabled:cursor-not-allowed flex items-center justify-center transition"
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
            className="w-full h-1.5 bg-slate-700 rounded-full appearance-none cursor-pointer disabled:cursor-not-allowed
              [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3
              [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-indigo-400
              [&::-webkit-slider-thumb]:hover:bg-indigo-300 [&::-webkit-slider-thumb]:transition"
            style={{
              background: duration
                ? `linear-gradient(to right, #818cf8 0%, #818cf8 ${(currentTime / duration) * 100}%, #334155 ${(currentTime / duration) * 100}%, #334155 100%)`
                : '#334155',
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
                  <span className="absolute -top-5 left-1/2 -translate-x-1/2 text-[9px] text-amber-300 font-medium opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
                    {m.label}
                  </span>
                </div>
              )
            })}
        </div>

        {/* Time */}
        <span className="text-xs text-slate-400 tabular-nums whitespace-nowrap shrink-0">
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>
      </div>

      {/* Bottom row: speed selector */}
      <div className="flex items-center gap-1.5 mt-2.5">
        <span className="text-[10px] text-slate-500 uppercase tracking-wider mr-1">Speed</span>
        {SPEEDS.map((s) => (
          <button
            key={s}
            onClick={() => changeSpeed(s)}
            aria-label={`Playback speed ${s}x`}
            aria-pressed={speed === s}
            className={`px-2 py-0.5 rounded-md text-xs font-medium transition ${
              speed === s
                ? 'bg-indigo-600 text-white'
                : 'bg-slate-800 text-slate-400 hover:text-slate-300'
            }`}
          >
            {s}x
          </button>
        ))}
      </div>
    </div>
  )
}
