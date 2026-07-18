'use client'

import { useCallback, useRef, useState } from 'react'
import type { FacialFrame } from '@shared/types/multimodal'

// Capture rate: 5fps is a good balance between data quality and CPU load
const CAPTURE_INTERVAL_MS = 200 // 5fps

// Expression classification from MediaPipe blend shapes
type BlendShapeMap = Record<string, number>

/**
 * Thresholds on summed L+R blendshapes (each side 0–1, so each sum is 0–2).
 * Tuned DOWN from the originals (smile>0.4, frown>0.3, surprise brow>0.4 &
 * eye>0.3, focused browDown>0.3): while a candidate is *speaking*, the mouth
 * blendshapes are dominated by jaw/viseme movement, which suppresses the
 * smile/frown signal. The old thresholds left nearly every talking frame on
 * 'neutral', so the per-question dominant expression collapsed to neutral for
 * essentially every answer of every interview.
 *
 * Only the MOUTH-based reads (smile/frown) are lowered aggressively, because a
 * speaking jaw suppresses those blendshapes. browDown (focused) is NOT
 * talking-suppressed, so it keeps the original 0.3 — lowering it would over-fire
 * 'focused' on any mildly furrowed brow, and (via facialAggregator →
 * fusionService) that would depress the body-language score, not just tint the
 * emoji strip.
 *
 * CALIBRATION CAVEAT: these are derived from blendshape ranges, NOT yet
 * validated against real camera interviews. A prod camera pass should confirm
 * or adjust them (see modules/interview/docs/AI_ANALYSIS.md §8). The dominance
 * floor in facialAggregator is the second-line safeguard (a class must be
 * SUSTAINED to surface). Exported so classifyExpression can be unit-tested
 * without MediaPipe.
 */
export const EXPRESSION_THRESHOLDS = {
  smile: 0.25,
  frown: 0.2,
  surpriseBrow: 0.3,
  surpriseEye: 0.2,
  focusedBrowDown: 0.3,
} as const

export function classifyExpression(blendShapes: BlendShapeMap): FacialFrame['expression'] {
  const smile = (blendShapes['mouthSmileLeft'] || 0) + (blendShapes['mouthSmileRight'] || 0)
  const frown = (blendShapes['mouthFrownLeft'] || 0) + (blendShapes['mouthFrownRight'] || 0)
  const browUp = (blendShapes['browOuterUpLeft'] || 0) + (blendShapes['browOuterUpRight'] || 0)
  const eyeWide = (blendShapes['eyeWideLeft'] || 0) + (blendShapes['eyeWideRight'] || 0)
  const browDown = (blendShapes['browDownLeft'] || 0) + (blendShapes['browDownRight'] || 0)

  if (smile > EXPRESSION_THRESHOLDS.smile) return 'smile'
  if (frown > EXPRESSION_THRESHOLDS.frown) return 'frown'
  if (browUp > EXPRESSION_THRESHOLDS.surpriseBrow && eyeWide > EXPRESSION_THRESHOLDS.surpriseEye) return 'surprise'
  if (browDown > EXPRESSION_THRESHOLDS.focusedBrowDown) return 'focused'
  return 'neutral'
}

function computeEyeContactScore(
  gazeX: number,
  gazeY: number,
  headYaw: number,
  headPitch: number
): number {
  // Eye contact = looking roughly at the camera (gaze + head facing forward)
  const gazeDeviation = Math.sqrt(gazeX * gazeX + gazeY * gazeY)
  const headDeviation = Math.sqrt(
    (headYaw / 30) ** 2 + (headPitch / 30) ** 2 // normalize to ~30 degree range
  )
  const combined = gazeDeviation * 0.6 + headDeviation * 0.4
  return Math.max(0, Math.min(1, 1 - combined))
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value))
}

/**
 * Sanitize one captured frame before it enters the upload payload.
 *
 * MediaPipe iris landmarks are frame-normalized but NOT clamped to [0,1]:
 * when the face is partially out of frame (leaning into a laptop camera puts
 * the eyes at/above the top edge), iris y goes below 0 and the ((v)/2-0.5)*2
 * gaze mapping lands outside [-1,1]. One such frame — a near-certainty over a
 * 30-minute interview — used to fail the server's Zod bounds and reject the
 * ENTIRE landmarks payload, silently killing all facial analysis for the
 * session (observed on the 2026-07-17 30-min staging gate at frames 2071+).
 *
 * Rules:
 * - Any non-finite numeric (NaN pitch via asin on a float-noisy matrix value,
 *   for example) → drop the frame entirely. JSON.stringify(NaN) === null and
 *   the server would reject the payload; a non-finite frame carries no signal.
 * - Finite but out-of-range gaze → clamp. Iris at/beyond the frame edge is
 *   still real signal ("looking fully away"), and eyeContactScore already
 *   treats it as maximal deviation.
 * - Negative ts (backwards wall-clock step mid-interview) → clamp to 0; the
 *   aggregator's windowing puts such frames in the first window.
 *
 * Exported for unit tests (MediaPipe itself can't run under vitest).
 */
export function sanitizeFacialFrame(frame: FacialFrame): FacialFrame | null {
  const numerics = [
    frame.ts,
    frame.gazeX,
    frame.gazeY,
    frame.headPoseYaw,
    frame.headPosePitch,
    frame.eyeContactScore,
    ...(frame.blendshapes ? Object.values(frame.blendshapes) : []),
  ]
  if (numerics.some((v) => !Number.isFinite(v))) return null

  return {
    ...frame,
    ts: Math.max(0, frame.ts),
    gazeX: clamp(frame.gazeX, -1, 1),
    gazeY: clamp(frame.gazeY, -1, 1),
    eyeContactScore: clamp(frame.eyeContactScore, 0, 1),
  }
}

