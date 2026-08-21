'use client'

export type HireInterviewDisplayShareErrorCode =
  | 'unavailable'
  | 'not_live'
  | 'wrong_surface'

export class HireInterviewDisplayShareError extends Error {
  constructor(
    readonly code: HireInterviewDisplayShareErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'HireInterviewDisplayShareError'
  }
}

function stopStream(stream: MediaStream) {
  stream.getTracks().forEach((track) => track.stop())
}

function getReportedDisplaySurface(track: MediaStreamTrack): string | null {
  const settings = track.getSettings?.() as MediaTrackSettings & {
    displaySurface?: string
  }
  const displaySurface = settings?.displaySurface
  return typeof displaySurface === 'string' && displaySurface.length > 0
    ? displaySurface
    : null
}

/**
 * Browsers are required to let the candidate choose a capture source. We accept
 * the share only when its video track is live and the browser positively
 * identifies the source as the entire monitor. Missing source metadata cannot
 * prove the compulsory entire-display consent condition and therefore fails
 * closed.
 */
export function hasLiveHireInterviewDisplayShare(stream: MediaStream | null) {
  const track = stream?.getVideoTracks()[0]
  if (
    !track ||
    track.readyState !== 'live' ||
    !track.enabled ||
    track.muted
  ) {
    return false
  }

  return getReportedDisplaySurface(track) === 'monitor'
}

/** Requests video-only full-display capture from a candidate gesture. */
export async function requestHireInterviewDisplayShare() {
  if (
    typeof navigator === 'undefined' ||
    !navigator.mediaDevices?.getDisplayMedia
  ) {
    throw new HireInterviewDisplayShareError(
      'unavailable',
      'Entire-screen sharing is unavailable in this browser.',
    )
  }

  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: false,
  })

  // Audio is never part of the integrity share, even if a browser returns an
  // unexpected audio track despite the explicit video-only request.
  stream.getAudioTracks().forEach((track) => track.stop())

  const videoTrack = stream.getVideoTracks()[0]
  if (
    !videoTrack ||
    videoTrack.readyState !== 'live' ||
    !videoTrack.enabled ||
    videoTrack.muted
  ) {
    stopStream(stream)
    throw new HireInterviewDisplayShareError(
      'not_live',
      'A live entire-screen share is required to begin the assessment.',
    )
  }

  const displaySurface = getReportedDisplaySurface(videoTrack)
  if (displaySurface !== 'monitor') {
    stopStream(stream)
    throw new HireInterviewDisplayShareError(
      'wrong_surface',
      'Please share your entire screen, not a browser tab or application window.',
    )
  }

  return stream
}
