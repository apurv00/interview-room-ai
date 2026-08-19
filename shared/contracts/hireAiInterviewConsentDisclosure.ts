/**
 * Client-safe, immutable wording for the current Hire AI interview consent.
 *
 * The server hashes this exact object into the consent receipt, and the
 * candidate flow renders it verbatim. Keep it free of Node-only imports so it
 * can be used by both the browser and the control surface.
 */
export const HIRE_AI_INTERVIEW_DISCLOSURES = Object.freeze({
  recording:
    'Your camera and microphone are recorded, shared with the hiring team for review, and analyzed with your spoken answers to prepare the Hire interview review.',
  identityPhoto:
    'A selfie is captured at interview start and shown to the hiring team for a later human identity comparison. No government ID or automated face match is used.',
  attentionMonitoring:
    'The interview processes camera video in your browser and privately retains structured facial-landmark and browser-window observations for Hire analysis and reproducibility. The hiring team receives the interview recording and derived Hire review, not raw landmark data. These observations are not standalone hiring scores; a human makes every hiring decision.',
  aiEvaluation:
    'AI evaluates the interview recording, transcript, and permitted interview signals and prepares evidence-linked scores and written observations. A human makes every hiring decision.',
  retention:
    'Interview recordings, identity photos, private analysis observations, and derived Hire review data are removed six calendar months after the job closes, or earlier after a verified deletion request.',
})

export type HireAiInterviewDisclosureKey = keyof typeof HIRE_AI_INTERVIEW_DISCLOSURES
