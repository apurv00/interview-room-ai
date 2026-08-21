import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  detectForVideo: vi.fn(),
  close: vi.fn(),
  forVisionTasks: vi.fn(),
  createFromOptions: vi.fn(),
}))

vi.mock('@mediapipe/tasks-vision', () => ({
  FilesetResolver: { forVisionTasks: mocks.forVisionTasks },
  FaceLandmarker: { createFromOptions: mocks.createFromOptions },
}))

import { useHireMultimodalCapture } from '../hooks/useHireMultimodalCapture'

function faceLandmarks() {
  const landmarks = Array.from({ length: 474 }, () => ({ x: 0.5, y: 0.5 }))
  landmarks[13] = { x: 0.5, y: 0.49 }
  landmarks[14] = { x: 0.5, y: 0.51 }
  landmarks[33] = { x: 0.4, y: 0.5 }
  landmarks[263] = { x: 0.6, y: 0.5 }
  landmarks[468] = { x: 0.5, y: 0.5 }
  landmarks[473] = { x: 0.5, y: 0.5 }
  return landmarks
}

describe('Hire native observation timeline', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mocks.forVisionTasks.mockResolvedValue({})
    mocks.createFromOptions.mockResolvedValue({
      detectForVideo: mocks.detectForVideo,
      close: mocks.close,
    })
    mocks.detectForVideo.mockReturnValue({
      faceLandmarks: [faceLandmarks()],
      facialTransformationMatrixes: [{
        data: [1, 0, 0, 0, 0, 0, 0, 0, 0],
      }],
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('timestamps camera and visibility samples on the canonical integrity clock', async () => {
    let timelineMs = 1_500
    const visibility = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('hidden')
    const video = document.createElement('video')
    Object.defineProperty(video, 'readyState', {
      configurable: true,
      value: HTMLMediaElement.HAVE_CURRENT_DATA,
    })
    const { result, unmount } = renderHook(() => useHireMultimodalCapture())

    try {
      await act(async () => {
        await result.current.startCapture(video, () => timelineMs)
      })

      timelineMs = 2_250
      visibility.mockReturnValue('visible')
      act(() => document.dispatchEvent(new Event('visibilitychange')))

      timelineMs = 4_250
      act(() => vi.advanceTimersByTime(200))

      let capture: ReturnType<typeof result.current.stopCapture> | undefined
      act(() => {
        capture = result.current.stopCapture()
      })
      expect(capture?.cameraSamples[0]?.atMs).toBe(4_250)
      expect(capture?.browserVisibility.hiddenSpans).toEqual([
        { startMs: 1_500, endMs: 2_250 },
      ])
    } finally {
      visibility.mockRestore()
      unmount()
    }
  })
})
