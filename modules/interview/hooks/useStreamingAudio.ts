'use client'

import { useCallback, useRef } from 'react'

/**
 * Hook for streaming audio playback via MediaSource API.
 * Starts playing audio as chunks arrive from the server,
 * reducing time-to-first-sound vs buffered playback.
 *
 * Falls back gracefully when MediaSource is not supported (Safari).
 */
export function useStreamingAudio() {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const mediaSourceRef = useRef<MediaSource | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const isSupported =
    typeof window !== 'undefined' &&
    typeof MediaSource !== 'undefined' &&
    MediaSource.isTypeSupported('audio/mpeg')

  /** Cancel any in-progress streaming playback. */
  const cancel = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null

    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.removeAttribute('src')
      audioRef.current.load()
      audioRef.current = null
    }

    if (mediaSourceRef.current?.readyState === 'open') {
      try { mediaSourceRef.current.endOfStream() } catch { /* already ended */ }
    }
    mediaSourceRef.current = null
  }, [])

  /**
   * Stream audio from a fetch Response and play progressively.
   * Resolves when playback finishes, rejects on error.
   */
  const streamAndPlay = useCallback(
    (response: Response, onPlaybackStarted?: () => void): Promise<void> => {
      // Cancel any previous stream
      cancel()

      return new Promise<void>((resolve, reject) => {
        if (!response.body) {
          reject(new Error('Response has no body'))
          return
        }

        const controller = new AbortController()
        abortRef.current = controller

        const mediaSource = new MediaSource()
        mediaSourceRef.current = mediaSource

        const audio = new Audio()
        audioRef.current = audio
        audio.src = URL.createObjectURL(mediaSource)

        // Track whether playback has started
        let playbackStarted = false
        let streamComplete = false

        audio.onended = () => {
          cleanup()
          resolve()
        }
        audio.onerror = () => {
          cleanup()
          reject(new Error('Audio playback error'))
        }

        function cleanup() {
          URL.revokeObjectURL(audio.src)
          audioRef.current = null
          mediaSourceRef.current = null
        }

        mediaSource.addEventListener('sourceopen', async () => {
          let sourceBuffer: SourceBuffer
          try {
            sourceBuffer = mediaSource.addSourceBuffer('audio/mpeg')
          } catch {
            cleanup()
            reject(new Error('Failed to create SourceBuffer'))
            return
          }

          const reader = response.body!.getReader()
          const chunkQueue: Uint8Array[] = []
          let appending = false

          function appendNext() {
            if (appending || chunkQueue.length === 0) return
            if (mediaSource.readyState !== 'open') return

            appending = true
            const chunk = chunkQueue.shift()!
            try {
              sourceBuffer.appendBuffer(chunk.buffer as ArrayBuffer)
            } catch {
              // Buffer may be full or source closed
              appending = false
            }
          }

          sourceBuffer.addEventListener('updateend', () => {
            appending = false

            // Start playback after first chunk is buffered
            if (!playbackStarted) {
              playbackStarted = true
              audio.play().catch(() => {
                cleanup()
                reject(new Error('Playback blocked'))
              })
              onPlaybackStarted?.()
            }

            // If stream is done and queue is empty, end the stream
            if (streamComplete && chunkQueue.length === 0) {
              try {
                if (mediaSource.readyState === 'open') {
                  mediaSource.endOfStream()
                }
              } catch { /* already ended */ }
              return
            }

            appendNext()
          })

          // Read chunks from the stream
          try {
            while (true) {
              if (controller.signal.aborted) break

              const { done, value } = await reader.read()
              if (done) {
                streamComplete = true
                // If nothing is being appended, finalize now
                if (!appending && chunkQueue.length === 0) {
                  try {
                    if (mediaSource.readyState === 'open') {
                      mediaSource.endOfStream()
                    }
                  } catch { /* already ended */ }
                }
                break
              }

              chunkQueue.push(value)
              appendNext()
            }
          } catch (err) {
            if (!controller.signal.aborted) {
              cleanup()
              reject(err)
            }
          }
        })
      })
    },
    [cancel]
  )

  return { streamAndPlay, cancel, isSupported }
}
