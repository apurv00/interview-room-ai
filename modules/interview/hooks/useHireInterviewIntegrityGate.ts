'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import {
  hasLiveHireInterviewDisplayShare,
  HireInterviewDisplayShareError,
  requestHireInterviewDisplayShare,
} from '@interview/utils/hireInterviewDisplayShare'

/**
 * Browser-observable integrity signals for a Hire assessment. These labels are
 * deliberately factual: the browser cannot establish a candidate's identity or
 * tell why a window lost focus.
 */
export type HireInterviewIntegrityEventKind =
  | 'fullscreen_exited'
  | 'browser_window_not_visible'
  | 'browser_window_focus_lost'
  | 'camera_interrupted'
  | 'microphone_interrupted'
  | 'screen_share_interrupted'
  | 'screen_share_wrong_surface'

export interface HireInterviewIntegrityEvent {
  kind: HireInterviewIntegrityEventKind
  startMs: number
  endMs: number
  durationMs: number
}

/**
 * Client adapter seam for the Hire observation bridge. Implementations must
 * return quickly; the gate never waits for persistence before protecting the
 * candidate flow.
 */
export type HireInterviewIntegrityEventReporter = (
  event: HireInterviewIntegrityEvent,
) => void | Promise<void>

export type HireInterviewIntegrityInterruption = {
  kind: HireInterviewIntegrityEventKind
  startMs: number
}

export interface UseHireInterviewIntegrityGateOptions {
  enabled: boolean
  displayCaptureRequired?: boolean
  mediaConstraints?: MediaStreamConstraints
  onEvent?: HireInterviewIntegrityEventReporter
}

const DEFAULT_MEDIA_CONSTRAINTS: MediaStreamConstraints = {
  video: true,
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
}

const MAX_INTERVIEW_DURATION_MS = 30 * 60 * 1_000

function elapsedMsFromTimestamp(
  timestamp: number,
  startedAt: number | null,
): number {
  if (startedAt === null) return 0
  return Math.min(
    MAX_INTERVIEW_DURATION_MS,
    Math.max(0, timestamp - startedAt),
  )
}

function stopMediaStream(stream: MediaStream | null | undefined) {
  stream?.getTracks().forEach((track) => track.stop())
}

function hasLiveTrack(tracks: MediaStreamTrack[]) {
  return tracks.some(
    (track) => track.readyState === 'live' && track.enabled && !track.muted,
  )
}

/** True only when the browser reports live, enabled camera and microphone tracks. */
export function hasLiveHireInterviewMedia(stream: MediaStream | null) {
  return Boolean(
    stream &&
      hasLiveTrack(stream.getVideoTracks()) &&
      hasLiveTrack(stream.getAudioTracks()),
  )
}

function isFullscreenActive() {
  return typeof document !== 'undefined' && document.fullscreenElement !== null
}

async function requestDocumentFullscreen() {
  if (typeof document === 'undefined') {
    throw new Error('Fullscreen is unavailable in this browser.')
  }

  const root = document.documentElement as HTMLElement & {
    webkitRequestFullscreen?: () => Promise<void> | void
  }
  const request = root.requestFullscreen ?? root.webkitRequestFullscreen
  if (!request) {
    throw new Error('Fullscreen is unavailable in this browser.')
  }

  await request.call(root)
  if (!isFullscreenActive()) {
    throw new Error('Fullscreen could not be enabled. Please try again.')
  }
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  return 'Camera, microphone, or fullscreen could not be enabled. Please try again.'
}

/**
 * Hire-only browser gate.
 *
 * It verifies camera + microphone and fullscreen from a user gesture before the
 * interview engine can start. Once active, browser-visible interruptions pause
 * the assessment until the candidate completes the same recheck. An initial
 * zero-length fact is emitted at detection, then the same lifecycle event is
 * emitted with its closed duration after recheck.
 */
