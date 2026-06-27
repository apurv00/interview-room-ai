/**
 * voiceMixer — module-level Web Audio API mixer that combines the
 * candidate's microphone with any AI-voice <audio> element.
 *
 * Why: the camera/mic recording captures only the candidate. The AI
 * interviewer's TTS plays through `new Audio(...)` and is therefore
 * inaudible in the recorded webm (the candidate hears it acoustically,
 * but a headphone user emits nothing into the mic). This mixer routes
 * both the mic stream and any tapped audio element into a single
 * MediaStreamAudioDestinationNode whose `.stream` is what we hand to
 * `MediaRecorder`. The audio elements are *also* connected to the
 * speakers so the user still hears Alex.
 *
 * Singleton-by-module: a fresh AudioContext per browser tab is fine,
 * and we never want two contexts competing for the mic. Call
 * `resetVoiceMixer()` between interviews to release the context.
 */

let audioContext: AudioContext | null = null
let destinationNode: MediaStreamAudioDestinationNode | null = null
let micSourceNode: MediaStreamAudioSourceNode | null = null
const tappedElements = new WeakSet<HTMLMediaElement>()

function getAudioContextCtor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null
  return (
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ||
    null
  )
}

function ensureContext(): { ctx: AudioContext; dest: MediaStreamAudioDestinationNode } | null {
  if (audioContext && destinationNode) {
    return { ctx: audioContext, dest: destinationNode }
  }

  const Ctor = getAudioContextCtor()
  if (!Ctor) return null

  try {
    const ctx = new Ctor()
    const dest = ctx.createMediaStreamDestination()
    audioContext = ctx
    destinationNode = dest
    return { ctx, dest }
  } catch {
    return null
  }
}

/**
 * iOS / iPadOS detection.
 *
 * iOS gives the whole browser tab ONE shared AVAudioSession. A live
 * microphone (Deepgram STT and this recording mixer each hold one) forces
 * that session into PlayAndRecord, which on iOS (a) routes Web Audio output
 * to the receiver/earpiece instead of the speaker and (b) intermittently
 * flips the playback AudioContext into the iOS-only 'interrupted' state.
 * Either one SILENCES TTS that is routed through the AudioContext — the
 * reported iPhone / iPad / iPad-mini "interviewer goes silent after the first
 * question" bug. macOS and Android do not arbitrate a single session, so they
 * are unaffected and keep full mixed-into-recording behaviour.
 *
 * So on Apple touch devices we DO NOT tap the TTS element into the mixer; it
 * plays natively and therefore stays audible. The only cost is that the AI
 * voice is absent from the recorded webm on iOS — the analysis pipeline
 * already falls back to the live Deepgram transcript for the AI side, so
 * nothing downstream breaks.
 *
 * iPadOS 13+ reports a desktop "Macintosh" userAgent, so we disambiguate via
 * maxTouchPoints (a real Mac reports 0; an iPad reports 5).
 */
function isAppleTouchDevice(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  if (/iPad|iPhone|iPod/.test(ua)) return true
  return /Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1
}

/**
 * Tap an HTMLAudioElement into the mixer so its playback is recorded
 * alongside the mic. Safe to call multiple times — each element is
 * tapped at most once. The element keeps playing through the speakers.
 *
 * Note: createMediaElementSource can only be called once per element,
 * and after it's called the element no longer routes to the default
 * audio output unless we explicitly reconnect it to ctx.destination.
 */
export function tapAudioElement(audio: HTMLMediaElement | null | undefined): void {
  if (!audio || tappedElements.has(audio)) return

  // iOS: never hijack the element into the mic-bound AudioContext — the
  // PlayAndRecord session conflict would silence it (see isAppleTouchDevice).
  // Returning here leaves the element on native playback, so it stays audible
  // on iPhone/iPad; the trade-off is no AI voice in the recording on iOS only.
  if (isAppleTouchDevice()) return

  const handle = ensureContext()
  if (!handle) return

  try {
    const source = handle.ctx.createMediaElementSource(audio)
    // Speakers — preserve user-audible playback
    source.connect(handle.ctx.destination)
    // Recording — feed into the mixed stream
    source.connect(handle.dest)
    tappedElements.add(audio)

    // AudioContext starts suspended in many browsers until user gesture.
    if (handle.ctx.state === 'suspended') {
      handle.ctx.resume().catch(() => {})
    }
  } catch {
    // Element may already belong to a different context, or the browser
    // may have rejected the source creation. Fall back silently — the
    // user still hears the audio via normal HTML playback.
  }
}

/**
 * Set (or replace) the microphone source. The provided MediaStream's
 * audio tracks are routed into the mixer destination. The video tracks
 * are ignored — caller is responsible for the recording's video.
 */
export function setMicStream(stream: MediaStream): void {
  const handle = ensureContext()
  if (!handle) return

  if (micSourceNode) {
    try {
      micSourceNode.disconnect()
    } catch {
      /* already disconnected */
    }
    micSourceNode = null
  }

  try {
    const source = handle.ctx.createMediaStreamSource(stream)
    source.connect(handle.dest)
    micSourceNode = source

    if (handle.ctx.state === 'suspended') {
      handle.ctx.resume().catch(() => {})
    }
  } catch {
    /* mic routing failed — recording will fall back to direct mic stream */
  }
}

/**
 * Returns the mixed MediaStream (mic + any tapped AI voices) suitable
 * for handing to MediaRecorder. Returns null if Web Audio API is
 * unsupported or the mixer hasn't been initialised.
 */
export function getMixedAudioStream(): MediaStream | null {
  return destinationNode?.stream ?? null
}

/**
 * Tear down the mixer between interviews. After calling this the next
 * `tapAudioElement` / `setMicStream` will lazily build a fresh context.
 */
export function resetVoiceMixer(): void {
  if (micSourceNode) {
    try {
      micSourceNode.disconnect()
    } catch {
      /* ignore */
    }
    micSourceNode = null
  }
  if (destinationNode) {
    try {
      destinationNode.disconnect()
    } catch {
      /* ignore */
    }
    destinationNode = null
  }
  if (audioContext) {
    audioContext.close().catch(() => {})
    audioContext = null
  }
}
