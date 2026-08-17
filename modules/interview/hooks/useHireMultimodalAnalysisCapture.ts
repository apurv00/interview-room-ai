'use client'

import { useCallback, useEffect, useRef } from 'react'
import type { HireMultimodalAnalysisFacialFrame } from '@shared/contracts/hireMultimodalAnalysisBridge'
import type { FacialFrame } from '@shared/types/multimodal'
import {
  classifyExpression,
  sanitizeFacialFrame,
} from './useFacialLandmarks'

const CAPTURE_INTERVAL_MS = 200
const MAX_FRAMES = 10_000
const MAX_DURATION_MS = 30 * 60 * 1_000
// This is deliberately pinned. A recorded candidate assessment must not
// silently change its landmark model when a CDN's `@latest` moves.
const MEDIAPIPE_TASKS_VISION_VERSION = '0.10.34'
const MEDIAPIPE_WASM_ROOT =
  `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_TASKS_VISION_VERSION}/wasm`

type FaceLandmarkerResult = {
  faceLandmarks?: Array<Array<{ x: number; y: number; z?: number }>>
  faceBlendshapes?: Array<{
    categories: Array<{ categoryName: string; score: number }>
  }>
  facialTransformationMatrixes?: Array<{ data: ArrayLike<number> }>
}

type FaceLandmarker = {
  detectForVideo(video: HTMLVideoElement, timestamp: number): FaceLandmarkerResult
  close(): void
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function rounded(value: number, decimals: number): number {
  const multiplier = 10 ** decimals
  return Math.round(value * multiplier) / multiplier
}

function elapsedSeconds(startedAt: number): number {
  return clamp(Date.now() - startedAt, 0, MAX_DURATION_MS) / 1_000
}

function eyeContactScore(
  gazeX: number,
  gazeY: number,
  headYaw: number,
  headPitch: number,
): number {
  const gazeDeviation = Math.hypot(gazeX, gazeY)
  const headDeviation = Math.hypot(headYaw / 30, headPitch / 30)
  return clamp(1 - (gazeDeviation * 0.6 + headDeviation * 0.4), 0, 1)
}

/**
 * Full Hire-native post-interview capture. It shares only pure MediaPipe
 * frame calculations with B2C; it never starts B2C coaching hooks, posts to
 * B2C routes, or produces a candidate-facing nudge.
 */
export function useHireMultimodalAnalysisCapture(): {
  startCapture: (video: HTMLVideoElement) => Promise<void>
  stopCapture: () => HireMultimodalAnalysisFacialFrame[]
} {
  const framesRef = useRef<HireMultimodalAnalysisFacialFrame[]>([])
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const landmarkerRef = useRef<FaceLandmarker | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const startedAtRef = useRef(0)
  const generationRef = useRef(0)

  const stopCapture = useCallback((): HireMultimodalAnalysisFacialFrame[] => {
    generationRef.current += 1
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
    if (landmarkerRef.current) {
      try {
        landmarkerRef.current.close()
      } catch {
        // MediaPipe/WebGL cleanup is supplemental and must not delay finish.
      }
      landmarkerRef.current = null
    }
    videoRef.current = null
    const frames = framesRef.current
    framesRef.current = []
    return frames
  }, [])

  const startCapture = useCallback(async (video: HTMLVideoElement): Promise<void> => {
    stopCapture()
    const generation = generationRef.current
    startedAtRef.current = Date.now()
    framesRef.current = []
    videoRef.current = video
    try {
      const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision')
      if (generation !== generationRef.current || !videoRef.current) return
      const fileset = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_ROOT)
      if (generation !== generationRef.current || !videoRef.current) return
      const landmarker = (await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath:
            'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
      })) as FaceLandmarker
      if (generation !== generationRef.current || !videoRef.current) {
        landmarker.close()
        return
      }
      landmarkerRef.current = landmarker
      intervalRef.current = setInterval(() => {
        const activeVideo = videoRef.current
        if (
          !activeVideo ||
          activeVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
          framesRef.current.length >= MAX_FRAMES
        ) {
          return
        }
        try {
          const result = landmarker.detectForVideo(activeVideo, performance.now())
          const landmarks = result.faceLandmarks?.[0]
          if (!landmarks) return
          const leftIris = landmarks[473] ?? landmarks[468]
          const rightIris = landmarks[468] ?? landmarks[473]
          if (!leftIris || !rightIris) return
          const gazeX = ((leftIris.x + rightIris.x) / 2 - 0.5) * 2
          const gazeY = ((leftIris.y + rightIris.y) / 2 - 0.5) * 2
          const matrix = result.facialTransformationMatrixes?.[0]?.data
          const headPoseYaw = matrix
            ? Math.atan2(matrix[8] ?? 0, matrix[0] ?? 1) * (180 / Math.PI)
            : 0
          const headPosePitch = matrix
            ? Math.asin(clamp(-(matrix[4] ?? 0), -1, 1)) * (180 / Math.PI)
            : 0
          if (![gazeX, gazeY, headPoseYaw, headPosePitch].every(Number.isFinite)) return

          const blendshapes: Record<string, number> = {}
          for (const category of result.faceBlendshapes?.[0]?.categories ?? []) {
            if (!Number.isFinite(category.score)) continue
            blendshapes[category.categoryName] = rounded(clamp(category.score, 0, 1), 3)
          }
          const frame = sanitizeFacialFrame({
            ts: elapsedSeconds(startedAtRef.current),
            gazeX: rounded(gazeX, 3),
            gazeY: rounded(gazeY, 3),
            headPoseYaw: rounded(headPoseYaw, 1),
            headPosePitch: rounded(headPosePitch, 1),
            expression: classifyExpression(blendshapes),
            eyeContactScore: rounded(
              eyeContactScore(gazeX, gazeY, headPoseYaw, headPosePitch),
              3,
            ),
            blendshapes,
          } satisfies FacialFrame)
          if (frame) framesRef.current.push(frame)
        } catch {
          // A single unavailable WebGL frame simply produces no landmark row.
        }
      }, CAPTURE_INTERVAL_MS)
    } catch {
      // Interview delivery and recording continue if MediaPipe is unavailable.
    }
  }, [stopCapture])

  useEffect(() => {
    return () => {
      stopCapture()
    }
  }, [stopCapture])

  return { startCapture, stopCapture }
}

export const __hireMultimodalAnalysisCapture = {
  CAPTURE_INTERVAL_MS,
  MAX_FRAMES,
  MEDIAPIPE_TASKS_VISION_VERSION,
  MEDIAPIPE_WASM_ROOT,
  eyeContactScore,
}
