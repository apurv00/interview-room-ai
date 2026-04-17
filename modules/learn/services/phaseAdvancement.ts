export type PathwayPhase =
  | 'assessment'
  | 'foundation'
  | 'building'
  | 'intensity'
  | 'mastery'
  | 'review'

export const PHASE_ORDER: PathwayPhase[] = [
  'assessment',
  'foundation',
  'building',
  'intensity',
  'mastery',
  'review',
]

/**
 * Default session-count thresholds at which each phase *graduates*.
 * E.g., assessment graduates at 2 sessions, foundation at 6, etc.
 * Tuned for a ~30-session curriculum; adjustable per-user in phaseThresholds.
 */
export const DEFAULT_PHASE_THRESHOLDS: Record<PathwayPhase, number> = {
  assessment: 2,
  foundation: 6,
  building: 14,
  intensity: 22,
  mastery: 28,
  review: 30,
}

export interface PhaseStatus {
  currentPhase: PathwayPhase
  sessionsCompleted: number
  sessionsInPhase: number
  sessionsUntilNextPhase: number
  progressInPhasePct: number
  isGraduating: boolean
  nextPhase: PathwayPhase | null
}

/**
 * Resolve the current phase from session count + thresholds.
 * Thresholds are cumulative session counts at which each phase exits.
 */
export function resolveCurrentPhase(
  sessionsCompleted: number,
  thresholds: Record<string, number> = DEFAULT_PHASE_THRESHOLDS,
): PathwayPhase {
  for (const phase of PHASE_ORDER) {
    const threshold = thresholds[phase] ?? DEFAULT_PHASE_THRESHOLDS[phase]
    if (sessionsCompleted < threshold) return phase
  }
  return 'review'
}

export function getPhaseStatus(
  sessionsCompleted: number,
  thresholds: Record<string, number> = DEFAULT_PHASE_THRESHOLDS,
): PhaseStatus {
  const current = resolveCurrentPhase(sessionsCompleted, thresholds)
  const currentIdx = PHASE_ORDER.indexOf(current)
  const prevThreshold =
    currentIdx === 0 ? 0 : (thresholds[PHASE_ORDER[currentIdx - 1]] ?? DEFAULT_PHASE_THRESHOLDS[PHASE_ORDER[currentIdx - 1]])
  const currentThreshold = thresholds[current] ?? DEFAULT_PHASE_THRESHOLDS[current]

  const sessionsInPhase = Math.max(0, sessionsCompleted - prevThreshold)
  const phaseLength = Math.max(1, currentThreshold - prevThreshold)
  const sessionsUntilNextPhase = Math.max(0, currentThreshold - sessionsCompleted)
  const progressInPhasePct = Math.min(100, Math.round((sessionsInPhase / phaseLength) * 100))

  return {
    currentPhase: current,
    sessionsCompleted,
    sessionsInPhase,
    sessionsUntilNextPhase,
    progressInPhasePct,
    isGraduating: sessionsUntilNextPhase === 0 && current !== 'review',
    nextPhase: currentIdx < PHASE_ORDER.length - 1 ? PHASE_ORDER[currentIdx + 1] : null,
  }
}

/**
 * Returns the phase that was *just* graduated when a session bumps the count,
 * or null if no graduation occurred.
 */
export function detectPhaseGraduation(
  previousSessions: number,
  newSessions: number,
  thresholds: Record<string, number> = DEFAULT_PHASE_THRESHOLDS,
): PathwayPhase | null {
  const previousPhase = resolveCurrentPhase(previousSessions, thresholds)
  const newPhase = resolveCurrentPhase(newSessions, thresholds)
  if (previousPhase === newPhase) return null
  return previousPhase
}

/**
 * Mastery threshold: consecutive at-target sessions needed to flag a competency mastered.
 */
export const MASTERY_CONSECUTIVE_THRESHOLD = 5
export const MASTERY_SCORE_TARGET = 75

export function isCompetencyMastered(
  consecutiveAtTarget: number,
  threshold = MASTERY_CONSECUTIVE_THRESHOLD,
): boolean {
  return consecutiveAtTarget >= threshold
}

export function phaseFocusCompetencies(
  phase: PathwayPhase,
  weakAreas: string[],
  strongAreas: string[],
): string[] {
  switch (phase) {
    case 'assessment':
      return weakAreas.slice(0, 3)
    case 'foundation':
      return weakAreas.slice(0, 2).concat(strongAreas.slice(0, 1))
    case 'building':
      return weakAreas.slice(0, 3)
    case 'intensity':
      return weakAreas.slice(0, 2)
    case 'mastery':
      return [...weakAreas.slice(0, 1), ...strongAreas.slice(0, 2)]
    case 'review':
      return strongAreas.slice(0, 3)
    default:
      return weakAreas.slice(0, 3)
  }
}
