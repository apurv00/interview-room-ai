import { describe, it, expect } from 'vitest'
import { LandmarksUploadSchema } from '../validators/multimodal'
import { sanitizeFacialFrame } from '../hooks/useFacialLandmarks'
import type { FacialFrame } from '@shared/types/multimodal'

// Regression suite for the 30-minute-interview facial-analysis kill
// (2026-07-17 staging gate): MediaPipe iris landmarks exceed the video frame
// when the face is partially out of shot, mapping to gaze values outside
// [-1,1]. Three such frames out of ~2,000 used to 400 the ENTIRE landmarks
// payload, so the analysis ran with zero facial data.

function frame(overrides: Partial<FacialFrame> = {}): FacialFrame {
  return {
    ts: 1.2,
    gazeX: 0.1,
    gazeY: -0.2,
    headPoseYaw: 4.5,
    headPosePitch: -2.1,
    expression: 'neutral',
    eyeContactScore: 0.9,
    blendshapes: { mouthSmileLeft: 0.12 },
    ...overrides,
  }
}

describe('LandmarksUploadSchema sanitation (server)', () => {
  it('clamps out-of-range gaze instead of rejecting the whole payload (the 30-min bug)', () => {
    const parsed = LandmarksUploadSchema.parse({
      sessionId: 'abc',
      frames: [frame(), frame({ gazeY: -1.42, gazeX: 1.07 }), frame()],
    })
    expect(parsed.frames).toHaveLength(3)
    expect(parsed.frames[1].gazeY).toBe(-1)
    expect(parsed.frames[1].gazeX).toBe(1)
    // Untouched frames pass through verbatim.
    expect(parsed.frames[0].gazeY).toBe(-0.2)
  })

  it('drops frames with non-finite numerics (client NaN arrives as JSON null) and keeps the rest', () => {
    const parsed = LandmarksUploadSchema.parse({
      sessionId: 'abc',
      frames: [frame(), { ...frame(), headPosePitch: null }, frame({ ts: 3.4 })],
    })
    expect(parsed.frames).toHaveLength(2)
    expect(parsed.frames.map((f) => f.ts)).toEqual([1.2, 3.4])
  })

  it('drops frames with a non-finite blendshape value', () => {
    const parsed = LandmarksUploadSchema.parse({
      sessionId: 'abc',
      frames: [frame({ blendshapes: { jawOpen: null as unknown as number } }), frame()],
    })
    expect(parsed.frames).toHaveLength(1)
  })

  it('clamps negative ts (wall-clock step) to 0', () => {
    const parsed = LandmarksUploadSchema.parse({
      sessionId: 'abc',
      frames: [frame({ ts: -0.4 })],
    })
    expect(parsed.frames[0].ts).toBe(0)
  })

  it('still rejects genuinely broken producers: out-of-range head pose fails validation', () => {
    const result = LandmarksUploadSchema.safeParse({
      sessionId: 'abc',
      frames: [frame({ headPoseYaw: 240 })],
    })
    expect(result.success).toBe(false)
  })

  it('still enforces the 10,000-frame cap after sanitation', () => {
    const result = LandmarksUploadSchema.safeParse({
      sessionId: 'abc',
      frames: Array.from({ length: 10_001 }, () => frame()),
    })
    expect(result.success).toBe(false)
  })

  it('enforces the cap on the RAW array — droppable frames cannot sneak an oversized payload under it (Codex P2 #553)', () => {
    // 10,001 raw frames, half of them invalid: sanitation would shrink this
    // under the cap; the raw-length check must reject it first.
    const frames = Array.from({ length: 10_001 }, (_, i) =>
      i % 2 === 0 ? frame() : { ...frame(), gazeY: null },
    )
    const result = LandmarksUploadSchema.safeParse({ sessionId: 'abc', frames })
    expect(result.success).toBe(false)
  })

  it('accepts an all-bad payload as an empty frame list (no facial data, but no 400)', () => {
    const parsed = LandmarksUploadSchema.parse({
      sessionId: 'abc',
      frames: [{ ...frame(), gazeY: null }],
    })
    expect(parsed.frames).toHaveLength(0)
  })
})

describe('sanitizeFacialFrame (client producer)', () => {
  it('clamps finite out-of-range gaze and eyeContactScore, and negative ts', () => {
    const out = sanitizeFacialFrame(frame({ gazeY: -1.3, gazeX: 1.9, eyeContactScore: 1.4, ts: -2 }))
    expect(out).not.toBeNull()
    expect(out!.gazeY).toBe(-1)
    expect(out!.gazeX).toBe(1)
    expect(out!.eyeContactScore).toBe(1)
    expect(out!.ts).toBe(0)
  })

  it('drops frames carrying NaN (asin-on-noisy-matrix pitch poisoning)', () => {
    expect(sanitizeFacialFrame(frame({ headPosePitch: NaN }))).toBeNull()
    expect(sanitizeFacialFrame(frame({ eyeContactScore: NaN }))).toBeNull()
    expect(sanitizeFacialFrame(frame({ blendshapes: { jawOpen: Infinity } }))).toBeNull()
  })

  it('passes clean frames through unchanged', () => {
    const input = frame()
    expect(sanitizeFacialFrame(input)).toEqual(input)
  })
})
