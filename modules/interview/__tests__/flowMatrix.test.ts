import { describe, it, expect } from 'vitest'
import {
  resolveFlow,
  buildFlowPromptContext,
  buildJDOverlay,
  TEMPLATE_REGISTRY,
  type ResolvedFlow,
  type TemplateKey,
} from '@interview/flow'
import { getQuestionCount } from '@interview/config/interviewConfig'
import type { ExperienceLevel, Duration, ThreadSummary } from '@shared/types'

// ─── Axes ─────────────────────────────────────────────────────────────────
// Only (domain,depth) pairs that exist in TEMPLATE_REGISTRY. Derived from
// the registry itself so we're testing what actually ships, not a spec.
const experiences: ExperienceLevel[] = ['0-2', '3-6', '7+']
const durations: Duration[] = [10, 20, 30]

type Combo = { domain: string; depth: string; experience: ExperienceLevel; duration: Duration; key: TemplateKey }

function enumerate(): Combo[] {
  const out: Combo[] = []
  for (const key of TEMPLATE_REGISTRY.keys()) {
    const [domain, depth, experience] = key.split(':') as [string, string, ExperienceLevel]
    for (const duration of durations) {
      out.push({ domain, depth, experience, duration, key })
    }
  }
  return out
}

// ─── Step 1.1 — exhaustive matrix ────────────────────────────────────────
interface Failure {
  combo: string
  assertion: string
  detail: string
}
const failures: Failure[] = []

function record(combo: Combo, assertion: string, detail: string) {
  failures.push({
    combo: `${combo.domain}:${combo.depth}:${combo.experience}:${combo.duration}`,
    assertion,
    detail,
  })
}

