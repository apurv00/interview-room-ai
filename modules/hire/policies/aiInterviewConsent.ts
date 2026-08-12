import { createHash } from 'node:crypto'
import type { HireConsentAcknowledgements } from '../models/HireConsentReceipt'

export const HIRE_AI_CONSENT_VERSION = 'hire-ai-v2-2026-08'

/**
 * The exact disclosure rendered before any camera or microphone access.
 * Changing any sentence changes HIRE_AI_DISCLOSURE_DIGEST and therefore
 * requires a new HIRE_AI_CONSENT_VERSION.
 */
export const HIRE_AI_DISCLOSURES = Object.freeze({
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

export const HIRE_AI_DISCLOSURE_DIGEST = createHash('sha256')
  .update(JSON.stringify(HIRE_AI_DISCLOSURES))
  .digest('hex')

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
