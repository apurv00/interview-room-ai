#!/usr/bin/env npx tsx
/**
 * Dual-pipeline comparison analysis (#4, Option B).
 *
 * Scans MultimodalAnalysis documents that ran the dual-pipeline comparison
 * (i.e. have both `fusionSummary` and `baselineFusionSummary` populated) and
 * computes offline evaluation metrics for the paper:
 *
 *   1. Dimension-wise absolute score deltas per session:
 *        |enhanced.overallBodyLanguageScore - baseline.overallBodyLanguageScore|
 *        |enhanced.eyeContactScore         - baseline.eyeContactScore        |
 *      Reported as count, mean, median, and max across the consented pool.
 *
 *   2. Rank correlation of coaching tip priorities — how often the top-3
 *      tips from each variant agree in ordering.
 *
 *   3. Qualitative timeline diff — events that appear in the enhanced run
 *      but not in the baseline (by title match), per session.
 *
 * If the mean |Δ| across all consented sessions is under 2 points AND the
 * rank correlation is >0.9, the experiment is effectively a null result —
 * Claude is treating the extra blendshape block as noise. That is still a
 * publishable finding for the paper and the script prints a warning at the
 * end.
 *
 * Usage:
 *   MONGODB_URI="mongodb+srv://..." npx tsx scripts/analyse-dual-pipeline.ts [--limit 50]
 */

import mongoose from 'mongoose'
import { MultimodalAnalysis } from '../shared/db/models/MultimodalAnalysis'
import type { FusionSummary, TimelineEvent } from '../shared/types/multimodal'

interface SessionComparison {
  sessionId: string
  // null when either variant had no facial data — the delta is undefined
  // in that case, callers (analysis aggregation, printed report) skip.
  bodyLanguageDelta: number | null
  eyeContactDelta: number | null
  enhancedBodyLanguage: number | null
  baselineBodyLanguage: number | null
  enhancedEyeContact: number | null
  baselineEyeContact: number | null
  topTipOverlap: number  // count of tips shared between top 3 of each variant
  enhancedOnlyEvents: string[]
  baselineOnlyEvents: string[]
}

function parseArgs() {
  const args = process.argv.slice(2)
  let limit = 1000
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[i + 1], 10)
      i++
    }
  }
  return { limit }
}

function median(values: number[]): number {
  // Return NaN (not 0) on empty input — Codex P2 on PR #318. After
  // null-skipping in the delta arrays, `values` can be genuinely empty
  // (e.g., every session was privacy-mode with no facial data). The old
  // `return 0` printed "median=0.00" and misled experiment conclusions
  // into thinking measured agreement existed where data was missing.
  // NaN routes through the printed `fmt` helper to "n/a", matching how
  // mean handles the same case.
  if (values.length === 0) return NaN
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().trim().replace(/\s+/g, ' ')
}

function compareSessions(
  enhanced: FusionSummary,
  baseline: FusionSummary,
  enhancedTimeline: TimelineEvent[],
  baselineTimeline: TimelineEvent[]
): Omit<SessionComparison, 'sessionId'> {
  // Post-PR #318: scores may be null when either variant had no valid
  // facial data. A null on either side makes the delta meaningless —
  // report null, not 0 (which would bias the aggregated median toward
  // "agreement" on sessions that had no data to agree on).
  const bodyLanguageDelta =
    enhanced.overallBodyLanguageScore != null && baseline.overallBodyLanguageScore != null
      ? Math.abs(enhanced.overallBodyLanguageScore - baseline.overallBodyLanguageScore)
      : null
  const eyeContactDelta =
    enhanced.eyeContactScore != null && baseline.eyeContactScore != null
      ? Math.abs(enhanced.eyeContactScore - baseline.eyeContactScore)
      : null

  // Rank correlation of top-3 coaching tips — count how many enhanced top
  // tips also appear in baseline top tips (order-insensitive proxy).
  const enhancedTop3 = new Set(
    enhanced.coachingTips.slice(0, 3).map((t) => normalizeTitle(t))
  )
  const baselineTop3 = new Set(
    baseline.coachingTips.slice(0, 3).map((t) => normalizeTitle(t))
  )
  let topTipOverlap = 0
  enhancedTop3.forEach((t) => {
    if (baselineTop3.has(t)) topTipOverlap++
  })

  // Timeline diff — titles that appear in one run but not the other.
  const enhancedTitles = new Set(enhancedTimeline.map((e) => normalizeTitle(e.title)))
  const baselineTitles = new Set(baselineTimeline.map((e) => normalizeTitle(e.title)))
  const enhancedOnlyEvents = Array.from(enhancedTitles).filter((t) => !baselineTitles.has(t))
  const baselineOnlyEvents = Array.from(baselineTitles).filter((t) => !enhancedTitles.has(t))

  return {
    bodyLanguageDelta,
    eyeContactDelta,
    enhancedBodyLanguage: enhanced.overallBodyLanguageScore,
    baselineBodyLanguage: baseline.overallBodyLanguageScore,
    enhancedEyeContact: enhanced.eyeContactScore,
    baselineEyeContact: baseline.eyeContactScore,
    topTipOverlap,
    enhancedOnlyEvents,
    baselineOnlyEvents,
  }
}

