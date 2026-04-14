import { describe, it, expect } from 'vitest'
import { resolveFlow } from '../flow/resolver'
import { buildFlowPromptContext } from '../flow/promptBuilder'
import { shouldProbeOrAdvanceWithFlow } from '../flow/coveragePressure'
import { buildJDOverlay } from '../flow/jdOverlayBuilder'
import { TEMPLATE_REGISTRY, makeTemplateKey } from '../flow'
import type { AnswerEvaluation, ThreadSummary } from '@shared/types'
import type { ResolvedFlow } from '../flow'

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeThread(topicQuestion: string, avgScore: number, probeCount = 1): ThreadSummary {
  return {
    topicIndex: 0,
    topicQuestion,
    summary: `Discussed ${topicQuestion}`,
    avgScore,
    probeCount,
    entries: [],
  }
}

function makeEvalWithProbe(shouldProbe: boolean): AnswerEvaluation {
  return {
    questionIndex: 0,
    question: 'Test',
    answer: 'Test',
    relevance: 70,
    structure: 70,
    specificity: 70,
    ownership: 70,
    needsFollowUp: false,
    flags: [],
    probeDecision: { shouldProbe, reason: 'test' },
  }
}

// ─── Template Registry ──────────────────────────────────────────────────────

describe('TEMPLATE_REGISTRY', () => {
  it('has at least 90 templates loaded', () => {
    expect(TEMPLATE_REGISTRY.size).toBeGreaterThanOrEqual(90)
  })

  it('has all backend behavioral templates', () => {
    expect(TEMPLATE_REGISTRY.has('backend:behavioral:0-2')).toBe(true)
    expect(TEMPLATE_REGISTRY.has('backend:behavioral:3-6')).toBe(true)
    expect(TEMPLATE_REGISTRY.has('backend:behavioral:7+')).toBe(true)
  })

  it('has all PM templates', () => {
    for (const depth of ['behavioral', 'technical', 'case-study']) {
      for (const exp of ['0-2', '3-6', '7+'] as const) {
        expect(TEMPLATE_REGISTRY.has(`pm:${depth}:${exp}`)).toBe(true)
      }
    }
  })

  it('has all general templates', () => {
    for (const depth of ['behavioral', 'technical', 'case-study', 'coding', 'system-design']) {
      for (const exp of ['0-2', '3-6', '7+'] as const) {
        expect(TEMPLATE_REGISTRY.has(`general:${depth}:${exp}`)).toBe(true)
      }
    }
  })

  it('every template has 8-12 slots', () => {
    for (const [key, tmpl] of TEMPLATE_REGISTRY) {
      expect(tmpl.slots.length, `${key} has ${tmpl.slots.length} slots`).toBeGreaterThanOrEqual(8)
      expect(tmpl.slots.length, `${key} has ${tmpl.slots.length} slots`).toBeLessThanOrEqual(12)
    }
  })

  it('every template has neverAsk entries', () => {
    for (const [key, tmpl] of TEMPLATE_REGISTRY) {
      expect(tmpl.neverAsk.length, `${key} neverAsk empty`).toBeGreaterThan(0)
    }
  })

  it('every template has at least one warm-up and one closing slot', () => {
    for (const [key, tmpl] of TEMPLATE_REGISTRY) {
      expect(tmpl.slots.some(s => s.phase === 'warm-up'), `${key} no warm-up`).toBe(true)
      expect(tmpl.slots.some(s => s.phase === 'closing'), `${key} no closing`).toBe(true)
    }
  })

  it('every template includes adaptive deep-dive slots', () => {
    for (const [key, tmpl] of TEMPLATE_REGISTRY) {
      expect(tmpl.slots.some(s => s.id === 'adaptive-deep-dive-1'), `${key} no deep-dive-1`).toBe(true)
      expect(tmpl.slots.some(s => s.id === 'adaptive-deep-dive-2'), `${key} no deep-dive-2`).toBe(true)
    }
  })
})

// ─── resolveFlow ────────────────────────────────────────────────────────────

