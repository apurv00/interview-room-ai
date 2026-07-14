import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import goldenSet from '../eval/goldenSet.json'
import { REASON_CODES } from '../config/verdictSchema'

/**
 * ALWAYS-ON shape guard for the golden set (the live eval itself is
 * env-gated and never runs in CI). Keeps the corpus honest: valid shape,
 * unique ids, category floors per the §4.5 gate design, plain-text bodies
 * (the pipeline stores tag-stripped text — a tagged fixture would test an
 * input the classifier can never receive), and no fixture that would make
 * the fraud-FP gate unmeasurable.
 */

const FixtureSchema = z.object({
  id: z.string().min(3),
  category: z.enum(['adversarial-fraud', 'labeled-genuine', 'injection']),
  expect: z.object({
    verdicts: z.array(z.enum(['genuine', 'suspicious', 'fraud'])).min(1),
    genuinenessMax: z.number().min(0).max(1).optional(),
    genuinenessMin: z.number().min(0).max(1).optional(),
    reasonCodesInclude: z.array(z.enum(REASON_CODES as unknown as [string, ...string[]])).optional(),
  }),
  posting: z.object({
    title: z.string().min(3).max(300),
    company: z.string().min(1).max(300),
    city: z.string(),
    isRemote: z.boolean(),
    salaryText: z.string().max(200).nullable().optional(),
    applyHosts: z.array(z.string()),
    body: z.string().min(100).max(6000),
  }),
  note: z.string().min(5),
  informational: z.boolean().optional(),
})

describe('golden set shape (CI guard for the env-gated live eval)', () => {
  const fixtures = goldenSet as Array<z.infer<typeof FixtureSchema>>

  it('every fixture validates', () => {
    for (const f of fixtures) {
      const r = FixtureSchema.safeParse(f)
      expect(r.success, `${(f as { id?: string }).id}: ${r.success ? '' : JSON.stringify(r.error.issues[0])}`).toBe(true)
    }
  })

  it('ids are unique and category floors hold (37/40/50 design targets)', () => {
    expect(new Set(fixtures.map((f) => f.id)).size).toBe(fixtures.length)
    const count = (c: string) => fixtures.filter((f) => f.category === c).length
    expect(count('adversarial-fraud')).toBeGreaterThanOrEqual(30)
    expect(count('labeled-genuine')).toBeGreaterThanOrEqual(35)
    expect(count('injection')).toBeGreaterThanOrEqual(40)
  })

  it('bodies are plain text — the classifier never receives tags', () => {
    for (const f of fixtures) {
      expect(/<[^>]+>/.test(f.posting.body), `${f.id} contains a markup tag`).toBe(false)
    }
  })

  it('no labeled-genuine fixture expects only fraud — the FP gate must stay measurable', () => {
    for (const f of fixtures.filter((x) => x.category === 'labeled-genuine')) {
      expect(f.expect.verdicts.includes('genuine') || f.expect.verdicts.includes('suspicious'), f.id).toBe(true)
    }
  })
})
