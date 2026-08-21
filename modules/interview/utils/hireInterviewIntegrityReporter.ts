'use client'

import {
  HIRE_MULTIMODAL_OBSERVATION_MAX_DURATION_MS,
  HIRE_MULTIMODAL_OBSERVATION_MAX_EVENTS,
  HIRE_MULTIMODAL_OBSERVATION_MAX_REVISIONS,
  HIRE_MULTIMODAL_OBSERVATION_MAX_SPEECH_VIDEO_SAMPLES,
  HIRE_MULTIMODAL_OBSERVATION_PLAYBACK_CLOCK_PROTOCOL_VERSION,
  type HireMultimodalObservationPlaybackClock,
  type HireMultimodalObservationSpeechVideoSample,
} from '@shared/contracts/hireMultimodalObservationBridge'
import type { ReplayUploadIntent } from './resumableUpload'
import type { HireMultimodalCapturePayload } from '@interview/hooks/useHireMultimodalCapture'
import { requestAccountBoundJson } from './accountBoundArtifactUpload'

export const HIRE_INTERVIEW_INTEGRITY_CAPTURE_PATH =
  '/api/hire-engine/multimodal-observations/capture'

export type HireInterviewIntegrityEvent =
  | {
      kind: 'browser_window_not_visible'
      source: 'browser_visibility'
      startMs: number
      endMs: number
    }
  | {
      kind: 'browser_window_focus_lost'
      source: 'browser_focus'
      startMs: number
      endMs: number
    }
  | {
      kind: 'fullscreen_exited'
      source: 'fullscreen'
      startMs: number
      endMs: number
    }
  | {
      kind: 'camera_interrupted'
      source: 'camera_track'
      startMs: number
      endMs: number
    }
  | {
      kind: 'microphone_interrupted'
      source: 'microphone_track'
      startMs: number
      endMs: number
    }
  | {
      kind: 'screen_share_wrong_surface'
      source: 'display_surface'
      startMs: number
      endMs: number
    }
  | {
      kind: 'screen_share_interrupted'
      source: 'display_track'
      startMs: number
      endMs: number
    }
  | {
      kind: 'screen_recording_interrupted'
      source: 'display_recorder'
      startMs: number
      endMs: number
    }

export type HireInterviewIntegrityFlushOutcome =
  | 'accepted'
  | 'already_captured'
  | 'disabled'
  | 'conflict'
  | 'unchanged'
  | 'cancelled'
  | 'unavailable'

export interface HireInterviewIntegrityReporter {
  /** Adds a neutral platform event; false means it exceeded the bounded input. */
  record(event: HireInterviewIntegrityEvent): boolean
  /**
   * Adds a coarse VAD/face-presence proxy. Never pass raw audio, a level,
   * transcript text, landmarks, embeddings, or an identity assertion.
   */
  recordSpeechVideoSample(sample: HireMultimodalObservationSpeechVideoSample): boolean
  /**
   * Delivers the current immutable snapshot through the same account-bound
   * runtime write fence. Use keepalive on pagehide; callers do not need to
   * await that best-effort delivery.
   */
  flush(options?: {
    keepalive?: boolean
    /**
     * The final in-memory capture. Passing it always creates a later revision
     * so camera-away and visibility cues join the validation events even after
     * an earlier pagehide flush has already staged a lightweight snapshot.
     */
    capture?: HireMultimodalCapturePayload
    /** Force an otherwise unchanged, bounded heartbeat snapshot. */
    force?: boolean
  }): Promise<HireInterviewIntegrityFlushOutcome>
  /** Gets the currently buffered bounded client data for diagnostics/tests. */
  snapshot(): {
    events: HireInterviewIntegrityEvent[]
    speechVideoSamples: HireMultimodalObservationSpeechVideoSample[]
  }
}

function validInterval(value: { startMs: number; endMs: number }): boolean {
  return (
    Number.isInteger(value.startMs) &&
    Number.isInteger(value.endMs) &&
    value.startMs >= 0 &&
    value.endMs >= value.startMs &&
    value.endMs <= HIRE_MULTIMODAL_OBSERVATION_MAX_DURATION_MS
  )
}

