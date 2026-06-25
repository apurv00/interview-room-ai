import fs from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'
import { STATIC_DOMAINS, STATIC_DEPTHS } from '../config/staticData'
import { TEMPLATE_REGISTRY } from '../flow/templates'
import { resolveFlow } from '../flow/resolver'

/**
 * PRODUCTION COVERAGE GUARD.
 *
 * Every interview domain×depth a user can actually select MUST have:
 *   1. a seniority-banded skill file  modules/interview/skills/{domain}-{depth}.md
 *   2. a registered flow template for every experience band ({domain}:{depth}:{0-2|3-6|7+})
 *
 * The live cell set is DERIVED from the taxonomy config (STATIC_DOMAINS ×
 * STATIC_DEPTHS applicability), so this guard auto-updates when the taxonomy
 * changes. This is the check whose absence let the Phase 4-6 expansion ship
 * 17 selectable domains with no skill files and no flow templates.
 */

const BANDS = ['0-2', '3-6', '7+'] as const
const skillsDir = path.join(process.cwd(), 'modules', 'interview', 'skills')

type Domain = (typeof STATIC_DOMAINS)[number]
type Depth = (typeof STATIC_DEPTHS)[number]

function depthApplies(domain: Domain, depth: Depth): boolean {
  const restricted = Boolean(depth.applicableDomains || depth.applicableCategories)
  if (!restricted) return true // behavioral / technical: all domains
  if (depth.applicableDomains?.includes(domain.slug)) return true
  if (domain.categorySlug && depth.applicableCategories?.includes(domain.categorySlug)) return true
  return false
}

const liveCells: Array<{ domain: string; depth: string }> = []
for (const d of STATIC_DOMAINS) {
  for (const depth of STATIC_DEPTHS) {
    if (depthApplies(d, depth)) liveCells.push({ domain: d.slug, depth: depth.slug })
  }
}

function skillIsBanded(file: string): boolean {
  const src = fs.readFileSync(file, 'utf-8')
  // must have a Sample Questions section banded by all three seniority levels
  const sq = src.split(/^## /m).find(s => s.toLowerCase().startsWith('sample questions'))
  if (!sq) return false
  return /###\s+Entry Level/i.test(sq) && /###\s+Mid Level/i.test(sq) && /###\s+Senior/i.test(sq)
}

describe('production skill + flow coverage', () => {
  it(`enumerates the live cell set (${liveCells.length} cells)`, () => {
    expect(liveCells.length).toBeGreaterThan(0)
  })

  it('every live cell has a seniority-banded skill file', () => {
    const missing: string[] = []
    for (const c of liveCells) {
      const file = path.join(skillsDir, `${c.domain}-${c.depth}.md`)
      if (!fs.existsSync(file)) missing.push(`${c.domain}-${c.depth}.md (absent)`)
      else if (!skillIsBanded(file)) missing.push(`${c.domain}-${c.depth}.md (not banded)`)
    }
    expect(missing, `Missing/invalid skill files:\n${missing.join('\n')}`).toEqual([])
  })

  it('every live cell has all 3 banded flow templates registered', () => {
    const missing: string[] = []
    for (const c of liveCells) {
      for (const band of BANDS) {
        const key = `${c.domain}:${c.depth}:${band}`
        if (!TEMPLATE_REGISTRY.has(key)) missing.push(key)
      }
    }
    expect(missing, `Missing flow templates:\n${missing.join('\n')}`).toEqual([])
  })
})

describe('general backstop', () => {
  it('resolveFlow falls back to the general domain for an unknown (CMS-added) domain', () => {
    const flow = resolveFlow({
      domain: 'some-cms-added-domain-not-in-staticdata',
      depth: 'behavioral',
      experience: '3-6',
      duration: 30,
    } as Parameters<typeof resolveFlow>[0])
    expect(flow, 'unknown domain should resolve to general, not null').not.toBeNull()
    expect(flow!.slots.length).toBeGreaterThan(4)
  })

  // academics inherits by category in /api/interview-types, so a CMS-added domain in
  // programming/data-ai/core-engineering/business can select it — it MUST resolve to
  // general:academics (and getSkillContent to general-academics.md), like every other depth.
  it('resolveFlow falls back to general:academics for an unknown (CMS-added) domain', () => {
    const flow = resolveFlow({
      domain: 'some-cms-added-programming-role',
      depth: 'academics',
      experience: '0-2',
      duration: 30,
    } as Parameters<typeof resolveFlow>[0])
    expect(flow, 'unknown domain + academics should resolve to general:academics, not null').not.toBeNull()
    expect(flow!.slots.length).toBeGreaterThan(4)
  })

  it('general-academics.md skill backstop exists and is seniority-banded', () => {
    const file = path.join(skillsDir, 'general-academics.md')
    expect(fs.existsSync(file), 'general-academics.md must exist as the CMS skill backstop').toBe(true)
    expect(skillIsBanded(file), 'general-academics.md must be seniority-banded').toBe(true)
  })
})
