'use client'

import { useCallback, useRef, useState } from 'react'
import type { FacialFrame } from '@shared/types/multimodal'

// Capture rate: 5fps is a good balance between data quality and CPU load
const CAPTURE_INTERVAL_MS = 200 // 5fps

// Expression classification from MediaPipe blend shapes
type BlendShapeMap = Record<string, number>

function classifyExpression(blendShapes: BlendShapeMap): FacialFrame['expression'] {
  const smile = (blendShapes['mouthSmileLeft'] || 0) + (blendShapes['mouthSmileRight'] || 0)
  const frown = (blendShapes['mouthFrownLeft'] || 0) + (blendShapes['mouthFrownRight'] || 0)
  const browUp = (blendShapes['browOuterUpLeft'] || 0) + (blendShapes['browOuterUpRight'] || 0)
  const eyeWide = (blendShapes['eyeWideLeft'] || 0) + (blendShapes['eyeWideRight'] || 0)
  const browDown = (blendShapes['browDownLeft'] || 0) + (blendShapes['browDownRight'] || 0)

  if (smile > 0.4) return 'smile'
  if (frown > 0.3) return 'frown'
  if (browUp > 0.4 && eyeWide > 0.3) return 'surprise'
  if (browDown > 0.3) return 'focused'
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
            // Extract Euler angles from rotation matrix
            headPoseYaw = Math.atan2(m[8], m[0]) * (180 / Math.PI)
            headPosePitch = Math.asin(-m[4]) * (180 / Math.PI)
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

          framesRef.current.push({
            ts,
            gazeX: parseFloat(gazeX.toFixed(3)),
            gazeY: parseFloat(gazeY.toFixed(3)),
            headPoseYaw: parseFloat(headPoseYaw.toFixed(1)),
            headPosePitch: parseFloat(headPosePitch.toFixed(1)),
            expression,
            eyeContactScore: parseFloat(eyeContactScore.toFixed(3)),
            blendshapes: roundedBlendshapes,
          })

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
