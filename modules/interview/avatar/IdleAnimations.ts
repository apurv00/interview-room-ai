// ─── Idle animation engine ──────────────────────────────────────────────────
// Continuous subtle animations: breathing, head tilt, gaze drift, nodding, blink

export interface IdleState {
  breathY: number        // vertical translate (-1.5 to 1.5)
  headTiltDeg: number    // rotation degrees (-1 to 1)
  gazeX: number          // horizontal eye offset (-2 to 2)
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
  private nodDurationMs = 400 // ~25 frames at 60fps

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
      this.scheduleNextNod()
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
    this.isSpeechActive = active
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
    const delay = 2500 + Math.random() * 3000 // 2.5–5.5s
    this.nextBlinkAt = performance.now() + delay
    this.blinkEndAt = this.nextBlinkAt + 150 // 150ms blink
  }

  private scheduleNextNod(): void {
    // Nod more frequently when candidate is actively speaking
    const delay = this.isSpeechActive
      ? 1500 + Math.random() * 1500 // 1.5–3s when speaking
      : 2000 + Math.random() * 4000 // 2–6s when silent
    this.nextNodAt = performance.now() + delay
  }

  private tick = (): void => {
    const now = performance.now()
    const t = (now - this.startTime) / 1000 // seconds elapsed

    // ── Breathing: 4s period, 1.5px amplitude ──
    const breathY = Math.sin((t * 2 * Math.PI) / 4) * 1.5

    // ── Head tilt: 6s period, ±1 degree ──
    const headTiltDeg = Math.sin((t * 2 * Math.PI) / 6) * 1

    // ── Gaze drift: 8s period, ±2px ──
    const gazeX = Math.sin((t * 2 * Math.PI) / 8) * 2

    // ── Blink ──
    let blinkState = false
    if (now >= this.nextBlinkAt && now <= this.blinkEndAt) {
      blinkState = true
    } else if (now > this.blinkEndAt) {
      this.scheduleNextBlink()
    }

    // ── Nod (only in listening mode) ──
    let isNodding = false
    let nodProgress = 0

    if (this.isListeningMode) {
      if (this.nodStartTime > 0) {
        // Currently nodding
        const elapsed = now - this.nodStartTime
        if (elapsed < this.nodDurationMs) {
          isNodding = true
          nodProgress = elapsed / this.nodDurationMs
        } else {
          this.nodStartTime = 0
          this.scheduleNextNod()
        }
      } else if (now >= this.nextNodAt) {
        // Start a nod
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