async function main() {
  const { limit } = parseArgs()

  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is required')
    process.exit(1)
  }

  await mongoose.connect(process.env.MONGODB_URI)

  const docs = await MultimodalAnalysis.find({
    status: 'completed',
    fusionSummary: { $exists: true },
    baselineFusionSummary: { $exists: true },
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean()

  console.log(`\nDual-pipeline comparison analysis`)
  console.log(`=================================\n`)
  console.log(`Consented sessions analyzed: ${docs.length}\n`)

  if (docs.length === 0) {
    console.log('No dual-pipeline sessions found. Check that:')
    console.log('  - FEATURE_FLAG_RESEARCH_COMPARISON=true in the runtime environment')
    console.log('  - At least one user has privacyConsent.researchDonationConsent=true')
    console.log('  - That user has completed an interview with blendshapes captured')
    await mongoose.disconnect()
    return
  }

  const comparisons: SessionComparison[] = docs.map((doc) => {
    const enhanced = doc.fusionSummary as FusionSummary
    const baseline = doc.baselineFusionSummary as FusionSummary
    const comparison = compareSessions(
      enhanced,
      baseline,
      (doc.timeline || []) as TimelineEvent[],
      (doc.baselineTimeline || []) as TimelineEvent[]
    )
    return {
      sessionId: doc.sessionId.toString(),
      ...comparison,
    }
  })

  // Dimension deltas — skip sessions where either variant had null (no
  // facial data). Including them as 0 would bias the median toward
  // "agreement" on sessions where neither side had data to compare.
  const bodyDeltas = comparisons
    .map((c) => c.bodyLanguageDelta)
    .filter((d): d is number => d !== null)
  const eyeDeltas = comparisons
    .map((c) => c.eyeContactDelta)
    .filter((d): d is number => d !== null)
  const meanBody = bodyDeltas.length > 0 ? bodyDeltas.reduce((a, b) => a + b, 0) / bodyDeltas.length : NaN
  const meanEye = eyeDeltas.length > 0 ? eyeDeltas.reduce((a, b) => a + b, 0) / eyeDeltas.length : NaN
  const skipped = comparisons.length - bodyDeltas.length

  console.log('Dimension-wise score deltas (|enhanced − baseline|)')
  console.log('----------------------------------------------------')
  if (skipped > 0) {
    console.log(`(${skipped}/${comparisons.length} sessions skipped — null scores on one or both variants)`)
  }
  const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : 'n/a')
  console.log(`Body language: mean=${fmt(meanBody)} median=${fmt(median(bodyDeltas))} max=${bodyDeltas.length ? Math.max(...bodyDeltas).toFixed(2) : 'n/a'}`)
  console.log(`Eye contact:   mean=${fmt(meanEye)} median=${fmt(median(eyeDeltas))} max=${eyeDeltas.length ? Math.max(...eyeDeltas).toFixed(2) : 'n/a'}\n`)

  // Top-tip overlap
  const overlaps = comparisons.map((c) => c.topTipOverlap)
  const meanOverlap = overlaps.reduce((a, b) => a + b, 0) / overlaps.length
  const rankAgreement = meanOverlap / 3 // normalized 0–1
  console.log('Coaching tip rank correlation')
  console.log('------------------------------')
  console.log(`Mean overlap (top 3, out of 3): ${meanOverlap.toFixed(2)}`)
  console.log(`Rank agreement (normalized):    ${rankAgreement.toFixed(3)}\n`)

  // Timeline diff summary
  const enhancedOnlyCounts = comparisons.map((c) => c.enhancedOnlyEvents.length)
  const baselineOnlyCounts = comparisons.map((c) => c.baselineOnlyEvents.length)
  console.log('Timeline event diff (per session)')
  console.log('---------------------------------')
  console.log(`Enhanced-only events: mean=${(enhancedOnlyCounts.reduce((a, b) => a + b, 0) / enhancedOnlyCounts.length).toFixed(1)}`)
  console.log(`Baseline-only events: mean=${(baselineOnlyCounts.reduce((a, b) => a + b, 0) / baselineOnlyCounts.length).toFixed(1)}\n`)

  // Per-session detail (first 5 sessions)
  console.log('Per-session detail (first 5)')
  console.log('----------------------------')
  for (const c of comparisons.slice(0, 5)) {
    const fmtScore = (v: number | null) => (v == null ? 'null' : String(v))
    const fmtDelta = (v: number | null) => (v == null ? 'n/a' : v.toFixed(1))
    console.log(`${c.sessionId}:`)
    console.log(`  body=${fmtScore(c.baselineBodyLanguage)}→${fmtScore(c.enhancedBodyLanguage)} (Δ${fmtDelta(c.bodyLanguageDelta)})`)
    console.log(`  eye =${fmtScore(c.baselineEyeContact)}→${fmtScore(c.enhancedEyeContact)} (Δ${fmtDelta(c.eyeContactDelta)})`)
    console.log(`  top-tip overlap: ${c.topTipOverlap}/3`)
    console.log(`  enhanced-only events: ${c.enhancedOnlyEvents.slice(0, 3).join(', ') || '(none)'}`)
  }

  // Null-result warning
  console.log('\nInterpretation')
  console.log('--------------')
  // Codex P2 on PR #318: if every session had null scores on one or
  // both variants (e.g., all sessions were privacy-mode, or facial
  // capture failed universally), `meanBody`/`meanEye` are NaN from the
  // `length > 0 ? ... : NaN` branches above. Numeric comparisons
  // against NaN always return false — so without this explicit guard,
  // the script would take the `else` branch and print
  // "Enhanced variant produces measurably different outputs" alongside
  // `NaN.toFixed(2)` = "NaN", inverting the conclusion in exactly the
  // no-data scenario. Explicit branch handles it honestly.
  if (!Number.isFinite(meanBody) || !Number.isFinite(meanEye)) {
    console.log('⚠ NO COMPARABLE SESSIONS: every session was skipped because at')
    console.log('  least one variant had a null score (no facial data captured).')
    console.log(`    - Sessions compared:      0 / ${comparisons.length}`)
    console.log('    - Cannot compute mean Δ body language or eye contact.')
    console.log('  Re-run the analysis against sessions that include camera-on')
    console.log('  interviews before drawing any enhanced-vs-baseline conclusions.')
  } else if (meanBody < 2 && meanEye < 2 && rankAgreement > 0.9) {
    console.log('⚠ NULL RESULT: enhanced variant is producing nearly identical scores')
    console.log('  and coaching tips to the baseline. Claude Haiku appears to be')
    console.log('  treating the extra blendshape block as noise. Consider:')
    console.log('    - Restructuring the prompt so blendshapes are more prominent')
    console.log('    - Pre-computing a "blendshape summary" narrative for the model')
    console.log('    - Using a larger model (Sonnet) for the enhanced variant')
  } else {
    console.log('✓ Enhanced variant produces measurably different outputs.')
    console.log('  Use these numbers directly in the paper:')
    console.log(`    - Mean |Δ| body language: ${meanBody.toFixed(2)} points`)
    console.log(`    - Mean |Δ| eye contact:   ${meanEye.toFixed(2)} points`)
    console.log(`    - Rank agreement:         ${rankAgreement.toFixed(3)}`)
  }

  await mongoose.disconnect()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
