/**
 * @vitest-environment node
 *
 * Pin the FIFO + overflow contract of PcmRingBuffer. This buffer holds
 * Deepgram-bound PCM frames while the WS is CONNECTING — production
 * session 69eb6689c6cbd204bd2b8266 (2026-04-24 IST) lost ~5.8s of Q1
 * audio because the worklet wouldn't start sending until after the ws
 * opened. After this PR the worklet runs in parallel with warmUp; this
 * buffer is what keeps the in-flight PCM alive until ws.onopen fires.
 *
 * Any regression in FIFO ordering would deliver the user's speech
 * out of order to Deepgram; any regression in overflow semantics could
 * either drop the user's most recent words (if we switched to drop-newest)
 * or let the buffer grow unbounded on a hung socket.
 */
import { describe, it, expect } from 'vitest'
import { PcmRingBuffer } from '../pcmRingBuffer'

function makeFrame(marker: number, size = 8): ArrayBuffer {
  // Small distinctive Int16 payload so FIFO-order assertions can
  // identify each frame by its first sample.
  const buf = new ArrayBuffer(size * 2)
  new Int16Array(buf)[0] = marker
  return buf
}

function firstSample(frame: ArrayBuffer): number {
  return new Int16Array(frame)[0]
}

describe('PcmRingBuffer', () => {
  it('returns 0 size and 0 dropped on a fresh buffer', () => {
    const buf = new PcmRingBuffer(4)
    expect(buf.size()).toBe(0)
    expect(buf.droppedCount()).toBe(0)
  })

  it('enqueues up to capacity without dropping', () => {
    const buf = new PcmRingBuffer(3)
    buf.enqueue(makeFrame(1))
    buf.enqueue(makeFrame(2))
    buf.enqueue(makeFrame(3))
    expect(buf.size()).toBe(3)
    expect(buf.droppedCount()).toBe(0)
  })

  it('drain returns frames in FIFO order and empties the buffer', () => {
    const buf = new PcmRingBuffer(4)
    buf.enqueue(makeFrame(10))
    buf.enqueue(makeFrame(20))
    buf.enqueue(makeFrame(30))
    const drained = buf.drain()
    expect(drained.map(firstSample)).toEqual([10, 20, 30])
    expect(buf.size()).toBe(0)
  })

  it('drain on empty buffer returns []', () => {
    const buf = new PcmRingBuffer(4)
    expect(buf.drain()).toEqual([])
  })

  it('overflow drops the OLDEST frame (preserves most recent speech)', () => {
    // 5.8s warmUp + continuous speech: we want Deepgram to receive the
    // user's LATEST words, even if it means losing their first 500ms.
    // Drop-oldest semantics achieves this.
    const buf = new PcmRingBuffer(3)
    buf.enqueue(makeFrame(1)) // oldest
    buf.enqueue(makeFrame(2))
    buf.enqueue(makeFrame(3))
    buf.enqueue(makeFrame(4)) // overflow — drops 1
    buf.enqueue(makeFrame(5)) // overflow — drops 2
    expect(buf.size()).toBe(3)
    expect(buf.droppedCount()).toBe(2)
    expect(buf.drain().map(firstSample)).toEqual([3, 4, 5])
  })

  it('droppedCount accumulates across drain cycles', () => {
    // Telemetry invariant: droppedCount is a MONOTONIC counter, not a
    // per-drain tally. Operators looking at session totals need to see
    // cumulative overflow over the whole interview.
    const buf = new PcmRingBuffer(2)
    buf.enqueue(makeFrame(1))
    buf.enqueue(makeFrame(2))
    buf.enqueue(makeFrame(3)) // drop 1
    expect(buf.droppedCount()).toBe(1)
    buf.drain()
    buf.enqueue(makeFrame(4))
    buf.enqueue(makeFrame(5))
    buf.enqueue(makeFrame(6)) // drop 4
    expect(buf.droppedCount()).toBe(2)
  })

  it('clear() empties the queue and resets droppedCount', () => {
    // Called at the start of each listening session so stale frames from
    // a prior session can't be delivered to the next ws.
    const buf = new PcmRingBuffer(2)
    buf.enqueue(makeFrame(1))
    buf.enqueue(makeFrame(2))
    buf.enqueue(makeFrame(3)) // overflow
    expect(buf.size()).toBe(2)
    expect(buf.droppedCount()).toBe(1)
    buf.clear()
    expect(buf.size()).toBe(0)
    expect(buf.droppedCount()).toBe(0)
  })

  it('rejects non-positive / non-integer capacity', () => {
    expect(() => new PcmRingBuffer(0)).toThrow()
    expect(() => new PcmRingBuffer(-1)).toThrow()
    expect(() => new PcmRingBuffer(1.5)).toThrow()
  })

  it('works with single-capacity buffer (degenerate but valid)', () => {
    const buf = new PcmRingBuffer(1)
    buf.enqueue(makeFrame(1))
    buf.enqueue(makeFrame(2)) // drop 1
    buf.enqueue(makeFrame(3)) // drop 2
    expect(buf.size()).toBe(1)
    expect(buf.droppedCount()).toBe(2)
    expect(buf.drain().map(firstSample)).toEqual([3])
  })
})