export interface UseFacialLandmarksReturn {
  isCapturing: boolean
  startCapture: (videoElement: HTMLVideoElement) => Promise<void>
  stopCapture: () => FacialFrame[]
  frameCount: number
  framesRef: React.RefObject<FacialFrame[]>
}

export function useFacialLandmarks(): UseFacialLandmarksReturn {
  const [isCapturing, setIsCapturing] = useState(false)
  const [frameCount, setFrameCount] = useState(0)

  const framesRef = useRef<FacialFrame[]>([])
  const landmarkerRef = useRef<unknown>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval>>()
  const startTimeRef = useRef<number>(0)
  const videoRef = useRef<HTMLVideoElement | null>(null)

  const startCapture = useCallback(async (videoElement: HTMLVideoElement) => {
    try {
      // Dynamically import MediaPipe to avoid bundling it
      const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision')

      const filesetResolver = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
      )

      const landmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
        baseOptions: {
          modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
      })

      landmarkerRef.current = landmarker
      videoRef.current = videoElement
      framesRef.current = []
      startTimeRef.current = Date.now()
      setFrameCount(0)
      setIsCapturing(true)

      // Start capture loop at 5fps
      intervalRef.current = setInterval(() => {
        if (!videoRef.current || videoRef.current.readyState < 2) return

        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const result = (landmarker as any).detectForVideo(videoRef.current, performance.now()) as {
            faceLandmarks: Array<Array<{ x: number; y: number; z: number }>>
            faceBlendshapes: Array<{ categories: Array<{ categoryName: string; score: number }> }>
            facialTransformationMatrixes: Array<{ data: number[] | Float32Array }>
          }

          if (!result.faceLandmarks || result.faceLandmarks.length === 0) return

          const landmarks = result.faceLandmarks[0]

          // Extract gaze from iris landmarks (468-477 are iris landmarks in MediaPipe)
          // Left iris center: ~473, Right iris center: ~468
          const leftIris = landmarks[473] || landmarks[468]
          const rightIris = landmarks[468] || landmarks[473]
          const gazeX = leftIris && rightIris
            ? ((leftIris.x + rightIris.x) / 2 - 0.5) * 2 // normalize to -1..1
            : 0
          const gazeY = leftIris && rightIris
            ? ((leftIris.y + rightIris.y) / 2 - 0.5) * 2
            : 0

          // Extract head pose from transformation matrix
          let headPoseYaw = 0
          let headPosePitch = 0
          if (result.facialTransformationMatrixes?.[0]) {
            const m = result.facialTransformationMatrixes[0].data
            // Extract Euler angles from rotation matrix. Clamp the asin input:
            // float noise puts matrix entries a hair past ±1 (e.g. 1.0000001),
            // and asin(>1) is NaN — which would poison this frame's pitch AND
            // eyeContactScore (NaN survives min/max clamps).
            headPoseYaw = Math.atan2(m[8], m[0]) * (180 / Math.PI)
            headPosePitch = Math.asin(Math.max(-1, Math.min(1, -m[4]))) * (180 / Math.PI)
          }

          // Extract expression from blend shapes
          const blendShapes: BlendShapeMap = {}
          if (result.faceBlendshapes?.[0]) {
            for (const cat of result.faceBlendshapes[0].categories) {
              blendShapes[cat.categoryName] = cat.score
            }
          }

          const expression = classifyExpression(blendShapes)
          const eyeContactScore = computeEyeContactScore(gazeX, gazeY, headPoseYaw, headPosePitch)

          // Round blendshape scores to 3 decimals to keep per-frame payload ~350 bytes.
          // Keeps enough precision for aggregation without bloating R2 storage.
          const roundedBlendshapes: Record<string, number> = {}
          for (const key in blendShapes) {
            roundedBlendshapes[key] = parseFloat(blendShapes[key].toFixed(3))
          }

          const ts = (Date.now() - startTimeRef.current) / 1000

          const frame = sanitizeFacialFrame({
            ts,
            gazeX: parseFloat(gazeX.toFixed(3)),
            gazeY: parseFloat(gazeY.toFixed(3)),
            headPoseYaw: parseFloat(headPoseYaw.toFixed(1)),
            headPosePitch: parseFloat(headPosePitch.toFixed(1)),
            expression,
            eyeContactScore: parseFloat(eyeContactScore.toFixed(3)),
            blendshapes: roundedBlendshapes,
          })
          if (!frame) return

          framesRef.current.push(frame)
          setFrameCount(framesRef.current.length)
        } catch {
          // Silently skip frame on detection error
        }
      }, CAPTURE_INTERVAL_MS)
    } catch (err) {
      console.warn('MediaPipe facial landmarks unavailable:', err)
      // Graceful degradation: no facial data will be captured
    }
  }, [])

  const stopCapture = useCallback((): FacialFrame[] => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = undefined
    }

    // Clean up landmarker
    if (landmarkerRef.current) {
      try {
        (landmarkerRef.current as { close: () => void }).close()
      } catch {
        // Ignore cleanup errors
      }
      landmarkerRef.current = null
    }

    setIsCapturing(false)
    const frames = [...framesRef.current]
    framesRef.current = []
    return frames
  }, [])

  return { isCapturing, startCapture, stopCapture, frameCount, framesRef }
}
