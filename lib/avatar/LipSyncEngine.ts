// ─── Viseme-based lip sync engine ────────────────────────────────────────────
// Maps text → viseme timeline → smooth mouth path interpolation at ~60fps

export type Viseme = 'REST' | 'OPEN_A' | 'OPEN_O' | 'NARROW' | 'CLOSED_M'

// SVG mouth paths for each viseme shape
export const VISEME_PATHS: Record<Viseme, string> = {
  REST:     'M 75 148 Q 100 155 125 148',        // closed relaxed
  OPEN_A:   'M 78 148 Q 100 172 122 148',        // wide open (a, ah)
  OPEN_O:   'M 82 148 Q 100 168 118 148',        // round open (o, oo)
  NARROW:   'M 80 148 Q 100 158 120 148',        // narrow (e, i)
  CLOSED_M: 'M 78 148 Q 100 150 122 148',        // pressed lips (m, b, p)
}

// Character → viseme lookup
const CHAR_VISEME: Record<string, Viseme> = {
  a: 'OPEN_A', e: 'NARROW', i: 'NARROW', o: 'OPEN_O', u: 'OPEN_O',
  m: 'CLOSED_M', b: 'CLOSED_M', p: 'CLOSED_M',
  f: 'NARROW', v: 'NARROW', s: 'NARROW', z: 'NARROW',
  t: 'NARROW', d: 'NARROW', n: 'NARROW', l: 'NARROW',
  r: 'NARROW', k: 'OPEN_A', g: 'OPEN_A', h: 'OPEN_A',
  w: 'OPEN_O', y: 'NARROW', j: 'NARROW', c: 'NARROW',
  q: 'OPEN_O', x: 'NARROW',
  ' ': 'REST',
}

interface VisemeFrame {
  viseme: Viseme
  startMs: number
  durationMs: number
}

// Parse an SVG path "M x y Q cx cy ex ey" into numbers
function parsePath(path: string): number[] {
  return path.match(/-?\d+\.?\d*/g)?.map(Number) || []
}

// Reconstruct SVG path from numbers
function buildPath(nums: number[]): string {
  // Format: M x y Q cx cy ex ey
  return `M ${nums[0]} ${nums[1]} Q ${nums[2]} ${nums[3]} ${nums[4]} ${nums[5]}`
}

// Lerp between two number arrays
function lerpNums(a: number[], b: number[], t: number): number[] {
  return a.map((v, i) => v + (b[i] - v) * t)
}

export class LipSyncEngine {
  private timeline: VisemeFrame[] = []
  private rafId: number | null = null
  private startTime = 0
  private onUpdate: ((mouthPath: string) => void) | null = null

  // Pre-parsed viseme number arrays for fast interpolation
  private visemeNums: Record<Viseme, number[]>

  constructor() {
    this.visemeNums = {} as Record<Viseme, number[]>
    for (const [key, path] of Object.entries(VISEME_PATHS)) {
      this.visemeNums[key as Viseme] = parsePath(path)
    }
  }

  /** Build a viseme timeline from text at ~13 chars/sec (matching TTS rate 0.93) */
  prepareFromText(text: string): void {
    const charDurationMs = 1000 / 13 // ~77ms per char
    this.timeline = []

    let timeMs = 0
    for (let i = 0; i < text.length; i++) {
      const ch = text[i].toLowerCase()
      const viseme = CHAR_VISEME[ch] || 'NARROW'
      this.timeline.push({ viseme, startMs: timeMs, durationMs: charDurationMs })
      timeMs += charDurationMs
    }
  }

  /** Start the animation loop */
  start(onUpdate: (mouthPath: string) => void): void {
    this.stop()
    this.onUpdate = onUpdate
    this.startTime = performance.now()
    this.tick()
  }

  /** Stop and reset to REST */
  stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    this.onUpdate?.(VISEME_PATHS.REST)
    this.onUpdate = null
  }

  private tick = (): void => {
    const elapsed = performance.now() - this.startTime

    if (this.timeline.length === 0 || elapsed > this.totalDuration()) {
      this.onUpdate?.(VISEME_PATHS.REST)
      // Don't stop — let the caller decide when to stop
      this.rafId = requestAnimationFrame(this.tick)
      return
    }

    // Find current frame
    let currentIdx = 0
    for (let i = 0; i < this.timeline.length; i++) {
      if (elapsed >= this.timeline[i].startMs) currentIdx = i
      else break
    }

    const currentFrame = this.timeline[currentIdx]
    const nextFrame = this.timeline[currentIdx + 1]

    if (!nextFrame) {
      this.onUpdate?.(VISEME_PATHS[currentFrame.viseme])
    } else {
      // Lerp between current and next over 70ms transition window
      const transitionMs = 70
      const frameEnd = currentFrame.startMs + currentFrame.durationMs
      const transitionStart = Math.max(currentFrame.startMs, frameEnd - transitionMs)
      const t = elapsed < transitionStart
        ? 0
        : Math.min(1, (elapsed - transitionStart) / transitionMs)

      const fromNums = this.visemeNums[currentFrame.viseme]
      const toNums = this.visemeNums[nextFrame.viseme]
      const blended = lerpNums(fromNums, toNums, t)
      this.onUpdate?.(buildPath(blended))
    }

    this.rafId = requestAnimationFrame(this.tick)
  }

  private totalDuration(): number {
    if (this.timeline.length === 0) return 0
    const last = this.timeline[this.timeline.length - 1]
    return last.startMs + last.durationMs
  }
}
