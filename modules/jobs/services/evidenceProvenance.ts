import { createHash } from 'node:crypto'
import {
  ANSWER_EVALUATION_CONTRACT_VERSION,
  CODE_EVALUATION_CONTRACT_VERSION,
  DESIGN_EVALUATION_CONTRACT_VERSION,
  AI_EXECUTION_PROVENANCE_SCHEMA_VERSION,
  captureModelConfigSnapshot,
  primaryModelExecutionProvenanceOf,
  sameModelConfigSnapshot,
  type ModelExecutionProvenance,
} from '@shared/services/scoringProvenance'
import type { CurrentReadinessProvenance } from '../config/readiness'

export const EVIDENCE_ATTRIBUTION_CONTRACT_VERSION = 'evidence-attribution.v1' as const

export const SCORING_PROVENANCE_CONTRACTS = [
  ['interview.evaluate-answer', ANSWER_EVALUATION_CONTRACT_VERSION],
  ['interview.evaluate-code', CODE_EVALUATION_CONTRACT_VERSION],
  ['interview.evaluate-design', DESIGN_EVALUATION_CONTRACT_VERSION],
] as const

function uniqueExecutions(executions: ModelExecutionProvenance[]): ModelExecutionProvenance[] {
  return Array.from(new Map(executions.map((execution) => [execution.fingerprint, execution])).values())
    .sort((left, right) => left.fingerprint.localeCompare(right.fingerprint))
}

/**
 * Positive allowlist for evidence that may count now. Two identical config
 * reads prevent a CMS cutover from producing a mixed epoch. Historical rows
 * are never relabelled: only their persisted execution fingerprints can match.
 */
export async function currentEvidenceProvenance(): Promise<CurrentReadinessProvenance> {
  const slots = [
    ...SCORING_PROVENANCE_CONTRACTS.map(([taskSlot]) => taskSlot),
    'jobs.evidence-attribution' as const,
  ]
  const before = await Promise.all(slots.map((taskSlot) =>
    captureModelConfigSnapshot(taskSlot, { waitForAuthoritative: true })
  ))
  const after = await Promise.all(slots.map((taskSlot) =>
    captureModelConfigSnapshot(taskSlot, { waitForAuthoritative: true })
  ))
  if (before.some((snapshot, index) => !sameModelConfigSnapshot(snapshot, after[index]))) {
    throw new Error('model config changed while building evidence provenance allowlist')
  }

  const scoring = uniqueExecutions(SCORING_PROVENANCE_CONTRACTS.flatMap(([taskSlot, contractVersion], index) => {
    const base = primaryModelExecutionProvenanceOf({ snapshot: before[index], contractVersion })
    return taskSlot === 'interview.evaluate-answer'
      ? [
          base,
          primaryModelExecutionProvenanceOf({
            snapshot: before[index],
            contractVersion,
            overrides: { maxTokens: 800 },
          }),
        ]
      : [base]
  }))
  const attributionSnapshot = before[SCORING_PROVENANCE_CONTRACTS.length]
  const attribution = uniqueExecutions([
    primaryModelExecutionProvenanceOf({
      snapshot: attributionSnapshot,
      contractVersion: EVIDENCE_ATTRIBUTION_CONTRACT_VERSION,
    }),
    primaryModelExecutionProvenanceOf({
      snapshot: attributionSnapshot,
      contractVersion: EVIDENCE_ATTRIBUTION_CONTRACT_VERSION,
      overrides: { maxTokens: attributionSnapshot.resolved.maxTokens + 600 },
    }),
  ])
  const epoch = createHash('sha256').update(JSON.stringify({
    schemaVersion: AI_EXECUTION_PROVENANCE_SCHEMA_VERSION,
    scoring: scoring.map((execution) => execution.fingerprint),
    attribution: attribution.map((execution) => execution.fingerprint),
  })).digest('hex')
  return { epoch, scoring, attribution }
}
