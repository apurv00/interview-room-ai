import { createHash } from 'node:crypto'
import {
  HIRE_MULTIMODAL_OBSERVATION_CONSENT_VERSION,
  HIRE_MULTIMODAL_OBSERVATION_POLICY_VERSION,
} from '@shared/contracts/hireMultimodalObservationBridge'
import { HIRE_AI_INTERVIEW_DISCLOSURES } from '@shared/contracts/hireAiInterviewConsentDisclosure'
import type { HireConsentAcknowledgements } from '../models/HireConsentReceipt'

/**
 * New Hire attempts receive this version. Earlier consent snapshots remain
 * valid only for their already-started attempts; they are never silently
 * upgraded to new disclosure terms.
 */
export const HIRE_AI_CONSENT_VERSION = 'hire-ai-v4-2026-08-17'
export { HIRE_MULTIMODAL_OBSERVATION_POLICY_VERSION }

/**
 * Exact historical V2/V3 pairs are deliberately retained for in-progress
 * attempts. This is not a generic historical-consent escape hatch: an
 * altered or unknown disclosure digest remains invalid.
 */
export const HIRE_AI_V2_CONSENT_VERSION = 'hire-ai-v2-2026-08'
export const HIRE_AI_V3_CONSENT_VERSION =
  HIRE_MULTIMODAL_OBSERVATION_CONSENT_VERSION

const HIRE_AI_V2_DISCLOSURES = Object.freeze({
  recording:
    'Your camera and microphone are recorded, and your spoken answers are transcribed.',
  identityPhoto:
    'A selfie is captured at interview start and shown to the hiring team for a later human identity comparison. No government ID or automated face match is used.',
  attentionMonitoring:
    'The interview records neutral attention observations such as tab or window changes, sustained gaze-away cues, and reading-cadence cues. These observations are not scores and never make a hiring decision.',
  aiEvaluation:
    'AI evaluates the interview and prepares evidence-linked scores and written observations. A human makes every hiring decision.',
  retention:
    'Interview recordings and identity photos are removed six calendar months after the job closes, or earlier after a verified deletion request.',
})

export const HIRE_AI_V2_DISCLOSURE_DIGEST = createHash('sha256')
  .update(JSON.stringify(HIRE_AI_V2_DISCLOSURES))
  .digest('hex')

/**
 * This is the exact V3 copy that was previously the current disclosure. It
 * must remain immutable so existing V3 receipts can finish under the wording
 * the candidate accepted, even though all new attempts use V4.
 */
const HIRE_AI_V3_DISCLOSURES = Object.freeze({
  recording:
    'Your camera and microphone are recorded, and your spoken answers are transcribed.',
  identityPhoto:
    'A selfie is captured at interview start and shown to the hiring team for a later human identity comparison. No government ID or automated face match is used.',
  attentionMonitoring:
    'The interview derives and records neutral browser-window and camera-attention observations, such as tab or window changes and sustained camera-away cues. Raw camera samples are discarded after this report is created. These observations are not scores and never affect a hiring decision, stage, ranking, recommendation, or export.',
  aiEvaluation:
    'AI evaluates the interview and prepares evidence-linked scores and written observations. A human makes every hiring decision.',
  retention:
    'Interview recordings, identity photos, and supplemental attention observations are removed six calendar months after the job closes, or earlier after a verified deletion request.',
})

export const HIRE_AI_V3_DISCLOSURE_DIGEST = createHash('sha256')
  .update(JSON.stringify(HIRE_AI_V3_DISCLOSURES))
  .digest('hex')

/**
 * The exact disclosure rendered before any camera or microphone access.
 * Changing any sentence changes HIRE_AI_DISCLOSURE_DIGEST and therefore
 * requires a new HIRE_AI_CONSENT_VERSION.
 */
export const HIRE_AI_DISCLOSURES = HIRE_AI_INTERVIEW_DISCLOSURES

export const HIRE_AI_DISCLOSURE_DIGEST = createHash('sha256')
  .update(JSON.stringify(HIRE_AI_DISCLOSURES))
  .digest('hex')

export interface HireConsentSnapshot {
  consentVersion: string
  disclosureDigest: string
}

const RECOGNIZED_HIRE_CONSENT_SNAPSHOTS = Object.freeze([
  {
    consentVersion: HIRE_AI_CONSENT_VERSION,
    disclosureDigest: HIRE_AI_DISCLOSURE_DIGEST,
  },
  {
    consentVersion: HIRE_AI_V3_CONSENT_VERSION,
    disclosureDigest: HIRE_AI_V3_DISCLOSURE_DIGEST,
  },
  {
    consentVersion: HIRE_AI_V2_CONSENT_VERSION,
    disclosureDigest: HIRE_AI_V2_DISCLOSURE_DIGEST,
  },
])

/**
 * The version and digest are an inseparable pair. This permits a valid
 * pre-rollout v2 attempt to finish while refusing a forged, changed, or
 * otherwise unrecognized historical consent record.
 */
export function isRecognizedHireConsentSnapshot(
  snapshot: Partial<HireConsentSnapshot> | null | undefined,
): snapshot is HireConsentSnapshot {
  return RECOGNIZED_HIRE_CONSENT_SNAPSHOTS.some(
    (recognized) =>
      recognized.consentVersion === snapshot?.consentVersion &&
      recognized.disclosureDigest === snapshot?.disclosureDigest,
  )
}

export class HireConsentError extends Error {
  readonly code = 'CONSENT_REQUIRED'
  readonly status = 409

  constructor() {
    super('Recording, identity photo, attention monitoring, and AI evaluation consent are required')
    this.name = 'HireConsentError'
  }
}

export function assertCompleteHireConsent(
  input: Partial<Record<keyof HireConsentAcknowledgements, boolean>>,
): asserts input is HireConsentAcknowledgements {
  if (
    input.recording !== true ||
    input.identityPhoto !== true ||
    input.attentionMonitoring !== true ||
    input.aiEvaluation !== true
  ) {
    throw new HireConsentError()
  }
}

/**
 * Existing V2/V3 sessions remain valid to finish under their exact receipt,
 * but only a V4 receipt may activate the current Hire-native capture path.
 * The runtime independently checks the receipt; this browser marker only
 * prevents unnecessary client collection.
 */
export function supportsHireMultimodalObservations(
  consentVersion: string | undefined,
): boolean {
  return consentVersion === HIRE_AI_CONSENT_VERSION
}
