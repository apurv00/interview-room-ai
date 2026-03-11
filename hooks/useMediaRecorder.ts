'use client'

import { useCallback, useRef, useState } from 'react'

export interface UseMediaRecorderReturn {
  isRecording: boolean
  recordingDuration: number
  startRecording: (stream: MediaStream) => void
  stopRecording: () => Promise<Blob | null>
}

export function useMediaRecorder(): UseMediaRecorderReturn {
  const [isRecording, setIsRecording] = useState(false)
  const [recordingDuration, setRecordingDuration] = useState(0)

  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<ReturnType<typeof setInterval>>()
  const resolveRef = useRef<((blob: Blob | null) => void) | null>(null)

  const startRecording = useCallback((stream: MediaStream) => {
    // Require at least audio; video is optional but preferred
    const audioTracks = stream.getAudioTracks()
    if (audioTracks.length === 0) {
      console.warn('No audio tracks available for recording')
      return
    }

    // Use the full stream (video + audio) when video tracks are present
    const hasVideo = stream.getVideoTracks().length > 0
    const recordingStream = hasVideo ? stream : new MediaStream(audioTracks)

    // Choose codec — prefer video/webm for full recording, fall back to audio-only
    const mimeType = hasVideo
      ? (MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
          ? 'video/webm;codecs=vp9,opus'
          : MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
          ? 'video/webm;codecs=vp8,opus'
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
      return
    }

    try {
      const recorder = new MediaRecorder(recordingStream, { mimeType })
      chunksRef.current = []

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data)
        }
      }

      recorder.onstop = () => {
        clearInterval(timerRef.current)
        const blob = new Blob(chunksRef.current, { type: mimeType })
        chunksRef.current = []
        resolveRef.current?.(blob)
        resolveRef.current = null
      }

      recorder.onerror = () => {
        clearInterval(timerRef.current)
        setIsRecording(false)
        resolveRef.current?.(null)
        resolveRef.current = null
      }

      recorderRef.current = recorder
      recorder.start(1000) // 1-second timeslices
      setIsRecording(true)
      setRecordingDuration(0)

      // Duration tracker
      const startTime = Date.now()
      timerRef.current = setInterval(() => {
        setRecordingDuration(Math.floor((Date.now() - startTime) / 1000))
      }, 1000)
    } catch (err) {
      console.error('Failed to start MediaRecorder:', err)
    }
  }, [])

  const stopRecording = useCallback((): Promise<Blob | null> => {
    return new Promise((resolve) => {
      if (!recorderRef.current || recorderRef.current.state === 'inactive') {
        resolve(null)
        return
      }

      resolveRef.current = resolve
      setIsRecording(false)
      recorderRef.current.stop()
    })
  }, [])

  return { isRecording, recordingDuration, startRecording, stopRecording }
}
