import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  emitPathwayEvent,
  onPathwayEvent,
  clearPathwayEventHandlers,
  type PathwayEvent,
} from '../services/pathwayEvents'

describe('pathwayEvents', () => {
  beforeEach(() => {
    clearPathwayEventHandlers()
  })

  const makeEvent = (type: PathwayEvent['type'] = 'phase_graduated'): PathwayEvent => ({
    type,
    userId: 'user-123',
    timestamp: new Date(),
    payload: { phase: 'foundation' },
  })

  it('calls registered handler when event is emitted', async () => {
    const handler = vi.fn()
    onPathwayEvent(handler)

    const event = makeEvent()
    await emitPathwayEvent(event)

    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith(event)
  })

  it('calls multiple handlers in order', async () => {
    const calls: number[] = []
    onPathwayEvent(() => { calls.push(1) })
    onPathwayEvent(() => { calls.push(2) })

    await emitPathwayEvent(makeEvent())

    expect(calls).toEqual([1, 2])
  })

  it('unsubscribe removes handler', async () => {
    const handler = vi.fn()
    const unsub = onPathwayEvent(handler)
    unsub()

    await emitPathwayEvent(makeEvent())

    expect(handler).not.toHaveBeenCalled()
  })

  it('clearPathwayEventHandlers removes all handlers', async () => {
    const h1 = vi.fn()
    const h2 = vi.fn()
    onPathwayEvent(h1)
    onPathwayEvent(h2)
    clearPathwayEventHandlers()

    await emitPathwayEvent(makeEvent())

    expect(h1).not.toHaveBeenCalled()
    expect(h2).not.toHaveBeenCalled()
  })

  it('handler error does not prevent other handlers from running', async () => {
    const h1 = vi.fn().mockRejectedValue(new Error('boom'))
    const h2 = vi.fn()
    onPathwayEvent(h1)
    onPathwayEvent(h2)

    await emitPathwayEvent(makeEvent())

    expect(h1).toHaveBeenCalledOnce()
    expect(h2).toHaveBeenCalledOnce()
  })

  it('no-op when no handlers registered', async () => {
    await expect(emitPathwayEvent(makeEvent())).resolves.toBeUndefined()
  })

  it('supports all pathway event types', async () => {
    const receivedTypes: string[] = []
    onPathwayEvent((e) => { receivedTypes.push(e.type) })

    const types: PathwayEvent['type'][] = [
      'phase_entered', 'phase_graduated', 'competency_mastered',
      'pathway_created', 'pathway_updated', 'first_drill_completed',
    ]

    for (const type of types) {
      await emitPathwayEvent(makeEvent(type))
    }

    expect(receivedTypes).toEqual(types)
  })
})
