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
    })
  ).max(10000), // ~5fps × 30min max = 9000 frames
})
