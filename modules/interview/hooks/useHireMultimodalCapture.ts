'use client'

import { useCallback, useEffect, useRef } from 'react'

const CAPTURE_INTERVAL_MS = 200
const MAX_CAMERA_SAMPLES = 10_000
const MAX_VISIBILITY_SPANS = 200
const MAX_DURATION_MS = 30 * 60 * 1_000
// Match the reviewed, lockfile-resolved @mediapipe/tasks-vision package.
// Never use @latest for code that receives a live candidate camera stream.
const MEDIAPIPE_TASKS_VISION_VERSION = '0.10.34'
const MEDIAPIPE_WASM_ROOT =
  `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_TASKS_VISION_VERSION}/wasm`

export interface HireMultimodalCameraSample {
  atMs: number
  gazeX: number
  gazeY: number
  headYaw: number
  headPitch: number
}

export interface HireMultimodalVisibilitySpan {
  startMs: number
  endMs: number
}

export interface HireMultimodalCapturePayload {
  cameraSamples: HireMultimodalCameraSample[]
  browserVisibility: {
    available: boolean
    hiddenSpans: HireMultimodalVisibilitySpan[]
  }
}

type FaceLandmarkerResult = {
  faceLandmarks?: Array<Array<{ x: number; y: number }>>
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

function elapsedMs(startedAt: number): number {
  return clamp(Date.now() - startedAt, 0, MAX_DURATION_MS)
}

function appendVisibilitySpan(
  spans: HireMultimodalVisibilitySpan[],
  next: HireMultimodalVisibilitySpan,
): void {
  if (next.endMs < next.startMs) return
  const previous = spans[spans.length - 1]
  if (previous && next.startMs <= previous.endMs + 250) {
    previous.endMs = Math.max(previous.endMs, next.endMs)
    return
  }
  if (spans.length < MAX_VISIBILITY_SPANS) spans.push(next)
}

/**
 * Hire-only browser collection. It deliberately keeps only bounded source
 * samples in memory until the interview ends; the runtime derives fixed,
 * neutral intervals and discards these samples without writing raw landmarks,
 * blendshapes, expressions, or a biometric score anywhere.
 */
export function useHireMultimodalCapture(): {
  startCapture: (video: HTMLVideoElement) => Promise<void>
  stopCapture: () => HireMultimodalCapturePayload
} {
  const samplesRef = useRef<HireMultimodalCameraSample[]>([])
  const hiddenSpansRef = useRef<HireMultimodalVisibilitySpan[]>([])
  const hiddenStartedAtRef = useRef<number | null>(null)
  const startedAtRef = useRef(0)
  const visibilityAvailableRef = useRef(false)
  const visibilityListenerRef = useRef<(() => void) | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const landmarkerRef = useRef<FaceLandmarker | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const generationRef = useRef(0)

  const stopCapture = useCallback((): HireMultimodalCapturePayload => {
    generationRef.current += 1
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
    if (visibilityListenerRef.current && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', visibilityListenerRef.current)
      visibilityListenerRef.current = null
    }
    if (hiddenStartedAtRef.current !== null) {
      appendVisibilitySpan(hiddenSpansRef.current, {
        startMs: hiddenStartedAtRef.current,
        endMs: elapsedMs(startedAtRef.current),
      })
      hiddenStartedAtRef.current = null
    }
    if (landmarkerRef.current) {
      try {
        landmarkerRef.current.close()
      } catch {
        // A failed WebGL/MediaPipe teardown must never block interview finish.
      }
      landmarkerRef.current = null
    }
    videoRef.current = null

    const result: HireMultimodalCapturePayload = {
      cameraSamples: samplesRef.current,
      browserVisibility: {
        available: visibilityAvailableRef.current,
        hiddenSpans: hiddenSpansRef.current,
      },
    }
    samplesRef.current = []
    hiddenSpansRef.current = []
    visibilityAvailableRef.current = false
    return result
  }, [])

  const startCapture = useCallback(async (video: HTMLVideoElement): Promise<void> => {
    // Stop any prior capture before a fresh runtime session starts.
    stopCapture()
    const generation = generationRef.current
    startedAtRef.current = Date.now()
    samplesRef.current = []
    hiddenSpansRef.current = []
    videoRef.current = video

    if (typeof document !== 'undefined') {
      visibilityAvailableRef.current = true
      const recordVisibility = () => {
        const now = elapsedMs(startedAtRef.current)
        if (document.visibilityState === 'hidden') {
          if (hiddenStartedAtRef.current === null) hiddenStartedAtRef.current = now
          return
        }
        if (hiddenStartedAtRef.current !== null) {
          appendVisibilitySpan(hiddenSpansRef.current, {
            startMs: hiddenStartedAtRef.current,
            endMs: now,
          })
          hiddenStartedAtRef.current = null
        }
      }
      visibilityListenerRef.current = recordVisibility
      document.addEventListener('visibilitychange', recordVisibility)
      recordVisibility()
    }

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
        // The Hire-native pipeline never asks MediaPipe for blendshapes or
        // expressions. It needs only the minimal geometry for fixed intervals.
        outputFaceBlendshapes: false,
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
          samplesRef.current.length >= MAX_CAMERA_SAMPLES
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
          const gazeX = clamp(((leftIris.x + rightIris.x) / 2 - 0.5) * 2, -1, 1)
          const gazeY = clamp(((leftIris.y + rightIris.y) / 2 - 0.5) * 2, -1, 1)
          const matrix = result.facialTransformationMatrixes?.[0]?.data
          const headYaw = matrix
            ? Math.atan2(matrix[8] ?? 0, matrix[0] ?? 1) * (180 / Math.PI)
            : 0
          const headPitch = matrix
            ? Math.asin(clamp(-(matrix[4] ?? 0), -1, 1)) * (180 / Math.PI)
            : 0
          if (![gazeX, gazeY, headYaw, headPitch].every(Number.isFinite)) return
          samplesRef.current.push({
            atMs: elapsedMs(startedAtRef.current),
            gazeX: rounded(gazeX, 3),
            gazeY: rounded(gazeY, 3),
            headYaw: rounded(headYaw, 1),
            headPitch: rounded(headPitch, 1),
          })
        } catch {
          // One bad browser/WebGL frame is simply unavailable signal.
        }
      }, CAPTURE_INTERVAL_MS)
    } catch {
      // Camera collection is supplemental. Browser visibility remains useful
      // when MediaPipe/WebGL is unavailable, and interview delivery continues.
    }
  }, [stopCapture])

  useEffect(() => () => {
    stopCapture()
  }, [stopCapture])

  return { startCapture, stopCapture }
}

export const __hireMultimodalCapture = {
  MEDIAPIPE_TASKS_VISION_VERSION,
  MEDIAPIPE_WASM_ROOT,
  clamp,
  elapsedMs,
  appendVisibilitySpan,
}