describe('flow matrix — exhaustive template verification', () => {
  const combos = enumerate()

  it('registry has 102 (domain, depth, experience) templates', () => {
    expect(TEMPLATE_REGISTRY.size).toBe(102)
  })

  it('enumerated combinations = 306 (102 × 3 durations)', () => {
    expect(combos.length).toBe(306)
  })

  it('every combination resolves to a non-null ResolvedFlow with valid invariants', () => {
    // State aggregators for follow-up reports
    const slotCountByTemplate = new Map<string, number[]>()
    const missingDeepDive1: string[] = []
    const missingDeepDive2: string[] = []

    for (const combo of combos) {
      const flow = resolveFlow({
        domain: combo.domain,
        depth: combo.depth,
        experience: combo.experience,
        duration: combo.duration,
      })

      if (!flow) {
        record(combo, 'resolveFlow returns ResolvedFlow', 'got null')
        continue
      }

      // invariant: slots >= 5 (even at 10 min)
      if (flow.slots.length < 5) {
        record(combo, 'slots.length >= 5', `got ${flow.slots.length}`)
      }

      // invariant: at least one warm-up and one closing
      const hasWarmUp = flow.slots.some(s => s.phase === 'warm-up')
      const hasClosing = flow.slots.some(s => s.phase === 'closing')
      if (!hasWarmUp) record(combo, 'has warm-up phase', 'none found')
      if (!hasClosing) record(combo, 'has closing phase', 'none found')

      // invariant: every slot has non-empty strings, valid maxProbes, valid priority
      for (const slot of flow.slots) {
        if (!slot.label || !slot.label.trim()) {
          record(combo, 'slot.label non-empty', `slot ${slot.id} has empty label`)
        }
        if (!slot.guidance || !slot.guidance.trim()) {
          record(combo, 'slot.guidance non-empty', `slot ${slot.id} has empty guidance`)
        }
        if (!slot.probeGuidance || !slot.probeGuidance.trim()) {
          record(combo, 'slot.probeGuidance non-empty', `slot ${slot.id} has empty probeGuidance`)
        }
        if (slot.maxProbes < 0 || slot.maxProbes > 5) {
          record(combo, 'slot.maxProbes ∈ [0,5]', `slot ${slot.id} has maxProbes=${slot.maxProbes}`)
        }
        if (slot.priority !== 'must' && slot.priority !== 'if-time') {
          record(combo, 'slot.priority valid', `slot ${slot.id} has priority='${slot.priority}'`)
        }
      }

      // invariant: unique ids within flow
      const ids = flow.slots.map(s => s.id)
      const uniq = new Set(ids)
      if (uniq.size !== ids.length) {
        const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
        record(combo, 'unique slot ids', `duplicates: ${Array.from(new Set(dupes)).join(', ')}`)
      }

      // invariant: totalSlots === slots.length
      if (flow.totalSlots !== flow.slots.length) {
        record(combo, 'totalSlots === slots.length', `totalSlots=${flow.totalSlots}, slots.length=${flow.slots.length}`)
      }

      // invariant: slotIndex sequential 0..N-1
      for (let i = 0; i < flow.slots.length; i++) {
        if (flow.slots[i].slotIndex !== i) {
          record(combo, 'slotIndex sequential', `slot[${i}].slotIndex=${flow.slots[i].slotIndex}`)
          break
        }
      }

      // invariant: totalSlots <= getQuestionCount(duration) — BUT with leeway since
      // resolver force-adds warm-up/closing back in after trimming, which can push
      // over the budget. Record as soft warning.
      const budget = getQuestionCount(combo.duration)
      if (flow.totalSlots > budget) {
        record(combo, `totalSlots <= getQuestionCount(${combo.duration})=${budget}`, `got totalSlots=${flow.totalSlots}`)
      }

      // track per-template slot counts (keyed without duration for comparison)
      const key = combo.key
      if (!slotCountByTemplate.has(key)) slotCountByTemplate.set(key, [])
      slotCountByTemplate.get(key)!.push(flow.slots.length)

      // check DEEP_DIVE_1 / DEEP_DIVE_2 preservation
      // Expected preserved in 20-min and 30-min (must and if-time respectively)
      // Short-duration trimming may drop DEEP_DIVE_2 legitimately.
      const hasDD1 = flow.slots.some(s => s.id === 'adaptive-deep-dive-1')
      const hasDD2 = flow.slots.some(s => s.id === 'adaptive-deep-dive-2')
      // DEEP_DIVE_1 is 'must' — should survive unless template doesn't use it
      const template = TEMPLATE_REGISTRY.get(combo.key)!
      const templateHasDD1 = template.slots.some(s => s.id === 'adaptive-deep-dive-1')
      const templateHasDD2 = template.slots.some(s => s.id === 'adaptive-deep-dive-2')

      if (templateHasDD1 && !hasDD1) {
        missingDeepDive1.push(`${combo.key}:${combo.duration}`)
      }
      if (templateHasDD2 && !hasDD2 && combo.duration >= 20) {
        // Only flag at 20+ min; DD2 is if-time so can legitimately drop at 10 min.
        missingDeepDive2.push(`${combo.key}:${combo.duration}`)
      }
    }

    // Log aggregates
    console.log(`\n[MATRIX] Total combinations tested: ${combos.length}`)
    console.log(`[MATRIX] Failures: ${failures.length}`)
    if (failures.length > 0) {
      console.log('[MATRIX] Failure details:')
      for (const f of failures) {
        console.log(`  • ${f.combo} | ${f.assertion} | ${f.detail}`)
      }
    }
    if (missingDeepDive1.length > 0) {
      console.log(`[MATRIX] Templates missing DEEP_DIVE_1 after trim: ${missingDeepDive1.length}`)
      for (const m of missingDeepDive1.slice(0, 20)) console.log(`  • ${m}`)
    }
    if (missingDeepDive2.length > 0) {
      console.log(`[MATRIX] Templates missing DEEP_DIVE_2 at >=20min: ${missingDeepDive2.length}`)
      for (const m of missingDeepDive2.slice(0, 20)) console.log(`  • ${m}`)
    }

    // Templates where slot count shrinks below 5 at any duration
    const shrunk: string[] = []
    for (const [key, counts] of slotCountByTemplate) {
      if (counts.some(c => c < 5)) {
        shrunk.push(`${key} → counts=[${counts.join(',')}]`)
      }
    }
    if (shrunk.length > 0) {
      console.log(`[MATRIX] Templates with <5 slots after trim: ${shrunk.length}`)
      for (const s of shrunk.slice(0, 20)) console.log(`  • ${s}`)
    }

    expect(failures, `failures: ${JSON.stringify(failures.slice(0, 20), null, 2)}`).toEqual([])
  })
})

