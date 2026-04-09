import type { FacialFrame, FacialSegment } from '@shared/types/multimodal'

interface AggregateOptions {
  /**
   * Fixed-width window size in seconds. When set, the aggregator ignores
   * `questionBoundaries` and buckets frames into equal-width windows from
   * 0 to totalDurationSec. Used for the per-second timeline in the replay
   * UI and for the dual-pipeline comparison experiment.
   */
  windowSec?: number
  /**
   * If true, include mean and max blendshape statistics per window in the
   * returned segments. Default false to keep the fusion-prompt output small.
   * Only meaningful for frames that carry blendshapes (post-April-2026).
   */
  includeBlendshapeStats?: boolean
}

/**
 * Aggregate raw facial frames into segments.
 *
 * Two modes:
 *   1. Per-question (default): splits frames by question boundaries.
 *   2. Fixed-width: set `options.windowSec` to emit uniform N-second buckets.
 *
 * @param frames  Raw FacialFrame[] captured by MediaPipe at ~5fps
 * @param questionBoundaries  Timestamps (seconds) marking the start of each question window
 * @param totalDurationSec  Total recording duration in seconds
 * @param options  Optional windowing and blendshape-stats flags
 */
export function aggregateFacialData(
  frames: FacialFrame[],
  questionBoundaries: number[],
  totalDurationSec: number,
  options: AggregateOptions = {}
): FacialSegment[] {
  if (frames.length === 0) return []

  // Build time windows.
  const windows: Array<{ startSec: number; endSec: number; questionIndex?: number }> = []
  if (options.windowSec && options.windowSec > 0 && totalDurationSec > 0) {
    // Fixed-width mode — uniform N-second buckets from 0 to totalDurationSec.
    const step = options.windowSec
    for (let start = 0; start < totalDurationSec; start += step) {
      windows.push({
        startSec: parseFloat(start.toFixed(3)),
        endSec: parseFloat(Math.min(start + step, totalDurationSec).toFixed(3)),
      })
    }
  } else {
    // Per-question mode — legacy behavior.
    if (questionBoundaries.length === 0) return []
    for (let i = 0; i < questionBoundaries.length; i++) {
      const start = questionBoundaries[i]
      const end = i < questionBoundaries.length - 1 ? questionBoundaries[i + 1] : totalDurationSec
      windows.push({ startSec: start, endSec: end, questionIndex: i })
    }
  }

  return windows.map((window) => {
    const windowFrames = frames.filter(
      (f) => f.ts >= window.startSec && f.ts < window.endSec
    )

    if (windowFrames.length === 0) {
      // No frames in window — emit neutral/null values so downstream
      // doesn't penalize this segment as "no eye contact" or "unstable".
      const empty: FacialSegment = {
        startSec: window.startSec,
        endSec: window.endSec,
        avgEyeContact: -1,  // sentinel: no data (downstream should skip, not treat as 0)
        dominantExpression: 'neutral',
        headStability: -1,  // sentinel: no data
        gestureLevel: 'minimal',
      }
      if (window.questionIndex !== undefined) empty.questionIndex = window.questionIndex
      return empty
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

    // Head stability: bounded exponential decay of yaw/pitch variance.
    // exp(-var/150) maps: variance 0 → stability 1.0, variance 75 → ~0.6,
    // variance 150 → ~0.37, variance 300 → ~0.14 (naturally bounded 0..1).
    const yawValues = windowFrames.map((f) => f.headPoseYaw)
    const pitchValues = windowFrames.map((f) => f.headPosePitch)
    const yawVariance = variance(yawValues)
    const pitchVariance = variance(pitchValues)
    const headStability = parseFloat(
      Math.exp(-(yawVariance + pitchVariance) / 150).toFixed(3)
    )

    // Gesture level: average frame-to-frame head movement in degrees.
    // Thresholds calibrated from pilot recordings:
    //   > 8 deg/frame avg = expressive (large head turns/nods)
    //   > 3 deg/frame avg = moderate (natural conversational movement)
    //   <= 3 deg/frame    = minimal
    const totalMovement = windowFrames.reduce((sum, f, i) => {
      if (i === 0) return 0
      const prev = windowFrames[i - 1]
      return sum + Math.abs(f.headPoseYaw - prev.headPoseYaw) + Math.abs(f.headPosePitch - prev.headPosePitch)
    }, 0)
    const avgMovementPerFrame = windowFrames.length > 1 ? totalMovement / (windowFrames.length - 1) : 0

    let gestureLevel: FacialSegment['gestureLevel'] = 'minimal'
    if (avgMovementPerFrame > 8) gestureLevel = 'expressive'
    else if (avgMovementPerFrame > 3) gestureLevel = 'moderate'

    const segment: FacialSegment = {
      startSec: window.startSec,
      endSec: window.endSec,
      avgEyeContact,
      dominantExpression,
      headStability,
      gestureLevel,
    }
    if (window.questionIndex !== undefined) segment.questionIndex = window.questionIndex

    // Blendshape summary statistics (dual-pipeline input). Skipped by
    // default to keep the per-question segments compact for the fusion
    // prompt; the per-second timeline run enables this.
    if (options.includeBlendshapeStats) {
      const framesWithBlendshapes = windowFrames.filter((f) => f.blendshapes)
      if (framesWithBlendshapes.length > 0) {
        const means: Record<string, number> = {}
        const maxes: Record<string, number> = {}
        // Collect the union of keys across all frames in the window. In
        // practice MediaPipe emits the same 52 keys every frame, but we
        // don't hard-code the list.
        const keys = new Set<string>()
        for (const f of framesWithBlendshapes) {
          for (const k in f.blendshapes!) keys.add(k)
        }
        keys.forEach((k) => {
          let sum = 0
          let max = 0
          let n = 0
          for (const f of framesWithBlendshapes) {
            const v = f.blendshapes![k] ?? 0
            sum += v
            if (v > max) max = v
            n++
          }
          means[k] = parseFloat((sum / n).toFixed(3))
          maxes[k] = parseFloat(max.toFixed(3))
        })
        segment.meanBlendshapes = means
        segment.maxBlendshapes = maxes
      }
    }

    return segment
  })
}

function variance(values: number[]): number {
  if (values.length === 0) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  return values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length
}
