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

export const STT_SAMPLE_RATE = 16_000
export const STT_CHUNK_SAMPLES = 4096

/**
 * Recording-relative time (seconds) at which the CURRENT turn's audio began
 * entering the CURRENT Deepgram connection — the base that converts
 * connection-relative word timestamps to recording-relative absolutes.
 *
 * Why this exists (2026-07-18 drift diagnosis): Deepgram's `w.start` is
 * relative to the audio fed into ONE WebSocket connection. When every turn
 * opened a fresh socket (090cae2), a per-turn wall-clock offset was a valid
 * base. Since sockets became preserved across turns (e7bb36d), the stream
 * clock accumulates every prior turn's audio, and adding a wall-clock turn
 * offset double-counted it — word timelines overshot the real recording by
 * ~60s per answer (+1148s on a 30-min interview), skewing every analysis
 * surface downstream (captions, moments, prosody attribution).
 *
 * The correct base subtracts what the connection's stream clock already
 * contains: samples actually sent on this connection, plus one chunk of
 * capture latency (the anchoring frame holds audio captured ~256ms before
 * its arrival on the main thread).
 */
export function audioStreamBaseSeconds(
  nowWallMs: number,
  sentSamplesOnConnection: number,
  sampleRate: number = STT_SAMPLE_RATE,
  chunkSamples: number = STT_CHUNK_SAMPLES,
): number {
  return Math.max(
    0,
    wallClockMsToAudioSeconds(nowWallMs) -
      chunkSamples / sampleRate -
      sentSamplesOnConnection / sampleRate,
  )
}