function validSpeechSample(
  sample: HireMultimodalObservationSpeechVideoSample,
): boolean {
  return (
    Number.isInteger(sample.atMs) &&
    sample.atMs >= 0 &&
    sample.atMs <= HIRE_MULTIMODAL_OBSERVATION_MAX_DURATION_MS
  )
}

/**
 * Converts MediaRecorder wall-clock starts onto the canonical integrity
 * timeline. Missing/invalid authority is omitted so a legacy or failed
 * recorder can never acquire a guessed seek offset.
 */
export function buildHireInterviewPlaybackClock(input: {
  cameraRecorderStartedAtMs?: number | null
  screenRecorderStartedAtMs?: number | null
  elapsedMsAt: (timestamp: number) => number | null
}): HireMultimodalObservationPlaybackClock | undefined {
  const offsetFor = (startedAtMs: number | null | undefined) => {
    if (startedAtMs === null || startedAtMs === undefined) return undefined
    const offset = input.elapsedMsAt(startedAtMs)
    if (
      offset === null ||
      !Number.isFinite(offset) ||
      offset < 0 ||
      offset > HIRE_MULTIMODAL_OBSERVATION_MAX_DURATION_MS
    ) {
      return undefined
    }
    return Math.round(offset)
  }
  const cameraRecorderStartOffsetMs = offsetFor(
    input.cameraRecorderStartedAtMs,
  )
  const screenRecorderStartOffsetMs = offsetFor(
    input.screenRecorderStartedAtMs,
  )
  if (
    cameraRecorderStartOffsetMs === undefined &&
    screenRecorderStartOffsetMs === undefined
  ) {
    return undefined
  }
  return {
    protocolVersion:
      HIRE_MULTIMODAL_OBSERVATION_PLAYBACK_CLOCK_PROTOCOL_VERSION,
    ...(cameraRecorderStartOffsetMs !== undefined
      ? { cameraRecorderStartOffsetMs }
      : {}),
    ...(screenRecorderStartOffsetMs !== undefined
      ? { screenRecorderStartOffsetMs }
      : {}),
  }
}

function responseOutcome(value: unknown): Exclude<
  HireInterviewIntegrityFlushOutcome,
  'unchanged' | 'cancelled' | 'unavailable'
> | null {
  if (!value || typeof value !== 'object') return null
  const outcome = (value as { outcome?: unknown }).outcome
  return outcome === 'accepted' ||
    outcome === 'already_captured' ||
    outcome === 'disabled' ||
    outcome === 'conflict'
    ? outcome
    : null
}

/**
 * Small browser-safe reporter for Hire's assessment-validation signals.
 * Snapshots are full and revision-fenced: a lost pagehide response can retry
 * the exact same body, and a later snapshot cannot overwrite it.
 */
