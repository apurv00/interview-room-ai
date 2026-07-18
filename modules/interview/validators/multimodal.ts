import { z } from 'zod'

export const StartAnalysisSchema = z.object({
  sessionId: z.string().min(1).max(50),
})

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value))
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Pre-validation sanitation for landmark frames.
 *
 * The schema used to hard-reject the ENTIRE payload when any single frame had
 * a value out of bounds. On long interviews that is a near-certainty: MediaPipe
 * iris landmarks are frame-normalized but unclamped, so a face partially out
 * of frame yields gazeY < -1 — three such frames out of ~2,000 silently killed
 * all facial analysis for the 2026-07-17 30-minute staging interview.
 *
 * Server-side rules (mirrors the client's sanitizeFacialFrame, covering old
 * cached client bundles that predate it):
 * - Frame with any non-finite/non-numeric required field (client NaN becomes
 *   JSON null) → DROP that frame, keep the rest.
 * - Finite gaze outside [-1,1] → clamp: iris at/beyond the frame edge is still
 *   real "looking fully away" signal.
 * - Negative ts (client wall-clock step) → clamp to 0.
 *
 * Deliberately NOT clamped: headPose (atan2/asin output is bounded — an
 * out-of-range value means a genuinely broken producer and should reject),
 * eyeContactScore and blendshapes (already clamped/bounded at the producer).
 * Blanket-clamping every field would mask real producer bugs.
 */
function sanitizeFrames(frames: unknown): unknown {
  if (!Array.isArray(frames)) return frames
  // Enforce the raw cap BEFORE sanitation (Codex P2 on #553): dropping bad
  // frames first would let an oversized payload sneak under the .max(10000)
  // as long as enough entries were discardable — unbounded scan work for
  // /api/recordings/landmarks. Pass the oversized array through untouched so
  // the schema's own cap rejects it.
  if (frames.length > 10_000) return frames
  const kept: unknown[] = []
  for (const raw of frames) {
    if (!raw || typeof raw !== 'object') {
      kept.push(raw)
      continue
    }
    const f = raw as Record<string, unknown>
    const requiredNumerics = [f.ts, f.gazeX, f.gazeY, f.headPoseYaw, f.headPosePitch, f.eyeContactScore]
    if (!requiredNumerics.every(isFiniteNumber)) continue
    if (f.blendshapes && typeof f.blendshapes === 'object') {
      if (!Object.values(f.blendshapes as Record<string, unknown>).every(isFiniteNumber)) continue
    }
    kept.push({
      ...f,
      ts: Math.max(0, f.ts as number),
      gazeX: clamp(f.gazeX as number, -1, 1),
      gazeY: clamp(f.gazeY as number, -1, 1),
    })
  }
  return kept
}

export const LandmarksUploadSchema = z.object({
  sessionId: z.string().min(1).max(50),
  frames: z.preprocess(
    sanitizeFrames,
    z.array(
      z.object({
        ts: z.number().min(0),
        gazeX: z.number().min(-1).max(1),
        gazeY: z.number().min(-1).max(1),
        headPoseYaw: z.number().min(-180).max(180),
        headPosePitch: z.number().min(-180).max(180),
        expression: z.enum(['neutral', 'smile', 'frown', 'surprise', 'focused']),
        eyeContactScore: z.number().min(0).max(1),
        // Full MediaPipe blendshape vector: 52 ARKit dimensions, each 0–1.
        // Optional for pre-April-2026 sessions that didn't persist blendshapes.
        blendshapes: z.record(z.string(), z.number().min(0).max(1)).optional(),
      })
    ).max(10000) // ~5fps × 30min max = 9000 frames
  ),
})
