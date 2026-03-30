import type { FacialFrame, FacialSegment } from '@shared/types/multimodal'

/**
 * Aggregate raw facial frames into per-question segments.
 *
 * @param frames  Raw FacialFrame[] captured by MediaPipe at ~5fps
 * @param questionBoundaries  Timestamps (seconds) marking the start of each question window
 * @param totalDurationSec  Total recording duration in seconds
 */
export function aggregateFacialData(
  frames: FacialFrame[],
  questionBoundaries: number[],
  totalDurationSec: number
): FacialSegment[] {
  if (frames.length === 0 || questionBoundaries.length === 0) {
    return []
  }

  // Build time windows from question boundaries
  const windows: Array<{ startSec: number; endSec: number; questionIndex: number }> = []
  for (let i = 0; i < questionBoundaries.length; i++) {
    const start = questionBoundaries[i]
    const end = i < questionBoundaries.length - 1 ? questionBoundaries[i + 1] : totalDurationSec
    windows.push({ startSec: start, endSec: end, questionIndex: i })
  }

  return windows.map((window) => {
    const windowFrames = frames.filter(
      (f) => f.ts >= window.startSec && f.ts < window.endSec
    )

    if (windowFrames.length === 0) {
      return {
        startSec: window.startSec,
        endSec: window.endSec,
        avgEyeContact: 0,
        dominantExpression: 'neutral',
        headStability: 0,
        gestureLevel: 'minimal' as const,
        questionIndex: window.questionIndex,
      }
    }

    // Average eye contact
    const avgEyeContact = parseFloat(
      (windowFrames.reduce((sum, f) => sum + f.eyeContactScore, 0) / windowFrames.length).toFixed(3)
    )

    // Dominant expression (most frequent)
    const expressionCounts = new Map<string, number>()
    for (const f of windowFrames) {
      expressionCounts.set(f.expression, (expressionCounts.get(f.expression) || 0) + 1)
    }
    let dominantExpression = 'neutral'
    let maxCount = 0
    expressionCounts.forEach((count, expr) => {
      if (count > maxCount) {
        dominantExpression = expr
        maxCount = count
      }
    })

    // Head stability: inverse of yaw/pitch variance (1 = very stable)
    const yawValues = windowFrames.map((f) => f.headPoseYaw)
    const pitchValues = windowFrames.map((f) => f.headPosePitch)
    const yawVariance = variance(yawValues)
    const pitchVariance = variance(pitchValues)
    // Normalize: variance of ~0 = stability 1, variance of ~100+ = stability ~0
    const headStability = parseFloat(
      Math.max(0, Math.min(1, 1 - (yawVariance + pitchVariance) / 200)).toFixed(3)
    )

    // Gesture level: based on head movement magnitude
    const totalMovement = windowFrames.reduce((sum, f, i) => {
      if (i === 0) return 0
      const prev = windowFrames[i - 1]
      return sum + Math.abs(f.headPoseYaw - prev.headPoseYaw) + Math.abs(f.headPosePitch - prev.headPosePitch)
    }, 0)
    const avgMovementPerFrame = windowFrames.length > 1 ? totalMovement / (windowFrames.length - 1) : 0

    let gestureLevel: FacialSegment['gestureLevel'] = 'minimal'
    if (avgMovementPerFrame > 5) gestureLevel = 'expressive'
    else if (avgMovementPerFrame > 2) gestureLevel = 'moderate'

    return {
      startSec: window.startSec,
      endSec: window.endSec,
      avgEyeContact,
      dominantExpression,
      headStability,
      gestureLevel,
      questionIndex: window.questionIndex,
    }
  })
}

function variance(values: number[]): number {
  if (values.length === 0) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  return values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length
}
