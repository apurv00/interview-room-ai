'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { useMediaRecorder } from './useMediaRecorder'

const DISPLAY_RECORDING_WIDTH = 1_280
const DISPLAY_RECORDING_HEIGHT = 720
const DISPLAY_RECORDING_FPS = 12
const DISPLAY_RECORDING_VIDEO_BITS_PER_SECOND = 900_000
const NEUTRAL_FRAME_COLOR = '#111827'

type CanvasWithCaptureStream = HTMLCanvasElement & {
  captureStream?: (frameRate?: number) => MediaStream
}

export interface UseHireDisplayRecorderReturn {
  isRecording: boolean
  error: string | null
  hasTerminalFailure: boolean
  setSource: (stream: MediaStream | null) => void
  stopRecording: () => Promise<Blob | null>
}

/**
 * Records one stable, video-only canvas stream while the browser display-share
 * source may be replaced during Hire rechecks. Missing or interrupted sources
 * render as a neutral frame instead of ending the recorder track.
 */
export function useHireDisplayRecorder(): UseHireDisplayRecorderReturn {
  const {
    isRecording,
    startRecording: startMediaRecording,
    stopRecording: stopMediaRecording,
  } = useMediaRecorder()
  const [error, setError] = useState<string | null>(null)
  const [recordingStarted, setRecordingStarted] = useState(false)
  const [hasTerminalFailure, setHasTerminalFailure] = useState(false)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const contextRef = useRef<CanvasRenderingContext2D | null>(null)
  const outputStreamRef = useRef<MediaStream | null>(null)
  const sourceRef = useRef<MediaStream | null>(null)
  const sourceAvailableRef = useRef(false)
  const removeSourceListenersRef = useRef<() => void>(() => {})
  const frameTimerRef = useRef<number>()
  const hasStartedRef = useRef(false)
  const hasStoppedRef = useRef(false)
  const hasTerminalFailureRef = useRef(false)
  const stopPromiseRef = useRef<Promise<Blob | null> | null>(null)

  const drawNeutralFrame = useCallback(() => {
    const context = contextRef.current
    if (!context) return
    context.fillStyle = NEUTRAL_FRAME_COLOR
    context.fillRect(0, 0, DISPLAY_RECORDING_WIDTH, DISPLAY_RECORDING_HEIGHT)
  }, [])

  const drawFrame = useCallback(() => {
    drawNeutralFrame()

    const context = contextRef.current
    const video = videoRef.current
    if (
      !context ||
      !video ||
      !sourceAvailableRef.current ||
      video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
      video.videoWidth <= 0 ||
      video.videoHeight <= 0
    ) {
      return
    }

    const scale = Math.min(
      DISPLAY_RECORDING_WIDTH / video.videoWidth,
      DISPLAY_RECORDING_HEIGHT / video.videoHeight,
    )
    const width = Math.round(video.videoWidth * scale)
    const height = Math.round(video.videoHeight * scale)
    const x = Math.round((DISPLAY_RECORDING_WIDTH - width) / 2)
    const y = Math.round((DISPLAY_RECORDING_HEIGHT - height) / 2)

    try {
      context.drawImage(video, x, y, width, height)
    } catch {
      // The neutral frame already represents a temporarily unavailable source.
    }
  }, [drawNeutralFrame])

  const clearVideoSource = useCallback(() => {
    sourceAvailableRef.current = false
    const video = videoRef.current
    if (video) video.srcObject = null
    drawNeutralFrame()
  }, [drawNeutralFrame])

  const removeSourceListeners = useCallback(() => {
    removeSourceListenersRef.current()
    removeSourceListenersRef.current = () => {}
  }, [])

  const startStableMediaRecorder = useCallback((outputStream: MediaStream) => {
    const didStart = startMediaRecording(outputStream, {
      videoBitsPerSecond: DISPLAY_RECORDING_VIDEO_BITS_PER_SECOND,
    })
    if (!didStart) {
      hasStartedRef.current = false
      setRecordingStarted(false)
      setError('Display recording could not start. Please try again.')
      return false
    }

    hasStartedRef.current = true
    setRecordingStarted(true)
    setError(null)
    return true
  }, [startMediaRecording])

  const ensureRecorderStarted = useCallback(() => {
    if (hasStartedRef.current || hasStoppedRef.current) return hasStartedRef.current
    if (typeof document === 'undefined') return false

    const existingOutputStream = outputStreamRef.current
    if (existingOutputStream) {
      return startStableMediaRecorder(existingOutputStream)
    }

    const canvas = document.createElement('canvas') as CanvasWithCaptureStream
    canvas.width = DISPLAY_RECORDING_WIDTH
    canvas.height = DISPLAY_RECORDING_HEIGHT
    const context = canvas.getContext('2d', { alpha: false })
    const captureStream = canvas.captureStream
    if (!context || !captureStream) {
      setError('Display recording is unavailable in this browser.')
      return false
    }

    const video = document.createElement('video')
    video.autoplay = true
    video.muted = true
    video.playsInline = true
    video.setAttribute('aria-hidden', 'true')
    Object.assign(video.style, {
      position: 'fixed',
      left: '-10000px',
      top: '0',
      width: '1px',
      height: '1px',
      opacity: '0',
      pointerEvents: 'none',
    })
    document.body.appendChild(video)

    canvasRef.current = canvas
    contextRef.current = context
    videoRef.current = video
    drawNeutralFrame()

    const capturedStream = captureStream.call(canvas, DISPLAY_RECORDING_FPS)
    const videoTracks = capturedStream.getVideoTracks()
    if (videoTracks.length === 0) {
      video.remove()
      videoRef.current = null
      canvasRef.current = null
      contextRef.current = null
      capturedStream.getTracks().forEach((track) => track.stop())
      setError('Display recording could not create a video track.')
      return false
    }

    // A canvas capture never needs candidate or system audio. Defensively end
    // any unexpected audio track before handing the stream to MediaRecorder.
    const unexpectedAudioTracks = capturedStream.getAudioTracks()
    unexpectedAudioTracks.forEach((track) => track.stop())
    const outputStream = unexpectedAudioTracks.length > 0
      ? new MediaStream(videoTracks)
      : capturedStream
    outputStreamRef.current = outputStream
    frameTimerRef.current = window.setInterval(
      drawFrame,
      Math.round(1_000 / DISPLAY_RECORDING_FPS),
    )
    return startStableMediaRecorder(outputStream)
  }, [drawFrame, drawNeutralFrame, startStableMediaRecorder])

  const setSource = useCallback((stream: MediaStream | null) => {
    if (hasStoppedRef.current || hasTerminalFailureRef.current) return

    removeSourceListeners()
    sourceRef.current = stream
    const track = stream?.getVideoTracks()[0]
    if (
      !stream ||
      !track ||
      track.readyState !== 'live' ||
      !track.enabled ||
      track.muted
    ) {
      clearVideoSource()
      return
    }

    if (!ensureRecorderStarted()) return

    const video = videoRef.current
    if (!video) return
    sourceAvailableRef.current = true
    video.srcObject = stream
    void video.play().catch(() => {
      if (sourceRef.current === stream) clearVideoSource()
    })

    const onUnavailable = () => {
      if (sourceRef.current !== stream) return
      clearVideoSource()
    }
    const onUnmute = () => {
      if (
        sourceRef.current !== stream ||
        track.readyState !== 'live' ||
        !track.enabled ||
        track.muted
      ) {
        return
      }
      const currentVideo = videoRef.current
      if (!currentVideo) return
      sourceAvailableRef.current = true
      currentVideo.srcObject = stream
      void currentVideo.play().catch(() => {
        if (sourceRef.current === stream) clearVideoSource()
      })
    }

    track.addEventListener('ended', onUnavailable)
    track.addEventListener('mute', onUnavailable)
    track.addEventListener('unmute', onUnmute)
    removeSourceListenersRef.current = () => {
      track.removeEventListener('ended', onUnavailable)
      track.removeEventListener('mute', onUnavailable)
      track.removeEventListener('unmute', onUnmute)
    }
  }, [clearVideoSource, ensureRecorderStarted, removeSourceListeners])

  const cleanupBridge = useCallback(() => {
    removeSourceListeners()
    sourceRef.current = null
    sourceAvailableRef.current = false

    if (frameTimerRef.current !== undefined) {
      window.clearInterval(frameTimerRef.current)
      frameTimerRef.current = undefined
    }

    const video = videoRef.current
    if (video) {
      video.pause()
      video.srcObject = null
      video.remove()
    }
    videoRef.current = null
    canvasRef.current = null
    contextRef.current = null

    outputStreamRef.current?.getTracks().forEach((track) => track.stop())
    outputStreamRef.current = null
  }, [removeSourceListeners])

  useEffect(() => {
    if (
      !recordingStarted ||
      isRecording ||
      hasStoppedRef.current
    ) {
      return
    }

    hasStartedRef.current = false
    hasTerminalFailureRef.current = true
    setHasTerminalFailure(true)
    setRecordingStarted(false)
    clearVideoSource()
    cleanupBridge()
    setError(
      'Display recording stopped unexpectedly. This interview cannot continue; submit the partial interview for review.',
    )
  }, [cleanupBridge, clearVideoSource, isRecording, recordingStarted])

  const stopRecording = useCallback(() => {
    if (stopPromiseRef.current) return stopPromiseRef.current

    hasStoppedRef.current = true
    clearVideoSource()
    removeSourceListeners()
    const stopPromise = stopMediaRecording()
      .catch(() => null)
      .finally(cleanupBridge)
    stopPromiseRef.current = stopPromise
    return stopPromise
  }, [cleanupBridge, clearVideoSource, removeSourceListeners, stopMediaRecording])

  useEffect(() => {
    return () => {
      if (hasStoppedRef.current) {
        cleanupBridge()
        return
      }
      hasStoppedRef.current = true
      void stopMediaRecording().finally(cleanupBridge)
    }
  }, [cleanupBridge, stopMediaRecording])

  return {
    isRecording,
    error,
    hasTerminalFailure,
    setSource,
    stopRecording,
  }
}
