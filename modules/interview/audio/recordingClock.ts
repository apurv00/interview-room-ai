/**
 * recordingClock — module-level singleton tracking the wall-clock time
 * at which MediaRecorder started capturing the camera/audio webm.
 *
 * Why: the multimodal analysis pipeline needs word-level timestamps
 * relative to the *audio timeline* (seconds from recording start), so
 * they line up with the video replay. Deepgram's streaming STT hands us
 * timestamps relative to *its own WebSocket session* (which opens a few
 * seconds into the interview). We convert one to the other by
 * subtracting the recording start time.
 *
 * Set from app/interview/page.tsx when `startRecording(...)` is called.
 * Read from useDeepgramRecognition when folding word arrays from each
 * Results message into the accumulated live transcript. Reset on
 * unmount alongside the voice mixer.
 */

let recordingStartedAtMs: number | null = null

export function setRecordingStartedAt(wallClockMs: number): void {
  recordingStartedAtMs = wallClockMs
}

export function getRecordingStartedAt(): number | null {
  return recordingStartedAtMs
}

/**
 * Convert a wall-clock millisecond timestamp to an audio-timeline
 * offset in seconds. Returns 0 if the recording clock hasn't been set
 * yet (defensive — better to collapse all words to t=0 than throw).
 */
export function wallClockMsToAudioSeconds(wallClockMs: number): number {
  if (recordingStartedAtMs === null) return 0
  return Math.max(0, (wallClockMs - recordingStartedAtMs) / 1000)
}

export function resetRecordingClock(): void {
  recordingStartedAtMs = null
}
