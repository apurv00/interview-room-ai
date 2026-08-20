'use client'

import { useCallback, useRef, useState } from 'react'

export interface UseMediaRecorderReturn {
  isRecording: boolean
  recordingDuration: number
  startRecording: (stream: MediaStream, options?: MediaRecorderOptions) => boolean
  stopRecording: () => Promise<Blob | null>
  /**
   * Recorder-truth wall-clock span in seconds: live while recording, frozen
   * at stop, null before the first start. The 1s-granularity
   * `recordingDuration` state is for display; callbacks need this ref-backed
   * read because the state value is stale inside stable useCallbacks.
   */
  getDurationSeconds: () => number | null
}

export function useMediaRecorder(): UseMediaRecorderReturn {
  const [isRecording, setIsRecording] = useState(false)
  const [recordingDuration, setRecordingDuration] = useState(0)

  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<ReturnType<typeof setInterval>>()
  const resolveRef = useRef<((blob: Blob | null) => void) | null>(null)
  const completedBlobRef = useRef<Blob | null>(null)
  const startedAtMsRef = useRef<number | null>(null)
  const finalDurationSecondsRef = useRef<number | null>(null)

  const startRecording = useCallback((stream: MediaStream, options?: MediaRecorderOptions) => {
    const audioTracks = stream.getAudioTracks()
    const videoTracks = stream.getVideoTracks()
    if (audioTracks.length === 0 && videoTracks.length === 0) {
      console.warn('No media tracks available for recording')
      return false
    }

    // Use the full stream (video + audio) when video tracks are present
    const hasVideo = videoTracks.length > 0
    const hasAudio = audioTracks.length > 0
    const recordingStream = hasVideo ? stream : new MediaStream(audioTracks)

    // Choose codec — prefer video/webm for full recording, fall back to audio-only
    const mimeType = hasVideo
      ? (hasAudio && MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
          ? 'video/webm;codecs=vp9,opus'
          : !hasAudio && MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
          ? 'video/webm;codecs=vp9'
          : hasAudio && MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
          ? 'video/webm;codecs=vp8,opus'
          : !hasAudio && MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
          ? 'video/webm;codecs=vp8'
          : MediaRecorder.isTypeSupported('video/webm')
          ? 'video/webm'
          : '')
      : (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : '')

    if (!mimeType) {
      console.warn('No supported recording format found')
      return false
    }

    try {
      const recorder = new MediaRecorder(recordingStream, {
        ...options,
        mimeType,
      })
      chunksRef.current = []
      completedBlobRef.current = null
      let finalized = false

      const finalizeRecording = () => {
        if (finalized || recorderRef.current !== recorder) return
        finalized = true
        recorderRef.current = null
        clearInterval(timerRef.current)
        setIsRecording(false)
        if (startedAtMsRef.current !== null) {
          finalDurationSecondsRef.current = (Date.now() - startedAtMsRef.current) / 1000
        }
        const blob = new Blob(chunksRef.current, { type: mimeType })
        chunksRef.current = []
        completedBlobRef.current = blob
        resolveRef.current?.(blob)
        resolveRef.current = null
      }

      recorder.ondataavailable = (event) => {
        if (recorderRef.current !== recorder) return
        if (event.data.size > 0) {
          chunksRef.current.push(event.data)
        }
      }

      recorder.onstop = finalizeRecording

      recorder.onerror = () => {
        if (recorderRef.current !== recorder) return
        setIsRecording(false)
        if (recorder.state !== 'inactive') {
          try {
            recorder.stop()
          } catch {
            finalizeRecording()
          }
        } else {
          finalizeRecording()
        }
      }

      recorderRef.current = recorder
      recorder.start(1000) // 1-second timeslices
      setIsRecording(true)
      setRecordingDuration(0)

      // Duration tracker
      const startTime = Date.now()
      startedAtMsRef.current = startTime
      finalDurationSecondsRef.current = null
      timerRef.current = setInterval(() => {
        setRecordingDuration(Math.floor((Date.now() - startTime) / 1000))
      }, 1000)
      return true
    } catch (err) {
      console.error('Failed to start MediaRecorder:', err)
      return false
    }
  }, [])

  const stopRecording = useCallback((): Promise<Blob | null> => {
    return new Promise((resolve) => {
      if (completedBlobRef.current) {
        resolve(completedBlobRef.current)
        return
      }
      if (!recorderRef.current || recorderRef.current.state === 'inactive') {
        resolve(null)
        return
      }

      resolveRef.current = resolve
      setIsRecording(false)
      recorderRef.current.stop()
    })
  }, [])

  const getDurationSeconds = useCallback((): number | null => {
    if (finalDurationSecondsRef.current !== null) return finalDurationSecondsRef.current
    if (startedAtMsRef.current !== null) return (Date.now() - startedAtMsRef.current) / 1000
    return null
  }, [])

  return { isRecording, recordingDuration, startRecording, stopRecording, getDurationSeconds }
}