// ─── Step 1.2 — prompt builder sanity ────────────────────────────────────
describe('prompt builder sanity', () => {
  const combos = enumerate()

  it('produces non-empty, non-leaky promptBlock at each slot position', () => {
    const lengths: number[] = []
    const issues: string[] = []

    for (const combo of combos) {
      const flow = resolveFlow({
        domain: combo.domain,
        depth: combo.depth,
        experience: combo.experience,
        duration: combo.duration,
      })
      if (!flow) continue

      const positions = [
        0,
        Math.floor(flow.totalSlots / 2),
        flow.totalSlots - 1,
      ]

      for (const pos of positions) {
        const ctx = buildFlowPromptContext({
          flow,
          currentSlotIndex: pos,
          completedThreads: [],
          performanceSignal: 'calibrating',
        })
        const label = `${combo.domain}:${combo.depth}:${combo.experience}:${combo.duration}@slot${pos}`

        // Non-empty at 0 and middle
        if (pos === 0 && !ctx.promptBlock) {
          issues.push(`${label} — promptBlock empty at slot 0`)
        }
        if (pos === positions[1] && !ctx.promptBlock) {
          issues.push(`${label} — promptBlock empty at middle`)
        }
        // Must mention current slot label
        if (ctx.promptBlock && flow.slots[pos] && !ctx.promptBlock.includes(flow.slots[pos].label)) {
          issues.push(`${label} — prompt missing current slot label "${flow.slots[pos].label}"`)
        }
        // No template placeholders leaked
        if (ctx.promptBlock.includes('${') || ctx.promptBlock.includes('undefined')) {
          issues.push(`${label} — placeholder leak: ${ctx.promptBlock.slice(0, 200)}`)
        }
        // Size sanity
        if (ctx.promptBlock.length > 1500) {
          issues.push(`${label} — promptBlock too long: ${ctx.promptBlock.length} chars`)
        }

        lengths.push(ctx.promptBlock.length)
      }
    }

    lengths.sort((a, b) => a - b)
    const p95 = lengths[Math.floor(lengths.length * 0.95)]
    const max = lengths[lengths.length - 1]
    const maxIdx = lengths.lastIndexOf(max)
    console.log(`\n[PROMPT] Calls: ${lengths.length}`)
    console.log(`[PROMPT] min=${lengths[0]} p50=${lengths[Math.floor(lengths.length/2)]} p95=${p95} max=${max}`)
    if (issues.length > 0) {
      console.log(`[PROMPT] Issues: ${issues.length}`)
      for (const i of issues.slice(0, 20)) console.log(`  • ${i}`)
    }

    expect(issues).toEqual([])
  })

  it('covered topics listed when currentSlotIndex > 0', () => {
    const flow = resolveFlow({ domain: 'backend', depth: 'behavioral', experience: '3-6', duration: 30 })!
    const ctx = buildFlowPromptContext({
      flow,
      currentSlotIndex: 3,
      completedThreads: [],
      performanceSignal: 'on_track',
    })
    expect(ctx.promptBlock).toMatch(/COVERED TOPICS:/)
  })

  it('remaining topics listed when currentSlotIndex < totalSlots - 1', () => {
    const flow = resolveFlow({ domain: 'backend', depth: 'behavioral', experience: '3-6', duration: 30 })!
    const ctx = buildFlowPromptContext({
      flow,
      currentSlotIndex: 0,
      completedThreads: [],
      performanceSignal: 'calibrating',
    })
    expect(ctx.promptBlock).toMatch(/REMAINING TOPICS:/)
  })
})