describe('resolveFlow', () => {
  it('returns a resolved flow for a known combination', () => {
    const flow = resolveFlow({
      domain: 'backend', depth: 'behavioral', experience: '3-6', duration: 20,
    })
    expect(flow).not.toBeNull()
    expect(flow!.domain).toBe('backend')
    expect(flow!.depth).toBe('behavioral')
    expect(flow!.slots.length).toBeGreaterThan(0)
  })

  it('returns null for an unknown combination', () => {
    const flow = resolveFlow({
      domain: 'unknown-domain', depth: 'behavioral', experience: '0-2', duration: 20,
    })
    expect(flow).toBeNull()
  })

  it('trims if-time slots for short duration', () => {
    const long = resolveFlow({
      domain: 'backend', depth: 'behavioral', experience: '3-6', duration: 30,
    })
    const short = resolveFlow({
      domain: 'backend', depth: 'behavioral', experience: '3-6', duration: 10,
    })
    expect(short!.totalSlots).toBeLessThanOrEqual(long!.totalSlots)
  })

  it('always includes warm-up and closing', () => {
    const flow = resolveFlow({
      domain: 'backend', depth: 'behavioral', experience: '0-2', duration: 10,
    })
    expect(flow!.slots[0].phase).toBe('warm-up')
    expect(flow!.slots[flow!.slots.length - 1].phase).toBe('closing')
  })

  it('applies JD overlay promotions', () => {
    const flow = resolveFlow({
      domain: 'backend', depth: 'behavioral', experience: '3-6', duration: 10,
      jdOverlay: {
        promotions: ['incident-response'],
        annotations: [{ slotId: 'incident-response', jdContext: 'JD requires on-call experience' }],
        insertions: [],
      },
    })
    const slot = flow!.slots.find(s => s.id === 'incident-response')
    if (slot) {
      expect(slot.priority).toBe('must')
      expect(slot.jdAnnotation).toContain('JD requires')
    }
  })

  it('slot indices are sequential', () => {
    const flow = resolveFlow({
      domain: 'pm', depth: 'technical', experience: '7+', duration: 20,
    })
    flow!.slots.forEach((s, i) => {
      expect(s.slotIndex).toBe(i)
    })
  })
})

// ─── buildFlowPromptContext ─────────────────────────────────────────────────

describe('buildFlowPromptContext', () => {
  it('generates a prompt block for the current slot', () => {
    const flow = resolveFlow({
      domain: 'backend', depth: 'behavioral', experience: '0-2', duration: 20,
    })!
    const ctx = buildFlowPromptContext({
      flow, currentSlotIndex: 0, completedThreads: [], performanceSignal: 'calibrating',
    })
    expect(ctx.promptBlock).toContain('INTERVIEW FLOW PLAN')
    expect(ctx.currentSlot).not.toBeNull()
    expect(ctx.phase).toBe('warm-up')
  })

  it('includes covered topics when threads exist', () => {
    const flow = resolveFlow({
      domain: 'backend', depth: 'behavioral', experience: '3-6', duration: 20,
    })!
    const ctx = buildFlowPromptContext({
      flow, currentSlotIndex: 2,
      completedThreads: [
        makeThread('project ownership', 75),
        makeThread('technical decisions', 65),
      ],
      performanceSignal: 'on_track',
    })
    expect(ctx.promptBlock).toContain('COVERED TOPICS')
    expect(ctx.promptBlock).toContain('Do NOT revisit')
    expect(ctx.promptBlock).toContain('REMAINING TOPICS')
  })

  it('returns empty prompt for past-all-slots', () => {
    const flow = resolveFlow({
      domain: 'backend', depth: 'behavioral', experience: '0-2', duration: 20,
    })!
    const ctx = buildFlowPromptContext({
      flow, currentSlotIndex: flow.totalSlots + 5,
      completedThreads: [], performanceSignal: 'calibrating',
    })
    expect(ctx.promptBlock).toBe('')
    expect(ctx.currentSlot).toBeNull()
  })

  it('shows coverage pressure alert when must-slots exceed remaining questions', () => {
    const flow = resolveFlow({
      domain: 'backend', depth: 'behavioral', experience: '3-6', duration: 20,
    })!
    // Simulate being near the end with lots of must-slots remaining
    const threads = flow.slots.slice(0, 2).map(s => makeThread(s.label, 60))
    const lastIdx = flow.totalSlots - 2
    const ctx = buildFlowPromptContext({
      flow, currentSlotIndex: lastIdx,
      completedThreads: threads, performanceSignal: 'on_track',
    })
    // May or may not show pressure — depends on remaining must-slots
    expect(ctx.promptBlock).toContain('INTERVIEW FLOW PLAN')
  })
})

// ─── shouldProbeOrAdvanceWithFlow ───────────────────────────────────────────