export function createHireInterviewIntegrityReporter(input: {
  sessionId: string
  originUserId: string
  intent: ReplayUploadIntent
  availability?: Partial<{
    browserFocus: boolean
    fullscreen: boolean
    cameraTrack: boolean
    microphoneTrack: boolean
    displayShare: boolean
    speechVideoCorroboration: boolean
  }>
}): HireInterviewIntegrityReporter {
  const events: HireInterviewIntegrityEvent[] = []
  const speechVideoSamples: HireMultimodalObservationSpeechVideoSample[] = []
  const availability = {
    browserFocus: input.availability?.browserFocus ?? true,
    fullscreen: input.availability?.fullscreen ?? true,
    cameraTrack: input.availability?.cameraTrack ?? true,
    microphoneTrack: input.availability?.microphoneTrack ?? true,
    displayShare: input.availability?.displayShare ?? false,
    speechVideoCorroboration:
      input.availability?.speechVideoCorroboration ?? true,
  }
  let generation = 0
  let deliveredGeneration = 0
  let nextRevision = 1
  let pending:
    | {
        generation: number
        revision: number
        body: Record<string, unknown>
      }
    | undefined

  const advanceRevisionPast = (revision: number) => {
    nextRevision = Math.max(nextRevision, revision + 1)
  }

  /**
   * A newer full snapshot must never overwrite an in-flight or failed older
   * body. Drop only the local retry reference and allocate the next immutable
   * revision; a still-running older request remains safe under its own fence.
   */
  const supersedePending = (): boolean => {
    if (!pending) return true
    if (pending.revision >= HIRE_MULTIMODAL_OBSERVATION_MAX_REVISIONS) {
      return false
    }
    advanceRevisionPast(pending.revision)
    pending = undefined
    return true
  }

  const makePending = (capture?: HireMultimodalCapturePayload) => {
    if (pending) return pending
    if (nextRevision > HIRE_MULTIMODAL_OBSERVATION_MAX_REVISIONS) {
      return undefined
    }
    const revision = nextRevision
    pending = {
      generation,
      revision,
      body: {
        sessionId: input.sessionId,
        revision,
        observedAt: new Date().toISOString(),
        cameraSamples: capture
          ? capture.cameraSamples.map((sample) => ({ ...sample }))
          : [],
        browserVisibility: capture
          ? {
              available: capture.browserVisibility.available,
              hiddenSpans: capture.browserVisibility.hiddenSpans.map((span) => ({
                ...span,
              })),
            }
          : { available: false, hiddenSpans: [] },
        ...(capture?.playbackClock
          ? { playbackClock: { ...capture.playbackClock } }
          : {}),
        integrity: {
          browserFocus: { available: availability.browserFocus },
          fullscreen: { available: availability.fullscreen },
          cameraTrack: { available: availability.cameraTrack },
          microphoneTrack: { available: availability.microphoneTrack },
          displayShare: { available: availability.displayShare },
          events: events.map((event) => ({ ...event })),
          speechVideoCorroboration: {
            available: availability.speechVideoCorroboration,
            samples: speechVideoSamples.map((sample) => ({ ...sample })),
          },
        },
      },
    }
    return pending
  }

  return {
    record(event) {
      if (!validInterval(event)) {
        return false
      }
      // The gate emits an immediate zero-length fact, then re-emits the same
      // start with its closed duration after a successful recheck. Preserve one
      // lifecycle event so the 100-item cap represents 100 interruptions,
      // while still making the closure a newer durable snapshot.
      const existing = events.find(
        (candidate) =>
          candidate.kind === event.kind &&
          candidate.source === event.source &&
          candidate.startMs === event.startMs,
      )
      if (existing) {
        if (event.endMs <= existing.endMs) return false
        existing.endMs = event.endMs
        generation += 1
        return true
      }
      if (events.length >= HIRE_MULTIMODAL_OBSERVATION_MAX_EVENTS) return false
      events.push({ ...event })
      generation += 1
      return true
    },

    recordSpeechVideoSample(sample) {
      if (
        !validSpeechSample(sample) ||
        speechVideoSamples.length >=
          HIRE_MULTIMODAL_OBSERVATION_MAX_SPEECH_VIDEO_SAMPLES
      ) {
        return false
      }
      // Samples are intentionally compacted to a 3-second cadence. That keeps
      // a complete 30-minute interview under browser keepalive's body ceiling.
      const prior = speechVideoSamples[speechVideoSamples.length - 1]
      if (prior && sample.atMs - prior.atMs < 3_000) return false
      speechVideoSamples.push({ ...sample })
      generation += 1
      return true
    },

    async flush(options = {}) {
      // A final capture or a newly recorded platform event always supersedes
      // an outstanding pagehide/failure snapshot. Both bodies can race safely
      // because their revisions differ; reusing the old body would silently
      // omit the newer event.
      if (
        pending &&
        (options.capture || pending.generation !== generation) &&
        !supersedePending()
      ) {
        return 'conflict'
      }
      if (
        !pending &&
        generation === deliveredGeneration &&
        !options.capture &&
        !options.force
      ) {
        return 'unchanged'
      }
      const snapshot = makePending(options.capture)
      if (!snapshot) return 'conflict'
      try {
        const response = await requestAccountBoundJson(
          HIRE_INTERVIEW_INTEGRITY_CAPTURE_PATH,
          snapshot.body,
          input.intent,
          input.originUserId,
          { keepalive: options.keepalive },
        )
        if (!response) return 'cancelled'
        if (!response.ok) {
          // The server's 409 is a revision collision, so issue the same full
          // snapshot under a fresh revision on the next caller-controlled flush.
          if (response.status === 409) {
            advanceRevisionPast(snapshot.revision)
            if (pending === snapshot) pending = undefined
            return 'conflict'
          }
          return 'unavailable'
        }
        const outcome = responseOutcome(await response.json().catch(() => null))
        if (!outcome) return 'unavailable'
        if (outcome === 'accepted' || outcome === 'already_captured') {
          deliveredGeneration = Math.max(deliveredGeneration, snapshot.generation)
          advanceRevisionPast(snapshot.revision)
          if (pending === snapshot) pending = undefined
        } else if (outcome === 'conflict') {
          advanceRevisionPast(snapshot.revision)
          if (pending === snapshot) pending = undefined
        }
        return outcome
      } catch {
        return 'unavailable'
      }
    },

    snapshot() {
      return {
        events: [...events],
        speechVideoSamples: [...speechVideoSamples],
      }
    },
  }
}

