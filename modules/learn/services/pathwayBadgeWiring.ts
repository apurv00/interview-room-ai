import { onPathwayEvent } from './pathwayEvents'
import { checkAndAwardBadges } from './badgeService'
import { logger } from '@shared/logger'

let _registered = false

/**
 * Register a pathway-event listener that translates phase/mastery events into
 * badge checks. Idempotent — safe to call at module init.
 */
export function registerPathwayBadgeWiring(): void {
  if (_registered) return
  _registered = true

  onPathwayEvent(async (event) => {
    try {
      if (event.type === 'phase_graduated') {
        await checkAndAwardBadges(event.userId, {
          type: 'phase_graduated',
          graduatedPhase: event.payload.graduatedPhase as string,
        })
      } else if (event.type === 'competency_mastered') {
        await checkAndAwardBadges(event.userId, {
          type: 'competency_mastered',
          consecutiveAtTarget: event.payload.consecutiveAtTarget as number,
          masteredCompetency: event.payload.competencyName as string,
        })
      } else if (event.type === 'first_drill_completed') {
        await checkAndAwardBadges(event.userId, {
          type: 'drill_complete',
        })
      }
    } catch (err) {
      logger.warn({ err, eventType: event.type, userId: event.userId }, 'Pathway badge wiring failed')
    }
  })
}

/**
 * Test-only: reset the singleton so handlers can be re-registered in unit tests.
 */
export function resetPathwayBadgeWiring(): void {
  _registered = false
}
