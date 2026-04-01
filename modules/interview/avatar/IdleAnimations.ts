// ─── Idle animation engine ──────────────────────────────────────────────────
// Continuous subtle animations: breathing, head tilt, gaze drift, nodding, blink

export interface IdleState {
  breathY: number        // vertical translate
  headTiltDeg: number    // rotation degrees
  gazeX: number          // horizontal eye offset
  isNodding: boolean
  nodProgress: number    // 0 to 1 during nod cycle
  blinkState: boolean    // true = eyes closed
}

export class IdleAnimationEngine {
  private rafId: number | null = null
  private startTime = 0
  private onUpdate: ((state: IdleState) => void) | null = null
  private isListeningMode = false
  private isSpeechActive = false

  // Nod scheduling
  private nextNodAt = 0
  private nodStartTime = 0
  private nodDurationMs = 500 // Slightly longer nod for visibility

  // Blink scheduling
  private nextBlinkAt = 0
  private blinkEndAt = 0

  /** Start the idle animation loop */
  start(onUpdate: (state: IdleState) => void): void {
    this.stop()
    this.onUpdate = onUpdate
    this.startTime = performance.now()
    this.scheduleNextBlink()
    this.scheduleNextNod()
    this.tick()
  }

  /** Set whether the avatar is in "listening" mode (triggers occasional nods) */
  setListening(listening: boolean): void {
    this.isListeningMode = listening
    if (listening) {
      // Start nodding sooner when entering listening mode
      this.nextNodAt = performance.now() + 800
    }
  }

  /** Force an immediate nod (e.g., reacting to candidate speech) */
  triggerNod(): void {
    if (this.isListeningMode && this.nodStartTime === 0) {
      this.nodStartTime = performance.now()
    }
  }

  /** Set speech-active state to adjust nod frequency */
  setSpeechActive(active: boolean): void {
    const wasActive = this.isSpeechActive
    this.isSpeechActive = active
    // When speech starts, trigger an immediate nod
    if (active && !wasActive && this.isListeningMode) {
      this.triggerNod()
    }
  }

  /** Stop all animations */
  stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    this.onUpdate = null
  }

  private scheduleNextBlink(): void {
    // Blink more often during listening (engaged look)
    const delay = this.isListeningMode
      ? 2000 + Math.random() * 2000 // 2–4s when listening
      : 2500 + Math.random() * 3000 // 2.5–5.5s otherwise
    this.nextBlinkAt = performance.now() + delay
    this.blinkEndAt = this.nextBlinkAt + 150
  }

  private scheduleNextNod(): void {
    // Nod much more frequently when candidate is actively speaking
    const delay = this.isSpeechActive
      ? 1000 + Math.random() * 1500 // 1–2.5s when speaking (very responsive)
      : this.isListeningMode
      ? 2000 + Math.random() * 2000 // 2–4s when listening but silence
      : 3000 + Math.random() * 4000 // 3–7s when not listening
    this.nextNodAt = performance.now() + delay
  }

  private tick = (): void => {
    const now = performance.now()
    const t = (now - this.startTime) / 1000 // seconds elapsed

    // ── Breathing: deeper during listening (engaged posture) ──
    const breathAmplitude = this.isListeningMode ? 2.0 : 1.5
    const breathY = Math.sin((t * 2 * Math.PI) / 4) * breathAmplitude

    // ── Head tilt: more subtle movement during listening ──
    const tiltAmplitude = this.isListeningMode ? 1.5 : 1.0
    const headTiltDeg = Math.sin((t * 2 * Math.PI) / 6) * tiltAmplitude

    // ── Gaze: look slightly toward candidate when listening ──
    const gazeBase = this.isListeningMode ? -0.5 : 0 // Slight leftward gaze (toward candidate)
    const gazeX = gazeBase + Math.sin((t * 2 * Math.PI) / 8) * 2

    // ── Blink ──
    let blinkState = false
    if (now >= this.nextBlinkAt && now <= this.blinkEndAt) {
      blinkState = true
    } else if (now > this.blinkEndAt) {
      this.scheduleNextBlink()
    }

    // ── Nod (listening mode — more visible and frequent) ──
    let isNodding = false
    let nodProgress = 0

    if (this.isListeningMode) {
      if (this.nodStartTime > 0) {
        const elapsed = now - this.nodStartTime
        if (elapsed < this.nodDurationMs) {
          isNodding = true
          nodProgress = elapsed / this.nodDurationMs
        } else {
          this.nodStartTime = 0
          this.scheduleNextNod()
        }
      } else if (now >= this.nextNodAt) {
        this.nodStartTime = now
        isNodding = true
        nodProgress = 0
      }
    }

    this.onUpdate?.({
      breathY,
      headTiltDeg,
      gazeX,
      isNodding,
      nodProgress,
      blinkState,
    })

    this.rafId = requestAnimationFrame(this.tick)
  }
}
