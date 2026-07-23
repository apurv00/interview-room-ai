// @vitest-environment node
// (repo default is jsdom; the OpenAI SDK refuses to construct under a
//  window global without dangerouslyAllowBrowser — this is a live eval,
//  it runs in node.)
import { describe, it, expect } from 'vitest'
// Vitest dual-instance quirk: the router registry's ensureInitialized() uses
// CJS require(), which under vitest loads a SECOND copy of providers/index —
// providers register into that copy's Map while the router reads this ESM
// instance's empty one ("Provider openai not registered"). ESM-importing the
// provider modules here registers them into the instance the router actually
// reads. Prod (consistent CJS) is unaffected; this is an eval-harness-only
// concern.
// ALL completion providers the CMS can route the slot to — a cutover eval
// on openrouter/google/groq would otherwise die with "Provider not
// registered" for every fixture (Codex on #516). azureTTS is speech-only,
// not a completion provider.
import '@shared/services/providers/openai'
import '@shared/services/providers/anthropic'
import '@shared/services/providers/openrouter'
import '@shared/services/providers/google'
import '@shared/services/providers/groq'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import goldenSet from './goldenSet.json'
import {
  evaluatePosting,
  resolveExpectedVerdictRoute,
  type EvaluatorDeps,
} from '../services/postingEvaluator'
import { epochOf } from '../config/verdictSchema'
import { companyKey, titleKey, locationKey } from '../services/identityResolver'
import { JOBS_VERDICT_DEFAULTS } from '@shared/db/models/JobsVerdictConfig'

/**
 * Golden-set LIVE eval (§4.5 rollout gate) — NOT a CI test. Skipped unless
 * JOBS_VERDICT_EVAL=1; needs OPENAI_API_KEY and MONGODB_URI so the same
 * authoritative route contract as production is evaluated.
 *
 * Run:  node scripts/jobs-verdict-eval.mjs
 *
 * Gates (shadow-exit criteria + this harness = the enforceEnabled pre-flip
 * gate; also the epoch-cutover replay comparator, ruling #8):
 * - fraud false-positive rate on labeled-genuine  < 2%
 * - evaluator failure rate (parse/schema/timeout) < 5%
 * Reported (no hard gate): adversarial fraud catch rate, injection
 * resistance, soft-close eligibility, spend.
 *
 * Results are written to eval/results/<epoch>-<ts>.json — compare two
 * epochs' artifacts before completing a model/prompt cutover.
 */

interface Fixture {
  id: string
  category: 'adversarial-fraud' | 'labeled-genuine' | 'injection'
  expect: { verdicts: string[]; genuinenessMax?: number; genuinenessMin?: number; reasonCodesInclude?: string[] }
  posting: { title: string; company: string; city: string; isRemote: boolean; salaryText?: string | null; applyHosts: string[]; body: string }
  note: string
  /** Runs + records but never gates: injection-in-genuine fixtures are
   *  threshold-unscoreable (the model's honest register on clean postings is
   *  median 0.96 genuineness — measured 2026-07-14); pass/fail needs a
   *  paired with/without-injection control design (follow-up). */
  informational?: boolean
}

const LIVE = process.env.JOBS_VERDICT_EVAL === '1'
const CONCURRENCY = 4

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const idx = i++
        if (idx >= items.length) return
        out[idx] = await fn(items[idx])
      }
    })
  )
  return out
}

