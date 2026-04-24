/**
 * Bounded FIFO ring buffer for Deepgram-bound PCM audio frames.
 *
 * Use case: `useDeepgramRecognition.ts` may start the AudioWorklet before
 * the Deepgram WebSocket has reached `OPEN` state — specifically on the
 * "warmUp pending" path where the audio worklet now runs in parallel with
 * the token fetch + TLS + Deepgram auth handshake (previously the worklet
 * only started AFTER warmUp resolved, causing Q1 audio loss when warmUp
 * took 5.8s in production session 69eb6689c6cbd204bd2b8266).
 *
 * Contract:
 *   - `enqueue(frame)` adds an ArrayBuffer frame. When `capacity` is
 *     reached, OLDEST frames are dropped and `droppedCount` increments.
 *     Dropping oldest (instead of newest) preserves the user's most recent
 *     speech over their initial words — on an abnormally long warmUp,
 *     losing the first 500ms is less bad than losing the last 500ms.
 *   - `drain()` returns all frames in FIFO order, empties the buffer,
 *     returns the array (caller sends each frame over the now-open ws).
 *   - `size()` returns the number of frames currently held.
 *   - `droppedCount()` returns the cumulative count of frames discarded
 *     via overflow (never resets; useful for telemetry).
 *   - `clear()` empties the buffer and resets `droppedCount` to 0. Called
 *     when starting a fresh listening session so stale frames from a
 *     prior session cannot leak.
 *
 * Capacity default = 40 frames. At the pcm-processor.js cadence
 * (4096 samples per frame, 16kHz sample rate = 256ms per frame), that is
 * ~10.24 seconds of audio = ~327 KB of in-memory buffer at worst case.
 * This comfortably covers the worst observed warmUp gap (5.8s) plus
 * margin, while bounding memory under a pathological hung-connection
 * scenario where the WS never opens.
 */
export class PcmRingBuffer {
  private readonly queue: ArrayBuffer[] = []
  private readonly capacity: number
  private _droppedCount = 0

  constructor(capacity = 40) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`PcmRingBuffer capacity must be a positive integer, got ${capacity}`)
    }
    this.capacity = capacity
  }

  enqueue(frame: ArrayBuffer): void {
    if (this.queue.length >= this.capacity) {
      this.queue.shift()
      this._droppedCount++
    }
    this.queue.push(frame)
  }

  drain(): ArrayBuffer[] {
    return this.queue.splice(0, this.queue.length)
  }

  size(): number {
    return this.queue.length
  }

  droppedCount(): number {
    return this._droppedCount
  }

  clear(): void {
    this.queue.length = 0
    this._droppedCount = 0
  }
}
