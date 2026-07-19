import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  audioStreamBaseSeconds,
  setRecordingStartedAt,
  resetRecordingClock,
  STT_SAMPLE_RATE,
  STT_CHUNK_SAMPLES,
} from '../audio/recordingClock'

// Pure arithmetic behind the 2026-07-18 word-clock drift fix: the base that
// converts connection-relative Deepgram word times to recording-relative
// absolutes must subtract the audio already on the connection's stream clock.

describe('audioStreamBaseSeconds', () => {
  beforeEach(() => {
    resetRecordingClock()
    setRecordingStartedAt(1_000_000)
  })
  afterEach(() => resetRecordingClock())

  const CHUNK_SEC = STT_CHUNK_SAMPLES / STT_SAMPLE_RATE // 0.256

  it('fresh connection: base = wall offset minus one chunk of capture latency', () => {
    // Turn starts 20s into the recording, nothing sent yet.
    expect(audioStreamBaseSeconds(1_020_000, 0)).toBeCloseTo(20 - CHUNK_SEC, 3)
  })

  it('preserved socket: subtracts prior turns audio so turn 2 lands at real time', () => {
    // Turn 2 anchors 120s in; connection already carries 60s of turn-1 audio
    // + 20 keepalive ticks (3200 samples = 0.2s).
    const base = audioStreamBaseSeconds(1_120_000, 960_000 + 3_200)
    expect(base).toBeCloseTo(120 - CHUNK_SEC - 60.2, 3)
    // A word Deepgram stamps at connection time 60.5 lands at ~120.04 —
    // the OLD formula produced 120 + 60.5 = 180.5.
    expect(base + 60.5).toBeCloseTo(120.044, 2)
  })

  it('clamps at 0 (defensive: counter ahead of wall clock can never go negative)', () => {
    expect(audioStreamBaseSeconds(1_001_000, 960_000)).toBe(0)
  })

  it('returns minus-chunk-clamped 0 when the recording clock is unset (legacy test parity)', () => {
    resetRecordingClock()
    expect(audioStreamBaseSeconds(1_020_000, 0)).toBe(0)
  })
})