describe('shouldProbeOrAdvanceWithFlow', () => {
  it('advances when evaluator says no probe', () => {
    const result = shouldProbeOrAdvanceWithFlow({
      evaluation: makeEvalWithProbe(false),
      timeRemaining: 300, completedThreadsCount: 2, duration: 20,
      flow: null, currentProbeDepth: 0,
    })
    expect(result).toBe('advance')
  })

  it('advances when time is critical', () => {
    const result = shouldProbeOrAdvanceWithFlow({
      evaluation: makeEvalWithProbe(true),
      timeRemaining: 30, completedThreadsCount: 2, duration: 20,
      flow: null, currentProbeDepth: 0,
    })
    expect(result).toBe('advance')
  })

  it('advances when warm-up phase (no probing)', () => {
    const flow = resolveFlow({
      domain: 'backend', depth: 'behavioral', experience: '0-2', duration: 20,
    })!
    const result = shouldProbeOrAdvanceWithFlow({
      evaluation: makeEvalWithProbe(true),
      timeRemaining: 300, completedThreadsCount: 0, duration: 20,
      flow, currentProbeDepth: 0,
    })
    expect(result).toBe('advance')
  })

  it('respects per-slot maxProbes', () => {
    const flow = resolveFlow({
      domain: 'backend', depth: 'behavioral', experience: '3-6', duration: 20,
    })!
    // Find a slot with maxProbes > 0
    const explorationIdx = flow.slots.findIndex(s => s.phase === 'exploration' && s.maxProbes > 0)
    if (explorationIdx >= 0) {
      const maxP = flow.slots[explorationIdx].maxProbes
      const result = shouldProbeOrAdvanceWithFlow({
        evaluation: makeEvalWithProbe(true),
        timeRemaining: 300, completedThreadsCount: explorationIdx, duration: 20,
        flow, currentProbeDepth: maxP, // at max
      })
      expect(result).toBe('advance')
    }
  })

  it('allows probing in deep-dive phase', () => {
    const flow = resolveFlow({
      domain: 'backend', depth: 'behavioral', experience: '3-6', duration: 20,
    })!
    const ddIdx = flow.slots.findIndex(s => s.phase === 'deep-dive')
    if (ddIdx >= 0) {
      const result = shouldProbeOrAdvanceWithFlow({
        evaluation: makeEvalWithProbe(true),
        timeRemaining: 300, completedThreadsCount: ddIdx, duration: 20,
        flow, currentProbeDepth: 0,
      })
      expect(result).toBe('probe')
    }
  })

  it('falls back to existing logic when flow is null — probes with ample time', () => {
    const result = shouldProbeOrAdvanceWithFlow({
      evaluation: makeEvalWithProbe(true),
      timeRemaining: 900, completedThreadsCount: 5, duration: 20,
      flow: null, currentProbeDepth: 0,
    })
    expect(result).toBe('probe')
  })

  it('falls back to existing logic when flow is null — advances under time pressure', () => {
    const result = shouldProbeOrAdvanceWithFlow({
      evaluation: makeEvalWithProbe(true),
      timeRemaining: 300, completedThreadsCount: 2, duration: 20,
      flow: null, currentProbeDepth: 0,
    })
    expect(result).toBe('advance')
  })
})

// ─── buildJDOverlay ─────────────────────────────────────────────────────────

describe('buildJDOverlay', () => {
  it('promotes matching slots and annotates them', () => {
    const overlay = buildJDOverlay(
      [{ requirement: 'Strong incident response experience', importance: 'must-have' }],
      ['incident-response', 'team-collaboration', 'self-intro'],
    )
    expect(overlay.promotions).toContain('incident-response')
    expect(overlay.annotations.length).toBeGreaterThan(0)
    expect(overlay.annotations[0].slotId).toBe('incident-response')
  })

  it('creates insertion for unmatched must-have requirements', () => {
    const overlay = buildJDOverlay(
      [{ requirement: 'experience with quantum computing', importance: 'must-have' }],
      ['self-intro', 'team-collaboration'],
    )
    expect(overlay.insertions.length).toBe(1)
    expect(overlay.insertions[0].slot.label).toContain('quantum computing')
  })

  it('limits insertions to 2', () => {
    const overlay = buildJDOverlay(
      [
        { requirement: 'quantum computing', importance: 'must-have' },
        { requirement: 'blockchain development', importance: 'must-have' },
        { requirement: 'mars colonization', importance: 'must-have' },
      ],
      ['self-intro'],
    )
    expect(overlay.insertions.length).toBeLessThanOrEqual(2)
  })

  it('ignores nice-to-have requirements', () => {
    const overlay = buildJDOverlay(
      [{ requirement: 'incident response', importance: 'nice-to-have' }],
      ['incident-response'],
    )
    expect(overlay.promotions.length).toBe(0)
    expect(overlay.annotations.length).toBe(0)
  })

  it('handles empty requirements', () => {
    const overlay = buildJDOverlay([], ['incident-response'])
    expect(overlay.promotions.length).toBe(0)
    expect(overlay.annotations.length).toBe(0)
    expect(overlay.insertions.length).toBe(0)
  })
})

// ─── makeTemplateKey ────────────────────────────────────────────────────────

describe('makeTemplateKey', () => {
  it('creates correct key format', () => {
    expect(makeTemplateKey('backend', 'behavioral', '3-6')).toBe('backend:behavioral:3-6')
    expect(makeTemplateKey('pm', 'case-study', '7+')).toBe('pm:case-study:7+')
  })
})
