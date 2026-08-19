/**
 * Focused Hire-control surface for the native multimodal module.
 *
 * This deliberately avoids `modules/hire/index.ts`, whose route-facing
 * exports create a broad dependency surface for a retention-only workflow.
 */
export { HireRound } from "./models/HireRound";
export { HIRE_AI_CONSENT_VERSION } from "./policies/aiInterviewConsent";
