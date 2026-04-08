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
  bodyLanguageDelta: number
  eyeContactDelta: number
  enhancedBodyLanguage: number
  baselineBodyLanguage: number
  enhancedEyeContact: number
  baselineEyeContact: number
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
  if (values.length === 0) return 0
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
  const bodyLanguageDelta = Math.abs(
    enhanced.overallBodyLanguageScore - baseline.overallBodyLanguageScore
  )
  const eyeContactDelta = Math.abs(
    enhanced.eyeContactScore - baseline.eyeContactScore
  )

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

  // Dimension deltas
  const bodyDeltas = comparisons.map((c) => c.bodyLanguageDelta)
  const eyeDeltas = comparisons.map((c) => c.eyeContactDelta)
  const meanBody = bodyDeltas.reduce((a, b) => a + b, 0) / bodyDeltas.length
  const meanEye = eyeDeltas.reduce((a, b) => a + b, 0) / eyeDeltas.length

  console.log('Dimension-wise score deltas (|enhanced − baseline|)')
  console.log('----------------------------------------------------')
  console.log(`Body language: mean=${meanBody.toFixed(2)} median=${median(bodyDeltas).toFixed(2)} max=${Math.max(...bodyDeltas).toFixed(2)}`)
  console.log(`Eye contact:   mean=${meanEye.toFixed(2)} median=${median(eyeDeltas).toFixed(2)} max=${Math.max(...eyeDeltas).toFixed(2)}\n`)

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
    console.log(`${c.sessionId}:`)
    console.log(`  body=${c.baselineBodyLanguage}→${c.enhancedBodyLanguage} (Δ${c.bodyLanguageDelta.toFixed(1)})`)
    console.log(`  eye =${c.baselineEyeContact}→${c.enhancedEyeContact} (Δ${c.eyeContactDelta.toFixed(1)})`)
    console.log(`  top-tip overlap: ${c.topTipOverlap}/3`)
    console.log(`  enhanced-only events: ${c.enhancedOnlyEvents.slice(0, 3).join(', ') || '(none)'}`)
  }

  // Null-result warning
  console.log('\nInterpretation')
  console.log('--------------')
  if (meanBody < 2 && meanEye < 2 && rankAgreement > 0.9) {
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
