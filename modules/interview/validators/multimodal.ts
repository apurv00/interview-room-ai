import { z } from 'zod'

export const StartAnalysisSchema = z.object({
  sessionId: z.string().min(1).max(50),
})

export const LandmarksUploadSchema = z.object({
  sessionId: z.string().min(1).max(50),
  frames: z.array(
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
  ).max(10000), // ~5fps × 30min max = 9000 frames
})
