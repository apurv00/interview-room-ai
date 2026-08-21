/**
 * Focused Hire-control surface for the native multimodal module.
 *
 * This deliberately avoids `modules/hire/index.ts`, whose route-facing
 * exports create a broad dependency surface for a retention-only workflow.
 */
export { HireRound } from "./models/HireRound";
export { withActiveHireWorkspaceWriteTransaction } from "./services/hireWorkspaceWriteFence";
export {
  HIRE_AI_CONSENT_VERSION,
  HIRE_AI_V4_CONSENT_VERSION,
  HIRE_AI_V5_CONSENT_VERSION,
  isRecognizedHireConsentSnapshot,
  isRecognizedHireConsentVersion,
  supportsHireDisplayCapture,
  supportsHireMultimodalObservations,
} from "./policies/aiInterviewConsent";
