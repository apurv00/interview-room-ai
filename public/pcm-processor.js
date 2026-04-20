/**
 * pcm-processor.js — AudioWorkletProcessor for Deepgram streaming.
 *
 * Runs on the audio rendering thread (NOT the main thread). Converts
 * incoming Float32 mic samples to linear16 PCM and posts them to the
 * main thread via MessagePort. The main thread then relays the bytes to
 * the Deepgram WebSocket.
 *
 * Why this replaces the ScriptProcessorNode that used to live at
 * `modules/interview/hooks/useDeepgramRecognition.ts:1071`:
 *
 *   ScriptProcessorNode's `onaudioprocess` callback runs on the main
 *   thread. When the main thread is under load — MediaPipe face
 *   landmarks, React renders, Deepgram message parsing, coaching
 *   timers, WebGL, GC pauses — the callback gets throttled or skipped.
 *   Dropped audio callbacks mean we stop sending bytes on the WS, the
 *   Deepgram server sees silence, it fires UtteranceEnd prematurely,
 *   or (worse) closes the socket with a 1011 idle-timeout. Those are
 *   the exact failure modes documented in INTERVIEW_FLOW.md §8 entries
 *   E-3.4 (WS drop mid-answer) and E-3.7 (tab-backgrounded truncation).
 *
 *   AudioWorkletNode runs this `process()` callback on the audio thread
 *   at a deterministic 128-frame render quantum, unaffected by
 *   main-thread work. Audio continues to flow through Deepgram smoothly
 *   even when the main thread is saturated.
 *
 * Chunk-size note: Deepgram currently receives 4096-sample (256ms at
 * 16kHz) packets from the ScriptProcessor implementation. AudioWorklet's
 * render quantum is a spec-fixed 128 frames (8ms at 16kHz). If we posted
 * every render quantum we'd send 125 WS messages/sec instead of 3.9 —
 * far more frame overhead and a different cadence than Deepgram's
 * server-side VAD is calibrated for. So we buffer 32 render quanta
 * (32 × 128 = 4096 samples) before posting, preserving the exact wire
 * contract Deepgram saw before this migration. If we later want to
 * experiment with smaller chunks for lower interim-transcript latency,
 * that's a separate tuning PR (tracked in CLAUDE.md Known Issues).
 */

class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.CHUNK_SAMPLES = 4096
    this.buffer = new Int16Array(this.CHUNK_SAMPLES)
    this.writeIdx = 0
  }

  /**
   * Called by the audio thread once per render quantum (128 frames,
   * fixed by the Web Audio spec). We accumulate 32 of these into a
   * 4096-sample Int16 buffer and post it as a transferable ArrayBuffer
   * (zero-copy handoff) to the main thread.
   */
  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0) return true
    const channel = input[0]
    if (!channel) return true

    for (let i = 0; i < channel.length; i++) {
      // Clamp and convert Float32 [-1, 1] → Int16 [-32768, 32767].
      // Formula is bit-for-bit identical to the old ScriptProcessor
      // path in useDeepgramRecognition.ts so Deepgram sees the same
      // PCM bytes after this migration.
      const s = channel[i] < -1 ? -1 : channel[i] > 1 ? 1 : channel[i]
      this.buffer[this.writeIdx++] = s < 0 ? s * 0x8000 : s * 0x7fff

      if (this.writeIdx === this.CHUNK_SAMPLES) {
        const out = this.buffer.buffer
        // Transferable: the ArrayBuffer is detached here and re-
        // attached on the main thread receiver. Avoids a per-packet
        // ~8KB copy across the thread boundary.
        this.port.postMessage(out, [out])
        // Fresh allocation — the old buffer is neutered by transfer
        // so we cannot reuse it.
        this.buffer = new Int16Array(this.CHUNK_SAMPLES)
        this.writeIdx = 0
      }
    }
    return true
  }
}

registerProcessor('pcm-processor', PCMProcessor)