export function useHireInterviewIntegrityGate({
  enabled,
  displayCaptureRequired = false,
  mediaConstraints = DEFAULT_MEDIA_CONSTRAINTS,
  onEvent,
}: UseHireInterviewIntegrityGateOptions) {
  const [stream, setStream] = useState<MediaStream | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [displayStream, setDisplayStream] = useState<MediaStream | null>(null)
  const displayStreamRef = useRef<MediaStream | null>(null)
  const [hasStarted, setHasStarted] = useState(false)
  const hasStartedRef = useRef(false)
  const startedAtRef = useRef<number | null>(null)
  const [isPaused, setIsPaused] = useState(false)
  const [isVerifying, setIsVerifying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [interruption, setInterruption] =
    useState<HireInterviewIntegrityInterruption | null>(null)
  const activeInterruptionsRef = useRef(
    new Map<HireInterviewIntegrityEventKind, number>(),
  )
  const monitoringStoppedRef = useRef(false)
  const mediaConstraintsRef = useRef(mediaConstraints)
  mediaConstraintsRef.current = mediaConstraints
  const reporterRef = useRef(onEvent)
  reporterRef.current = onEvent

  const elapsedMs = useCallback(() => {
    return elapsedMsFromTimestamp(Date.now(), startedAtRef.current)
  }, [])

  const elapsedMsAt = useCallback((timestamp: number): number | null => {
    if (!Number.isFinite(timestamp) || startedAtRef.current === null) return null
    return elapsedMsFromTimestamp(timestamp, startedAtRef.current)
  }, [])

  const reportCompletedInterruption = useCallback(
    (kind: HireInterviewIntegrityEventKind, startMs: number, endMs: number) => {
      const normalizedStartMs = elapsedMsFromTimestamp(startMs, startedAtRef.current)
      const normalizedEndMs = elapsedMsFromTimestamp(endMs, startedAtRef.current)
      const event: HireInterviewIntegrityEvent = {
        kind,
        startMs: normalizedStartMs,
        endMs: normalizedEndMs,
        durationMs: Math.max(0, normalizedEndMs - normalizedStartMs),
      }
      try {
        // Persistence is intentionally non-blocking. The page-level bridge
        // adapter owns retries/keepalive flushing once connected.
        void Promise.resolve(reporterRef.current?.(event)).catch(() => {})
      } catch {
        // A reporting failure must never trap a candidate in the recheck UI.
      }
    },
    [],
  )

  const flagInterruption = useCallback(
    (kind: HireInterviewIntegrityEventKind) => {
      if (!enabled || !hasStartedRef.current || monitoringStoppedRef.current) return

      const now = Date.now()
      const active = activeInterruptionsRef.current
      let detectedAt: number | null = null

      // A browser typically dispatches blur before visibilitychange when the
      // tab is hidden. The active recheck state prefers the later, factual
      // "not visible" signal; an already-delivered zero-length blur fact is
      // retained as its own browser observation rather than rewritten.
      if (
        kind === 'browser_window_not_visible' &&
        active.has('browser_window_focus_lost')
      ) {
        const startedAt = active.get('browser_window_focus_lost') ?? now
        active.delete('browser_window_focus_lost')
        active.set(kind, startedAt)
        setInterruption({ kind, startMs: startedAt })
        detectedAt = startedAt
      } else if (!active.has(kind)) {
        active.set(kind, now)
        setInterruption({ kind, startMs: now })
        detectedAt = now
      }

      // Persist the factual detection immediately. The later closure retains
      // the same start, allowing the bridge reporter to update one bounded
      // lifecycle event with its observed duration after recheck.
      if (detectedAt !== null) {
        reportCompletedInterruption(kind, detectedAt, detectedAt)
      }

      setIsPaused(true)
      setError(null)
    },
    [enabled, reportCompletedInterruption],
  )

  const validateAndEnterFullscreen = useCallback(async () => {
    if (!enabled) return true

    setIsVerifying(true)
    setError(null)

    const previousStream = streamRef.current
    const previousDisplayStream = displayStreamRef.current
    const canReusePreviousStream = hasLiveHireInterviewMedia(previousStream)
    const canReusePreviousDisplayStream =
      !displayCaptureRequired ||
      hasLiveHireInterviewDisplayShare(previousDisplayStream)
    let discardNewResources = false
    let retainVerifiedResources = false
    let acquiredStream: MediaStream | null = null
    let acquiredDisplayStream: MediaStream | null = null

    const mediaPromise = canReusePreviousStream
      ? Promise.resolve(previousStream as MediaStream)
      : typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia
        ? Promise.reject(new Error('Camera and microphone are unavailable in this browser.'))
        : navigator.mediaDevices
            .getUserMedia(mediaConstraintsRef.current)
            .then((nextStream) => {
              acquiredStream = nextStream
              if (discardNewResources) stopMediaStream(nextStream)
              return nextStream
            })

    const displayPromise: Promise<MediaStream | null> = !displayCaptureRequired
      ? Promise.resolve(null)
      : canReusePreviousDisplayStream
        ? Promise.resolve(previousDisplayStream as MediaStream)
        : requestHireInterviewDisplayShare().then((nextDisplayStream) => {
            acquiredDisplayStream = nextDisplayStream
            if (discardNewResources) stopMediaStream(nextDisplayStream)
            return nextDisplayStream
          })

    try {
      // All permission-gated calls start inside the button's user gesture.
      // Browsers otherwise reject screen capture or fullscreen after an
      // awaited permission prompt.
      const [nextStream, nextDisplayStream] = await Promise.all([
        mediaPromise,
        displayPromise,
        requestDocumentFullscreen(),
      ])

      if (!hasLiveHireInterviewMedia(nextStream)) {
        throw new Error('A live camera and microphone are required to begin the assessment.')
      }
      if (
        displayCaptureRequired &&
        !hasLiveHireInterviewDisplayShare(nextDisplayStream)
      ) {
        throw new Error('A live entire-screen share is required to begin the assessment.')
      }

      // The display picker can remain open after fullscreen was granted. If
      // fullscreen is exited while that picker is pending, retain only the
      // already-verified tracks internally so the next user gesture can reuse
      // them to restore fullscreen without reopening either permission picker.
      // They are not published to the interview or marked started here.
      if (!isFullscreenActive()) {
        retainVerifiedResources = true
        streamRef.current = nextStream
        displayStreamRef.current = nextDisplayStream
        if (previousStream && previousStream !== nextStream) {
          stopMediaStream(previousStream)
        }
        if (
          previousDisplayStream &&
          previousDisplayStream !== nextDisplayStream
        ) {
          stopMediaStream(previousDisplayStream)
        }
        throw new Error('Fullscreen could not be enabled. Please try again.')
      }

      // Publish the replacement before ending the old tracks. Old-track
      // `ended` events are an intentional recheck teardown, not a fresh
      // candidate microphone interruption.
      streamRef.current = nextStream
      if (previousStream && previousStream !== nextStream) {
        stopMediaStream(previousStream)
      }
      setStream(nextStream)

      displayStreamRef.current = nextDisplayStream
      if (
        previousDisplayStream &&
        previousDisplayStream !== nextDisplayStream
      ) {
        stopMediaStream(previousDisplayStream)
      }
      setDisplayStream(nextDisplayStream)
      monitoringStoppedRef.current = false

      const now = Date.now()
      for (const [kind, startMs] of Array.from(activeInterruptionsRef.current.entries())) {
        reportCompletedInterruption(kind, startMs, now)
      }
      activeInterruptionsRef.current.clear()
      setInterruption(null)
      setIsPaused(false)

      if (!hasStartedRef.current) {
        startedAtRef.current = now
        hasStartedRef.current = true
        setHasStarted(true)
      }

      // `start_verified` and `recheck_verified` are local state transitions,
      // not persisted observations.
      return true
    } catch (caught) {
      discardNewResources = true
      if (
        !retainVerifiedResources &&
        acquiredStream &&
        acquiredStream !== previousStream
      ) {
        stopMediaStream(acquiredStream)
      }
      if (
        !retainVerifiedResources &&
        acquiredDisplayStream &&
        acquiredDisplayStream !== previousDisplayStream
      ) {
        stopMediaStream(acquiredDisplayStream)
      }
      if (
        caught instanceof HireInterviewDisplayShareError &&
        caught.code === 'wrong_surface'
      ) {
        const detectedAt = Date.now()
        reportCompletedInterruption(
          'screen_share_wrong_surface',
          detectedAt,
          detectedAt,
        )
      }
      if (
        (!canReusePreviousStream || !canReusePreviousDisplayStream) &&
        isFullscreenActive()
      ) {
        void document.exitFullscreen?.().catch(() => {})
      }
      setError(errorMessage(caught))
      return false
    } finally {
      setIsVerifying(false)
    }
  }, [displayCaptureRequired, enabled, reportCompletedInterruption])

  const markInterviewComplete = useCallback(() => {
    monitoringStoppedRef.current = true
    const completedDisplayStream = displayStreamRef.current
    displayStreamRef.current = null
    stopMediaStream(completedDisplayStream)
    setDisplayStream(null)
    activeInterruptionsRef.current.clear()
    setInterruption(null)
    setIsPaused(false)
  }, [])

  useEffect(() => {
    if (!enabled || !hasStarted || monitoringStoppedRef.current) return

    const checkTracks = () => {
      const currentStream = streamRef.current
      if (!currentStream) {
        flagInterruption('camera_interrupted')
        flagInterruption('microphone_interrupted')
      } else {
        if (!hasLiveTrack(currentStream.getVideoTracks())) {
          flagInterruption('camera_interrupted')
        }
        if (!hasLiveTrack(currentStream.getAudioTracks())) {
          flagInterruption('microphone_interrupted')
        }
      }

      if (
        displayCaptureRequired &&
        !hasLiveHireInterviewDisplayShare(displayStreamRef.current)
      ) {
        flagInterruption('screen_share_interrupted')
      }
    }

    const onFullscreenChange = () => {
      if (!isFullscreenActive()) flagInterruption('fullscreen_exited')
    }
    const onVisibilityChange = () => {
      if (document.hidden) flagInterruption('browser_window_not_visible')
    }
    const onWindowBlur = () => {
      if (!document.hidden) flagInterruption('browser_window_focus_lost')
    }
    const onPageHide = () => {
      const endedAt = Date.now()
      for (const [kind, startMs] of Array.from(activeInterruptionsRef.current.entries())) {
        reportCompletedInterruption(kind, startMs, endedAt)
      }
      activeInterruptionsRef.current.clear()
    }

    document.addEventListener('fullscreenchange', onFullscreenChange)
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('blur', onWindowBlur)
    window.addEventListener('pagehide', onPageHide)

    const attachTrackListeners = (currentStream: MediaStream) => {
      const listeners: Array<{
        track: MediaStreamTrack
        onInterrupted: () => void
      }> = []
      for (const track of currentStream.getTracks()) {
        const kind = track.kind === 'video'
          ? 'camera_interrupted'
          : 'microphone_interrupted'
        const onInterrupted = () => {
          // Recheck deliberately stops the superseded stream after replacing
          // this ref. Ignore its delayed `ended`/`mute` events.
          if (streamRef.current !== currentStream) return
          flagInterruption(kind)
        }
        track.addEventListener('ended', onInterrupted)
        track.addEventListener('mute', onInterrupted)
        listeners.push({ track, onInterrupted })
      }
      return () => {
        for (const { track, onInterrupted } of listeners) {
          track.removeEventListener('ended', onInterrupted)
          track.removeEventListener('mute', onInterrupted)
        }
      }
    }

    const removeTrackListeners = streamRef.current
      ? attachTrackListeners(streamRef.current)
      : () => {}
    const removeDisplayTrackListeners = displayStreamRef.current
      ? (() => {
          const currentDisplayStream = displayStreamRef.current as MediaStream
          const displayTrack = currentDisplayStream.getVideoTracks()[0]
          if (!displayTrack) return () => {}

          const onDisplayInterrupted = () => {
            // Ignore a superseded share deliberately stopped after a
            // successful recheck.
            if (displayStreamRef.current !== currentDisplayStream) return
            flagInterruption('screen_share_interrupted')
          }
          displayTrack.addEventListener('ended', onDisplayInterrupted)
          displayTrack.addEventListener('mute', onDisplayInterrupted)
          return () => {
            displayTrack.removeEventListener('ended', onDisplayInterrupted)
            displayTrack.removeEventListener('mute', onDisplayInterrupted)
          }
        })()
      : () => {}
    const trackPoll = window.setInterval(checkTracks, 1_000)

    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('blur', onWindowBlur)
      window.removeEventListener('pagehide', onPageHide)
      removeTrackListeners()
      removeDisplayTrackListeners()
      window.clearInterval(trackPoll)
    }
  }, [
    displayCaptureRequired,
    displayStream,
    enabled,
    flagInterruption,
    hasStarted,
    reportCompletedInterruption,
    stream,
  ])

  useEffect(() => {
    return () => {
      stopMediaStream(streamRef.current)
      stopMediaStream(displayStreamRef.current)
    }
  }, [])

  return {
    stream,
    displayStream,
    hasStarted,
    isPaused,
    isVerifying,
    error,
    interruption,
    startAssessment: validateAndEnterFullscreen,
    recheck: validateAndEnterFullscreen,
    markInterviewComplete,
    elapsedMs,
    elapsedMsAt,
  }
}