describe.skipIf(!LIVE)('verdict golden-set live eval (JOBS_VERDICT_EVAL=1)', () => {
  it('fraud-FP < 2% on labeled-genuine; evaluator failure rate < 5%', async () => {
    const fixtures = goldenSet as Fixture[]
    const resolvedModel = await resolveExpectedVerdictRoute()
    const epoch = epochOf(resolvedModel)
    let totalCost = 0
    const deps: EvaluatorDeps = {
      checkBudget: async () => ({ allowed: true, softening: false }),
      recordSpend: async (_c, _s, usd) => { totalCost += usd },
      pricing: { inputUsdPerMTok: JOBS_VERDICT_DEFAULTS.inputUsdPerMTok, outputUsdPerMTok: JOBS_VERDICT_DEFAULTS.outputUsdPerMTok },
      resolvedModel,
    }

    const results = await pool(fixtures, CONCURRENCY, async (f) => {
      const outcome = await evaluatePosting(
        {
          companyKey: companyKey(f.posting.company),
          titleKey: titleKey(f.posting.title),
          locationKey: locationKey(f.posting.city),
          sourceId: 'golden-set',
          prompt: {
            title: f.posting.title,
            company: f.posting.company,
            city: f.posting.city,
            isRemote: f.posting.isRemote,
            salaryText: f.posting.salaryText ?? null,
            applyHosts: f.posting.applyHosts,
            body: f.posting.body,
          },
        },
        deps
      )
      if (!outcome.ok) return { id: f.id, category: f.category, ok: false as const, kind: outcome.kind, pass: false }
      const v = outcome.verdict
      // reasonCodesInclude is ANY-of BY DESIGN (the authoring contract):
      // multi-code fixtures list alternative acceptable justifications, and
      // demanding all of them would be brittle against harmless variation
      // in a 4-code-capped output. Code-level drift across epochs is
      // visible via matchedReasonCodes in the artifact instead — diff THAT
      // between cutover runs, not the pass rate (Codex on #516).
      const matchedReasonCodes = (f.expect.reasonCodesInclude ?? []).filter((c) => v.reasonCodes.includes(c))
      const pass =
        f.expect.verdicts.includes(v.verdict) &&
        (f.expect.genuinenessMax == null || v.genuineness <= f.expect.genuinenessMax) &&
        (f.expect.genuinenessMin == null || v.genuineness >= f.expect.genuinenessMin) &&
        (f.expect.reasonCodesInclude == null || matchedReasonCodes.length > 0)
      return { id: f.id, category: f.category, ok: true as const, verdict: v.verdict, genuineness: v.genuineness, reasonCodes: v.reasonCodes, matchedReasonCodes, pass, expected: f.expect }
    })

    const okResults = results.filter((r) => r.ok)
    const failures = results.filter((r) => !r.ok)
    const byCat = (cat: Fixture['category']) => okResults.filter((r) => r.category === cat)

    const genuineRows = byCat('labeled-genuine')
    const fraudFPs = genuineRows.filter((r) => r.ok && r.verdict === 'fraud')
    const fraudFPRate = genuineRows.length ? fraudFPs.length / genuineRows.length : 0
    const adversarial = byCat('adversarial-fraud')
    const catchRate = adversarial.length ? adversarial.filter((r) => r.pass).length / adversarial.length : 0
    const informationalIds = new Set(fixtures.filter((f) => f.informational).map((f) => f.id))
    const injection = byCat('injection').filter((r) => !informationalIds.has(r.id))
    const injectionResistance = injection.length ? injection.filter((r) => r.pass).length / injection.length : 0
    const errorRate = results.length ? failures.length / results.length : 0

    const summary = {
      epoch,
      ranAt: new Date().toISOString(),
      total: results.length,
      fraudFPRate,
      fraudFPs: fraudFPs.map((r) => r.id),
      adversarialCatchRate: catchRate,
      injectionResistance,
      injectionScored: injection.length,
      injectionInformational: informationalIds.size,
      evaluatorErrorRate: errorRate,
      evaluatorErrors: failures.map((r) => ({ id: r.id, kind: (r as { kind?: string }).kind })),
      failedFixtures: results.filter((r) => r.ok && !r.pass && !informationalIds.has(r.id)),
      informationalOutcomes: results.filter((r) => r.ok && informationalIds.has(r.id)).map((r) => ({ id: r.id, verdict: r.verdict, genuineness: r.genuineness })),
      estCostUsd: totalCost,
    }

    const dir = join(__dirname, 'results')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${epoch.replace(/[^a-z0-9.-]/gi, '_')}-${Date.now()}.json`)
    writeFileSync(file, JSON.stringify({ summary, results }, null, 2))
    // eslint-disable-next-line no-console
    console.log(`\n── golden-set eval ── epoch ${summary.epoch}\n` +
      `fraud-FP on genuine: ${(fraudFPRate * 100).toFixed(1)}% (gate <2%)  [${fraudFPs.map((r) => r.id).join(', ') || 'none'}]\n` +
      `adversarial catch:  ${(catchRate * 100).toFixed(1)}%\n` +
      `injection resist:   ${(injectionResistance * 100).toFixed(1)}% (scored ${injection.length}; ${informationalIds.size} informational)\n` +
      `evaluator errors:   ${(errorRate * 100).toFixed(1)}% (gate <5%)\n` +
      `est. spend:         $${totalCost.toFixed(3)}\n` +
      `artifact:           ${file}\n`)

    expect(fraudFPRate).toBeLessThan(0.02)
    expect(errorRate).toBeLessThan(0.05)
  }, 1_800_000)
})
