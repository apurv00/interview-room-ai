/**
 * QA harness strong-answer routing by flow metadata (competency bucket / domain).
 * Used by qa-matrix-runner (inlined at build) and unit tests.
 *
 * Lookup order:
 *   1. bySlot[slotId]
 *   2. byDomainBucket[`${domain}:${competencyBucket}`]
 *   3. byBucket[competencyBucket]
 *   4. depthFallback[depth] → depthFallback.behavioral
 */

/**
 * @param {import('../config/strongAnswers.schema').StrongAnswersConfig} config
 * @param {{ domain: string, depth: string, flowMeta?: { slotId?: string, competencyBucket?: string } | null }} ctx
 * @returns {{ answer: string, route: string }}
 */
export function pickStrongAnswer(config, ctx) {
  const { domain, depth, flowMeta } = ctx
  const bucket = flowMeta?.competencyBucket
  const slotId = flowMeta?.slotId

  if (slotId && config.bySlot?.[slotId]) {
    return { answer: config.bySlot[slotId], route: `slot:${slotId}` }
  }

  if (bucket && domain) {
    const dbKey = `${domain}:${bucket}`
    if (config.byDomainBucket?.[dbKey]) {
      return { answer: config.byDomainBucket[dbKey], route: `domain-bucket:${dbKey}` }
    }
  }

  if (bucket && config.byBucket?.[bucket]) {
    return { answer: config.byBucket[bucket], route: `bucket:${bucket}` }
  }

  const fallback =
    config.depthFallback?.[depth] ??
    config.depthFallback?.behavioral ??
    'Situation: At Acme I led a cross-functional initiative with clear metrics and ownership. Action: I aligned stakeholders, scoped a phased rollout, and tracked weekly outcomes. Result: Delivered measurable impact on schedule.'

  return { answer: fallback, route: bucket ? `depth-fallback:${depth}` : `no-flowMeta:${depth}` }
}

/**
 * @param {import('../config/strongAnswers.schema').StrongAnswersConfig} config
 * @param {Set<string>} requiredBuckets
 * @returns {{ missingBuckets: string[], missingDomainBuckets: string[] }}
 */
export function findCoverageGaps(config, requiredBuckets) {
  const missingBuckets = [...requiredBuckets].filter((b) => !config.byBucket?.[b]).sort()
  return { missingBuckets, missingDomainBuckets: [] }
}

/**
 * @param {number | null} avg
 * @param {'strong' | 'weak'} persona
 * @returns {{ g1Pipeline: boolean, g2Separation: boolean | null, g3Relevance: boolean | null, bandOk: boolean }}
 */
export function scoreQuestionGates(avg, persona, hasEval) {
  const g1Pipeline = hasEval && avg != null
  const g2Separation = persona === 'weak' && avg != null ? avg <= 55 : null
  const g3Relevance = persona === 'strong' && avg != null ? avg >= 60 : null
  // G1 drives cell pass; G2 required for weak; G3 tracked for strong (calibration, non-blocking)
  const bandOk = persona === 'weak' ? (g1Pipeline && g2Separation === true) : g1Pipeline
  return { g1Pipeline, g2Separation, g3Relevance, bandOk }
}