/**
 * Attaches the pagehide delivery required for tab close, navigation, and
 * minimize/kill paths. The handler is intentionally best-effort and does not
 * block page teardown.
 */
export function attachHireInterviewIntegrityPagehideFlush(
  reporter: Pick<HireInterviewIntegrityReporter, 'flush'>,
): () => void {
  if (typeof window === 'undefined') return () => {}
  const onPageHide = () => {
    void reporter.flush({ keepalive: true })
  }
  window.addEventListener('pagehide', onPageHide)
  return () => window.removeEventListener('pagehide', onPageHide)
}

/**
 * Optional local VAD sampler. It forwards only a boolean every three seconds
 * after caller-provided MediaPipe callbacks agree on a current face result and
 * (when geometry is available) a local mouth-motion proxy. If either state is
 * unavailable, it is omitted rather than inferred as a negative signal.
 */
export function createHireInterviewSpeechVideoSampler(input: {
  stream: MediaStream
  reporter: Pick<HireInterviewIntegrityReporter, 'recordSpeechVideoSample'>
  elapsedMs: () => number
  facePresent: () => boolean | null | undefined
  facialSpeechActive?: () => boolean | null | undefined
  intervalMs?: number
}): { start: () => void; stop: () => void } {
  const AudioContextConstructor =
    typeof window === 'undefined'
      ? undefined
      : window.AudioContext ??
        (window as typeof window & {
          webkitAudioContext?: typeof AudioContext
        }).webkitAudioContext
  if (!AudioContextConstructor) return { start: () => {}, stop: () => {} }
  let context: AudioContext
  let source: MediaStreamAudioSourceNode
  let analyser: AnalyserNode
  try {
    context = new AudioContextConstructor()
    source = context.createMediaStreamSource(input.stream)
    analyser = context.createAnalyser()
    analyser.fftSize = 512
    source.connect(analyser)
  } catch {
    // AudioContext creation can be denied or unsupported despite an otherwise
    // usable camera/microphone stream. This optional corroboration signal must
    // never prevent the interview from loading or progressing.
    return { start: () => {}, stop: () => {} }
  }
  const samples = new Uint8Array(analyser.fftSize)
  let timer: ReturnType<typeof setInterval> | undefined
  let stopped = false

  const sample = () => {
    const facePresent = input.facePresent()
    if (facePresent === null || facePresent === undefined) return
    const facialSpeechActive = input.facialSpeechActive?.()
    analyser.getByteTimeDomainData(samples)
    let energy = 0
    for (let index = 0; index < samples.length; index += 1) {
      const value = samples[index]
      const normalized = (value - 128) / 128
      energy += normalized * normalized
    }
    // Local boolean only. The energy value is immediately discarded and never
    // enters the report or transport payload.
    const voiceActive = Math.sqrt(energy / samples.length) >= 0.015
    input.reporter.recordSpeechVideoSample({
      atMs: input.elapsedMs(),
      voiceActive,
      facePresent,
      ...(facialSpeechActive === null || facialSpeechActive === undefined
        ? {}
        : { facialSpeechActive }),
    })
  }

  return {
    start() {
      if (timer || stopped) return
      void context.resume().catch(() => undefined)
      sample()
      timer = setInterval(sample, input.intervalMs ?? 3_000)
    },
    stop() {
      if (stopped) return
      stopped = true
      if (timer) clearInterval(timer)
      timer = undefined
      try {
        source.disconnect()
        analyser.disconnect()
      } catch {
        // A browser can tear down the graph during navigation before cleanup.
      }
      void context.close().catch(() => undefined)
    },
  }
}

export const __hireInterviewIntegrityReporter = {
  validInterval,
  validSpeechSample,
  responseOutcome,
}