// ─── Step 1.3 — JD overlay verification ─────────────────────────────────
describe('JD overlay verification', () => {
  // 10 representative templates spanning all 8 domains
  const subset: Array<Pick<Combo, 'domain' | 'depth' | 'experience' | 'duration'>> = [
    { domain: 'backend', depth: 'behavioral', experience: '3-6', duration: 30 },
    { domain: 'backend', depth: 'system-design', experience: '7+', duration: 30 },
    { domain: 'frontend', depth: 'technical', experience: '3-6', duration: 30 },
    { domain: 'pm', depth: 'case-study', experience: '7+', duration: 30 },
    { domain: 'pm', depth: 'behavioral', experience: '3-6', duration: 20 },
    { domain: 'data-science', depth: 'case-study', experience: '3-6', duration: 30 },
    { domain: 'sdet', depth: 'technical', experience: '3-6', duration: 30 },
    { domain: 'design', depth: 'case-study', experience: '7+', duration: 30 },
    { domain: 'business', depth: 'case-study', experience: '7+', duration: 30 },
    { domain: 'general', depth: 'behavioral', experience: '3-6', duration: 20 },
  ]

  const requirements = [
    { requirement: 'strong incident response experience', importance: 'must-have' as const },
    { requirement: 'led cross-functional initiatives', importance: 'must-have' as const },
    { requirement: 'quantum computing expertise', importance: 'must-have' as const },
  ]

  it('overlay produces valid promotions, annotations, and insertions', () => {
    const issues: string[] = []
    for (const combo of subset) {
      const template = TEMPLATE_REGISTRY.get(`${combo.domain}:${combo.depth}:${combo.experience}`)
      if (!template) {
        issues.push(`no template for ${combo.domain}:${combo.depth}:${combo.experience}`)
        continue
      }
      const existingSlotIds = template.slots.map(s => s.id)
      const overlay = buildJDOverlay(requirements, existingSlotIds)

      // promotions must reference existing slots
      for (const p of overlay.promotions) {
        if (!existingSlotIds.includes(p)) {
          issues.push(`${combo.domain}:${combo.depth}:${combo.experience} — orphan promotion: ${p}`)
        }
      }
      // annotations must reference existing slots
      for (const a of overlay.annotations) {
        if (!existingSlotIds.includes(a.slotId)) {
          issues.push(`${combo.domain}:${combo.depth}:${combo.experience} — orphan annotation: ${a.slotId}`)
        }
      }
      // unmatched "quantum computing expertise" should produce an insertion
      const hasQuantumInsertion = overlay.insertions.some(ins =>
        ins.jdRequirement.toLowerCase().includes('quantum'),
      )
      if (!hasQuantumInsertion) {
        issues.push(`${combo.domain}:${combo.depth}:${combo.experience} — expected insertion for unmatched 'quantum computing'`)
      }
      // max 2 insertions
      if (overlay.insertions.length > 2) {
        issues.push(`${combo.domain}:${combo.depth}:${combo.experience} — too many insertions: ${overlay.insertions.length}`)
      }

      // Resolve with overlay and confirm slot count is bounded
      const flow = resolveFlow({
        domain: combo.domain,
        depth: combo.depth,
        experience: combo.experience,
        duration: combo.duration,
        jdOverlay: overlay,
      })!
      const budget = getQuestionCount(combo.duration)
      if (flow.totalSlots > budget + 2 /* insertions can overshoot before trim */) {
        issues.push(`${combo.domain}:${combo.depth}:${combo.experience} — resolved slots ${flow.totalSlots} > budget+2 (${budget + 2})`)
      }
    }

    if (issues.length > 0) {
      console.log(`\n[JD] Issues: ${issues.length}`)
      for (const i of issues) console.log(`  • ${i}`)
    }
    expect(issues).toEqual([])
  })
})
