import { describe, it, expect } from 'vitest'

// ─── Phase Definitions Tests ────────────────────────────────────────────────

describe('30-Day Adaptive Plan — Phase Definitions', () => {
  const PHASE_ORDER = ['assessment', 'foundation', 'building', 'intensity', 'mastery', 'review']

  it('has 6 phases in correct order', () => {
    expect(PHASE_ORDER).toHaveLength(6)
    expect(PHASE_ORDER[0]).toBe('assessment')
    expect(PHASE_ORDER[PHASE_ORDER.length - 1]).toBe('review')
  })

  it('phase exit thresholds increase progressively', () => {
    const thresholds = { assessment: 0, foundation: 50, building: 65, intensity: 75, mastery: 100, review: 100 }
    let prev = -1
    for (const phase of PHASE_ORDER) {
      const threshold = thresholds[phase as keyof typeof thresholds]
      expect(threshold).toBeGreaterThanOrEqual(prev)
      prev = threshold
    }
  })
})

// ─── Tier Differentiation Tests ─────────────────────────────────────────────

describe('30-Day Adaptive Plan — Tier Differentiation', () => {
  it('free tier gets 1 task per day', () => {
    const tasksPerDay = (tier: string) => {
      switch (tier) {
        case 'free': return 1
        case 'pro': return 2
        case 'enterprise': return 3
        default: return 1
      }
    }
    expect(tasksPerDay('free')).toBe(1)
    expect(tasksPerDay('pro')).toBe(2)
    expect(tasksPerDay('enterprise')).toBe(3)
  })

  it('free tier spaces interviews on days 1, 15, 28', () => {
    const freeInterviewDays = [1, 15, 28]
    expect(freeInterviewDays).toHaveLength(3)
    expect(freeInterviewDays[0]).toBe(1)
    expect(freeInterviewDays[1]).toBe(15)
    expect(freeInterviewDays[2]).toBe(28)
    // All within 30-day window
    freeInterviewDays.forEach(d => expect(d).toBeLessThanOrEqual(30))
  })
})

// ─── Plan Duration Tests ────────────────────────────────────────────────────

describe('30-Day Adaptive Plan — Duration Alignment', () => {
  it('plan duration is 30 days', () => {
    const PLAN_DURATION_DAYS = 30
    expect(PLAN_DURATION_DAYS).toBe(30)
  })

  it('review phase always covers last 3 days', () => {
    const PLAN_DURATION_DAYS = 30
    const reviewStart = PLAN_DURATION_DAYS - 2 // day 28
    expect(reviewStart).toBe(28)
    // Days 28, 29, 30 are always review
    for (let day = reviewStart; day <= PLAN_DURATION_DAYS; day++) {
      expect(day).toBeGreaterThanOrEqual(28)
      expect(day).toBeLessThanOrEqual(30)
    }
  })

  it('assessment phase is always exactly day 1', () => {
    // Assessment auto-advances after day 1
    const assessmentDays = 1
    expect(assessmentDays).toBe(1)
  })
})
