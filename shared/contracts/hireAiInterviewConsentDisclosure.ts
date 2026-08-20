/**
 * Client-safe, immutable wording for the current Hire AI interview consent.
 *
 * The server hashes this exact object into the consent receipt, and the
 * candidate flow renders it verbatim. Keep it free of Node-only imports so it
 * can be used by both the browser and the control surface.
 */
export const HIRE_AI_INTERVIEW_DISCLOSURES = Object.freeze({
  recording:
    'A working camera, microphone, and entire-display share are required before the interview can start. Your camera, microphone, and entire display are recorded and shared with the hiring team for review, and your spoken answers are analyzed to prepare the Hire interview review.',
  identityPhoto:
    'A selfie is captured at interview start and shown to the hiring team for a later human identity comparison. No government ID or automated face match is used.',
  attentionMonitoring:
    'The interview starts in full-screen mode and requires your entire display to be shared. It records neutral interview-validation events when the assessment window is hidden or loses focus, full-screen mode is exited, camera or microphone capture is interrupted, the wrong display surface is shared, or display sharing is interrupted. You will be warned and asked to restore the interview when that happens. The hiring team receives a timestamped review of these events with the camera, microphone, and display recordings; raw landmark data is not shared. These observations are not standalone hiring scores and never make a hiring decision, stage, ranking, recommendation, or export.',
  aiEvaluation:
    'AI evaluates the interview recording, transcript, and permitted interview signals, including whether spoken audio can be corroborated by the visible candidate. An unverified signal is only a timestamp for human review; it does not establish who was speaking. A human makes every hiring decision.',
  retention:
    'Interview camera, microphone, and display recordings, identity photos, private validation observations, and derived Hire review data are removed six calendar months after the job closes, or earlier after a verified deletion request.',
})

export type HireAiInterviewDisclosureKey = keyof typeof HIRE_AI_INTERVIEW_DISCLOSURES
