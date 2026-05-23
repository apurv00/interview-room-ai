import type { InterviewDepth, PersonaKind } from '../agent/types'

/** Question counts — duplicated from product rules (no @interview import). */
export function plannedQuestionCount(duration: number, depth: InterviewDepth): number {
  if (depth === 'coding') {
    if (duration <= 10) return 1
    if (duration <= 20) return 1
    return 2
  }
  return interpolateDuration(duration, [
    [10, 6],
    [20, 11],
    [30, 16],
  ])
}

export function effectiveQuestionLimit(
  duration: number,
  depth: InterviewDepth,
  limit?: number,
): number {
  const planned = plannedQuestionCount(duration, depth)
  if (!limit || limit <= 0) return planned
  return Math.min(limit, planned)
}

function interpolateDuration(duration: number, anchors: [number, number][]): number {
  if (duration <= anchors[0][0]) return anchors[0][1]
  for (let i = 1; i < anchors.length; i++) {
    const [d0, q0] = anchors[i - 1]
    const [d1, q1] = anchors[i]
    if (duration <= d1) {
      const t = (duration - d0) / (d1 - d0)
      return Math.round(q0 + t * (q1 - q0))
    }
  }
  return anchors[anchors.length - 1][1]
}

export function expectedScoreBand(persona: PersonaKind): { min: number; max: number } {
  return persona === 'strong' ? { min: 60, max: 100 } : { min: 0, max: 55 }
}

export function avgDimensionScore(ev: Record<string, unknown>): number {
  const dims = ['relevance', 'structure', 'specificity', 'ownership'] as const
  const vals = dims.map((d) => Number(ev[d])).filter((n) => Number.isFinite(n))
  if (vals.length === 0) return 0
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length)
}

export const BANNED_COPY_PATTERNS = [
  /\bprompts?\b/i,
  /\bas json\b/i,
  /\buse this template\b/i,
  /strong-answer outline/i,
  /what exactly do you mean by/i,
]

export const DEFAULT_POLL_MS = 3_000
export const DEFAULT_ANALYSIS_TIMEOUT_MS = 180_000
export const DEFAULT_PATHWAY_TIMEOUT_MS = 120_000
