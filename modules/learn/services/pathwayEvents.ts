import { logger } from '@shared/logger'

export type PathwayEventType =
  | 'phase_entered'
  | 'phase_graduated'
  | 'competency_mastered'
  | 'pathway_created'
  | 'pathway_updated'
  | 'first_drill_completed'

export interface PathwayEvent {
  type: PathwayEventType
  userId: string
  timestamp: Date
  payload: Record<string, unknown>
}

export type PathwayEventHandler = (event: PathwayEvent) => void | Promise<void>

const handlers: PathwayEventHandler[] = []

export function onPathwayEvent(handler: PathwayEventHandler): () => void {
  handlers.push(handler)
  return () => {
    const idx = handlers.indexOf(handler)
    if (idx !== -1) handlers.splice(idx, 1)
  }
}

export async function emitPathwayEvent(event: PathwayEvent): Promise<void> {
  for (const handler of handlers) {
    try {
      await handler(event)
    } catch (err) {
      logger.warn({ err, eventType: event.type, userId: event.userId }, 'Pathway event handler failed')
    }
  }
}

export function clearPathwayEventHandlers(): void {
  handlers.length = 0
}
