// ─── Emotion cross-fade engine ──────────────────────────────────────────────
// Smooth 300ms cross-fade between emotion states by interpolating SVG path control points

import type { AvatarEmotion } from '@shared/types'

// Emotion → SVG path config (matches Avatar.tsx EMOTION_CONFIG)
const EMOTION_CONFIG: Record<
  AvatarEmotion,
  { leftBrow: string; rightBrow: string; mouth: string; mouthFill: string; cheekOpacity: number }
> = {
  neutral: {
    leftBrow: 'M 62 96 Q 80 90 98 96',
    rightBrow: 'M 102 96 Q 120 90 138 96',
    mouth: 'M 75 148 Q 100 155 125 148',
    mouthFill: 'transparent',
    cheekOpacity: 0,
  },
  friendly: {
    leftBrow: 'M 62 92 Q 80 86 98 92',
    rightBrow: 'M 102 92 Q 120 86 138 92',
    mouth: 'M 75 145 Q 100 162 125 145',
    mouthFill: 'rgba(255,150,130,0.3)',
    cheekOpacity: 0.25,
  },
  curious: {
    leftBrow: 'M 62 90 Q 80 84 98 92',
    rightBrow: 'M 102 88 Q 120 82 138 90',
    mouth: 'M 78 150 Q 100 158 122 150',
    mouthFill: 'transparent',
    cheekOpacity: 0,
  },
  skeptical: {
    leftBrow: 'M 62 94 Q 80 88 98 96',
    rightBrow: 'M 102 90 Q 120 95 138 92',
    mouth: 'M 75 152 Q 100 148 125 152',
    mouthFill: 'transparent',
    cheekOpacity: 0,
  },
  impressed: {
    leftBrow: 'M 62 88 Q 80 80 98 88',
    rightBrow: 'M 102 88 Q 120 80 138 88',
    mouth: 'M 72 142 Q 100 168 128 142',
    mouthFill: 'rgba(255,150,130,0.4)',
    cheekOpacity: 0.25,
  },
}

// Parse SVG path into numbers
function parsePath(path: string): number[] {
  return path.match(/-?\d+\.?\d*/g)?.map(Number) || []
}

function buildPath(nums: number[]): string {
  return `M ${nums[0]} ${nums[1]} Q ${nums[2]} ${nums[3]} ${nums[4]} ${nums[5]}`
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function lerpNums(a: number[], b: number[], t: number): number[] {
  return a.map((v, i) => lerp(v, b[i], t))
}

// Pre-parse all emotion configs
const PARSED: Record<AvatarEmotion, {
  leftBrow: number[]
  rightBrow: number[]
  mouth: number[]
  cheekOpacity: number
  mouthFill: string
}> = {} as typeof PARSED

for (const [key, cfg] of Object.entries(EMOTION_CONFIG)) {
  PARSED[key as AvatarEmotion] = {
    leftBrow: parsePath(cfg.leftBrow),
    rightBrow: parsePath(cfg.rightBrow),
    mouth: parsePath(cfg.mouth),
    cheekOpacity: cfg.cheekOpacity,
    mouthFill: cfg.mouthFill,
  }
}

export interface EmotionState {
  leftBrow: string
  rightBrow: string
  mouth: string
  mouthFill: string
  cheekOpacity: number
}

export class EmotionEngine {
  private currentEmotion: AvatarEmotion = 'neutral'
  private targetEmotion: AvatarEmotion = 'neutral'
  private transitionStartTime = 0
  private transitionDurationMs = 300
  private rafId: number | null = null
  private onUpdate: ((state: EmotionState) => void) | null = null

  // Snapshot of state at start of transition
  private fromLeftBrow: number[] = PARSED.neutral.leftBrow
  private fromRightBrow: number[] = PARSED.neutral.rightBrow
  private fromMouth: number[] = PARSED.neutral.mouth
  private fromCheekOpacity = 0

  /** Start the animation loop */
  start(onUpdate: (state: EmotionState) => void): void {
    this.stop()
    this.onUpdate = onUpdate
    this.tick()
  }

  /** Transition to a new emotion with 300ms cross-fade */
  transitionTo(emotion: AvatarEmotion): void {
    if (emotion === this.targetEmotion) return
    // Snapshot current interpolated state as "from"
    const current = this.getCurrentBlended()
    this.fromLeftBrow = parsePath(current.leftBrow)
    this.fromRightBrow = parsePath(current.rightBrow)
    this.fromMouth = parsePath(current.mouth)
    this.fromCheekOpacity = current.cheekOpacity

    this.currentEmotion = this.targetEmotion
    this.targetEmotion = emotion
    this.transitionStartTime = performance.now()

    // Restart the RAF loop if it stopped after completing a previous transition
    if (this.rafId === null && this.onUpdate) {
      this.tick()
    }
  }

  /** Stop the engine */
  stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    this.onUpdate = null
  }

  /** Get the current emotion */
  getEmotion(): AvatarEmotion {
    return this.targetEmotion
  }

  private getCurrentBlended(): EmotionState {
    const now = performance.now()
    const elapsed = now - this.transitionStartTime
    const t = Math.min(1, elapsed / this.transitionDurationMs)
    // Smooth ease-out
    const eased = 1 - Math.pow(1 - t, 2)

    const target = PARSED[this.targetEmotion]

    const leftBrow = buildPath(lerpNums(this.fromLeftBrow, target.leftBrow, eased))
    const rightBrow = buildPath(lerpNums(this.fromRightBrow, target.rightBrow, eased))
    const mouth = buildPath(lerpNums(this.fromMouth, target.mouth, eased))
    const cheekOpacity = lerp(this.fromCheekOpacity, target.cheekOpacity, eased)
    const mouthFill = eased > 0.5 ? target.mouthFill : EMOTION_CONFIG[this.currentEmotion].mouthFill

    return { leftBrow, rightBrow, mouth, mouthFill, cheekOpacity }
  }

  private tick = (): void => {
    const state = this.getCurrentBlended()
    this.onUpdate?.(state)

    // Only continue the RAF loop while a transition is in progress
    const elapsed = performance.now() - this.transitionStartTime
    if (elapsed < this.transitionDurationMs) {
      this.rafId = requestAnimationFrame(this.tick)
    } else {
      this.rafId = null
    }
  }

  /** Static helper: pick emotion for interview phase context */
  static emotionForPhase(
    phase: string,
    questionIndex: number,
    avgScore?: number
  ): AvatarEmotion {
    switch (phase) {
      case 'INTERVIEW_START':
      case 'WRAP_UP':
        return 'friendly'
      case 'ASK_QUESTION':
        return questionIndex === 0 ? 'friendly' : questionIndex % 3 === 0 ? 'curious' : 'neutral'
      case 'LISTENING':
        return 'neutral'
      case 'PROCESSING':
        return 'curious'
      default:
        if (avgScore !== undefined) {
          if (avgScore >= 75) return 'impressed'
          if (avgScore >= 55) return 'friendly'
          return 'curious'
        }
        return 'neutral'
    }
  }
}
